// Deterministic P040 wiring: real RemoteOps, ProviderGate, Deployer v2 and repository service
// (P036/P037 harnesses) over in-memory PCMS storage, the Perchance v2 emulator, and the P040
// Refresher following Deployer-confirmed releases read from a fixture repository.
import { createFixtureRepositoryProvider } from "../../../extension/pcms/providers/repository/fixture.js";
import { createDeployerRepositoryService } from "../../../pcms-modules/p015/repository-service.js";
import { createRefresherService } from "../../../pcms-modules/p017/refresher.js";
import { createSingletonStateStore } from "../../../extension/pcms/integration/adapters.js";
import { createRemoteOperationCanceller } from "../../../extension/pcms/integration/refresher-background.js";
import { setup } from "../p036/harness.mjs";

export const SHA1 = "1".repeat(40);
export const SHA2 = "2".repeat(40);
export const CONFIG = { provider:"github", owner:"fixtures", repo:"generators", ref:"main", root:"", access:{ kind:"public" }, network:"default" };

export function release({ slug, version = "1.0.0", code = "code of " + slug, html = "<main>" + slug + "</main>", folder = "alice", listing = "UNLISTED" }) {
  const base = folder + "/" + slug + "/";
  return {
    [base + "generator.json"]:JSON.stringify({ format:"pcms.generator/v1", slug, title:slug, release:version, listing, deploy:"manual" }),
    [base + "releases/" + version + "/code.perchance"]:code,
    [base + "releases/" + version + "/page.html"]:html
  };
}
export function commit(...releases) {
  return Object.assign({ "pcms-generators.json":'{"format":"pcms.generator-repository/v1"}' }, ...releases);
}

export function createP040Fixture({ commits = { [SHA1]:commit(release({ slug:"alpha" })) }, now = "2026-10-08T12:00:00.000Z" } = {}) {
  const ctx = setup();
  const provider = createFixtureRepositoryProvider({ refs:{ main:SHA1 }, commits:Object.fromEntries(
    Object.entries(commits).map(([sha, blobs]) => [sha, { blobs, committedAt:"2026-10-01T12:00:00.000Z" }])) });
  let n = 0;
  const repoClock = () => new Date(Date.UTC(2026, 9, 8, 11, 0, n++)).toISOString();
  const repository = createDeployerRepositoryService({
    stateStore:createSingletonStateStore({ storageBroker:ctx.storage, namespace:"module.deployer.repository" }),
    ledgerStore:ctx.storage.namespace("module.deployer.repository.ledger"),
    repositoryProvider:provider, deployer:ctx.deployer, accounts:ctx.accounts.service, recoveryHold:ctx.recoveryHold, clock:repoClock
  });
  let clockValue = now;
  const clock = () => clockValue;
  const refresherStore = createSingletonStateStore({ storageBroker:ctx.storage, namespace:"module.refresher" });
  const refresher = createRefresherService({
    stateStore:refresherStore,
    accountsService:ctx.accounts.service,
    providerGateResolver:ctx.gates.resolver,
    remoteOperationReader:ctx.remoteOps,
    remoteOperationCanceller:createRemoteOperationCanceller({ remoteOps:ctx.remoteOps }),
    deployer:ctx.deployer,
    repository,
    repositoryProvider:provider,
    clock
  });

  async function scan() {
    const start = await repository.startScan();
    if (start.alreadyRunning) throw new Error("scan already running");
    for (let i = 0; i < 128; i += 1) {
      const result = await repository.scanStep({ batchSize:4 });
      if (result.done) return result;
    }
    throw new Error("scan did not finish");
  }
  async function connect() {
    await repository.configure({ config:CONFIG, expectedRevision:0 });
    const row = await repository.read();
    await repository.linkFolder({ folder:"alice", accountId:"acct-1", expectedRevision:row.revision });
    return scan();
  }
  // Deploys the current repository release of `slug` until the Deployer confirms it.
  async function deploy(slug) {
    const listed = await ctx.deployer.listDeployments();
    const deployment = listed.deployments.find((item) => item.targetRef.id === slug);
    return repository.deployFromRepository({ deploymentId:deployment.deploymentId, expectedRevision:listed.revision });
  }
  async function storedRefresherJson() {
    const row = await refresherStore.read();
    return JSON.stringify(row?.value ?? null);
  }
  return Object.freeze({
    ctx, provider, repository, refresher, refresherStore, scan, connect, deploy, storedRefresherJson,
    setNow(value) { clockValue = new Date(value).toISOString(); },
    get now() { return clockValue; }
  });
}

export const AUTO_POLICY = Object.freeze({ mode:"AUTO_RECENT", dailyBudget:2, dayOffsetMinutes:0, activeHours:24, sleepDays:0, anchorAt:"2026-10-01T00:00:00.000Z" });
