import assert from "node:assert/strict";
import { createPcmsControlPlane } from "../lib/pcms-control-plane.js";
import { createPcmsEventHub } from "../lib/pcms-events.js";
import { PCMS_ERROR_CODES, PCMS_PROTOCOL_VERSION, sanitizePcmsValue } from "../lib/pcms-protocol.js";

const sharedDescriptor = { type: "boolean" };
assert.deepEqual(
  sanitizePcmsValue({ first: sharedDescriptor, second: sharedDescriptor }, { maxBytes: 4096 }),
  { first: { type: "boolean" }, second: { type: "boolean" } },
  "shared response objects must not be mistaken for cycles"
);
const actualCycle = {};
actualCycle.self = actualCycle;
assert.deepEqual(
  sanitizePcmsValue(actualCycle, { maxBytes: 4096 }),
  { self: "[truncated]" },
  "ancestor cycles must still truncate"
);

const PERSONA_UID = "80000000-0000-4000-8000-000000000001";
let revision = 7;
let active = 0;
let peakActive = 0;
const calls = [];
const openCalls = [];
const workflowRunCalls = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const routeManager = {
  async list() { return [{ id: "route-a", host: "127.0.0.1", password: "must-not-leak" }]; },
  async get(id) { return id === "route-a" ? { id, password: "must-not-leak" } : null; },
  async assign(profileId, routeId, options) {
    calls.push(["assign", profileId, routeId, options]);
    if (profileId === "missing") throw new Error("Managed persona not found");
    if (routeId === "disabled") { const error = new Error("Route disabled"); error.code = "ROUTE_DISABLED"; throw error; }
    revision += 1;
    return { profileId, routeId, password: "must-not-leak" };
  },
  async test(profileId) {
    active += 1; peakActive = Math.max(peakActive, active);
    await delay(profileId === "bad" ? 2 : 8);
    active -= 1;
    if (profileId === "bad") throw new Error("Managed persona not found");
    return { profileId, ok: true, cookie: "must-not-leak" };
  }
};
const facade = {
  PersonaManager: {
    list: async () => [{ id: "one", personaUid: PERSONA_UID, cookieStoreId: "one" }], get: async (id) => id === "missing" ? null : { id, personaUid: PERSONA_UID, cookieStoreId: id },
    create: async (input, options) => ({ profile: { containerId: "new" }, input, options }),
    open: async (profileId, url, activeValue, options) => {
      openCalls.push([profileId, url, activeValue, options]);
      return { profileId, url, active: activeValue };
    },
    updateIdentity: async (profileId, changes, options) => ({ profileId, changes, options }),
    clone: async (profileId, options) => ({ profile: { containerId: "cloned" }, profileId, options }), archive: async (profileId) => ({ profileId }), destroy: async (profileId) => ({ profileId })
  },
  StorageManager: {
    inspect: async (id) => ({ id }),
    clearCookies: async () => ({}),
    clearSiteData: async () => ({}),
    fullWipe: async () => ({
      personaUid: PERSONA_UID,
      oldCookieStoreId: "one",
      newCookieStoreId: "two",
      operationId: "rotation-one",
      profile: { containerId: "two" }
    })
  },
  RouteManager: routeManager,
  WorkflowRunner: {
    list: async () => [{ id: "flow" }], get: async (id) => id === "missing" ? null : { id },
    run: async (id) => { workflowRunCalls.push(id); return { id: `job-${id}` }; },
    listJobs: async () => [], getJob: async (id) => id === "missing" ? null : { id }, stopJob: async (id) => ({ id }), clearFinishedJobs: async () => []
  },
  Diagnostics: { getSystemStatus: async () => ({ security: "safe", token: "must-not-leak" }) }
};
const events = createPcmsEventHub({ bootId: "boot-test", getRevision: () => revision });
const observed = [];
events.subscribe((event) => observed.push(event));
const fencedCommands = [];
const control = createPcmsControlPlane({ personaApi: facade, eventHub: events, getRevision: () => revision, bootId: "boot-test", productVersion: "0.8.0-test",
  mutationFence: async (command, params, operation) => {
    fencedCommands.push({ command, profileId: params.profileId || null });
    if (command === "route.assign" && params.profileId === "fenced") throw new Error("local mutation rejected by active external control");
    return operation();
  }
});
const request = (command, params = {}, requestId = `${command}-${Math.random()}`) => control.handleRequest({ type: "PCMS_REQUEST", version: PCMS_PROTOCOL_VERSION, requestId, command, params });

const describe = await request("system.describe", {}, "describe");
assert.equal(describe.ok, true);
assert.equal(describe.result.protocolVersion, 1);
assert.equal(describe.result.bootId, "boot-test");
assert.ok(describe.result.capabilities.includes("routes"));
const listedPersonas = await request("persona.list", {}, "list-identities");
assert.equal(listedPersonas.result[0].id, "one");
assert.equal(listedPersonas.result[0].cookieStoreId, "one");
assert.equal(listedPersonas.result[0].personaUid, PERSONA_UID);

const staleOpen = await request("persona.open", {
  profileId: "one",
  url: "https://example.test/",
  expectedRevision: 7,
  expectedBootId: "previous-boot"
}, "stale-open");
assert.equal(staleOpen.error.code, PCMS_ERROR_CODES.STATE_CONFLICT);
assert.equal(openCalls.length, 0, "stale guarded open must not invoke PersonaManager.open");

const opened = await request("persona.open", {
  profileId: "one",
  url: "https://example.test/",
  active: false,
  expectedRevision: 7,
  expectedBootId: "boot-test"
}, "guarded-open");
assert.equal(opened.ok, true);
assert.equal(openCalls.length, 1);
assert.equal(openCalls[0][0], "one");
assert.equal(openCalls[0][2], false);
assert.equal(openCalls[0][3].expectedRevision, 7);
assert.equal(openCalls[0][3].expectedBootId, "boot-test");

const badVersion = await control.handleRequest({ type: "PCMS_REQUEST", version: 2, requestId: "bad", command: "system.describe", params: {} });
assert.equal(badVersion.ok, false);
assert.equal(badVersion.error.code, PCMS_ERROR_CODES.PROTOCOL_UNSUPPORTED);
const unknown = await request("api.call", {}, "unknown");
assert.equal(unknown.error.code, PCMS_ERROR_CODES.UNKNOWN_COMMAND);
const malformed = await request("persona.get", {}, "malformed");
assert.equal(malformed.error.code, PCMS_ERROR_CODES.BAD_REQUEST);
for (const [command, params] of [
  ["persona.list", { options: "not-an-object" }],
  ["persona.create", { input: "not-an-object" }],
  ["route.assign", { profileId: "one", routeId: "route-a", options: [] }],
  ["workflow.jobs.list", { options: 1 }],
  ["batch.execute", { command: "route.test", personaIds: ["one"], params: "not-an-object" }]
]) {
  const response = await request(command, params, `bad-${command}`);
  assert.equal(response.ok, false, `${command} should reject non-object optional input`);
  assert.equal(response.error.code, PCMS_ERROR_CODES.BAD_REQUEST);
}
const topLevelCreate = await request("persona.create", { name: "Requested Name" }, "create-top-level");
assert.equal(topLevelCreate.ok, true);
assert.equal(topLevelCreate.result.input.name, "Requested Name");
const nestedCreate = await request("persona.create", { input: { name: "Nested Name" } }, "create-nested");
assert.equal(nestedCreate.ok, true);
assert.equal(nestedCreate.result.input.name, "Nested Name");
const beforeInvalid = calls.length;
for (const [command, params] of [
  ["persona.list", { ignored: true }],
  ["persona.get", { profileId: "one", options: { includeStorag: true } }],
  ["persona.create", { input: { name: "No", settings: { routeId: "route-a", unexpected: true } } }],
  ["persona.updateIdentity", { profileId: "one", changes: { colour: "blue" } }],
  ["persona.clone", { profileId: "one", options: { copyCookies: "true" } }],
  ["route.assign", { profileId: "one", routeId: "route-a", options: { allowDirect: "true" } }],
  ["route.assign", { profileId: "one", routeId: "route-a", expectedRevision: "7" }],
  ["route.assign", { profileId: "one", routeId: "route-a", expectedBootId: 7 }],
  ["workflow.jobs.stop", { jobId: "job", unexpected: false }],
  ["batch.execute", { command: "route.assign", personaIds: ["one"], params: { routeId: "route-a", options: { allowDirect: "true" } } }]
]) {
  const response = await request(command, params);
  assert.equal(response.error?.code || response.result?.results?.[0]?.error?.code, PCMS_ERROR_CODES.BAD_REQUEST, `${command} rejects unknown fields and wrong types`);
}
assert.equal(calls.length, beforeInvalid, "invalid inputs must not invoke route assignment");
const cloned = await request("persona.clone", { profileId: "one", options: { copyCookies: true } });
assert.equal(cloned.ok, true);
assert.equal(observed.at(-1).entityId, "cloned");
assert.deepEqual(observed.at(-1).data, { id: "cloned", sourceProfileId: "one" });

assert.equal((await request("persona.get", { profileId: "missing" })).error.code, PCMS_ERROR_CODES.PERSONA_NOT_FOUND);
assert.equal((await request("route.get", { routeId: "missing" })).error.code, PCMS_ERROR_CODES.ROUTE_NOT_FOUND);
assert.equal((await request("workflow.get", { workflowId: "missing" })).error.code, PCMS_ERROR_CODES.WORKFLOW_NOT_FOUND);
assert.equal((await request("workflow.jobs.get", { jobId: "missing" })).error.code, PCMS_ERROR_CODES.JOB_NOT_FOUND);

const runnerCallsBeforeAdmissionChecks = workflowRunCalls.length;
const missingAdmissionControl = createPcmsControlPlane({ personaApi: facade, getRevision: () => revision, bootId: "boot-test" });
const missingAdmission = await missingAdmissionControl.handleRequest({
  type: "PCMS_REQUEST", version: PCMS_PROTOCOL_VERSION, requestId: "workflow-run-no-admission",
  command: "workflow.run", params: { workflowId: "flow" }
});
assert.equal(missingAdmission.ok, false);
assert.equal(missingAdmission.error.code, PCMS_ERROR_CODES.CAPABILITY_UNAVAILABLE,
  "workflow.run must fail closed when the lease-aware admission callback is not injected");
assert.equal(workflowRunCalls.length, runnerCallsBeforeAdmissionChecks,
  "missing admission must never fall back to WorkflowRunner.run");

let refusedAdmissionCalls = 0;
const refusedAdmissionControl = createPcmsControlPlane({
  personaApi: facade,
  getRevision: () => revision,
  bootId: "boot-test",
  runWorkflowAdmission: async () => {
    refusedAdmissionCalls += 1;
    const error = new Error("A Persona is controlled by an external automation");
    error.code = PCMS_ERROR_CODES.CAPABILITY_UNAVAILABLE;
    throw error;
  }
});
const refusedAdmission = await refusedAdmissionControl.handleRequest({
  type: "PCMS_REQUEST", version: PCMS_PROTOCOL_VERSION, requestId: "workflow-run-admission-refused",
  command: "workflow.run", params: { workflowId: "flow" }
});
assert.equal(refusedAdmission.ok, false);
assert.equal(refusedAdmission.error.code, PCMS_ERROR_CODES.CAPABILITY_UNAVAILABLE);
assert.equal(refusedAdmissionCalls, 1, "the guarded admission callback is used");
assert.equal(workflowRunCalls.length, runnerCallsBeforeAdmissionChecks,
  "a refused admission must not invoke WorkflowRunner.run");

let successfulAdmissionId = null;
const admittedControl = createPcmsControlPlane({
  personaApi: facade,
  getRevision: () => revision,
  bootId: "boot-test",
  runWorkflowAdmission: async (workflowId) => {
    successfulAdmissionId = workflowId;
    return facade.WorkflowRunner.run(workflowId);
  }
});
const admitted = await admittedControl.handleRequest({
  type: "PCMS_REQUEST", version: PCMS_PROTOCOL_VERSION, requestId: "workflow-run-admitted",
  command: "workflow.run", params: { workflowId: "flow" }
});
assert.equal(admitted.ok, true, JSON.stringify(admitted.error));
assert.equal(successfulAdmissionId, "flow");
assert.equal(admitted.result.id, "job-flow");
assert.equal(workflowRunCalls.length, runnerCallsBeforeAdmissionChecks + 1);

const callsBeforeStaleBoot = calls.length;
const staleBoot = await request("route.assign", {
  profileId: "one", routeId: "route-a", expectedRevision: 7, expectedBootId: "previous-boot"
}, "stale-boot");
assert.equal(staleBoot.error.code, PCMS_ERROR_CODES.STATE_CONFLICT);
assert.equal(calls.length, callsBeforeStaleBoot, "stale boot must conflict before invoking the mutation");

const assign = await request("route.assign", {
  profileId: "one", routeId: "route-a", expectedRevision: 7, expectedBootId: "boot-test"
}, "assign");
assert.equal(assign.ok, true);
assert.equal(assign.revision, 8);
assert.equal(assign.result.password, "[redacted]");
assert.equal(calls.at(-1)[1], "one", "legacy profileId still targets the current container ID");
assert.equal(calls.at(-1)[3].expectedRevision, 7);
assert.equal(calls.at(-1)[3].expectedBootId, "boot-test");
assert.equal(observed.at(-1).type, "route.assignment.changed");
assert.equal(observed.at(-1).data.routeId, "route-a");
const callsBeforeFencedRoute = calls.length;
const fencedRoute = await request("route.assign", { profileId: "fenced", routeId: "route-a" }, "fenced-route");
assert.equal(fencedRoute.ok, false, "the local mutation fence can reject a Persona write before its handler runs");
assert.equal(calls.length, callsBeforeFencedRoute);

const legacyRevisionOnly = await request("route.assign", {
  profileId: "one", routeId: "route-a", expectedRevision: 8
}, "legacy-revision-only");
assert.equal(legacyRevisionOnly.ok, true, "expectedRevision-only management clients remain valid");
assert.equal(legacyRevisionOnly.revision, 9);
assert.equal(calls.at(-1)[3].expectedRevision, 8);
assert.equal(calls.at(-1)[3].expectedBootId, undefined);

const disabled = await request("route.assign", { profileId: "one", routeId: "disabled" }, "disabled-route");
assert.equal(disabled.error.code, PCMS_ERROR_CODES.ROUTE_DISABLED);
assert.equal(disabled.error.message, "Route is disabled");

const destructive = await request("storage.fullWipe", { profileId: "one" }, "wipe");
assert.equal(destructive.error.code, PCMS_ERROR_CODES.DESTRUCTIVE_CONFIRMATION_REQUIRED);
const destructiveConfirmed = await request("storage.fullWipe", { profileId: "one", confirm: true }, "wipe-confirmed");
assert.equal(destructiveConfirmed.ok, true);
assert.equal(observed.at(-1).type, "persona.changed", "management v1 retains a refresh-compatible change event");
assert.equal(observed.at(-1).entityId, "two");
assert.deepEqual(observed.at(-1).data, {
  id: "two",
  previousProfileId: "one",
  personaUid: PERSONA_UID,
  storageChanged: true
});

peakActive = 0;
const batch = await request("batch.execute", {
  command: "route.test", personaIds: ["one", "bad", "one", "two"], concurrency: 2, failurePolicy: "continue",
  expectedRevision: revision, expectedBootId: "boot-test", params: {}
}, "batch");
assert.equal(batch.ok, true);
assert.deepEqual(batch.result.results.map((row) => row.personaId), ["one", "bad", "two"]);
assert.deepEqual(batch.result.results.map((row) => row.ok), [true, false, true]);
assert.equal(batch.result.results[1].error.code, PCMS_ERROR_CODES.PERSONA_NOT_FOUND);
assert.ok(peakActive <= 2);
assert.equal(batch.result.results[0].result.cookie, "[redacted]");
assert.equal(observed.at(-1).type, "pcms.batch.completed");
assert.equal(fencedCommands.some((entry) => entry.command === "batch.execute"), false,
  "batch admission fences individual items without recursively acquiring the outer fence");

const nestedPrecondition = await request("batch.execute", {
  command: "route.assign",
  personaIds: ["one"],
  params: { routeId: "route-a", expectedRevision: revision }
}, "batch-nested-precondition");
assert.equal(nestedPrecondition.error.code, PCMS_ERROR_CODES.BAD_REQUEST);

const nestedBootPrecondition = await request("batch.execute", {
  command: "route.assign",
  personaIds: ["one"],
  params: { routeId: "route-a", options: { expectedBootId: "boot-test" } }
}, "batch-nested-boot");
assert.equal(nestedBootPrecondition.error.code, PCMS_ERROR_CODES.BAD_REQUEST);

const mutationBatchStart = fencedCommands.filter((entry) => entry.command === "route.assign").length;
const mutationBatch = await request("batch.execute", {
  command: "route.assign", personaIds: ["one", "two"], params: { routeId: "route-a" }
}, "mutation-batch");
assert.equal(mutationBatch.ok, true);
assert.equal(fencedCommands.filter((entry) => entry.command === "route.assign").length - mutationBatchStart, 2,
  "batch mutations pass through the fence for each started Persona item");

const failFast = await request("batch.execute", {
  command: "route.test", personaIds: ["bad", "never-started-a", "never-started-b"], concurrency: 1, failurePolicy: "failFast", params: {}
}, "fail-fast");
assert.deepEqual(failFast.result.results.map((row) => row.personaId), ["bad", "never-started-a", "never-started-b"]);
assert.equal(failFast.result.results[0].error.code, PCMS_ERROR_CODES.PERSONA_NOT_FOUND);
assert.deepEqual(failFast.result.results.slice(1).map((row) => row.error.code), ["BATCH_CANCELLED", "BATCH_CANCELLED"]);
assert.deepEqual(failFast.result.results.slice(1).map((row) => row.error.message), [
  "Batch item was not started after an earlier failure",
  "Batch item was not started after an earlier failure"
]);

const unmanagedFacade = {
  ...facade,
  RouteManager: { ...routeManager, test: async () => { const error = new Error("Persona is not managed"); error.code = "PERSONA_UNMANAGED"; throw error; } }
};
const unmanagedControl = createPcmsControlPlane({ personaApi: unmanagedFacade, getRevision: () => 0, bootId: "boot-test" });
const unmanaged = await unmanagedControl.handleRequest({ type: "PCMS_REQUEST", version: 1, requestId: "unmanaged", command: "batch.execute", params: { command: "route.test", personaIds: ["unmanaged"], params: {} } });
assert.equal(unmanaged.result.results[0].error.code, PCMS_ERROR_CODES.PERSONA_UNMANAGED);

const rejectedBatch = await request("batch.execute", { command: "storage.fullWipe", personaIds: ["one"], params: {} }, "bad-batch");
assert.equal(rejectedBatch.error.code, PCMS_ERROR_CODES.BATCH_COMMAND_NOT_ALLOWED);
const overConcurrency = await request("batch.execute", { command: "route.test", personaIds: ["one"], concurrency: 17, params: {} }, "over-concurrency");
assert.equal(overConcurrency.error.code, PCMS_ERROR_CODES.BATCH_LIMIT_EXCEEDED);
const overSize = await request("batch.execute", { command: "route.test", personaIds: Array.from({ length: 201 }, (_, index) => `p-${index}`), params: {} }, "over-size");
assert.equal(overSize.error.code, PCMS_ERROR_CODES.BATCH_LIMIT_EXCEEDED);

const oversized = await control.handleRequest({ type: "PCMS_REQUEST", version: 1, requestId: "oversized", command: "persona.list", params: { options: { padding: "x".repeat(1024 * 1024) } } });
assert.equal(oversized.error.code, PCMS_ERROR_CODES.BAD_REQUEST);

const explodingFacade = { ...facade, RouteManager: { ...routeManager, test: async () => { throw new Error("credential=super-secret\nstack line"); } } };
const exploding = createPcmsControlPlane({ personaApi: explodingFacade, getRevision: () => 0, bootId: "boot-test" });
const safeFailure = await exploding.handleRequest({ type: "PCMS_REQUEST", version: 1, requestId: "safe", command: "route.test", params: { profileId: "one" } });
assert.equal(safeFailure.error.code, PCMS_ERROR_CODES.INTERNAL_ERROR);
assert.equal(safeFailure.error.message.includes("super-secret"), false);
assert.equal(JSON.stringify(safeFailure).includes("stack line"), false);

const declaredCapabilities = createPcmsControlPlane({
  personaApi: facade,
  getRevision: () => 0,
  bootId: "declared-capabilities",
  capabilities: ["personas", "batch", "events"]
});
const declared = await declaredCapabilities.handleRequest({ type: "PCMS_REQUEST", version: 1, requestId: "declared", command: "system.describe", params: {} });
assert.deepEqual(declared.result.capabilities, ["batch", "events", "personas"]);

console.log("pcms control plane tests passed");
