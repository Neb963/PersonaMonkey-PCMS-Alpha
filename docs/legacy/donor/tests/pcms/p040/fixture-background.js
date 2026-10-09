// P040 fixture add-on background (A040-02 PKG proof). Never part of the product XPI.
//
// It composes the shipped modules, copied byte for byte from the product XPI: storage broker
// and Audit Journal over IndexedDB, RemoteOps, ProviderGate, the Deployer v2 and repository
// service, the P040 Refresher with its Deployer-confirmed release source, the Core timer
// service, the Refresher background scheduler and the P029 alarm coordinator. Only the
// provider (Perchance v2 emulator), the repository (network-free fixture) and the account are
// test doubles. The same function runs in Node for a local rehearsal (bases and stores injected).
export const P040_FIXTURE_PROBE = "p040-status";
const ACCOUNT_ID = "acct-1";
const SHA = "a".repeat(40);
const SLUGS = ["alpha", "beta", "gamma"];
export const P040_FIXTURE_BUDGET = 2;

function blobs() {
  const out = { "pcms-generators.json":'{"format":"pcms.generator-repository/v1"}' };
  for (const slug of SLUGS) {
    const base = "alice/" + slug + "/";
    out[base + "generator.json"] = JSON.stringify({ format:"pcms.generator/v1", slug, title:slug, release:"1.0.0", listing:"UNLISTED", deploy:"manual" });
    out[base + "releases/1.0.0/code.perchance"] = "// " + slug + " 1.0.0\ntitle\n  " + slug + "\n";
    out[base + "releases/1.0.0/page.html"] = "<h1>" + slug + "</h1>\n";
  }
  return out;
}

export async function createP040Background({ pcmsBase, modulesBase, browserRef, storageBroker = null, auditJournal = null, now = () => new Date().toISOString() }) {
  const load = (base, path) => import(new URL(path, base).href);
  const [
    { createPcmsStorageBroker }, { createPcmsAuditJournal }, { createRemoteOps }, { createRecoveryHoldController },
    { createProviderGate }, { createPerchanceProviderAdapter }, { createPerchanceEmulator }, { createFixtureRepositoryProvider },
    { createSingletonStateStore }, { createCoreServiceRegistry }, { createTimerService }, { createPcmsAlarmCoordinator },
    { REFRESHER_BACKGROUND_TIMER_ID, createRefresherBackgroundScheduler, createRemoteOperationCanceller, createUnattendedRefreshCapability },
    { createDeployerService }, { createDeployerRepositoryService }, { createRefresherService }
  ] = await Promise.all([
    load(pcmsBase, "storage/storage-broker.js"), load(pcmsBase, "audit/journal.js"), load(pcmsBase, "remoteops/remote-ops.js"),
    load(pcmsBase, "remoteops/recovery-hold.js"), load(pcmsBase, "remoteops/provider-gate.js"), load(pcmsBase, "providers/perchance/adapter.js"),
    load(pcmsBase, "providers/perchance/emulator.js"), load(pcmsBase, "providers/repository/fixture.js"), load(pcmsBase, "integration/adapters.js"),
    load(pcmsBase, "services/registry.js"), load(pcmsBase, "services/timers.js"), load(pcmsBase, "background/alarms/coordinator.js"),
    load(pcmsBase, "integration/refresher-background.js"), load(modulesBase, "p015/deployer.js"), load(modulesBase, "p015/repository-service.js"),
    load(modulesBase, "p017/refresher.js")
  ]);
  const storage = storageBroker ?? createPcmsStorageBroker({ clock:now });
  const audit = auditJournal ?? createPcmsAuditJournal({ clock:now });
  await storage.open?.();
  await audit.open?.();
  const fixtureStore = storage.namespace("p040.fixture");

  const account = Object.freeze({ schemaVersion:1, kind:"account", accountId:ACCOUNT_ID, providerId:"perchance", displayName:"Alice",
    personaUid:"11111111-1111-4111-8111-111111111111", bindingEpoch:1, createdAt:"2026-10-01T00:00:00.000Z", updatedAt:"2026-10-01T00:00:00.000Z" });
  const accounts = Object.freeze({
    async getAccount(id) { return id === ACCOUNT_ID ? { ...account } : null; },
    async listAccounts() { return { revision:1, accounts:[{ ...account }] }; }
  });
  const remoteOps = createRemoteOps({ storageBroker:storage, clock:now });
  const recoveryHold = createRecoveryHoldController({ storageBroker:storage, remoteOps, clock:now });
  const emulator = createPerchanceEmulator({ contractVersion:2 });
  const adapter = createPerchanceProviderAdapter({ driver:emulator.driver });
  const gate = createProviderGate({ remoteOps, recoveryHold, providers:{ perchance:adapter.providerDescriptor } });
  const gates = Object.freeze({ async get(id) { return id === ACCOUNT_ID ? gate : null; } });
  const provider = createFixtureRepositoryProvider({ refs:{ main:SHA }, commits:{ [SHA]:{ blobs:blobs(), committedAt:"2026-10-01T12:00:00.000Z" } } });
  const deployer = createDeployerService({ stateStore:createSingletonStateStore({ storageBroker:storage, namespace:"module.deployer" }),
    accountsService:accounts, providerGateResolver:gates, remoteOperationReader:remoteOps, clock:now });
  const repository = createDeployerRepositoryService({
    stateStore:createSingletonStateStore({ storageBroker:storage, namespace:"module.deployer.repository" }),
    ledgerStore:storage.namespace("module.deployer.repository.ledger"),
    repositoryProvider:provider, deployer, accounts, recoveryHold, clock:now });
  const refresherStore = createSingletonStateStore({ storageBroker:storage, namespace:"module.refresher" });
  const refresher = createRefresherService({ stateStore:refresherStore, accountsService:accounts, providerGateResolver:gates,
    remoteOperationReader:remoteOps, remoteOperationCanceller:createRemoteOperationCanceller({ remoteOps }),
    deployer, repository, repositoryProvider:provider, clock:now });

  const registry = createCoreServiceRegistry();
  let scheduler = null;
  let coordinator = null;
  const timers = createTimerService({ storageBroker:storage, auditJournal:audit, serviceRegistry:registry, clock:now,
    onChanged:async (change) => {
      // Same re-declaration rule as core-factory.js.
      if (scheduler && change.timerId === REFRESHER_BACKGROUND_TIMER_ID
          && (change.state?.value?.state === "FIRED" || change.state?.value?.state === "MISSED")) {
        try { await scheduler.declare(); } catch {}
      }
      if (coordinator) await coordinator.armNext();
    } });
  // The emulator's probe declares `unattended`; the shipped capability check reads it.
  scheduler = createRefresherBackgroundScheduler({ refresher, timers, recoveryHold, clock:now,
    canDispatch:createUnattendedRefreshCapability({ providerProbes:[adapter] }) });
  registry.register(scheduler.serviceName, scheduler.service, { ownerId:scheduler.ownerId, generation:scheduler.generation });
  coordinator = createPcmsAlarmCoordinator({ alarms:browserRef.alarms, timers, clock:now,
    declareSchedules:async () => { try { await scheduler.declare(); } catch {} } });

  async function append(key, entry) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await fixtureStore.get(key);
      try {
        await fixtureStore.compareAndSwap(key, { expectedRevision:current?.revision ?? 0, value:[...(current?.value ?? []), entry].slice(-50) });
        return;
      } catch {}
    }
  }

  // One-time seed: confirm three repository releases through the Deployer, then create one
  // automatic cohort (budget 2/day) that follows them. Never repeated on later wakes.
  async function seed() {
    if (await fixtureStore.get("seed")) return false;
    await repository.configure({ config:{ provider:"github", owner:"fixtures", repo:"generators", ref:"main", root:"", access:{ kind:"public" }, network:"default" }, expectedRevision:0 });
    const configured = await repository.read();
    await repository.linkFolder({ folder:"alice", accountId:ACCOUNT_ID, expectedRevision:configured.revision });
    await repository.startScan();
    for (let i = 0; i < 64; i += 1) { if ((await repository.scanStep({ batchSize:4 })).done) break; }
    for (const slug of SLUGS) {
      const listed = await deployer.listDeployments();
      const deployment = listed.deployments.find((item) => item.targetRef.id === slug);
      await repository.deployFromRepository({ deploymentId:deployment.deploymentId, expectedRevision:listed.revision });
    }
    const cohorts = await refresher.listCohorts();
    await refresher.createCohort({ cohortId:"daily", name:"Daily", accountId:ACCOUNT_ID, enabled:true,
      policy:{ mode:"AUTO_RECENT", dailyBudget:P040_FIXTURE_BUDGET, dayOffsetMinutes:0, activeHours:24, sleepDays:0, anchorAt:"2026-01-01T00:00:00.000Z" },
      members:SLUGS.map((generatorId) => ({ generatorId })) }, { expectedRevision:cohorts.revision });
    await fixtureStore.compareAndSwap("seed", { expectedRevision:0, value:{ seededAt:now() } });
    return true;
  }

  async function status() {
    const [views, deployments, timer, seedRow, starts, passes, ops, stored] = await Promise.all([
      refresher.listCohortViews(), deployer.listDeployments(), timers.get(REFRESHER_BACKGROUND_TIMER_ID), fixtureStore.get("seed"),
      fixtureStore.get("starts"), fixtureStore.get("passes"), remoteOps.list(), refresherStore.read()
    ]);
    const json = JSON.stringify(stored?.value ?? null);
    return {
      seededAt:seedRow?.value?.seededAt ?? null,
      starts:starts?.value ?? [],
      passes:passes?.value ?? [],
      cohort:views.cohorts[0] ?? null,
      confirmed:deployments.deployments.map((d) => ({ slug:d.targetRef.id, confirmed:d.confirmed.payloadHash !== null })),
      timer:timer ? { state:timer.value.state, dueAt:timer.value.dueAt, revision:timer.revision } : null,
      refreshOperations:ops.filter((row) => row.value.operationId.startsWith("refresh:")).map((row) => ({ operationId:row.value.operationId,
        state:row.value.state, intentFingerprint:row.value.intentFingerprint })),
      refresherStoresContent:SLUGS.some((slug) => json.includes("<h1>" + slug) || json.includes("// " + slug)),
      alarms:typeof browserRef.alarms.getAll === "function" ? (await browserRef.alarms.getAll()).map((a) => ({ name:a.name, scheduledTime:a.scheduledTime })) : []
    };
  }

  async function start(wake) {
    await append("starts", { at:now(), wake });
    await seed();
    const result = await coordinator.start({ wake });
    await recordPass(result);
    return result;
  }
  async function recordPass(result) {
    const fired = result?.due?.processed?.some((row) => row.value.timerId === REFRESHER_BACKGROUND_TIMER_ID && row.value.state === "FIRED");
    if (fired) await append("passes", { at:now(), lastPass:(await scheduler.status()).lastPass });
  }
  async function handleAlarm(name) {
    const result = await coordinator.handleAlarm(name, { wake:"WARM" });
    await recordPass(result);
    return result;
  }
  return Object.freeze({ start, handleAlarm, status, refresher, timers, scheduler, emulator });
}
