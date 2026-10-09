import assert from "node:assert/strict";

const storage = {};
const tabs = new Map();
const sessions = new Map();
const updates = new Set();
const removed = new Set();
let nextTab = 1;
let createHook = null;
let updateHook = null;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function signal() {
  const gate = deferred();
  let enter;
  const entered = new Promise((r) => { enter = r; });
  return { gate, entered, enter };
}

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
    onRemoved: { addListener(fn) { removed.add(fn); }, removeListener(fn) { removed.delete(fn); } },
    async query() { return [...tabs.values()].map((tab) => ({ ...tab })); },
    async create(options) {
      const tab = { id: nextTab++, status: "complete", url: options.url, cookieStoreId: options.cookieStoreId };
      tabs.set(tab.id, tab);
      if (createHook) await createHook(tab.id);
      return { ...tab };
    },
    async get(id) { if (!tabs.has(id)) throw new Error("missing tab"); return { ...tabs.get(id) }; },
    async update(id, changes) {
      const tab = tabs.get(id);
      if (!tab) throw new Error("missing tab");
      Object.assign(tab, changes, { status: "complete" });
      if (updateHook) await updateHook(id);
      for (const listener of [...updates]) listener(id, { status: "complete" }, { ...tab });
      return { ...tab };
    },
    async remove(id) {
      tabs.delete(id);
      sessions.delete(`${id}:personaAutomationOwner`);
      for (const listener of [...removed]) listener(id, { isWindowClosing: false });
    }
  },
  scripting: { async executeScript() { return [{ result: true }]; } }
};

const profileId = "firefox-container-1";
const workflow = (id) => ({
  id, name: id, enabled: true,
  steps: [{ id: "step-1", profileId, urls: [`https://${id}.test/`], concurrency: 1,
    scriptIds: [], completion: { mode: "load", timeoutMs: 5000 }, retries: 0,
    closeTabs: false, stopOnError: true }]
});
const state = {
  global: { automation: { historyLimit: 100, maxTabsPerStep: 2, maxTabsTotal: 2, maxJobRuntimeMinutes: 2 } },
  profiles: { [profileId]: { managed: true, name: "P1" } }, scripts: {},
  workflows: Object.fromEntries(["cancel-create", "cancel-update", "cancel-readiness"].map((id) => [id, workflow(id)]))
};
const mod = await import(`../lib/orchestrator.js?cancel-races=${Date.now()}`);
await mod.configureOrchestrator({ getState: async () => state, ensureProfileReady: async () => ({}) });

async function waitTerminal(id) {
  for (let i = 0; i < 200; i++) {
    const job = await mod.getJob(id);
    if (["stopped", "failed", "completed"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${id} did not reach a terminal state`);
}

const create = signal();
createHook = async () => { create.enter(); await create.gate.promise; };
const creating = await mod.runWorkflow("cancel-create");
await create.entered;
await mod.stopJob(creating.id);
create.gate.resolve();
const createStopped = await waitTerminal(creating.id);
assert.equal(createStopped.state, "stopped", "cancellation during tabs.create cannot be overwritten");
assert.equal(createStopped.tasks[0].state, "stopped");
assert.equal(tabs.size, 0, "a tab returned after cancellation is still removed");
createHook = null;

const update = signal();
updateHook = async () => { update.enter(); await update.gate.promise; };
const updating = await mod.runWorkflow("cancel-update");
await update.entered;
await mod.stopJob(updating.id);
update.gate.resolve();
const updateStopped = await waitTerminal(updating.id);
assert.equal(updateStopped.state, "stopped", "cancellation during tabs.update cannot mark the task complete");
assert.equal(updateStopped.tasks[0].state, "stopped");
assert.equal(tabs.size, 0, "a tab updated after cancellation is still removed");
updateHook = null;

const readiness = signal();
const readinessMod = await import(`../lib/orchestrator.js?cancel-readiness-race=${Date.now()}`);
await readinessMod.configureOrchestrator({
  getState: async () => state,
  ensureProfileReady: async () => { readiness.enter(); await readiness.gate.promise; return {}; }
});
const preparing = await readinessMod.runWorkflow("cancel-readiness");
await readiness.entered;
await readinessMod.stopJob(preparing.id);
readiness.gate.resolve();
for (let i = 0; i < 200; i++) {
  const job = await readinessMod.getJob(preparing.id);
  if (["stopped", "failed", "completed"].includes(job.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const readinessStopped = await readinessMod.getJob(preparing.id);
assert.equal(readinessStopped.state, "stopped", "cancellation during final profile readiness cannot be overwritten by completion");
assert.equal(readinessStopped.stepProgress[0].state, "stopped");
assert.equal(readinessStopped.tasks.length, 0);

console.log("orchestrator cancellation race tests passed");
