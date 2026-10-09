import assert from "node:assert/strict";
import { PCMS_COMMAND_DESCRIPTORS, createPcmsControlPlane } from "../lib/pcms-control-plane.js";
import { PCMS_ERROR_CODES, PCMS_PROTOCOL_VERSION } from "../lib/pcms-protocol.js";

let revision = 0;
const facade = {
  PersonaManager: {
    list: async () => [],
    get: async () => null,
    create: async () => ({}),
    open: async () => { revision += 1; return {}; },
    updateIdentity: async () => ({}),
    clone: async () => ({}),
    archive: async () => ({}),
    destroy: async () => ({})
  },
  StorageManager: {
    inspect: async () => ({}), clearCookies: async () => ({}), clearSiteData: async () => ({}), fullWipe: async () => ({})
  },
  RouteManager: {
    list: async () => [], get: async () => null,
    assign: async (profileId, routeId) => { revision += 1; return { profileId, routeId }; },
    test: async (profileId) => ({ profileId, ok: true })
  },
  WorkflowRunner: {
    list: async () => [], get: async () => null, run: async () => ({}),
    listJobs: async () => [], getJob: async () => null, stopJob: async () => ({}), clearFinishedJobs: async () => []
  },
  Diagnostics: { getSystemStatus: async () => ({ ok: true }) }
};

const request = (control, command, params = {}, id = command) => control.handleRequest({
  type: "PCMS_REQUEST", version: PCMS_PROTOCOL_VERSION, requestId: id, command, params
});

const restricted = createPcmsControlPlane({
  personaApi: facade,
  getRevision: () => revision,
  bootId: "restricted",
  capabilities: ["personas", "batch", "events"]
});
const describe = await request(restricted, "system.describe", {}, "describe");
assert.equal(describe.ok, true);
assert.equal(describe.result.capabilities.includes("routes"), false);
assert.equal((await request(restricted, "route.list", {}, "route-list")).error.code, PCMS_ERROR_CODES.CAPABILITY_UNAVAILABLE);
assert.equal((await request(restricted, "route.assign", { profileId: "p1", routeId: "r1" }, "route-assign")).error.code, PCMS_ERROR_CODES.CAPABILITY_UNAVAILABLE);
assert.equal((await request(restricted, "system.status", {}, "status")).error.code, PCMS_ERROR_CODES.CAPABILITY_UNAVAILABLE);

const openMetadata = restricted.getCommand("persona.open");
assert.equal(openMetadata.mutating, true, "persona.open touches persistent usage statistics");
assert.deepEqual(PCMS_COMMAND_DESCRIPTORS["persona.open"].params, { profileId: "id", url: "string", active: "boolean", expectedRevision: "revision", expectedBootId: "bootId" });
assert.deepEqual(PCMS_COMMAND_DESCRIPTORS["persona.open"].required, ["profileId"]);
assert.deepEqual(
  restricted.listCommands().map((entry) => entry.command).sort(),
  Object.keys(PCMS_COMMAND_DESCRIPTORS).sort(),
  "runtime registry must cover every shared command descriptor"
);
for (const entry of restricted.listCommands()) {
  const descriptor = PCMS_COMMAND_DESCRIPTORS[entry.command];
  assert.deepEqual(entry, {
    command: entry.command,
    capability: descriptor.capability,
    mutating: descriptor.mutating,
    batchable: descriptor.batchable,
    destructive: descriptor.destructive
  });
}

const batchRevision = await request(restricted, "batch.execute", {
  command: "persona.open",
  personaIds: ["p1", "p2"],
  params: { expectedRevision: 0 }
}, "batch-revision");
assert.equal(batchRevision.ok, false);
assert.equal(batchRevision.error.code, PCMS_ERROR_CODES.BAD_REQUEST);

const routeBatch = createPcmsControlPlane({
  personaApi: facade, getRevision: () => revision, bootId: "route-batch",
  capabilities: ["routes", "batch"]
});
const revisionBeforeNestedBatch = revision;
const nestedBatchRevision = await request(routeBatch, "batch.execute", {
  command: "route.assign", personaIds: ["p1", "p2"],
  params: { routeId: "r1", options: { expectedRevision: revisionBeforeNestedBatch } }
}, "batch-nested-revision");
assert.equal(nestedBatchRevision.ok, false);
assert.equal(nestedBatchRevision.error.code, PCMS_ERROR_CODES.BAD_REQUEST);
assert.equal(revision, revisionBeforeNestedBatch, "invalid batch must not mutate a persona");

const singleNestedRevision = await request(routeBatch, "batch.execute", {
  command: "route.assign", personaIds: ["p1"],
  params: { routeId: "r1", options: { expectedRevision: revisionBeforeNestedBatch } }
}, "single-nested-revision");
assert.equal(singleNestedRevision.ok, false);
assert.equal(singleNestedRevision.error.code, PCMS_ERROR_CODES.BAD_REQUEST);

const nestedBootRevision = await request(routeBatch, "batch.execute", {
  command: "route.assign", personaIds: ["p1"],
  params: { routeId: "r1", options: { expectedBootId: "route-batch" } }
}, "single-nested-boot");
assert.equal(nestedBootRevision.ok, false);
assert.equal(nestedBootRevision.error.code, PCMS_ERROR_CODES.BAD_REQUEST);

const topLevelRevision = await request(restricted, "batch.execute", {
  command: "persona.open",
  personaIds: ["p1"],
  expectedRevision: 0,
  expectedBootId: "restricted",
  params: {}
}, "batch-top-level-revision");
assert.equal(topLevelRevision.ok, true);
assert.equal(topLevelRevision.result.results[0].ok, true);

console.log("pcms contract hardening tests passed");
