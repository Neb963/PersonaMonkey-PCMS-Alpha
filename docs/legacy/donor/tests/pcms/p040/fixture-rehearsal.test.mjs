// Local rehearsal of the A040-02 packaged proof: the fixture background composition runs in
// Node over the accepted memory storage backends with a fake browser.alarms. A "wake" is a new
// background context over the same durable rows, exactly as after an event-page unload.
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createP040Background, P040_FIXTURE_BUDGET } from "./fixture-background.js";
import { makeDurable } from "../p028/harness.mjs";
import { PCMS_TIMER_ALARM_NEXT } from "../../../extension/pcms/background/alarms/coordinator.js";

const pcmsBase = pathToFileURL(resolve("extension/pcms") + "/").href;
const modulesBase = pathToFileURL(resolve("pcms-modules") + "/").href;

function fakeAlarms() {
  const alarms = new Map();
  return {
    alarms:{
      async create(name, info) { alarms.set(name, { name, scheduledTime:info.when ?? null, periodInMinutes:info.periodInMinutes ?? null }); },
      async clear(name) { return alarms.delete(name); },
      async get(name) { return alarms.get(name) ?? null; },
      async getAll() { return [...alarms.values()]; }
    },
    map:alarms
  };
}

test("A040-02 rehearsal: after an unload, the alarm alone wakes a fresh context that refreshes within budget", async () => {
  const shared = { rows:new Map() };
  const browser = fakeAlarms();
  let clock = "2026-10-08T12:00:00.000Z";
  const now = () => clock;
  const context = () => {
    const durable = makeDurable(shared, { now:clock });
    return createP040Background({ pcmsBase, modulesBase, browserRef:browser, storageBroker:durable.storageBroker, auditJournal:durable.auditJournal, now });
  };
  const first = await context();
  await first.start("COLD");
  let status = await first.status();
  assert.ok(status.seededAt);
  assert.deepEqual(status.confirmed.map((c) => c.confirmed), [true, true, true]);
  assert.equal(status.timer.state, "SCHEDULED");
  assert.equal(status.timer.dueAt, "2026-10-08T12:01:00.000Z");
  assert.equal(browser.map.get(PCMS_TIMER_ALARM_NEXT).scheduledTime, Date.parse("2026-10-08T12:01:00.000Z"));
  assert.equal(status.cohort.budget.used, 0);

  // Unload: the first context is dropped. The alarm fires later into a brand-new context.
  clock = "2026-10-08T12:01:00.500Z";
  const woken = await context();
  await woken.start("WARM");
  await woken.handleAlarm(PCMS_TIMER_ALARM_NEXT);
  status = await woken.status();
  assert.equal(status.starts.length, 2);
  assert.equal(status.passes.length, 1);
  assert.equal(status.passes[0].lastPass.dispatched, P040_FIXTURE_BUDGET);
  assert.deepEqual(status.cohort.budget, { limit:2, used:2, remaining:0 });
  assert.deepEqual(status.cohort.members.map((m) => m.operationStatus), ["SUCCEEDED", "SUCCEEDED", "IDLE"]);
  assert.equal(status.refreshOperations.length, 2);
  assert.ok(status.refreshOperations.every((op) => op.state === "SUCCEEDED" && op.intentFingerprint.startsWith("perchance:generator-release:v2:")));
  assert.equal(status.refresherStoresContent, false);
  assert.equal(status.timer.state, "SCHEDULED", "the next pass is re-declared");
  assert.equal(status.timer.dueAt, "2026-10-08T18:01:00.500Z");
  // Another wake inside the same day never exceeds the budget.
  clock = "2026-10-08T18:02:00.000Z";
  const later = await context();
  await later.start("WARM");
  status = await later.status();
  assert.deepEqual(status.cohort.budget, { limit:2, used:2, remaining:0 });
  assert.equal(status.refreshOperations.length, 2);
});
