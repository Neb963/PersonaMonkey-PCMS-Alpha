import assert from "node:assert/strict";
import { createPersonaManager } from "../lib/personas.js";

let state = {
  global: { autoReloadOnRouteChange: false },
  profiles: { p1: { containerId: "p1", name: "Persona", managed: true, owned: true, routeId: "__block__", scriptIds: [] } },
  routes: {}, scripts: {}, workflows: {}
};
const calls = { create: 0, update: 0, remove: 0, tabCreate: 0 };
const browserApi = {
  contextualIdentities: {
    async get(id) { return { cookieStoreId: id, name: "Persona", color: "blue", icon: "fingerprint" }; },
    async getSupportedColors() { return ["blue"]; },
    async getSupportedIcons() { return ["fingerprint"]; },
    async create(details) { calls.create += 1; return { cookieStoreId: "p2", ...details }; },
    async update(id, changes) { calls.update += 1; return { cookieStoreId: id, name: changes.name || "Persona", color: changes.color || "blue", icon: changes.icon || "fingerprint" }; },
    async remove() { calls.remove += 1; }
  },
  tabs: {
    async query() { return []; },
    async create() { calls.tabCreate += 1; return { id: 90 }; },
    async reload() {},
    async remove() {}
  }
};
const mutate = async (mutator, { expectedRevision } = {}) => {
  if (expectedRevision !== undefined && expectedRevision !== 3) {
    const error = new Error("State revision conflict");
    error.code = "STATE_CONFLICT";
    throw error;
  }
  const draft = structuredClone(state);
  const result = await mutator(draft);
  state = draft;
  return { state, result, revision: 4 };
};
const manager = createPersonaManager({ getState: async () => state, setState: async (next) => { state = next; return state; }, mutate, browserApi });

await assert.rejects(manager.create({ name: "New" }, { expectedRevision: 2 }), { code: "STATE_CONFLICT" });
await assert.rejects(manager.updateIdentity("p1", { name: "Changed" }, { expectedRevision: 2 }), { code: "STATE_CONFLICT" });
await assert.rejects(manager.destroy("p1", { expectedRevision: 2 }), { code: "STATE_CONFLICT" });
await assert.rejects(manager.open("p1", "https://example.test/", true, { expectedRevision: 2 }), { code: "STATE_CONFLICT" });
assert.deepEqual(calls, { create: 0, update: 0, remove: 0, tabCreate: 0 }, "conflicts must not produce browser side effects");

console.log("persona mutation conflict tests passed");
