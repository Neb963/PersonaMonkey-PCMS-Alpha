import assert from "node:assert/strict";
import { createStateManager } from "../lib/state-manager.js";
import { normalizeProfile } from "../lib/storage.js";
import { createPersonaPlatform } from "../lib/persona-platform.js";
import { createPersonaApi } from "../lib/persona-api.js";
import { validateWorkflowForRun } from "../lib/workflow-model.js";
import {
  INTEGRATION_COMMAND_DESCRIPTORS,
  INTEGRATION_ERROR_CODES,
  INTEGRATION_PROTOCOL_VERSION,
  INTEGRATION_REQUEST_TYPE
} from "../lib/management-integration-protocol.js";
import {
  createIntegrationOperationStore,
  createManagementIntegration
} from "../lib/management-integration.js";

const TRUSTED_ID = "pcms-stage5@example.test";
const SECOND_TRUSTED_ID = "second-client@example.test";
const SELF_ID = "persona-route-manager@local";
const UID = "90000000-0000-4000-8000-000000000001";
const clone = (value) => structuredClone(value);

const initial = {
  schemaVersion: 3,
  global: {
    integration: {
      enabled: true,
      trustedExtensionIds: [TRUSTED_ID, SECOND_TRUSTED_ID],
      allowDestructive: true,
      allowDirect: false,
      allowExternalAutomation: true,
      allowExecutableInstall: true
    }
  },
  profiles: {},
  routes: {
    "route-safe": {
      id: "route-safe",
      name: "Safe route",
      provider: "generic",
      type: "socks",
      host: "127.0.0.1",
      port: 1080,
      proxyDNS: true,
      username: "route-user-secret",
      password: "route-password-secret",
      enabled: true
    }
  },
  scripts: {
    "script-safe": {
      id: "script-safe",
      name: "Existing helper",
      namespace: "stage5",
      version: "1.0.0",
      code: "globalThis.__privateSource = true;",
      enabled: true,
      autoRun: true,
      matches: ["https://example.com/*"],
      excludeMatches: [],
      includes: [],
      excludes: [],
      runAt: "document_idle",
      allFrames: false,
      injectInto: "content",
      world: "USER_SCRIPT",
      grants: ["GM_getValue", "Persona.signal"],
      requires: [],
      resources: {},
      connects: ["example.com"],
      tags: [],
      unwrap: false,
      profileIds: [],
      compatibility: { compatible: true, supported: ["GM_getValue", "Persona.signal"], unsupported: [] },
      metaBlock: "// private metadata"
    }
  },
  workflows: {},
  personaRotations: {},
  wireguardImports: []
};

let persisted = clone(initial);
const stateManager = createStateManager({
  load: async () => clone(persisted),
  save: async (next) => {
    persisted = clone(next);
    return clone(persisted);
  }
});
await stateManager.initialize();

let containerSequence = 0;
let tabSequence = 100;
const fakePersonaManager = {
  async listContainers() {
    const state = await stateManager.getState();
    return Object.values(state.profiles || {}).map((profile) => ({
      cookieStoreId: profile.containerId,
      name: profile.name,
      color: "blue",
      icon: "fingerprint"
    }));
  },
  async create(input = {}, options = {}) {
    const committed = await stateManager.mutate((draft) => {
      const id = "firefox-container-" + (++containerSequence);
      const profile = normalizeProfile({
        ...(input.profile || {}),
        managed: true,
        name: input.name || "Persona",
        routeId: input.profile?.routeId || "__block__"
      }, id);
      options.validateProfile?.(draft, profile);
      draft.profiles[id] = profile;
      return {
        profile: clone(profile),
        container: { cookieStoreId: id, name: profile.name, color: input.color || "blue", icon: input.icon || "fingerprint" }
      };
    }, options);
    return committed.result;
  },
  async updateProfileRoute(profileId, routeId, options = {}, validateProfile) {
    const committed = await stateManager.mutate((draft) => {
      const profile = draft.profiles?.[profileId];
      validateProfile?.(draft, profile);
      profile.routeId = routeId;
      return clone(profile);
    }, options);
    return committed.result;
  },
  async open(profileId, url, active = true) {
    return { id: ++tabSequence, cookieStoreId: profileId, url, active };
  },
  async updateIdentity(profileId, changes = {}, options = {}) {
    const committed = await stateManager.mutate((draft) => {
      const profile = draft.profiles?.[profileId];
      if (!profile?.managed) throw new Error("Managed persona not found");
      if (changes.name) profile.name = String(changes.name);
      return clone(profile);
    }, options);
    return committed.result;
  },
  async archive(profileId, options = {}) {
    const committed = await stateManager.mutate((draft) => {
      const profile = draft.profiles?.[profileId];
      if (!profile?.managed) throw new Error("Managed persona not found");
      profile.status = "archived";
      return clone(profile);
    }, options);
    return committed.result;
  },
  async destroy(profileId, options = {}) {
    const committed = await stateManager.mutate((draft) => {
      if (!draft.profiles?.[profileId]) throw new Error("Managed persona not found");
      delete draft.profiles[profileId];
      draft.global.unmanagedPolicy = "block";
      return true;
    }, options);
    return committed.result;
  },
  async fullWipe(personaUid, options = {}) {
    const committed = await stateManager.mutate((draft) => {
      const source = Object.values(draft.profiles || {}).find((profile) =>
        profile?.managed && !profile.rotationRole && profile.personaUid === personaUid);
      if (!source) throw new Error("Managed persona not found");
      const oldCookieStoreId = source.containerId;
      const newCookieStoreId = "firefox-container-" + (++containerSequence);
      const target = { ...source, containerId: newCookieStoreId };
      delete draft.profiles[oldCookieStoreId];
      draft.global.unmanagedPolicy = "block";
      draft.profiles[newCookieStoreId] = target;
      for (const script of Object.values(draft.scripts || {})) {
        script.profileIds = (script.profileIds || []).map((id) => id === oldCookieStoreId ? newCookieStoreId : id);
      }
      for (const workflow of Object.values(draft.workflows || {})) {
        for (const step of workflow.steps || []) {
          if (step.profileId === oldCookieStoreId) step.profileId = newCookieStoreId;
        }
      }
      return {
        personaUid,
        oldCookieStoreId,
        newCookieStoreId,
        operationId: "rotation-stage5",
        profile: clone(target)
      };
    }, options);
    return committed.result;
  },
  async resolvePersonaUid(personaUid) {
    const state = await stateManager.getState();
    return Object.values(state.profiles || {}).find((profile) => profile.personaUid === personaUid) || null;
  }
};

const cookieService = {
  async list() { return []; },
  async importRecords() { return { imported: 0, failed: 0 }; }
};
const storageService = {
  async summary() { return { activeTabs: 0 }; },
  async inspect() { return { cookies: { count: 0, bytes: 0, byDomain: [] }, activeTabs: 0 }; },
  async clear() { return {}; },
  async clearCookies() { return { cookies: 0 }; },
  async clearSiteData() { return { siteData: true }; }
};
const browserApi = { tabs: { async query() { return []; } } };
const personaPlatform = createPersonaPlatform({
  getState: stateManager.getState,
  setState: stateManager.setState,
  mutate: stateManager.mutate,
  personaManager: fakePersonaManager,
  cookieService,
  storageService,
  browserApi,
  securityState: {
    ready: true,
    privacySafe: true,
    proxyControl: "controlled_by_this_extension"
  }
});

const jobs = [];
const externalJobs = new Map();
let jobSequence = 0;
const workflowRunner = {
  list: personaPlatform.listWorkflows,
  get: personaPlatform.getWorkflow,
  create: personaPlatform.createWorkflow,
  update: personaPlatform.updateWorkflow,
  delete: personaPlatform.deleteWorkflow,
  async run(workflowId) {
    const state = await stateManager.getState();
    const workflow = state.workflows?.[workflowId];
    if (!workflow) throw new Error("Workflow not found");
    validateWorkflowForRun(workflow, state);
    const job = {
      id: "job-" + (++jobSequence),
      workflowId,
      workflowName: workflow.name,
      state: "queued",
      profileId: workflow.steps[0].profileId,
      createdAt: "2026-09-24T12:00:00.000Z",
      currentStep: -1,
      totalSteps: workflow.steps.length,
      tasks: []
    };
    jobs.push(job);
    return clone(job);
  },
  async listJobs() { return jobs.map(clone); },
  async getJob(jobId) { return clone(jobs.find((job) => job.id === jobId) || null); },
  async stopJob(jobId) {
    const job = jobs.find((entry) => entry.id === jobId);
    if (!job) throw new Error("Job not found");
    job.state = "stopping";
    return clone(job);
  },
  async clearFinishedJobs() { return []; },
  async runExternalExecution(plan, owner) {
    const job = { executionId: owner.executionId, operationId: owner.operationId, state: "running", createdAt: new Date().toISOString(), stepProgress: [] };
    externalJobs.set(owner.executionId, { senderId: owner.senderId, job });
    return clone(job);
  },
  async listExternalExecutions(senderId) {
    return [...externalJobs.values()].filter((entry) => entry.senderId === senderId).map((entry) => clone(entry.job));
  },
  async getExternalExecution(senderId, executionId) {
    const entry = externalJobs.get(executionId);
    return entry?.senderId === senderId ? clone(entry.job) : null;
  },
  async findExternalExecutionByOperation() { return null; }
};

const personaApi = createPersonaApi({
  personaManager: personaPlatform,
  routeManager: personaPlatform,
  userscriptManager: personaPlatform,
  workflowRunner,
  diagnostics: {
    async getSystemStatus() {
      return { security: { ready: true, privacySafe: true }, managedPersonaCount: Object.keys((await stateManager.getState()).profiles).length };
    }
  }
});

const operationData = {};
const storageArea = {
  async get(key) { return { [key]: clone(operationData[key]) }; },
  async set(values) { Object.assign(operationData, clone(values)); }
};
const operationStore = createIntegrationOperationStore(storageArea);

function makeIntegration() {
  return createManagementIntegration({
    personaApi,
    stateManager,
    operationStore,
    productVersion: "0.8.0-stage5-test",
    selfExtensionId: SELF_ID,
    getExternalRuntimeAvailability: async () => ({ userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true })
  });
}
let integration = makeIntegration();
let requestSequence = 0;

async function request(command, params = {}, {
  senderId = TRUSTED_ID,
  operationId,
  precondition
} = {}) {
  const descriptor = INTEGRATION_COMMAND_DESCRIPTORS[command];
  const message = {
    type: INTEGRATION_REQUEST_TYPE,
    version: INTEGRATION_PROTOCOL_VERSION,
    requestId: "req-" + (++requestSequence),
    command,
    params
  };
  if (descriptor?.mutating || descriptor?.sideEffecting) {
    message.operationId = operationId || "op-" + requestSequence;
    message.precondition = precondition || {
      bootId: stateManager.getBootId(),
      revision: stateManager.getRevision()
    };
  }
  return integration.handleExternalRequest(message, { id: senderId });
}

const describe = await request("system.describe");
assert.equal(describe.ok, true);
assert.ok(describe.result.commands.some((entry) => entry.command === "userscript.assign"));
assert.ok(describe.result.commands.some((entry) => entry.command === "workflow.create"));

const created = await request("persona.create", {
  personaUid: UID,
  name: "Stage 5 Persona"
}, { operationId: "create-stage5" });
assert.equal(created.ok, true);
assert.equal(created.result.persona.personaUid, UID);
const originalCookieStoreId = created.result.persona.cookieStoreId;

const assignedRoute = await request("route.assign", {
  personaUid: UID,
  routeId: "route-safe"
}, { operationId: "route-stage5" });
assert.equal(assignedRoute.ok, true);

const scripts = await request("userscript.list");
assert.equal(scripts.ok, true);
assert.equal(scripts.result.length, 1);
assert.equal(scripts.result[0].id, "script-safe");
assert.equal(Object.hasOwn(scripts.result[0], "code"), false);
assert.equal(JSON.stringify(scripts.result).includes("privateSource"), false);

const externalSource = "// ==UserScript==\n// @name Scoped artifact\n// @match https://example.com/*\n// @grant Persona.signal\n// ==/UserScript==\nPersona.complete(true);";
const externalHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(externalSource)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const installArtifact = await request("userscript.artifact.install", {
  artifactId: "provider.package/1.0.0/component",
  sha256: externalHash,
  source: externalSource,
  provenance: { packageId: "provider.package", packageVersion: "1.0.0", component: "component" }
}, { operationId: "artifact-install-owner" });
assert.equal(installArtifact.ok, true);
assert.equal(Object.hasOwn(installArtifact.result, "ownerKey"), false, "artifact responses do not expose owner identifiers");
assert.equal(installArtifact.result.autoRun, false);
const externalScriptId = installArtifact.result.scriptId;
const storedArtifact = persisted.scripts[externalScriptId].externalArtifact;
assert.equal(storedArtifact.ownerKey.length, 64);
assert.equal(JSON.stringify(storedArtifact).includes(TRUSTED_ID), false, "persisted artifact ownership stores no raw sender ID");

const secondList = await request("userscript.artifact.list", {}, { senderId: SECOND_TRUSTED_ID });
assert.equal(secondList.ok, true);
assert.deepEqual(secondList.result, [], "artifact listing is scoped to the authenticated sender");
const secondGet = await request("userscript.artifact.get", { artifactId: "provider.package/1.0.0/component" }, { senderId: SECOND_TRUSTED_ID });
assert.equal(secondGet.ok, false);
assert.equal(secondGet.error.code, INTEGRATION_ERROR_CODES.ARTIFACT_NOT_FOUND);
const secondInstall = await request("userscript.artifact.install", {
  artifactId: "provider.package/1.0.0/component",
  sha256: externalHash,
  source: externalSource,
  provenance: { packageId: "provider.package", packageVersion: "1.0.0", component: "component" }
}, { senderId: SECOND_TRUSTED_ID, operationId: "artifact-install-other-owner" });
assert.equal(secondInstall.ok, true, "artifact IDs are sender-scoped, so another trusted sender gets an independent copy");
assert.notEqual(secondInstall.result.scriptId, externalScriptId, "sender-scoped copies must not share the internal script identity");
const secondScopedList = await request("userscript.artifact.list", {}, { senderId: SECOND_TRUSTED_ID });
assert.equal(secondScopedList.ok, true);
assert.deepEqual(secondScopedList.result.map((item) => item.scriptId), [secondInstall.result.scriptId],
  "the second sender sees only its own same-named artifact");
const secondScopedGet = await request("userscript.artifact.get", {
  artifactId: "provider.package/1.0.0/component"
}, { senderId: SECOND_TRUSTED_ID });
assert.equal(secondScopedGet.ok, true);
assert.equal(secondScopedGet.result.scriptId, secondInstall.result.scriptId);
for (const command of ["userscript.assign", "userscript.unassign"]) {
  const denied = await request(command, { scriptId: externalScriptId, personaUid: UID }, { senderId: SECOND_TRUSTED_ID, operationId: `other-${command}` });
  assert.equal(denied.ok, false, `${command} cannot expose or mutate another sender's artifact`);
  assert.equal(denied.error.code, INTEGRATION_ERROR_CODES.USERSCRIPT_NOT_FOUND);
}
const standardScriptList = await request("userscript.list", {}, { senderId: SECOND_TRUSTED_ID });
assert.equal(standardScriptList.ok, true);
assert.equal(standardScriptList.result.some((script) => script.id === externalScriptId), false);
const standardScriptGet = await request("userscript.get", { scriptId: externalScriptId }, { senderId: SECOND_TRUSTED_ID });
assert.equal(standardScriptGet.ok, false);
assert.equal(standardScriptGet.error.code, INTEGRATION_ERROR_CODES.USERSCRIPT_NOT_FOUND);
const assignedArtifact = await request("userscript.artifact.assign", {
  artifactId: "provider.package/1.0.0/component", personaUid: UID
}, { operationId: "artifact-assign-owner" });
assert.equal(assignedArtifact.ok, true);
assert.equal(assignedArtifact.result.personaUid, UID);
const secondAfterOwnerAssign = await request("userscript.artifact.get", {
  artifactId: "provider.package/1.0.0/component"
}, { senderId: SECOND_TRUSTED_ID });
assert.equal(secondAfterOwnerAssign.ok, true);
assert.deepEqual(secondAfterOwnerAssign.result.assignedPersonaUids, [],
  "assigning the first sender's copy must not mutate the second sender's same-named copy");
const secondLease = await request("persona.control.acquire", { personaUid: UID, purpose: "ownership test", ttlMs: 60000 }, { senderId: SECOND_TRUSTED_ID, operationId: "second-sender-lease" });
assert.equal(secondLease.ok, true);
const secondUnassignedExecution = await request("execution.start", {
  plan: { name: "Sender-scoped check", steps: [{ id: "step-other", personaUid: UID, urls: ["https://example.com/"], artifacts: ["provider.package/1.0.0/component"] }] }
}, { senderId: SECOND_TRUSTED_ID, operationId: "sender-scoped-execution" });
assert.equal(secondUnassignedExecution.ok, false,
  "execution.start resolves the second sender's own same-named copy rather than adopting the first sender's assigned artifact");
assert.equal(secondUnassignedExecution.error.code, INTEGRATION_ERROR_CODES.USERSCRIPT_INCOMPATIBLE);
await request("persona.control.release", { leaseId: secondLease.result.leaseId }, { senderId: SECOND_TRUSTED_ID, operationId: "second-sender-lease-release" });
const genericOwnerUnassign = await request("userscript.unassign", { scriptId: externalScriptId, personaUid: UID }, { operationId: "artifact-generic-unassign" });
assert.equal(genericOwnerUnassign.ok, false, "artifact mutation uses the owner-scoped artifact command family");
const ownerLease = await request("persona.control.acquire", { personaUid: UID, purpose: "artifact execution test", ttlMs: 60000 }, { operationId: "owner-artifact-lease" });
assert.equal(ownerLease.ok, true);
for (const privateField of ["ownerSenderId", "cookieStoreId", "routeId", "routeFingerprint"]) {
  assert.equal(Object.hasOwn(ownerLease.result, privateField), false, `lease response must not expose ${privateField}`);
}
const ownerPlan = {
  name: "Owner artifact run",
  steps: [{ id: "step-owner", personaUid: UID, urls: ["https://example.com/"], artifacts: ["provider.package/1.0.0/component"] }]
};
const originalExternalRun = workflowRunner.runExternalExecution;
let failBeforeDurableJob = true;
const attemptedExecutionIds = [];
workflowRunner.runExternalExecution = async (plan, owner) => {
  attemptedExecutionIds.push(owner.executionId);
  if (failBeforeDurableJob) {
    failBeforeDurableJob = false;
    throw new Error("simulated stop before durable job creation");
  }
  return originalExternalRun(plan, owner);
};
const recoveryPrecondition = { bootId: stateManager.getBootId(), revision: stateManager.getRevision() };
const pendingAdmission = await request("execution.start", { plan: ownerPlan }, {
  operationId: "owner-execution-crash-recovery", precondition: recoveryPrecondition
});
assert.equal(pendingAdmission.ok, false, "the first call simulates a stop after write-ahead admission but before job creation");
const recoveredAdmission = await request("execution.start", { plan: ownerPlan }, {
  operationId: "owner-execution-crash-recovery", precondition: recoveryPrecondition
});
workflowRunner.runExternalExecution = originalExternalRun;
assert.equal(recoveredAdmission.ok, true, "a retry must recover an admission with no durable job yet");
assert.equal(attemptedExecutionIds[0], attemptedExecutionIds[1], "recovery must reuse the journaled executionId");
externalJobs.get(recoveredAdmission.result.executionId).job.state = "completed";
assert.equal((await request("execution.get", { executionId: recoveredAdmission.result.executionId })).ok, true);

const ownerExecution = await request("execution.start", {
  plan: ownerPlan
}, { operationId: "owner-execution-start" });
assert.equal(ownerExecution.ok, true, "the owning sender may explicitly select its artifact");
const releaseWhileActive = await request("userscript.artifact.release", { artifactId: "provider.package/1.0.0/component", confirm: true }, { operationId: "artifact-release-active" });
assert.equal(releaseWhileActive.ok, false, "release is fenced while a current execution references the artifact");
assert.equal(releaseWhileActive.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT);
externalJobs.get(ownerExecution.result.executionId).job.state = "completed";
const terminalExecution = await request("execution.get", { executionId: ownerExecution.result.executionId });
assert.equal(terminalExecution.ok, true);
await request("persona.control.release", { leaseId: ownerLease.result.leaseId }, { operationId: "owner-artifact-lease-release" });

const unassignedArtifact = await request("userscript.artifact.unassign", {
  artifactId: "provider.package/1.0.0/component", personaUid: UID
}, { operationId: "artifact-unassign-owner" });
assert.equal(unassignedArtifact.ok, true);
const otherRelease = await request("userscript.artifact.release", { artifactId: "provider.package/1.0.0/component", confirm: true }, { senderId: SECOND_TRUSTED_ID, operationId: "artifact-release-other-owner" });
assert.equal(otherRelease.ok, true);
assert.equal(otherRelease.result.released, true, "the second sender releases only its independent same-named artifact");
const ownerStillPresent = await request("userscript.artifact.get", { artifactId: "provider.package/1.0.0/component" });
assert.equal(ownerStillPresent.ok, true, "releasing the second sender's copy cannot release the first sender's artifact");
assert.equal(ownerStillPresent.result.scriptId, externalScriptId);
const secondAfterRelease = await request("userscript.artifact.get", { artifactId: "provider.package/1.0.0/component" }, { senderId: SECOND_TRUSTED_ID });
assert.equal(secondAfterRelease.ok, false);
assert.equal(secondAfterRelease.error.code, INTEGRATION_ERROR_CODES.ARTIFACT_NOT_FOUND);
const ownerRelease = await request("userscript.artifact.release", { artifactId: "provider.package/1.0.0/component", confirm: true }, { operationId: "artifact-release-owner" });
assert.equal(ownerRelease.ok, true);
assert.equal(ownerRelease.result.released, true);

const unassignedWorkflow = await request("workflow.create", {
  workflow: {
    name: "Must reject unassigned script",
    enabled: true,
    steps: [{
      personaUid: UID,
      urls: ["https://example.com/task"],
      concurrency: 1,
      scriptIds: ["script-safe"],
      completion: { mode: "signal", value: "", timeoutMs: 5000 },
      retries: 0,
      retryDelayMs: 0,
      closeTabs: true,
      stopOnError: true
    }]
  }
}, { operationId: "workflow-unassigned-stage5" });
assert.equal(unassignedWorkflow.ok, false);
assert.equal(unassignedWorkflow.error.code, INTEGRATION_ERROR_CODES.VALIDATION_FAILED);
assert.ok(unassignedWorkflow.error.details.issues.some((issue) => issue.code === "script-persona-mismatch"));

const assignedScript = await request("userscript.assign", {
  scriptId: "script-safe",
  personaUid: UID
}, { operationId: "script-stage5" });
assert.equal(assignedScript.ok, true);
assert.deepEqual(assignedScript.result.assignedPersonaUids, [UID]);

await stateManager.mutate((draft) => {
  draft.scripts["script-safe"].injectInto = "page";
  draft.scripts["script-safe"].world = "MAIN";
});
const mainWorldWorkflow = await request("workflow.create", {
  workflow: {
    name: "Must reject MAIN signal",
    enabled: true,
    steps: [{
      personaUid: UID,
      urls: ["https://example.com/task"],
      concurrency: 1,
      scriptIds: ["script-safe"],
      completion: { mode: "signal", value: "", timeoutMs: 5000 },
      retries: 0,
      retryDelayMs: 0,
      closeTabs: true,
      stopOnError: true
    }]
  }
}, { operationId: "workflow-main-stage5" });
assert.equal(mainWorldWorkflow.ok, false);
assert.equal(mainWorldWorkflow.error.code, INTEGRATION_ERROR_CODES.VALIDATION_FAILED);
assert.ok(mainWorldWorkflow.error.details.issues.some((issue) => issue.code === "signal-main-world"));
await stateManager.mutate((draft) => {
  draft.scripts["script-safe"].injectInto = "content";
  draft.scripts["script-safe"].world = "USER_SCRIPT";
});

const workflowPayload = {
  name: "Stage 5 workflow",
  enabled: true,
  steps: [{
    id: "step-1",
    personaUid: UID,
    urls: ["https://example.com/task"],
    concurrency: 1,
    scriptIds: ["script-safe"],
    completion: { mode: "signal", value: "", timeoutMs: 5000 },
    retries: 0,
    retryDelayMs: 0,
    closeTabs: true,
    stopOnError: true
  }]
};
const workflowCreated = await request("workflow.create", {
  workflow: workflowPayload
}, { operationId: "workflow-create-stage5" });
assert.equal(workflowCreated.ok, true);
const workflowId = workflowCreated.result.id;
assert.equal(workflowCreated.result.steps[0].personaUid, UID);
assert.deepEqual(workflowCreated.result.steps[0].scriptIds, ["script-safe"]);

const staleUpdate = await request("workflow.update", {
  workflowId,
  workflow: workflowPayload
}, {
  operationId: "workflow-stale-update-stage5",
  precondition: { bootId: stateManager.getBootId(), revision: Math.max(0, stateManager.getRevision() - 1) }
});
assert.equal(staleUpdate.ok, false);
assert.equal(staleUpdate.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT);

const runPrecondition = { bootId: stateManager.getBootId(), revision: stateManager.getRevision() };
const run1 = await request("workflow.run", { workflowId }, {
  operationId: "workflow-run-stage5",
  precondition: runPrecondition
});
assert.equal(run1.ok, true);
assert.equal(jobs.length, 1);
assert.equal(run1.result.cookieStoreId, originalCookieStoreId);
const leaseDuringOrdinaryJob = await request("persona.control.acquire", {
  personaUid: UID, purpose: "must not overlap a local workflow", ttlMs: 60000
}, { operationId: "lease-during-workflow" });
assert.equal(leaseDuringOrdinaryJob.ok, false, "lease acquisition must not overlap an already-running ordinary workflow");
assert.equal(leaseDuringOrdinaryJob.error.code, INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY);

const retryRun1 = await request("workflow.run", { workflowId }, {
  operationId: "workflow-run-stage5",
  precondition: runPrecondition
});
assert.equal(retryRun1.ok, true);
assert.equal(retryRun1.result.id, run1.result.id);
assert.equal(jobs.length, 1, "completed external run retry must not create a duplicate job");

const observed = await request("workflow.jobs.get", { jobId: run1.result.id });
assert.equal(observed.ok, true);
assert.equal(observed.result.personaUid, UID);

const rotated = await request("storage.fullWipe", {
  personaUid: UID,
  confirm: true
}, { operationId: "rotate-stage5" });
assert.equal(rotated.ok, true);
assert.equal(rotated.result.oldCookieStoreId, originalCookieStoreId);
assert.notEqual(rotated.result.newCookieStoreId, originalCookieStoreId);
const rotatedCookieStoreId = rotated.result.newCookieStoreId;

// Simulate an external client reconnect: discard adapter-local indexes and
// rediscover/requery authoritative state by durable personaUid.
integration.dispose();
integration = makeIntegration();
const reconnectedDescribe = await request("system.describe");
assert.equal(reconnectedDescribe.ok, true);

const personaAfterRotation = await request("persona.get", { personaUid: UID });
assert.equal(personaAfterRotation.ok, true);
assert.equal(personaAfterRotation.result.cookieStoreId, rotatedCookieStoreId);

const scriptAfterRotation = await request("userscript.get", { scriptId: "script-safe" });
assert.equal(scriptAfterRotation.ok, true);
assert.deepEqual(scriptAfterRotation.result.assignedPersonaUids, [UID]);

const workflowAfterRotation = await request("workflow.get", { workflowId });
assert.equal(workflowAfterRotation.ok, true);
assert.equal(workflowAfterRotation.result.steps[0].personaUid, UID);
assert.deepEqual(workflowAfterRotation.result.steps[0].scriptIds, ["script-safe"]);

const internalAfterRotation = await stateManager.getState();
assert.deepEqual(internalAfterRotation.scripts["script-safe"].profileIds, [rotatedCookieStoreId]);
assert.equal(internalAfterRotation.workflows[workflowId].steps[0].profileId, rotatedCookieStoreId);

const run2 = await request("workflow.run", { workflowId }, { operationId: "workflow-run-stage5-after-rotation" });
assert.equal(run2.ok, true);
assert.equal(run2.result.cookieStoreId, rotatedCookieStoreId);
assert.equal(jobs.length, 2);

const directDenied = await request("route.assign", {
  personaUid: UID,
  routeId: "__direct__",
  allowDirect: true
}, { operationId: "direct-denied-stage5" });
assert.equal(directDenied.ok, false);
assert.equal(directDenied.error.code, INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED);

const untrusted = await request("system.describe", {}, { senderId: "not-authorized@example.test" });
assert.equal(untrusted.ok, false);
assert.equal(untrusted.error.code, INTEGRATION_ERROR_CODES.UNAUTHORIZED);

const staleDelete = await request("workflow.delete", {
  workflowId,
  confirm: true
}, {
  operationId: "workflow-stale-delete-stage5",
  precondition: { bootId: stateManager.getBootId(), revision: Math.max(0, stateManager.getRevision() - 1) }
});
assert.equal(staleDelete.ok, false);
assert.equal(staleDelete.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT);
assert.ok((await stateManager.getState()).workflows[workflowId], "stale delete must not remove the workflow");

console.log("PCMS integration Stage 5 lifecycle test passed");
