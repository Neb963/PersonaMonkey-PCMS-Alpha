import assert from "node:assert/strict";

let nextTabId = 1;
const tabs = new Map();
const updatedListeners = new Set();
const storage = {};
const events = [];
const tabValues = new Map();

globalThis.browser = {
  storage: { local: {
    async get(key) { return typeof key === "string" ? { [key]: storage[key] } : { ...storage }; },
    async set(value) { Object.assign(storage, value); }
  }},
  sessions: {
    async setTabValue(id, key, value) { tabValues.set(`${id}:${key}`, structuredClone(value)); },
    async getTabValue(id, key) { return tabValues.get(`${id}:${key}`); },
    async removeTabValue(id, key) { tabValues.delete(`${id}:${key}`); }
  },
  tabs: {
    onUpdated: { addListener(fn) { updatedListeners.add(fn); }, removeListener(fn) { updatedListeners.delete(fn); } },
    async create(options) {
      const tab = { id: nextTabId++, status: "complete", url: options.url, cookieStoreId: options.cookieStoreId };
      tabs.set(tab.id, tab);
      return { ...tab };
    },
    async get(id) { return { ...tabs.get(id) }; },
    async update(id, changes) {
      const tab = tabs.get(id);
      Object.assign(tab, changes, { status: "complete" });
      events.push(`navigate:${tab.cookieStoreId}:${changes.url}`);
      for (const listener of [...updatedListeners]) listener(id, { status: "complete" }, { ...tab });
      return { ...tab };
    },
    async remove(id) { tabs.delete(id); }
  },
  scripting: { async executeScript() { return [{ result: true }]; } }
};

const state = {
  global: { automation: { historyLimit: 100, maxTabsPerStep: 4, maxTabsTotal: 4, maxJobRuntimeMinutes: 2 } },
  profiles: {
    p1: { containerId: "p1", managed: true, name: "First" },
    p2: { containerId: "p2", managed: true, name: "Second" }
  },
  scripts: {},
  workflows: {
    sequence: {
      id: "sequence",
      name: "Sequential",
      enabled: true,
      steps: [
        { id: "one", profileId: "p1", urls: ["https://example.com/one"], concurrency: 1, scriptIds: [], completion: { mode: "load", value: "", timeoutMs: 5000 }, retries: 0, retryDelayMs: 1000, closeTabs: true, stopOnError: true },
        { id: "two", profileId: "p2", urls: ["https://example.com/two"], concurrency: 1, scriptIds: [], completion: { mode: "load", value: "", timeoutMs: 5000 }, retries: 0, retryDelayMs: 1000, closeTabs: true, stopOnError: true }
      ]
    }
  }
};

const mod = await import(`../lib/orchestrator.js?sequential=${Date.now()}`);
await mod.configureOrchestrator({
  getState: async () => state,
  ensureProfileReady: async (profileId) => {
    events.push(`prepare:${profileId}`);
    return { profile: state.profiles[profileId], route: null, mode: "direct" };
  }
});

await mod.runWorkflow("sequence");
let job;
for (let i = 0; i < 100; i++) {
  [job] = await mod.listJobs(1);
  if (["completed", "failed"].includes(job?.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}

assert.equal(job.state, "completed");
assert.deepEqual(events, [
  "prepare:p1",
  "navigate:p1:https://example.com/one",
  "prepare:p2",
  "navigate:p2:https://example.com/two"
]);
assert.equal(job.stepProgress.length, 2);
assert.equal(job.stepProgress[0].state, "completed");
assert.equal(job.stepProgress[1].state, "completed");
assert.equal(job.tasks[0].stepIndex, 0);
assert.equal(job.tasks[1].stepIndex, 1);

console.log("orchestrator sequential step test passed");
