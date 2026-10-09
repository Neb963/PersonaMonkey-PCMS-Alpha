import assert from "node:assert/strict";
import { createStateManager } from "../lib/state-manager.js";
import { createPersonaManager } from "../lib/personas.js";

function baseState() {
  return {
    global: { autoReloadOnRouteChange: false },
    profiles: {
      p1: {
        containerId: "p1", name: "Persona", description: "original", managed: true,
        owned: true, routeId: "__block__", scriptIds: ["s1"]
      }
    },
    routes: {},
    scripts: { s1: { id: "s1", name: "Script", profileIds: ["p1"] } },
    workflows: {
      w1: { id: "w1", name: "Workflow", steps: [{ id: "step-1", profileId: "p1", urls: [], scriptIds: ["s1"] }] }
    }
  };
}

async function setup(overrides = {}) {
  const stateManager = createStateManager({
    load: async () => baseState(),
    save: async (state) => structuredClone(state)
  });
  await stateManager.initialize();
  let personaManager;
  let removedEventPromise = null;
  let updatedEventPromise = null;
  let identityName = "Persona";
  const browserApi = {
    contextualIdentities: {
      async query() { return [{ cookieStoreId: "p1", name: "Persona", color: "blue", icon: "fingerprint" }]; },
      async get(id) { return { cookieStoreId: id, name: identityName, color: "blue", icon: "fingerprint" }; },
      async getSupportedColors() { return ["blue"]; },
      async getSupportedIcons() { return ["fingerprint"]; },
      async create(details) { return { cookieStoreId: "p2", ...details }; },
      async update(id, changes) {
        identityName = changes.name || identityName;
        const container = { cookieStoreId: id, name: identityName, color: changes.color || "blue", icon: changes.icon || "fingerprint" };
        updatedEventPromise = personaManager.handleUpdated({ contextualIdentity: container });
        return container;
      },
      async remove(id) {
        removedEventPromise = personaManager.handleRemoved({ contextualIdentity: { cookieStoreId: id } });
      },
      ...overrides.contextualIdentities
    },
    tabs: {
      async query() { return []; }, async create() { return {}; }, async reload() {}, async remove() {},
      ...overrides.tabs
    },
    storage: {
      local: {
        async get() { return { automationJobs: [] }; }, async set() {},
        ...overrides.storageLocal
      }
    }
  };
  personaManager = createPersonaManager({
    getState: stateManager.getState,
    setState: stateManager.setState,
    mutate: stateManager.mutate,
    browserApi
  });
  return {
    stateManager,
    personaManager,
    browserApi,
    removedEvent: () => removedEventPromise,
    updatedEvent: () => updatedEventPromise,
    setContainerName(name) { identityName = name; }
  };
}

// Firefox onRemoved may fire from inside destroy(). It must queue behind the
// destructive mutation and must never recreate an old unmanaged profile.
{
  const ctx = await setup();
  await ctx.personaManager.destroy("p1");
  await ctx.removedEvent();
  const state = await ctx.stateManager.getState();
  assert.equal(state.profiles.p1, undefined, "destroyed persona must not be resurrected by onRemoved");
  assert.deepEqual(state.scripts.s1.profileIds, []);
  assert.equal(state.workflows.w1.steps[0].profileId, "");
  assert.equal(ctx.stateManager.getRevision(), 1, "idempotent onRemoved must not create a duplicate revision");
}

// A delayed onUpdated event for an identity Firefox has already removed must
// not rename the retained unmanaged tombstone used for recovery/history.
{
  const ctx = await setup({ contextualIdentities: { get: undefined } });
  const removed = await ctx.personaManager.handleRemoved({ contextualIdentity: { cookieStoreId: "p1" } });
  assert.equal(removed, true);
  const revisionAfterRemoval = ctx.stateManager.getRevision();
  const updated = await ctx.personaManager.handleUpdated({
    contextualIdentity: { cookieStoreId: "p1", name: "Stale Firefox event" }
  });
  const state = await ctx.stateManager.getState();
  assert.equal(updated, false);
  assert.equal(state.profiles.p1.managed, false);
  assert.equal(state.profiles.p1.routeId, "__block__");
  assert.equal(state.global.unmanagedPolicy, "block", "container removal quarantines unmanaged traffic");
  assert.equal(state.profiles.p1.name, "Persona");
  assert.equal(ctx.stateManager.getRevision(), revisionAfterRemoval);
}

// When get() is unavailable, query() must confirm the identity still exists
// before an update event can change the canonical Persona record.
{
  const ctx = await setup({ contextualIdentities: { get: undefined, async query() { return []; } } });
  const updated = await ctx.personaManager.handleUpdated({
    contextualIdentity: { cookieStoreId: "p1", name: "Stale update after browser removal" }
  });
  const state = await ctx.stateManager.getState();
  assert.equal(updated, false);
  assert.equal(state.profiles.p1.managed, true);
  assert.equal(state.profiles.p1.name, "Persona");
  assert.equal(ctx.stateManager.getRevision(), 0);
}

// onUpdated is redundant with updateIdentity's own state commit. It must not
// overwrite a later independent mutation or advance revision by itself.
{
  const ctx = await setup();
  const identityUpdate = ctx.personaManager.updateIdentity("p1", { name: "Renamed" });
  const result = await identityUpdate;
  await ctx.updatedEvent();
  await ctx.stateManager.mutate((draft) => {
    draft.profiles.p1.description = "newer-description";
    draft.profiles.p1.routeId = "__block__";
  });
  const state = await ctx.stateManager.getState();
  assert.equal(result.profile.name, "Renamed");
  assert.equal(state.profiles.p1.name, "Renamed");
  assert.equal(state.profiles.p1.description, "newer-description");
  assert.equal(state.profiles.p1.routeId, "__block__");
  assert.equal(ctx.stateManager.getRevision(), 2, "redundant onUpdated must not create a duplicate revision");

  ctx.setContainerName("Latest browser name");
  await ctx.personaManager.handleUpdated({ contextualIdentity: { cookieStoreId: "p1", name: "Delayed stale event" } });
  const reconciled = await ctx.stateManager.getState();
  assert.equal(reconciled.profiles.p1.name, "Latest browser name", "a delayed identity event must read the current browser identity instead of restoring stale event data");
  assert.equal(reconciled.profiles.p1.description, "newer-description");
  assert.equal(reconciled.profiles.p1.routeId, "__block__");
}

// Full wipe rotates the contextual identity. An onRemoved event for the old
// container can interleave between remap and old-profile cleanup without
// losing the replacement or cross-references.
{
  const ctx = await setup();
  const result = await ctx.personaManager.fullWipe("p1");
  const revisionAfterRotation = ctx.stateManager.getRevision();
  await ctx.removedEvent();
  const state = await ctx.stateManager.getState();
  assert.equal(result.profile.containerId, "p2");
  assert.equal(state.profiles.p1, undefined);
  assert.equal(state.profiles.p2.managed, true);
  assert.deepEqual(state.scripts.s1.profileIds, ["p2"]);
  assert.equal(state.workflows.w1.steps[0].profileId, "p2");
  assert.ok(revisionAfterRotation >= 2, "recoverable full wipe must persist staged checkpoints");
  assert.equal(ctx.stateManager.getRevision(), revisionAfterRotation, "onRemoved event echo must not add or rewind a committed rotation revision");
}

console.log("persona contextual-identity race tests passed");
