// Shared deterministic wiring for P036 tests: real RemoteOps, ProviderGate, recovery hold,
// HumanTasks, provider handoff, Deployer and generator index over in-memory PCMS storage.
import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../../extension/pcms/remoteops/provider-gate.js";
import { createPerchanceProviderAdapter } from "../../../extension/pcms/providers/perchance/adapter.js";
import { createPerchanceEmulator } from "../../../extension/pcms/providers/perchance/emulator.js";
import { createPerchanceAssistedReleaseMethods, PERCHANCE_ASSISTED_CAPABILITIES } from "../../../extension/pcms/providers/perchance/assisted-driver.js";
import { createProviderHandoff } from "../../../extension/pcms/integration/provider-handoff.js";
import { createSingletonStateStore } from "../../../extension/pcms/integration/adapters.js";
import { createGeneratorIndexService } from "../../../extension/pcms/integration/generator-index.js";
import { createHumanTaskService } from "../../../extension/pcms/services/human-tasks.js";
import { createDeployerService } from "../../../pcms-modules/p015/deployer.js";
import { makeStorage } from "../p010-harness.mjs";
import { AUDIT_ERROR_CODES } from "../../../extension/pcms/audit/errors.js";
import { createPcmsAuditJournal } from "../../../extension/pcms/audit/journal.js";
import { createAuditEvent } from "../../../extension/pcms/audit/schema.js";
import { account, makeAccounts, makeGateResolver } from "../p015/harness.mjs";

export function jpegBase64(extra = 16) {
  const bytes = new Uint8Array(4 + extra);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let index = 4; index < bytes.length; index += 1) bytes[index] = index % 251;
  return Buffer.from(bytes).toString("base64");
}

// The real Audit Journal over a backend that writes the same rows as makeStorage.
function makeAudit(storage, clock) {
  const events = [];
  const backend = {
    async open() {}, close() {},
    async transitionAndAppend({ transition, draft, timestamp }) {
      const id = transition.namespace + "\0" + transition.key;
      const current = storage.shared.rows.get(id) || null;
      const revision = current?.revision || 0;
      if (revision !== transition.expectedRevision) {
        const error = new Error("conflict"); error.code = AUDIT_ERROR_CODES.CONFLICT; error.currentRevision = revision; throw error;
      }
      const event = createAuditEvent({ sequence:events.length + 1, timestamp, draft });
      const state = { key:transition.key, revision:revision + 1, updatedAt:timestamp, value:structuredClone(transition.value) };
      storage.shared.rows.set(id, structuredClone(state)); events.push(structuredClone(event));
      return { state:structuredClone(state), event:structuredClone(event) };
    }
  };
  const journal = createPcmsAuditJournal({ backend, clock });
  return Object.freeze({ journal, events });
}

export function setup({ mode = "emulator", storage = makeStorage() } = {}) {
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 9, 8, 10, 0, tick++)).toISOString();
  const remoteOps = createRemoteOps({ storageBroker:storage });
  const recoveryHold = createRecoveryHoldController({ storageBroker:storage, remoteOps });
  const audit = makeAudit(storage, clock);
  const humanTasks = createHumanTaskService({ storageBroker:storage, auditJournal:audit.journal, clock });
  const handoff = createProviderHandoff({ storageBroker:storage, humanTasks, clock });
  const emulator = createPerchanceEmulator({ contractVersion:2 });
  const opened = [];
  let driver = emulator.driver;
  if (mode === "assisted") {
    const release = createPerchanceAssistedReleaseMethods({
      operator:handoff,
      async openTarget({ operationId, generatorId, phase }) {
        opened.push({ operationId, generatorId, phase });
        return { targetRef:{ kind:"generator", id:generatorId } };
      }
    });
    driver = Object.freeze({
      async probe() {
        return { contractId:"pcms.perchance.driver", contractVersion:2, providerId:"perchance", operations:["generator.update"], capabilities:{ ...PERCHANCE_ASSISTED_CAPABILITIES } };
      },
      updateGenerator:emulator.driver.updateGenerator,
      reconcileGeneratorUpdate:emulator.driver.reconcileGeneratorUpdate,
      ...release
    });
  }
  const adapter = createPerchanceProviderAdapter({ driver });
  const gate = createProviderGate({ remoteOps, recoveryHold, providers:{ perchance:adapter.providerDescriptor } });
  const accounts = makeAccounts({ "acct-1":account("acct-1"), "acct-2":account("acct-2") });
  const accountsService = Object.freeze({
    getAccount:accounts.service.getAccount,
    async listAccounts() {
      const rows = [];
      for (const id of ["acct-1", "acct-2"]) { const row = await accounts.service.getAccount(id); if (row) rows.push({ ...row, displayName:id === "acct-1" ? "Alice" : "Bob" }); }
      return { revision:1, accounts:rows };
    }
  });
  const gates = makeGateResolver(gate);
  const stateStore = createSingletonStateStore({ storageBroker:storage, namespace:"module.deployer" });
  const deployer = createDeployerService({
    stateStore, accountsService, providerGateResolver:gates.resolver, remoteOperationReader:remoteOps, clock
  });
  const generators = createGeneratorIndexService({ deployer, accounts:accountsService, humanTasks, recoveryHold, clock });
  // Same order as core-factory answerHandoff: record durably, then reconcile from the answer.
  async function answer(taskId, outcome) {
    const answered = await handoff.answer(taskId, outcome);
    let operation = await remoteOps.get(answered.operationId);
    if (operation?.value?.state === "UNCERTAIN") operation = await gate.reconcile(answered.operationId);
    return { ...answered, operationState:operation?.value?.state ?? null };
  }
  return { storage, remoteOps, recoveryHold, humanTasks, handoff, emulator, adapter, gate, accounts, gates, deployer, generators, opened, answer, audit, stateStore };
}
