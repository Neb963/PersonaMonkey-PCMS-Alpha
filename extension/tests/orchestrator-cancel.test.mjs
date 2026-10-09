import assert from "node:assert/strict";

let nextTab = 300;
const tabs = new Map();
const storage = {};
const updated = new Set();
const removed = new Set();
const session = new Map();

function values(id) {
  let map = session.get(id);
  if (!map) session.set(id, map = new Map());
  return map;
}

globalThis.browser = {
  storage: { local: {
    async get(key) { return typeof key === "string" ? { [key]: storage[key] } : { ...storage }; },
    async set(obj) { Object.assign(storage, obj); }
  }},
  sessions: {
    async setTabValue(id, key, value) { values(id).set(key, structuredClone(value)); },
    async getTabValue(id, key) { return session.get(id)?.get(key); },
    async removeTabValue(id, key) { session.get(id)?.delete(key); }
  },
  tabs: {
    onUpdated: { addListener(fn) { updated.add(fn); }, removeListener(fn) { updated.delete(fn); } },
    onRemoved: { addListener(fn) { removed.add(fn); }, removeListener(fn) { removed.delete(fn); } },
    async query() { return [...tabs.values()].map((x) => ({ ...x })); },
    async create(opts) {
      const tab = { id: nextTab++, status: "complete", url: opts.url, cookieStoreId: opts.cookieStoreId };
      tabs.set(tab.id, tab);
      return { ...tab };
    },
    async get(id) { return { ...tabs.get(id) }; },
    async update(id, changes) {
      const tab = tabs.get(id);
      Object.assign(tab, changes, { status: "complete" });
      for (const fn of [...updated]) fn(id, { status: "complete" }, { ...tab });
      return { ...tab };
    },
    async remove(id) {
      tabs.delete(id);
      session.delete(id);
      for (const fn of [...removed]) fn(id, { isWindowClosing: false });
    }
  },
  scripting: { async executeScript() { return [{ result: true }]; } }
};

const mod = await import(`../lib/orchestrator.js?cancel=${Date.now()}`);
const profile = "firefox-container-1";
const state = {
  global: { automation: { historyLimit: 100, maxTabsPerStep: 2, maxTabsTotal: 2, maxJobRuntimeMinutes: 2 } },
  profiles: { [profile]: { managed: true, name: "P1" } },
  scripts: {},
  workflows: {
    cancel: {
      id: "cancel",
      name: "Cancel",
      enabled: true,
      steps: [{
        id: "s1",
        profileId: profile,
        urls: ["https://cancel.test/1"],
        concurrency: 1,
        scriptIds: [],
        completion: { mode: "delay", value: "5000", timeoutMs: 10000 },
        retries: 0,
        closeTabs: false,
        stopOnError: true
      }]
    }
  }
};
await mod.configureOrchestrator({ getState: async () => state, ensureProfileReady: async () => ({}) });
const started = await mod.runWorkflow("cancel");

for (let i = 0; i < 100 && tabs.size === 0; i++) await new Promise((r) => setTimeout(r, 5));
assert.equal(tabs.size, 1, "job should own an open tab before cancellation");
const [tab] = tabs.values();
assert.ok(mod.getAutomationTabPolicy(tab.id));

await mod.stopJob(started.id);
for (let i = 0; i < 100; i++) {
  const job = (await mod.listJobs(10)).find((x) => x.id === started.id);
  if (job && job.state === "stopped") break;
  await new Promise((r) => setTimeout(r, 5));
}
const stopped = (await mod.listJobs(10)).find((x) => x.id === started.id);
assert.equal(stopped.state, "stopped");
assert.equal(tabs.size, 0, "cancellation must close job-owned tabs even when closeTabs=false");
assert.equal(mod.getAutomationTabPolicy(tab.id), null);
assert.equal(await browser.sessions.getTabValue(tab.id, "personaAutomationOwner"), undefined);

console.log("orchestrator cancellation tests passed");
