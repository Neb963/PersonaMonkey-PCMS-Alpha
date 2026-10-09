// P041 harness: the real P023 integrated Core (storage, RemoteOps, recovery hold, provider
// gate, accounts, backup/restore) with a mutable Persona directory and a controllable clock.
import { createPcmsModuleIntegration } from "../../../extension/pcms/integration/composition.js";
import { createAccountsService } from "../../../pcms-modules/p014/accounts.js";
import { createDeployerService } from "../../../pcms-modules/p015/deployer.js";
import { createExplorerService } from "../../../pcms-modules/p016/explorer.js";
import { createRefresherService } from "../../../pcms-modules/p017/refresher.js";
import { createStatisticsService } from "../../../pcms-modules/p018/statistics.js";
import { createProvisioningService } from "../../../pcms-modules/p019/provisioning.js";
import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";
import { createPcmsAuditJournal } from "../../../extension/pcms/audit/journal.js";
import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../../extension/pcms/remoteops/provider-gate.js";
import { createModulePackageRegistry } from "../../../extension/pcms/modules/registry.js";
import { createModuleRuntimeBroker } from "../../../extension/pcms/runtime/module-runtime.js";
import { makeAuditBackend, makeMemoryBackend, makeProvisioningSupport, UID_A, UID_B } from "../p023/harness.mjs";

export { UID_A, UID_B };

export function makeClock(start = Date.UTC(2026, 9, 8, 12, 0, 0)) {
  let now = start;
  const clock = () => new Date(now += 1000).toISOString();
  clock.advance = (ms) => { now += ms; };
  return clock;
}

export function makePersonaDirectory(uids = [UID_A, UID_B]) {
  const personas = new Map(uids.map((uid, index) => [uid, { personaUid: uid, cookieStoreId: "firefox-container-" + index }]));
  return {
    personas,
    broker: Object.freeze({
      async request(request) {
        const result = personas.get(request?.params?.personaUid) || null;
        if (!result) return Object.freeze({ ok: false, error: Object.freeze({ code: "PERSONA_NOT_FOUND" }) });
        return Object.freeze({ ok: true, result: Object.freeze({ ...result }) });
      }
    })
  };
}

export function composeCore({ reconcileOutcome = "APPLIED" } = {}) {
  const clock = makeClock();
  const backend = makeMemoryBackend();
  const storageBroker = createPcmsStorageBroker({ backend, clock });
  const auditJournal = createPcmsAuditJournal({ backend: makeAuditBackend(backend), clock });
  const remoteOps = createRemoteOps({ storageBroker, clock });
  const recoveryHold = createRecoveryHoldController({ storageBroker, remoteOps, clock });
  const outcome = { value: reconcileOutcome };
  const behavior = Object.freeze({
    async dispatch() { return Object.freeze({ status: "APPLIED" }); },
    async reconcile() { return Object.freeze({ status: outcome.value }); }
  });
  const providerGate = createProviderGate({
    remoteOps, recoveryHold,
    providers: Object.freeze({
      perchance: Object.freeze({ operations: Object.freeze({ "generator.update": behavior, "account.provision": behavior }) })
    })
  });
  const moduleRegistry = createModulePackageRegistry({ storageBroker, clock });
  const moduleRuntime = createModuleRuntimeBroker({ storageBroker, moduleRegistry, recoveryHold });
  const directory = makePersonaDirectory();
  const integration = createPcmsModuleIntegration({
    storageBroker, auditJournal, personaBroker: directory.broker, providerGate, remoteOps, recoveryHold,
    moduleRegistry, moduleRuntime,
    featureFactories: Object.freeze({
      accounts: createAccountsService, deployer: createDeployerService, explorer: createExplorerService,
      refresher: createRefresherService, statistics: createStatisticsService, provisioning: createProvisioningService
    }),
    provisioning: makeProvisioningSupport(),
    statisticsDefinitions: [{ metricId: "attention_opened", label: "Attention opened", eventType: "human-task.opened",
      aggregation: "COUNT", valuePath: null, subjectKind: "human-task" }],
    providerProbes: Object.freeze([Object.freeze({ async probeCompatibility() { return Object.freeze({ providerId: "perchance" }); } })]),
    clock
  });
  return { clock, backend, storageBroker, remoteOps, recoveryHold, providerGate, directory, outcome, integration };
}

export async function prepareOperation(remoteOps, { operationId, action = "generator.update", targetRef, uncertain = false }) {
  let row = await remoteOps.prepare({ operationId, providerId: "perchance", action, targetRef, intentFingerprint: "fp-" + operationId });
  if (uncertain) {
    row = await remoteOps.beginDispatch(operationId, { expectedRevision: row.revision });
    row = await remoteOps.markUncertain(operationId, { expectedRevision: row.revision });
  }
  return row;
}
