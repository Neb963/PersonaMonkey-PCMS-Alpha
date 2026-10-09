import assert from "node:assert/strict";
import { createPcmsControlPlane } from "../lib/pcms-control-plane.js";
import { PCMS_ERROR_CODES } from "../lib/pcms-protocol.js";

const wire = (requestId, command, params = {}) => ({ type: "PCMS_REQUEST", version: 1, requestId, command, params });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

let time = 0;
let revision = 3;
let wipeCalls = 0;
const wipe = deferred();
const plane = createPcmsControlPlane({
  personaApi: { StorageManager: { async fullWipe() { wipeCalls += 1; await wipe.promise; revision += 1; return { id: "replacement" }; } } },
  bootId: "boot-a", getRevision: () => revision, replayNow: () => time
});
const original = wire("wipe-1", "storage.fullWipe", { profileId: "one", confirm: true, expectedRevision: 3, expectedBootId: "boot-a" });
const concurrent = plane.handleRequest(original);
const joined = plane.handleRequest(wire("wipe-1", "storage.fullWipe", { expectedBootId: "boot-a", confirm: true, profileId: "one", expectedRevision: 3 }));
for (let tick = 0; tick < 5 && wipeCalls === 0; tick += 1) await Promise.resolve();
assert.equal(wipeCalls, 1, "same requestId and JSON payload must share in-flight destructive work");
const conflict = await plane.handleRequest(wire("wipe-1", "storage.fullWipe", { profileId: "two", confirm: true }));
assert.equal(conflict.error.code, PCMS_ERROR_CODES.REQUEST_ID_CONFLICT);
assert.equal(wipeCalls, 1);
time = 6 * 60 * 1000;
const stillJoined = plane.handleRequest(original);
assert.equal(wipeCalls, 1, "in-flight entries must survive the completed-response TTL");
wipe.resolve();
const first = await concurrent;
assert.equal(first.ok, true);
assert.equal(first.revision, 4);
assert.deepEqual(await joined, first);
assert.deepEqual(await stillJoined, first);
revision = 9;
assert.deepEqual(await plane.handleRequest(original), first, "completed retry replays original envelope, even after revision changes");
assert.equal(wipeCalls, 1);
const otherCommand = await plane.handleRequest(wire("wipe-1", "storage.clearCookies", { profileId: "one", confirm: true }));
assert.equal(otherCommand.error.code, PCMS_ERROR_CODES.REQUEST_ID_CONFLICT);

const bad = await plane.handleRequest(wire("invalid", "storage.fullWipe", { profileId: "one" }));
assert.equal(bad.error.code, PCMS_ERROR_CODES.DESTRUCTIVE_CONFIRMATION_REQUIRED);
revision = 10;
assert.deepEqual(await plane.handleRequest(wire("invalid", "storage.fullWipe", { profileId: "one" })), bad, "failed mutations replay their original error envelope");
assert.equal((await plane.handleRequest(wire("invalid", "storage.fullWipe", { profileId: "one", confirm: true }))).error.code, PCMS_ERROR_CODES.REQUEST_ID_CONFLICT);
assert.equal(wipeCalls, 1);

let batchCalls = 0;
const emitted = [];
const batches = createPcmsControlPlane({
  personaApi: { RouteManager: { async assign(profileId) { batchCalls += 1; return { profileId }; } } },
  eventHub: { emit: (event) => emitted.push(event) }, bootId: "boot-b", getRevision: () => 1
});
const batchRequest = wire("batch-1", "batch.execute", { command: "route.assign", personaIds: ["one", "two"], params: { routeId: "route" } });
const batchResult = await batches.handleRequest(batchRequest);
assert.equal(batchResult.ok, true);
assert.equal(batchCalls, 2);
assert.deepEqual(await batches.handleRequest(batchRequest), batchResult);
assert.equal(batchCalls, 2, "replaying a batch must not repeat its children");
assert.equal(emitted.filter((event) => event.type === "pcms.batch.completed").length, 1);

let opens = 0;
const bounded = createPcmsControlPlane({
  personaApi: { PersonaManager: { async open() { opens += 1; return { opens }; } } },
  getRevision: () => 0, bootId: "boot-c", replayNow: () => time
});
for (let index = 0; index < 32; index += 1) {
  assert.equal((await bounded.handleRequest(wire(`open-${index}`, "persona.open", { profileId: "one" }))).ok, true);
}
assert.equal(opens, 32);
const full = await bounded.handleRequest(wire("extra", "persona.open", { profileId: "one" }));
assert.equal(full.error.code, PCMS_ERROR_CODES.REPLAY_CAPACITY);
assert.equal(full.error.retryable, true);
assert.equal(opens, 32, "capacity refusal must happen before a mutation");
assert.equal((await bounded.handleRequest(wire("open-0", "persona.open", { profileId: "one" }))).result.opens, 1);
time += 5 * 60 * 1000 - 1;
assert.equal((await bounded.handleRequest(wire("extra", "persona.open", { profileId: "one" }))).error.code, PCMS_ERROR_CODES.REPLAY_CAPACITY);
time += 1;
assert.equal((await bounded.handleRequest(wire("extra", "persona.open", { profileId: "one" }))).ok, true);
assert.equal(opens, 33, "expired entries must be pruned deterministically on the next request");
assert.equal((await bounded.handleRequest(wire("open-0", "persona.open", { profileId: "one" }))).ok, true);
assert.equal(opens, 34, "an ID can execute again after its replay window expires");

const gate = deferred();
let pendingOpens = 0;
const saturated = createPcmsControlPlane({
  personaApi: { PersonaManager: { async open() { pendingOpens += 1; await gate.promise; return { pendingOpens }; } } },
  getRevision: () => 0, bootId: "boot-pending", replayNow: () => time
});
const pending = Array.from({ length: 32 }, (_, index) => saturated.handleRequest(wire(`pending-${index}`, "persona.open", { profileId: "one" })));
const duplicatePending = saturated.handleRequest(wire("pending-0", "persona.open", { profileId: "one" }));
const noSlot = await saturated.handleRequest(wire("pending-extra", "persona.open", { profileId: "one" }));
assert.equal(noSlot.error.code, PCMS_ERROR_CODES.REPLAY_CAPACITY);
assert.equal(pendingOpens, 32);
time += 5 * 60 * 1000;
assert.equal((await saturated.handleRequest(wire("pending-extra", "persona.open", { profileId: "one" }))).error.code, PCMS_ERROR_CODES.REPLAY_CAPACITY);
gate.resolve();
const finished = await Promise.all(pending);
assert.deepEqual(await duplicatePending, finished[0]);
assert.equal(pendingOpens, 32);

const restarted = createPcmsControlPlane({
  personaApi: { PersonaManager: { async open() { opens += 1; return { opens }; } } },
  getRevision: () => 0, bootId: "boot-d"
});
assert.equal((await restarted.handleRequest(wire("extra", "persona.open", { profileId: "one" }))).ok, true);
assert.equal(opens, 35, "the replay table is process-local and does not survive restart");

console.log("pcms replay tests passed");
