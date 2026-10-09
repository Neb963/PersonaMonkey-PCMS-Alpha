import assert from "node:assert/strict";
import { createPcmsControlPlane } from "../lib/pcms-control-plane.js";
import { paginatePcmsCollection } from "../lib/pcms-pagination.js";
import { PCMS_ERROR_CODES } from "../lib/pcms-protocol.js";

const personas = Array.from({ length: 150 }, (_, i) => ({ id: `persona-${String(149 - i).padStart(3, "0")}`, name: `Persona ${i}` }));
let revision = 1;
let applied = 0;
const steps = Array.from({ length: 150 }, (_, i) => ({
  id: `step-${i}`, profileId: "persona-001", urls: i === 0
    ? Array.from({ length: 150 }, (_, j) => `https://example.com/${i}/${j}?token=private-${j}`)
    : [`https://example.com/${i}?token=private-${i}`],
  concurrency: 1, completion: { mode: i === 0 ? "selector" : "load", value: i === 0 ? "#private-selector" : "", timeoutMs: 1000 }, retries: 0, retryDelayMs: 1000
}));
let workflow = { id: "w1", name: "Large workflow", enabled: true, steps };
const script = { id: "large-script", name: "Large script", matches: Array.from({ length: 501 }, (_, i) => `https://host-${i}.example/*`),
  assignedProfileIds: Array.from({ length: 201 }, (_, i) => `persona-${i}`) };
const control = createPcmsControlPlane({
  personaApi: {
    PersonaManager: { list: async () => personas, get: async () => null },
    RouteManager: { list: async () => [], assign: async (profileId) => {
      applied += 1;
      return profileId === "batch-oversize" ? { data: "x".repeat(5000) } : { assigned: true };
    }, test: async () => ({ ok: true }) },
    UserscriptManager: { list: async () => [script], get: async () => script },
    WorkflowRunner: { list: async () => [workflow], get: async () => workflow,
      update: async (id, input) => { workflow = input; return workflow; }, listJobs: async () => [] }
  }, getRevision: () => revision, bootId: "pagination-test"
});
let serial = 0;
const request = (command, params = {}) => control.handleRequest({
  type: "PCMS_REQUEST", version: 1, requestId: `cardinality-${++serial}`, command, params
});

const complete = await request("persona.list");
assert.equal(complete.ok, true);
assert.equal(complete.result.length, 150);
assert.equal(complete.result[149].id, "persona-149");
for (const response of [await request("userscript.get", { scriptId: script.id }),
  await request("userscript.list", { page: { size: 1 } })]) {
  assert.equal(response.ok, true, JSON.stringify(response.error));
  const item = response.result.items?.[0] || response.result;
  assert.equal(item.matches.length, 501);
  assert.equal(item.assignedProfileIds.length, 201);
}

const seen = [];
let cursor;
do {
  const response = await request("persona.list", { page: { size: 37, ...(cursor ? { cursor } : {}) } });
  assert.equal(response.ok, true);
  assert.equal(response.result.hasMore, Boolean(response.result.nextCursor));
  seen.push(...response.result.items.map((item) => item.id));
  cursor = response.result.nextCursor;
} while (cursor);
assert.deepEqual(seen, Array.from({ length: 150 }, (_, i) => `persona-${String(i).padStart(3, "0")}`));
const first = await request("persona.list", { page: { size: 20 } });
assert.equal((await request("persona.list", { page: { size: 20, cursor: "garbage" } })).error.code, PCMS_ERROR_CODES.PAGE_INVALID);
assert.equal((await request("persona.list", { page: { size: null } })).error.code, PCMS_ERROR_CODES.PAGE_INVALID);
const firstCursorPayload = JSON.parse(Buffer.from(first.result.nextCursor, "base64url").toString("utf8"));
const legacyCursorPayload = { ...firstCursorPayload };
delete legacyCursorPayload.signature;
assert.equal((await request("persona.list", { page: { size: 20,
  cursor: Buffer.from(JSON.stringify(legacyCursorPayload)).toString("base64url") } })).error.code, PCMS_ERROR_CODES.PAGE_INVALID);
const tamperedOffset = { ...firstCursorPayload, offset: firstCursorPayload.offset + 1 };
assert.equal((await request("persona.list", { page: { size: 20,
  cursor: Buffer.from(JSON.stringify(tamperedOffset)).toString("base64url") } })).error.code, PCMS_ERROR_CODES.PAGE_INVALID);
const tamperedSnapshot = { ...firstCursorPayload, digest: "a".repeat(64) };
assert.equal((await request("persona.list", { page: { size: 20,
  cursor: Buffer.from(JSON.stringify(tamperedSnapshot)).toString("base64url") } })).error.code, PCMS_ERROR_CODES.PAGE_INVALID);
const second = await request("persona.list", { page: { size: 20, cursor: first.result.nextCursor } });
const repeatedSecond = await request("persona.list", { page: { size: 20, cursor: first.result.nextCursor } });
assert.equal(second.ok, true, JSON.stringify(second.error));
assert.deepEqual(repeatedSecond.result, second.result, "replaying a valid cursor must return the same page");
await assert.rejects(
  paginatePcmsCollection(personas, { page: { size: 20, cursor: first.result.nextCursor },
    command: "persona.list", bootId: "pagination-test-restarted", revision }),
  (error) => error.code === PCMS_ERROR_CODES.PAGE_STALE,
  "a signed cursor from a prior worker must be stale after restart"
);
const emptyRoutes = await request("route.list", { page: { size: 20 } });
assert.equal(emptyRoutes.ok, true, JSON.stringify(emptyRoutes.error));
assert.deepEqual(emptyRoutes.result, { items: [], hasMore: false, nextCursor: null });
assert.equal((await request("persona.list", { page: { size: 21, cursor: first.result.nextCursor } })).error.code, PCMS_ERROR_CODES.PAGE_INVALID);
revision += 1;
assert.equal((await request("persona.list", { page: { size: 20, cursor: first.result.nextCursor } })).error.code, PCMS_ERROR_CODES.PAGE_STALE);
revision -= 1;
personas[0].name = "Changed without revision";
assert.equal((await request("persona.list", { page: { size: 20, cursor: first.result.nextCursor } })).error.code, PCMS_ERROR_CODES.PAGE_STALE);

const projection = await request("workflow.get", { workflowId: "w1" });
assert.equal(projection.ok, true);
assert.equal(projection.result.steps.length, 150);
assert.equal(projection.result.steps[0].urlCount, 150);
assert.equal("urls" in projection.result.steps[149], false);
const updated = await request("workflow.update", { workflowId: "w1", workflow: projection.result });
assert.equal(updated.ok, true, JSON.stringify(updated.error));
assert.deepEqual(workflow.steps.map((step) => step.urls), steps.map((step) => step.urls));
assert.equal(workflow.steps[0].completion.value, "#private-selector");
assert.equal(workflow.steps[149].completion.value, "");

const batch = await request("batch.execute", { command: "route.assign",
  personaIds: Array.from({ length: 200 }, (_, i) => `batch-${i}`), params: { routeId: "route-1" } });
assert.equal(batch.ok, true, JSON.stringify(batch.error));
assert.equal(batch.result.results.length, 200);
assert.equal(batch.result.results[199].personaId, "batch-199");
assert.equal(applied, 200);
const oversizedRow = await request("batch.execute", { command: "route.assign",
  personaIds: ["batch-oversize"], params: { routeId: "route-1" } });
assert.equal(oversizedRow.ok, true);
assert.equal(oversizedRow.result.results.length, 1);
assert.equal(oversizedRow.result.results[0].applied, true);
assert.equal(oversizedRow.result.results[0].error.code, PCMS_ERROR_CODES.RESULT_TOO_LARGE);
assert.equal(applied, 201);

console.log("PCMS pagination and cardinality tests passed");
