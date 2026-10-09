import assert from "node:assert/strict";

const storage = {};
const tabs = new Map();
const sessions = new Map();
const updates = new Set();
const events = [];
let nextTab = 1;
let updateHook = null;

globalThis.browser = {
  storage: { local: {
    async get(key) { return typeof key === "string" ? { [key]: storage[key] } : { ...storage }; },
    async set(value) { Object.assign(storage, value); }
  } },
  sessions: {
    async setTabValue(id, key, value) { sessions.set(`${id}:${key}`, structuredClone(value)); },
    async getTabValue(id, key) { return sessions.get(`${id}:${key}`); },
    async removeTabValue(id, key) { sessions.delete(`${id}:${key}`); }
  },
  tabs: {
    onUpdated: { addListener(fn) { updates.add(fn); }, removeListener(fn) { updates.delete(fn); } },
    async create(options) { const tab = { id: nextTab++, status: "complete", url: options.url, cookieStoreId: options.cookieStoreId }; tabs.set(tab.id, tab); return { ...tab }; },
    async get(id) { if (!tabs.has(id)) throw new Error("missing tab"); return { ...tabs.get(id) }; },
    async update(id, changes) {
      const tab = tabs.get(id);
      Object.assign(tab, changes, { status: "complete" });
      if (updateHook) await updateHook(id, { ...tab }, changes);
      if (changes.url) for (const listener of [...updates]) listener(id, { status: "complete" }, { ...tab });
      return { ...tab };
    },
    async remove(id) { tabs.delete(id); }
  },
  scripting: { async executeScript() { return [{ result: true }]; } }
};

const mod = await import(`../lib/orchestrator.js?external=${Date.now()}`);
const profileId = "firefox-container-1";
const state = {
  global: { automation: { historyLimit: 100, maxTabsPerStep: 2, maxTabsTotal: 2, maxJobRuntimeMinutes: 2 } },
  profiles: { [profileId]: { managed: true, name: "P1" } },
  scripts: {
    artifactScript: { enabled: true, profileIds: [profileId], grants: ["Persona.signal"], externalArtifact: { artifactId: "pkg/component@1" } }
  },
  workflows: {}
};
await mod.configureOrchestrator({
  getState: async () => state,
  ensureProfileReady: async () => ({}),
  onJobEvent: (event) => events.push(event)
});

const plan = {
  id: "caller-selected-id",
  name: "External ephemeral plan",
  enabled: true,
  externalOwner: { senderId: "forged" },
  steps: [{
    id: "step-1", profileId, urls: ["https://example.com/"], concurrency: 1,
    scriptIds: ["artifactScript"], completion: { mode: "delay", value: "5000", timeoutMs: 10000 },
    retries: 0, retryDelayMs: 0, closeTabs: false, stopOnError: true
  }]
};

// Saved/local/API workflows all use runWorkflow -> admitAndRun without the
// trusted external owner marker, so they must not execute external artifacts.
state.workflows.ordinary = {
  id: "ordinary", name: "Ordinary workflow", enabled: true,
  steps: structuredClone(plan.steps)
};
await assert.rejects(
  mod.runWorkflow("ordinary"),
  (error) => error.code === "EXTERNAL_ARTIFACT_REQUIRES_EXTERNAL_EXECUTION"
);
assert.equal(Object.keys(storage.automationJobs || {}).length, 0,
  "ordinary workflow rejection happens before a job or tab is admitted");
delete state.workflows.ordinary;

const maxOperationId = "o".repeat(256);
const started = await mod.runExternalExecution(plan, { senderId: "trusted-extension", executionId: "exec-1", operationId: maxOperationId, requestFingerprint: "request-hash-1" });
assert.equal(state.workflows["external-exec-1"], undefined, "ephemeral plans must not be inserted in state.workflows");
assert.equal(storage.automationJobs[started.id].externalOwner.senderId, "trusted-extension", "ownership comes from the trusted internal argument");
assert.equal(storage.automationJobs[started.id].externalOwner.executionId, "exec-1");
assert.equal(storage.automationJobs[started.id].externalOwner.requestFingerprint, "request-hash-1");
assert.equal(storage.automationJobs[started.id].workflowId, "external-exec-1", "caller plan ID cannot choose the external job identity");

for (let i = 0; i < 100 && !storage.automationJobs[started.id].tasks.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
const taskId = storage.automationJobs[started.id].tasks[0].id;
assert.ok(taskId);
const tabId = storage.automationJobs[started.id].tasks[0].tabId;
const context = await mod.getExternalExecutionContext(tabId, "artifactScript");
assert.deepEqual(context, {
  senderId: "trusted-extension", executionId: "exec-1", taskId,
  stepId: "step-1", artifactId: "pkg/component@1"
});
assert.equal("tabId" in context, false, "external context must not expose raw browser tab IDs");
assert.equal(await mod.getExternalExecutionContext(tabId, "not-allowed"), null, "a script outside the active step allowlist has no context");
assert.deepEqual(await mod.listJobs(100), [], "ordinary workflow list hides external executions");
assert.equal(await mod.getJob(started.id), null, "ordinary workflow get hides external executions");
await assert.rejects(mod.stopJob(started.id), /Job not found/, "ordinary workflow controls cannot stop external executions");
assert.equal(events.length, 0, "external progress does not enter the ordinary workflow event channel");
assert.equal(await mod.getExternalExecution("other-extension", "exec-1"), null, "another sender cannot query this execution");
const status = await mod.getExternalExecution("trusted-extension", "exec-1");
assert.equal(status.id, started.id);
assert.equal(status.executionId, "exec-1");
assert.equal(status.operationId, maxOperationId);
assert.equal(status.stepProgress[0].stepId, "step-1", "owner-scoped external status maps the workflow step ID");
assert.equal("id" in status.stepProgress[0], false, "external status exposes the step ID only as stepId");
assert.equal("externalOwner" in status, false, "owner metadata and fingerprint stay out of status views");
assert.equal(JSON.stringify(status).includes("request-hash-1"), false, "request fingerprints stay out of status views");
assert.equal(JSON.stringify(status).includes("https://example.com/"), false, "URLs stay out of status views");
assert.equal(JSON.stringify(status).includes('"result"'), false, "arbitrary result bodies stay out of status views");
await assert.rejects(mod.acknowledgeExternalExecution("trusted-extension", "exec-1"), (error) => error.code === "EXECUTION_NOT_TERMINAL" && error.status === 409, "active executions cannot be acknowledged");
assert.equal((await mod.findExternalExecutionByOperation("trusted-extension", maxOperationId, "request-hash-1")).executionId, "exec-1");
assert.equal(await mod.findExternalExecutionByOperation("other-extension", maxOperationId, "request-hash-1"), null);
await assert.rejects(mod.findExternalExecutionByOperation("trusted-extension", maxOperationId, "different-hash"), (error) => error.code === "OPERATION_CONFLICT" && error.status === 409);
await assert.rejects(mod.runExternalExecution(plan, { senderId: "trusted-extension", executionId: "exec-1", operationId: maxOperationId, requestFingerprint: "different-hash" }), (error) => error.code === "OPERATION_CONFLICT");

let focused = false;
updateHook = async (id, _tab, changes) => {
  if (changes.active) focused = id;
  if (changes.url?.endsWith("/result")) {
    assert.equal(mod.handleAutomationSignal({ tabId: id, scriptId: "artifactScript", status: "complete", result: { answer: 42 } }), true);
  }
  if (changes.url?.endsWith("/large-result")) {
    assert.equal(mod.handleAutomationSignal({ tabId: id, scriptId: "artifactScript", status: "complete", result: "x".repeat(65320) }), true);
  }
};
assert.deepEqual(await mod.focusExternalExecution("trusted-extension", "exec-1", taskId), { executionId: "exec-1", focused: true });
assert.equal(focused, storage.automationJobs[started.id].tasks[0].tabId, "focus is restricted to the active owned task tab");
await assert.rejects(mod.focusExternalExecution("other-extension", "exec-1"), /Execution not found/);

await mod.clearFinishedJobs();
assert.ok(storage.automationJobs[started.id], "ordinary history clearing preserves external execution records");
const stopped = await mod.stopExternalExecution("trusted-extension", "exec-1");
assert.ok(["stopping", "stopped"].includes(stopped.state));
for (let i = 0; i < 200; i++) {
  const job = await mod.getExternalExecution("trusted-extension", "exec-1");
  if (["stopped", "failed"].includes(job.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const acknowledged = await mod.acknowledgeExternalExecution("trusted-extension", "exec-1");
assert.equal(acknowledged.acknowledged, true);
assert.equal("acknowledgedAt" in acknowledged, false, "status uses a safe acknowledgement flag");
const afterAck = await mod.getExternalExecutionResult("trusted-extension", "exec-1");
assert.deepEqual(afterAck, { executionId: "exec-1", operationId: maxOperationId, state: "stopped", acknowledged: true, tasks: [], truncated: false });
assert.equal(await mod.getExternalExecutionResult("other-extension", "exec-1"), null);

const resultPlan = structuredClone(plan);
resultPlan.steps[0].urls = ["https://example.com/result"];
resultPlan.steps[0].completion = { mode: "signal", timeoutMs: 5000 };
const resultStart = await mod.runExternalExecution(resultPlan, { senderId: "trusted-extension", executionId: "exec-result", operationId: "op-result", requestFingerprint: "result-hash" });
for (let i = 0; i < 200; i++) {
  const job = await mod.getExternalExecution("trusted-extension", "exec-result");
  if (["completed", "failed"].includes(job.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const details = await mod.getExternalExecutionResult("trusted-extension", "exec-result");
assert.equal(details.executionId, "exec-result");
assert.equal(details.tasks[0].result.artifactScript.answer, 42, "owner result API returns the bounded userscript result body");
assert.equal(JSON.stringify(details).includes("https://example.com/result"), false, "result projection does not include task URLs");
const importedHistory = await mod.replaceJobsTrusted([
  { id: "ordinary-import", state: "completed", createdAt: new Date().toISOString(), tasks: [] },
  { id: "forged-external", state: "completed", createdAt: new Date().toISOString(),
    externalOwner: { senderId: "trusted-extension", executionId: "forged-execution" }, tasks: [] },
  { id: resultStart.id, state: "completed", createdAt: new Date().toISOString(), tasks: [] }
]);
assert.deepEqual(importedHistory.map((job) => job.id), ["ordinary-import"],
  "history replacement returns only ordinary jobs and preserves private IDs against imported collisions");
assert.equal(storage.automationJobs["forged-external"], undefined, "history imports cannot forge external ownership");
assert.equal(await mod.getExternalExecution("trusted-extension", "forged-execution"), null);
assert.deepEqual(await mod.getExternalExecutionResult("trusted-extension", "exec-result"), details,
  "ordinary history replacement preserves terminal external results awaiting acknowledgement");
assert.equal((await mod.findExternalExecutionByOperation("trusted-extension", "op-result", "result-hash")).executionId, "exec-result",
  "history replacement preserves external restart reconciliation provenance");
const resultAck = await mod.acknowledgeExternalExecution("trusted-extension", "exec-result");
assert.equal(resultAck.acknowledged, true);
assert.deepEqual(await mod.getExternalExecutionResult("trusted-extension", "exec-result"), { executionId: "exec-result", operationId: "op-result", state: "completed", acknowledged: true, tasks: [], truncated: false });

const largeResultPlan = structuredClone(resultPlan);
largeResultPlan.steps[0].urls = ["https://example.com/large-result"];
await mod.runExternalExecution(largeResultPlan, { senderId: "trusted-extension", executionId: "exec-large", operationId: "op-large", requestFingerprint: "large-hash" });
for (let i = 0; i < 200; i++) {
  const job = await mod.getExternalExecution("trusted-extension", "exec-large");
  if (["completed", "failed"].includes(job.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const largeDetails = await mod.getExternalExecutionResult("trusted-extension", "exec-large");
assert.equal(largeDetails.tasks[0].result, undefined, "a body that would exceed the total result ceiling is omitted");
assert.equal(largeDetails.tasks[0].resultOmitted, true);
assert.equal(largeDetails.truncated, true);
assert.ok(new TextEncoder().encode(JSON.stringify(largeDetails)).byteLength <= 64 * 1024, "entire owner result response respects the advertised 64 KiB maximum");

const multiStepPlan = structuredClone(resultPlan);
multiStepPlan.steps.push({ ...structuredClone(plan.steps[0]), id: "step-2", urls: ["https://example.com/focus-active"] });
const multiStepStart = await mod.runExternalExecution(multiStepPlan, {
  senderId: "trusted-extension", executionId: "exec-multi-focus", operationId: "op-multi-focus", requestFingerprint: "multi-focus-hash"
});
let multiTasks;
for (let i = 0; i < 200; i++) {
  multiTasks = storage.automationJobs[multiStepStart.id].tasks;
  if (multiTasks[1]?.state === "waiting") break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(multiTasks[0].state, "completed");
assert.equal(multiTasks[1].state, "waiting");
await mod.focusExternalExecution("trusted-extension", "exec-multi-focus");
assert.equal(focused, multiTasks[1].tabId, "implicit focus skips completed tasks and selects the live owned tab");
await assert.rejects(mod.focusExternalExecution("trusted-extension", "exec-multi-focus", multiTasks[0].id), /no active owned tab/);
let releaseFocus;
let focusEntered;
const focusGate = new Promise((resolve) => { releaseFocus = resolve; });
const focusStarted = new Promise((resolve) => { focusEntered = resolve; });
updateHook = async (_id, _tab, changes) => { if (changes.active) { focusEntered(); await focusGate; } };
const racingFocus = mod.focusExternalExecution("trusted-extension", "exec-multi-focus");
await focusStarted;
await mod.stopExternalExecution("trusted-extension", "exec-multi-focus");
releaseFocus();
await assert.rejects(racingFocus, /no active owned tab/, "a focus request racing cancellation cannot report success after ownership is released");
await assert.rejects(mod.focusExternalExecution("trusted-extension", "exec-multi-focus"), /no active owned tab/,
  "focus fails safely when no active owned tab remains");
assert.equal(events.length, 0, "external jobs stay off the ordinary workflow event channel through completion");

const providerFailure = { code: "AUTH_REQUIRED", retryable: false, details: { challenge: "provider-private-challenge", attempts: 2, alternatives: ["login", null] } };
assert.deepEqual(mod.normalizeStructuredAutomationFailure(providerFailure), providerFailure);
const cyclicFailure = { code: "cycle" };
cyclicFailure.details = cyclicFailure;
let deepFailure = {};
for (let i = 0; i < 8; i++) deepFailure = { details: deepFailure };
const getterFailure = Object.defineProperty({}, "code", { enumerable: true, get() { throw new Error("getter must never execute"); } });
const malformedFailures = [
  new Error("raw provider error"), new Date(), { value: undefined }, { value: Infinity }, { value: 1n },
  { details: new Map() }, { code: "x".repeat(4097) }, deepFailure, cyclicFailure, getterFailure,
  JSON.parse('{"details":{"__proto__":{"secret":"bad"}}}'), { details: { constructor: "bad" } },
  { details: { prototype: "bad" } }, { details: Array.from({ length: 512 }, () => null) },
  { details: Array.from({ length: 8 }, () => "x".repeat(4096)) }
];
for (const malformed of malformedFailures) assert.throws(() => mod.normalizeStructuredAutomationFailure(malformed), /Invalid structured userscript failure/);

async function runFailureCase(error, label, early = true) {
  const failurePlan = structuredClone(resultPlan);
  failurePlan.steps[0].urls = [`https://example.com/failure-${label}`];
  let failureTab;
  updateHook = async (tabId, _tab, changes) => {
    if (!changes.url?.includes(`/failure-${label}`)) return;
    failureTab = tabId;
    if (early) assert.equal(mod.handleAutomationSignal({ tabId, scriptId: "artifactScript", status: "failed", error }), true);
  };
  const started = await mod.runExternalExecution(failurePlan, {
    senderId: "trusted-extension", executionId: `failure-${label}`, operationId: `failure-op-${label}`, requestFingerprint: `failure-hash-${label}`
  });
  if (!early) {
    for (let i = 0; i < 200 && storage.automationJobs[started.id].tasks[0]?.state !== "waiting"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(mod.handleAutomationSignal({ tabId: failureTab, scriptId: "artifactScript", status: "failed", error }), true);
  }
  for (let i = 0; i < 200; i++) {
    if ((await mod.getExternalExecution("trusted-extension", `failure-${label}`)).state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const status = await mod.getExternalExecution("trusted-extension", `failure-${label}`);
  assert.equal(status.state, "failed");
  assert.equal(status.error, "Workflow failed");
  assert.equal(status.tasks[0].error, "Task failed");
  assert.equal(JSON.stringify(status).includes("provider-private-challenge"), false, "safe status hides structured provider content");
  assert.equal(await mod.getJob(started.id), null, "ordinary job lookup hides external failures");
  assert.equal(await mod.getExternalExecutionResult("other-extension", `failure-${label}`), null, "provider failures are owner-only");
  return { started, details: await mod.getExternalExecutionResult("trusted-extension", `failure-${label}`) };
}
const validFailure = await runFailureCase(providerFailure, "valid");
assert.deepEqual(validFailure.details.tasks[0].failure, providerFailure, "early structured failures survive the completion-signal handoff");
assert.equal(storage.automationJobs[validFailure.started.id].error, "Userscript failed", "provider content does not become the generic saved error");
const lateFailure = await runFailureCase(providerFailure, "late", false);
assert.deepEqual(lateFailure.details.tasks[0].failure, providerFailure, "live waiter failures retain bounded structured content");
const legacyFailure = await runFailureCase("legacy private error", "legacy");
assert.equal(legacyFailure.details.tasks[0].failure, undefined, "legacy string failures remain supported");
for (const [index, malformed] of malformedFailures.entries()) {
  const invalidFailure = await runFailureCase(malformed, `invalid-${index}`);
  assert.equal(invalidFailure.details.tasks[0].failure, undefined, "invalid structured failure is rejected rather than retained");
  assert.equal(storage.automationJobs[invalidFailure.started.id].error, "Invalid structured userscript failure");
}
await mod.acknowledgeExternalExecution("trusted-extension", "failure-valid");
assert.equal(storage.automationJobs[validFailure.started.id].tasks[0].structuredFailure, undefined, "acknowledgement erases structured failure details");
assert.deepEqual((await mod.getExternalExecutionResult("trusted-extension", "failure-valid")).tasks, []);
assert.equal(events.length, 0, "structured provider failures never enter ordinary workflow events");

// Reinitializing the orchestrator against the same durable storage recovers
// terminal owner-only results until the owner acknowledges them.
const restartPlan = structuredClone(resultPlan);
restartPlan.steps[0].urls = ["https://example.com/restart-result"];
updateHook = async (tabId, _tab, changes) => {
  if (changes.url?.endsWith("/restart-result")) {
    assert.equal(mod.handleAutomationSignal({ tabId, scriptId: "artifactScript", status: "complete", result: { persisted: true } }), true);
  }
};
await mod.runExternalExecution(restartPlan, {
  senderId: "trusted-extension", executionId: "exec-restart", operationId: "op-restart", requestFingerprint: "restart-hash"
});
for (let i = 0; i < 200; i++) {
  if (["completed", "failed"].includes(storage.automationJobs["external-exec-restart"]?.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const restartedMod = await import(`../lib/orchestrator.js?external-restart=${Date.now()}`);
await restartedMod.configureOrchestrator({ getState: async () => state, ensureProfileReady: async () => ({}) });
const recoveredResult = await restartedMod.getExternalExecutionResult("trusted-extension", "exec-restart");
assert.equal(recoveredResult.state, "completed");
assert.deepEqual(recoveredResult.tasks[0].result.artifactScript, { persisted: true },
  "unacknowledged result bodies survive orchestrator reinitialization");
await restartedMod.acknowledgeExternalExecution("trusted-extension", "exec-restart");
const acknowledgedRestartedMod = await import(`../lib/orchestrator.js?external-restart-ack=${Date.now()}`);
await acknowledgedRestartedMod.configureOrchestrator({ getState: async () => state, ensureProfileReady: async () => ({}) });
assert.deepEqual(await acknowledgedRestartedMod.getExternalExecutionResult("trusted-extension", "exec-restart"), {
  executionId: "exec-restart", operationId: "op-restart", state: "completed", acknowledged: true, tasks: [], truncated: false
}, "acknowledgement remains durable across reinitialization");
console.log("orchestrator external execution tests passed");
