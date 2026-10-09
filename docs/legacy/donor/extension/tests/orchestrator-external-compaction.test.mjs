import assert from "node:assert/strict";

const owner = {
  senderId: "trusted-extension",
  executionId: "execution-compacted",
  operationId: "operation-compacted",
  requestFingerprint: "fingerprint-compacted"
};
const storage = {
  automationJobs: {
    "external-job": {
      id: "external-job",
      workflowId: "external-execution-compacted",
      workflowName: "Large external execution",
      state: "completed",
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      externalOwner: owner,
      acknowledgedAt: new Date().toISOString(),
      tasks: [{ id: "large-diagnostic", state: "completed", privateDiagnostic: "x".repeat(1_100_000) }]
    }
  }
};

globalThis.browser = {
  storage: { local: {
    async get(key) { return typeof key === "string" ? { [key]: storage[key] } : { ...storage }; },
    async set(value) { Object.assign(storage, value); }
  } }
};

const mod = await import(`../lib/orchestrator.js?external-compaction=${Date.now()}`);
const compacted = await mod.getJobTrusted("external-job");
assert.equal(compacted.tasks, undefined, "oversized diagnostics are compacted");
assert.deepEqual(compacted.externalOwner, owner, "compaction preserves the complete external owner identity");
assert.ok(compacted.acknowledgedAt, "compaction preserves acknowledgement state");
assert.equal(await mod.getJob("external-job"), null, "compacted external jobs remain hidden from ordinary get APIs");
assert.deepEqual(await mod.listJobs(), [], "compacted external jobs remain hidden from ordinary history lists");
assert.deepEqual(await mod.getExternalExecutionResult(owner.senderId, owner.executionId), {
  executionId: owner.executionId,
  operationId: owner.operationId,
  state: "completed",
  acknowledged: true,
  tasks: [],
  truncated: false
}, "owner-scoped result queries still resolve the acknowledged execution");
assert.equal((await mod.findExternalExecutionByOperation(owner.senderId, owner.operationId, owner.requestFingerprint)).executionId,
  owner.executionId, "compaction preserves operation reconciliation provenance");

console.log("orchestrator external compaction tests passed");
