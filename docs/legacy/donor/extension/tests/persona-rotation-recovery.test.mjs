import assert from "node:assert/strict";
import { createStateManager, STATE_CONFLICT } from "../lib/state-manager.js";
import { createPersonaManager } from "../lib/personas.js";

const PERSONA_UID = "90000000-0000-4000-8000-000000000001";
const UNRELATED_UID = "90000000-0000-4000-8000-000000000002";
const SOURCE_ID = "firefox-container-source";
const UNRELATED_ID = "firefox-container-unrelated";

function clone(value) {
  return structuredClone(value);
}

function initialState() {
  return {
    schemaVersion: 3,
    global: {
      unmanagedPolicy: "direct",
      autoReloadOnRouteChange: false
    },
    profiles: {
      [SOURCE_ID]: {
        containerId: SOURCE_ID,
        personaUid: PERSONA_UID,
        managed: true,
        owned: true,
        name: "Source Persona",
        routeId: "r1",
        killSwitch: true,
        blockLocalNetwork: true,
        scriptIds: ["script-source"]
      },
      [UNRELATED_ID]: {
        containerId: UNRELATED_ID,
        personaUid: UNRELATED_UID,
        managed: true,
        owned: false,
        name: "Unrelated Persona",
        routeId: "r2",
        killSwitch: true,
        blockLocalNetwork: true,
        scriptIds: ["script-unrelated"]
      }
    },
    routes: {
      r1: { id: "r1", name: "Source route", type: "socks", host: "127.0.0.1", port: 1081, enabled: true },
      r2: { id: "r2", name: "Unrelated route", type: "socks", host: "127.0.0.1", port: 1082, enabled: true }
    },
    scripts: {
      "script-source": { id: "script-source", name: "Source script", code: "", profileIds: [SOURCE_ID] },
      "script-unrelated": { id: "script-unrelated", name: "Other script", code: "", profileIds: [UNRELATED_ID] }
    },
    workflows: {
      "workflow-source": {
        id: "workflow-source",
        name: "Source workflow",
        steps: [{ id: "step-1", profileId: SOURCE_ID, urls: [], scriptIds: ["script-source"] }]
      },
      "workflow-unrelated": {
        id: "workflow-unrelated",
        name: "Other workflow",
        steps: [{ id: "step-1", profileId: UNRELATED_ID, urls: [], scriptIds: ["script-unrelated"] }]
      }
    },
    personaRotations: {},
    wireguardImports: []
  };
}

function createEnvironment(label = "rotation") {
  const env = {
    label,
    operationId: `operation-${label}`,
    correlationOperationId: null,
    persisted: initialState(),
    containers: new Map([
      [SOURCE_ID, { cookieStoreId: SOURCE_ID, name: "Source Persona", color: "blue", icon: "fingerprint" }],
      [UNRELATED_ID, { cookieStoreId: UNRELATED_ID, name: "Unrelated Persona", color: "green", icon: "briefcase" }]
    ]),
    tabs: new Map([
      [101, { id: 101, cookieStoreId: SOURCE_ID, url: "https://source.example/" }],
      [202, { id: 202, cookieStoreId: UNRELATED_ID, url: "https://unrelated.example/" }]
    ]),
    automationJobs: {
      "job-source": {
        id: "job-source",
        profileId: SOURCE_ID,
        tasks: [{ profileId: SOURCE_ID }],
        stepProgress: [{ profileId: SOURCE_ID }]
      },
      "job-unrelated": {
        id: "job-unrelated",
        profileId: UNRELATED_ID,
        tasks: [{ profileId: UNRELATED_ID }],
        stepProgress: [{ profileId: UNRELATED_ID }]
      }
    },
    createCount: 0,
    removeCount: 0,
    updateCount: 0,
    historyRemapCalls: 0,
    targetNavigationCount: 0,
    rotationEvents: [],
    activeGetState: null
  };

  env.browserApi = {
    contextualIdentities: {
      async query() {
        return [...env.containers.values()].map(clone);
      },
      async get(id) {
        const identity = env.containers.get(id);
        if (!identity) {
          const error = new Error("Contextual identity not found");
          error.code = "CONTEXTUAL_IDENTITY_NOT_FOUND";
          throw error;
        }
        return clone(identity);
      },
      async create(details) {
        env.createCount += 1;
        const id = `firefox-container-target-${env.createCount}`;
        const created = { cookieStoreId: id, ...clone(details) };
        env.containers.set(id, created);
        return clone(created);
      },
      async update(id, changes) {
        const identity = env.containers.get(id);
        if (!identity) throw new Error("Contextual identity not found");
        env.updateCount += 1;
        Object.assign(identity, clone(changes));
        return clone(identity);
      },
      async remove(id) {
        const identity = env.containers.get(id);
        if (!identity) throw new Error("Contextual identity not found");
        if (id === UNRELATED_ID) throw new Error("rotation attempted to remove unrelated container");
        const sourceTabs = [...env.tabs.values()].filter((tab) => tab.cookieStoreId === id);
        assert.equal(sourceTabs.length, 0, "source container removal requires tab quiescence");
        env.removeCount += 1;
        env.containers.delete(id);
      }
    },
    tabs: {
      async query({ cookieStoreId } = {}) {
        return [...env.tabs.values()]
          .filter((tab) => !cookieStoreId || tab.cookieStoreId === cookieStoreId)
          .map(clone);
      },
      async remove(ids) {
        const list = Array.isArray(ids) ? ids : [ids];
        const current = await env.activeGetState();
        for (const id of list) {
          const tab = env.tabs.get(id);
          if (!tab) continue;
          if (tab.cookieStoreId === SOURCE_ID) {
            const source = current.profiles[SOURCE_ID];
            assert.ok(source, "source profile must still exist while source tabs are live");
            assert.equal(source.managed, true, "source must remain managed while closing old tabs");
            assert.equal(source.routeId, "r1", "source must retain its protected route until tabs are closed");
            assert.equal(current.global.unmanagedPolicy, "direct", "test must exercise the Direct fallback hazard");
          }
          env.tabs.delete(id);
        }
      },
      async create() {
        env.targetNavigationCount += 1;
        throw new Error("rotation must not navigate a target container");
      },
      async reload() {}
    }
  };

  env.remapAutomationHistory = async (sourceId, targetId) => {
    env.historyRemapCalls += 1;
    for (const job of Object.values(env.automationJobs)) {
      if (job.profileId === sourceId) job.profileId = targetId;
      for (const task of job.tasks || []) if (task.profileId === sourceId) task.profileId = targetId;
      for (const progress of job.stepProgress || []) if (progress.profileId === sourceId) progress.profileId = targetId;
    }
  };

  return env;
}

async function boot(env, { failPoint = null } = {}) {
  const stateManager = createStateManager({
    load: async () => clone(env.persisted),
    save: async (state) => {
      env.persisted = clone(state);
      return clone(env.persisted);
    }
  });
  await stateManager.initialize();
  env.activeGetState = () => stateManager.getState();

  let injected = false;
  const manager = createPersonaManager({
    getState: () => stateManager.getState(),
    setState: (state, options) => stateManager.setState(state, options),
    mutate: (mutator, options) => stateManager.mutate(mutator, options),
    browserApi: env.browserApi,
    remapAutomationHistory: env.remapAutomationHistory,
    onRotationEvent: async (event) => { env.rotationEvents.push(clone(event)); },
    rotationOperationIdFactory: () => env.operationId,
    rotationFailureInjector: failPoint ? async (point) => {
      if (!injected && point === failPoint) {
        injected = true;
        const error = new Error(`injected failure after ${point}`);
        error.code = "INJECTED_FAILURE";
        throw error;
      }
    } : null
  });
  return { stateManager, manager };
}

function assertUnrelatedPreserved(env, finalState, originalUnrelated, originalJob) {
  assert.deepEqual(finalState.profiles[UNRELATED_ID], originalUnrelated.profile);
  assert.deepEqual(finalState.scripts["script-unrelated"], originalUnrelated.script);
  assert.deepEqual(finalState.workflows["workflow-unrelated"], originalUnrelated.workflow);
  assert.deepEqual(env.containers.get(UNRELATED_ID), originalUnrelated.container);
  assert.deepEqual(env.tabs.get(202), originalUnrelated.tab);
  assert.deepEqual(env.automationJobs["job-unrelated"], originalJob);
}

async function assertConverged(env, originalUnrelated, originalJob) {
  const finalState = clone(env.persisted);
  const owners = Object.values(finalState.profiles).filter((profile) => profile.personaUid === PERSONA_UID);
  assert.equal(owners.length, 1, "exactly one current profile must own the durable personaUid");
  const target = owners[0];
  assert.notEqual(target.containerId, SOURCE_ID);
  assert.equal(target.managed, true);
  assert.equal(target.rotationRole, null);
  assert.equal(target.rotationOperationId, null);
  assert.equal(target.routeId, "r1");
  assert.equal(finalState.profiles[SOURCE_ID], undefined, "source compatibility profile must be cleaned up");
  assert.deepEqual(finalState.personaRotations, {}, "successful recovery must clear the rotation journal");
  assert.equal(env.containers.has(SOURCE_ID), false, "old contextual identity must be absent");
  assert.equal(env.containers.has(target.containerId), true, "current target contextual identity must survive");
  assert.equal(env.createCount, 1, "retries must not create unbounded replacement containers");
  assert.equal(env.targetNavigationCount, 0, "rotation must never navigate the target container");
  assert.equal([...env.tabs.values()].some((tab) => tab.cookieStoreId === SOURCE_ID), false);
  assert.equal(finalState.scripts["script-source"].profileIds.includes(target.containerId), true);
  assert.equal(finalState.scripts["script-source"].profileIds.includes(SOURCE_ID), false);
  assert.equal(finalState.workflows["workflow-source"].steps[0].profileId, target.containerId);
  assert.equal(env.automationJobs["job-source"].profileId, target.containerId);
  assert.equal(env.automationJobs["job-source"].tasks[0].profileId, target.containerId);
  assert.equal(env.automationJobs["job-source"].stepProgress[0].profileId, target.containerId);
  assertUnrelatedPreserved(env, finalState, originalUnrelated, originalJob);
  assert.equal(env.rotationEvents.length, 1, "a converged rotation publishes one semantic rotation event");
  assert.deepEqual(env.rotationEvents[0], {
    personaUid: PERSONA_UID,
    oldCookieStoreId: SOURCE_ID,
    newCookieStoreId: target.containerId,
    operationId: env.operationId,
    correlationOperationId: env.correlationOperationId,
    oldProfileId: SOURCE_ID,
    profile: env.rotationEvents[0].profile,
    container: env.rotationEvents[0].container,
    closedTabs: env.rotationEvents[0].closedTabs,
    revision: env.rotationEvents[0].revision,
    bootId: env.rotationEvents[0].bootId
  });
  return target;
}

{
  const env = createEnvironment("preconditions");
  const { stateManager, manager } = await boot(env);
  await assert.rejects(
    manager.fullWipe(SOURCE_ID, { expectedRevision: stateManager.getRevision() + 1, expectedBootId: stateManager.getBootId() }),
    (error) => error?.code === STATE_CONFLICT
  );
  await assert.rejects(
    manager.fullWipe(SOURCE_ID, { expectedRevision: stateManager.getRevision(), expectedBootId: "stale-boot" }),
    (error) => error?.code === STATE_CONFLICT
  );
  assert.equal(env.createCount, 0, "failed preconditions must precede Firefox side effects");
  assert.deepEqual(env.persisted.personaRotations, {}, "failed preconditions must not create a journal");
  assert.equal(env.containers.has(SOURCE_ID), true);
}

{
  const env = createEnvironment("uid-retry");
  env.correlationOperationId = `external-op-${"x".repeat(244)}`;
  assert.equal(env.correlationOperationId.length, 256);
  const firstBoot = await boot(env, { failPoint: "after-target-persist" });
  const originalBootId = firstBoot.stateManager.getBootId();
  const originalUnrelated = {
    profile: clone(env.persisted.profiles[UNRELATED_ID]),
    script: clone(env.persisted.scripts["script-unrelated"]),
    workflow: clone(env.persisted.workflows["workflow-unrelated"]),
    container: clone(env.containers.get(UNRELATED_ID)),
    tab: clone(env.tabs.get(202))
  };
  const originalUnrelatedJob = clone(env.automationJobs["job-unrelated"]);

  await assert.rejects(
    firstBoot.manager.fullWipe(SOURCE_ID, {
      expectedRevision: firstBoot.stateManager.getRevision(),
      expectedBootId: originalBootId,
      correlationOperationId: env.correlationOperationId
    }),
    /injected failure/
  );
  const journal = env.persisted.personaRotations[env.operationId];
  assert.ok(journal, "failed rotation must remain journaled for retry");
  assert.equal(journal.operationId, env.operationId, "journal must keep the internal operation ID");
  assert.equal(journal.correlationOperationId, env.correlationOperationId, "256-character caller correlation must survive storage normalization");
  const secondBoot = await boot(env);
  assert.notEqual(secondBoot.stateManager.getBootId(), originalBootId, "restart must establish a new boot scope");
  const resumed = await secondBoot.manager.fullWipe(PERSONA_UID, {
    expectedRevision: 0,
    expectedBootId: "stale-original-boot"
  });
  assert.equal(resumed.operationId, env.operationId, "restart retry must resume the same internal operation ID");
  assert.equal(resumed.personaUid, PERSONA_UID);
  assert.equal(resumed.correlationOperationId, env.correlationOperationId, "restart recovery must retain the full external correlation ID");
  assert.notEqual(resumed.operationId, resumed.correlationOperationId, "internal and external operation IDs remain distinct");
  await assertConverged(env, originalUnrelated, originalUnrelatedJob);
  assert.equal(env.rotationEvents.length, 1, "restart recovery must publish one rotation event");
  assert.equal(env.rotationEvents[0].operationId, env.operationId);
  assert.equal(env.rotationEvents[0].correlationOperationId, env.correlationOperationId, "rotation event must preserve the exact external correlation ID");
}

const failurePoints = [
  "after-journal-prepare",
  "after-target-create",
  "after-target-persist",
  "after-state-cutover",
  "after-reference-remap",
  "after-history-remap",
  "after-source-tabs-remove",
  "after-source-remove",
  "after-final-cleanup"
];

for (const point of failurePoints) {
  const env = createEnvironment(point.replaceAll("-", "_"));
  const firstBoot = await boot(env, { failPoint: point });
  const originalUnrelated = {
    profile: clone(env.persisted.profiles[UNRELATED_ID]),
    script: clone(env.persisted.scripts["script-unrelated"]),
    workflow: clone(env.persisted.workflows["workflow-unrelated"]),
    container: clone(env.containers.get(UNRELATED_ID)),
    tab: clone(env.tabs.get(202))
  };
  const originalUnrelatedJob = clone(env.automationJobs["job-unrelated"]);
  const originalBootId = firstBoot.stateManager.getBootId();
  await assert.rejects(
    firstBoot.manager.fullWipe(SOURCE_ID, {
      expectedRevision: firstBoot.stateManager.getRevision(),
      expectedBootId: originalBootId
    }),
    /injected failure/
  );

  assert.ok(env.createCount <= 1, `${point}: first attempt must create at most one target`);
  if (env.persisted.personaRotations[env.operationId]) {
    const sourceContainerBeforeGuard = env.containers.has(SOURCE_ID);
    const removeCountBeforeGuard = env.removeCount;
    await assert.rejects(firstBoot.manager.open(SOURCE_ID), /rotation is in progress/i);
    await assert.rejects(firstBoot.manager.destroy(SOURCE_ID), /rotation is in progress/i);
    assert.equal(env.containers.has(SOURCE_ID), sourceContainerBeforeGuard, `${point}: guarded destroy must not change source-container presence`);
    assert.equal(env.removeCount, removeCountBeforeGuard, `${point}: guarded destroy must not invoke contextual identity removal`);
  }

  const secondBoot = await boot(env);
  assert.notEqual(secondBoot.stateManager.getBootId(), originalBootId, `${point}: restart must use a new boot scope`);
  await secondBoot.manager.reconcileRotations();
  const target = await assertConverged(env, originalUnrelated, originalUnrelatedJob);

  if (point === "after-target-create") {
    assert.equal(target.containerId, "firefox-container-target-1", "recovery must rediscover the exact marker-created target");
  }
  if (point === "after-history-remap") {
    assert.equal(env.historyRemapCalls, 2, "history remapping must be idempotent across a crash before stage persistence");
  }
}

console.log("persona rotation recovery matrix tests passed");
