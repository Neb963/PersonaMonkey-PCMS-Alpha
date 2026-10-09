import assert from "node:assert/strict";

const storage = {};
const tabs = new Map();
let stateRead = null;
let pendingWrite = null;

globalThis.browser = {
  storage: { local: {
    async get(key) { return typeof key === "string" ? { [key]: storage[key] } : { ...storage }; },
    async set(value) {
      const pendingJob = Object.values(value.automationJobs || {}).find((job) => job.workflowId === "external-expiry-write");
      if (pendingJob && pendingWrite) {
        const gate = pendingWrite;
        pendingWrite = null;
        gate.started();
        await gate.promise;
      }
      Object.assign(storage, value);
    }
  } },
  sessions: {
    async setTabValue() {}, async getTabValue() {}, async removeTabValue() {}
  },
  tabs: {
    onUpdated: { addListener() {}, removeListener() {} },
    async create(options) {
      const tab = { id: tabs.size + 1, status: "complete", url: options.url };
      tabs.set(tab.id, tab);
      return { ...tab };
    },
    async get(id) { if (!tabs.has(id)) throw new Error("missing tab"); return { ...tabs.get(id) }; },
    async update(id, changes) { Object.assign(tabs.get(id), changes); return { ...tabs.get(id) }; },
    async remove(id) { tabs.delete(id); }
  },
  scripting: { async executeScript() { return [{ result: true }]; } }
};

const profileId = "firefox-container-1";
const state = {
  global: { automation: { historyLimit: 100, maxTabsPerStep: 1, maxTabsTotal: 1, maxJobRuntimeMinutes: 2 } },
  profiles: { [profileId]: { managed: true, name: "P1" } },
  scripts: {}, workflows: {}
};
const mod = await import(`../lib/orchestrator.js?external-admission=${Date.now()}`);
await mod.configureOrchestrator({
  getState: async () => stateRead ? stateRead() : state,
  ensureProfileReady: async () => ({})
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function plan(executionId) {
  return {
    name: "Lease guarded external plan", enabled: true,
    steps: [{
      id: "step-1", profileId, urls: ["https://example.com/"], concurrency: 1,
      scriptIds: [], completion: { mode: "delay", value: "5000", timeoutMs: 10000 },
      retries: 0, retryDelayMs: 0, closeTabs: true, stopOnError: true
    }]
  };
}

function leaseGuard(deadline) {
  return () => {
    if (Date.now() >= deadline) {
      const error = new Error("Persona control lease expired");
      error.code = "PERSONA_CONTROL_LEASE_LOST";
      throw error;
    }
  };
}

const realDateNow = Date.now;
let now = 1000;
Date.now = () => now;
try {
  // The second state read is inside admitAndRun. Expiry during that awaited
  // validation must be observed before the job enters memory or storage.
  const validationEntered = deferred();
  const validationRelease = deferred();
  let reads = 0;
  stateRead = async () => {
    if (++reads === 2) {
      validationEntered.resolve();
      await validationRelease.promise;
    }
    return state;
  };
  const validationDeadline = now + 100;
  const validationRun = mod.runExternalExecution(plan("expiry-validation"), {
    senderId: "test-extension", executionId: "expiry-validation"
  }, leaseGuard(validationDeadline));
  await validationEntered.promise;
  now = validationDeadline;
  validationRelease.resolve();
  await assert.rejects(validationRun, (error) => error.code === "PERSONA_CONTROL_LEASE_LOST");
  assert.equal(Object.values(storage.automationJobs || {}).some((job) => job.workflowId === "external-expiry-validation"), false);
  assert.equal(tabs.size, 0, "expired admission never starts a browser task");

  // If the queued job write itself spans expiry, the post-persistence guard
  // must remove the durable queue record and still avoid starting a runner.
  stateRead = async () => state;
  const writeStarted = deferred();
  const writeRelease = deferred();
  pendingWrite = { started: () => writeStarted.resolve(), promise: writeRelease.promise };
  const writeDeadline = now + 100;
  const writeRun = mod.runExternalExecution(plan("expiry-write"), {
    senderId: "test-extension", executionId: "expiry-write"
  }, leaseGuard(writeDeadline));
  await writeStarted.promise;
  now = writeDeadline;
  writeRelease.resolve();
  await assert.rejects(writeRun, (error) => error.code === "PERSONA_CONTROL_LEASE_LOST");
  assert.equal(Object.values(storage.automationJobs || {}).some((job) => job.workflowId === "external-expiry-write"), false,
    "expired admission is removed from persisted history");
  assert.equal(tabs.size, 0, "runner does not start after the lease expires during persistence");
} finally {
  stateRead = null;
  Date.now = realDateNow;
}
