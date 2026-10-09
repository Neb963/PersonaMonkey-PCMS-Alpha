// P031 A031-02: module schedules run through the Core durable timer service with zero PCMS
// tabs, survive event-page unload and browser restart, and catch up a bounded number of
// times. A context here is the background Core alone: no UI client is ever connected.
import assert from "node:assert/strict";
import test from "node:test";

import { MODULE_STATUS, moduleActivationBackoffMs } from "../../../extension/pcms/background/modules/supervisor.js";
import { FIXTURE_MODULE_ID, FIXTURE_TICK_MS, buildCounterArchiveText } from "../../fixtures/modules/counter.mjs";
import { interruptTimer, makeWorld, moduleData, openContext } from "./harness.mjs";

const ID = FIXTURE_MODULE_ID;
const TIMER = "module." + ID + "/tick";

async function installed(world, options = {}) {
  const ctx = await openContext(world);
  const staged = await ctx.core.modules.install(buildCounterArchiveText(options));
  await ctx.core.modules.approve(ID, staged.candidate.packageHash);
  return ctx;
}

async function tickTimer(ctx) {
  return (await ctx.core.modules.get(ID)).timers.find((timer) => timer.name === "tick");
}

test("A031-02 a declared schedule fires through the Core timer service with no PCMS tab", async (t) => {
  const world = makeWorld();
  const ctx = await installed(world);
  t.after(() => ctx.unload());
  const declared = await tickTimer(ctx);
  assert.equal(declared.state, "SCHEDULED");
  assert.equal(Date.parse(declared.dueAt) - Date.parse(world.clock()), FIXTURE_TICK_MS);

  world.clock.advance(FIXTURE_TICK_MS - 1000);
  assert.deepEqual((await ctx.duePass()).processed, [], "nothing is due early");
  world.clock.advance(2000);
  const pass = await ctx.duePass();
  assert.deepEqual(pass.processed.map((row) => [row.value.timerId, row.value.state]), [[TIMER, "FIRED"]]);
  assert.equal((await moduleData(world, ID)).ticks.count, 1);
  // The next occurrence, declared inside onTimer while the timer was DISPATCHING, applies.
  const next = await tickTimer(ctx);
  assert.equal(next.state, "SCHEDULED");
  assert.equal(next.dueAt, new Date(Date.parse(world.clock()) + FIXTURE_TICK_MS).toISOString());

  for (let i = 0; i < 3; i += 1) { world.clock.advance(FIXTURE_TICK_MS); await ctx.duePass(); }
  assert.equal((await moduleData(world, ID)).ticks.count, 4);
});

test("A031-02 after event-page unload the next context activates the module lazily and delivers", async (t) => {
  const world = makeWorld();
  const first = await installed(world);
  first.unload();

  const second = await openContext(world, { wake: "WARM" });
  t.after(() => second.unload());
  assert.deepEqual([...second.initialized.schedulerModules], [ID], "the scheduler is registered before the due pass");
  const idle = await second.core.modules.get(ID);
  assert.equal(idle.status, MODULE_STATUS.READY, "no controller runs until work addresses it");
  assert.equal(idle.running, false);
  assert.equal(second.document.created.length, 0);

  world.clock.advance(FIXTURE_TICK_MS + 1000);
  await second.duePass();
  assert.equal((await moduleData(world, ID)).ticks.count, 1);
  const active = await second.core.modules.get(ID);
  assert.equal(active.status, MODULE_STATUS.ACTIVE);
  assert.equal(active.generation > 1, true, "rehydration starts a new generation");
  assert.equal((await tickTimer(second)).state, "SCHEDULED");
});

test("A031-02 an occurrence interrupted by unload is delivered once on the next wake", async (t) => {
  const world = makeWorld();
  const first = await installed(world);
  world.clock.advance(FIXTURE_TICK_MS + 1000);
  await interruptTimer(world, TIMER);
  first.unload();

  const second = await openContext(world, { wake: "WARM" });
  t.after(() => second.unload());
  await second.duePass();
  assert.equal((await moduleData(world, ID)).ticks.count, 1, "the interrupted occurrence ran exactly once");
  assert.equal((await tickTimer(second)).state, "SCHEDULED");
  await second.duePass();
  assert.equal((await moduleData(world, ID)).ticks.count, 1, "no duplicate delivery");
});

test("A031-02 a browser restart days later catches up once, not once per missed occurrence", async (t) => {
  const world = makeWorld();
  const first = await installed(world);
  first.unload();

  world.clock.advance(3 * 24 * 60 * 60 * 1000);
  const restarted = await openContext(world, { wake: "COLD" });
  t.after(() => restarted.unload());
  const pass = await restarted.duePass({ wakeKind: "COLD" });
  assert.deepEqual(pass.processed.map((row) => [row.value.state, row.value.missedReason]), [["MISSED", "overdue"]]);
  const catchUp = await tickTimer(restarted);
  assert.equal(catchUp.state, "SCHEDULED");
  assert.equal(catchUp.dueAt, world.clock(), "one bounded catch-up occurrence");
  await restarted.duePass({ wakeKind: "COLD" });
  assert.equal((await moduleData(world, ID)).ticks.count, 1);
  await restarted.duePass({ wakeKind: "COLD" });
  assert.equal((await moduleData(world, ID)).ticks.count, 1);
  world.clock.advance(FIXTURE_TICK_MS);
  await restarted.duePass();
  assert.equal((await moduleData(world, ID)).ticks.count, 2, "normal cadence resumes");
});

test("A031-02 a failing activation backs off, raises Attention and recovers", async (t) => {
  const world = makeWorld();
  const first = await installed(world);
  first.unload();

  // The next context cannot load controller frames.
  const broken = await openContext(world, { wake: "WARM", documentMode: "error" });
  world.clock.advance(FIXTURE_TICK_MS + 1000);
  const pass = await broken.duePass();
  assert.deepEqual(pass.processed.map((row) => [row.value.state, row.value.missedReason]), [["MISSED", "delivery-failed"]]);
  const failed = await broken.core.modules.get(ID);
  assert.equal(failed.status, MODULE_STATUS.UNAVAILABLE);
  assert.equal(failed.failures, 1);
  assert.equal(Date.parse(failed.nextAttemptAt) - Date.parse(world.clock()), moduleActivationBackoffMs(1));
  const retry = await tickTimer(broken);
  assert.equal(retry.state, "SCHEDULED");
  assert.equal(retry.dueAt, failed.nextAttemptAt, "the retry waits for the backoff");
  const attention = (await broken.core.humanTasks.listAttention()).filter((task) => task.value.taskKind === "module.unavailable");
  assert.equal(attention.length, 1);
  assert.equal(attention[0].value.priority, "HIGH");

  world.clock.advance(moduleActivationBackoffMs(1));
  await broken.duePass();
  const twice = await broken.core.modules.get(ID);
  assert.equal(twice.failures, 2);
  assert.equal(Date.parse(twice.nextAttemptAt) - Date.parse(world.clock()), moduleActivationBackoffMs(2));
  assert.equal((await broken.core.humanTasks.listAttention()).filter((task) => task.value.taskKind === "module.unavailable").length, 1,
    "one Attention task per failure episode");
  broken.unload();

  const healed = await openContext(world, { wake: "WARM" });
  t.after(() => healed.unload());
  world.clock.advance(moduleActivationBackoffMs(2));
  await healed.duePass();
  assert.equal((await moduleData(world, ID)).ticks.count, 1);
  const recovered = await healed.core.modules.get(ID);
  assert.equal(recovered.status, MODULE_STATUS.ACTIVE);
  assert.equal(recovered.failures, 0);
  assert.deepEqual((await healed.core.humanTasks.listAttention()).filter((task) => task.value.taskKind === "module.unavailable"), []);
  assert.equal(moduleActivationBackoffMs(30), 30 * 60 * 1000, "backoff is capped at 30 minutes");
});

test("A031-02 an unsupported browser leaves schedules waiting instead of spinning", async (t) => {
  const world = makeWorld();
  const first = await installed(world);
  first.unload();
  const old = await openContext(world, { wake: "WARM", support: { state: "UNAVAILABLE", reason: "BROWSER_TOO_OLD", message: "Requires Firefox 154+", browser: null } });
  t.after(() => old.unload());
  world.clock.advance(FIXTURE_TICK_MS + 1000);
  await old.duePass();
  const status = await old.core.modules.get(ID);
  assert.equal(status.status, MODULE_STATUS.UNAVAILABLE);
  assert.equal(status.reason, "Requires Firefox 154+");
  assert.equal(old.document.created.length, 0);
  assert.deepEqual(status.timers.map((timer) => [timer.state, timer.missedReason]), [["MISSED", "delivery-failed"]]);
  await old.duePass();
  assert.deepEqual((await old.core.modules.get(ID)).timers.map((timer) => timer.state), ["MISSED"], "no catch-up loop without a runtime");
});

test("A031-02 disabling a module stops its schedule across contexts", async (t) => {
  const world = makeWorld();
  const first = await installed(world);
  await first.core.modules.disable(ID);
  first.unload();
  const second = await openContext(world, { wake: "WARM" });
  t.after(() => second.unload());
  world.clock.advance(2 * FIXTURE_TICK_MS);
  await second.duePass();
  assert.equal((await moduleData(world, ID)).ticks, undefined);
  assert.equal(second.document.created.length, 0);
});
