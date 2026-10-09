import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTimerService, TIMER_STATES } from "../../../extension/pcms/services/timers.js";
import { createCoreServiceRegistry } from "../../../extension/pcms/services/registry.js";
import {
  REFRESHER_BACKGROUND_SERVICE, REFRESHER_BACKGROUND_TIMER_ID, createRefresherBackgroundScheduler, createUnattendedRefreshCapability
} from "../../../extension/pcms/integration/refresher-background.js";
import { AUTO_POLICY, createP040Fixture } from "./harness.mjs";

async function wired({ probe = null } = {}) {
  const fx = createP040Fixture();
  await fx.connect();
  await fx.deploy("alpha");
  const listed = await fx.refresher.listCohorts();
  await fx.refresher.createCohort({ cohortId:"daily", name:"Daily", accountId:"acct-1", enabled:true, policy:AUTO_POLICY,
    members:[{ generatorId:"alpha" }] }, { expectedRevision:listed.revision });
  const registry = createCoreServiceRegistry();
  const timers = createTimerService({ storageBroker:fx.ctx.storage, auditJournal:fx.ctx.audit.journal, serviceRegistry:registry, clock:() => fx.now });
  const scheduler = createRefresherBackgroundScheduler({ refresher:fx.refresher, timers, recoveryHold:fx.ctx.recoveryHold, clock:() => fx.now,
    canDispatch:createUnattendedRefreshCapability({ providerProbes:[probe ?? fx.ctx.adapter] }) });
  registry.register(scheduler.serviceName, scheduler.service, { ownerId:scheduler.ownerId, generation:scheduler.generation });
  return { fx, timers, scheduler };
}

test("A040-02 the Refresher pass is a declared Core timer service and runs from a due timer alone", async () => {
  const { fx, timers, scheduler } = await wired();
  assert.equal(REFRESHER_BACKGROUND_SERVICE, "refresher.background");
  const declared = await scheduler.declare();
  assert.equal(declared.value.timerId, REFRESHER_BACKGROUND_TIMER_ID);
  assert.equal(declared.value.state, TIMER_STATES.SCHEDULED);
  assert.equal(declared.value.dueAt, "2026-10-08T12:01:00.000Z");
  // Nothing happens before the due time.
  assert.equal((await timers.runDue({ now:fx.now })).processed.length, 0);
  assert.equal(fx.ctx.emulator.getGenerator("alpha").code, "code of alpha");
  const before = fx.ctx.emulator.dispatched().length;
  fx.setNow("2026-10-08T12:01:00.000Z");
  const due = await timers.runDue({ now:fx.now });
  assert.equal(due.processed.length, 1);
  assert.equal(due.processed[0].value.state, TIMER_STATES.FIRED);
  assert.equal(fx.ctx.emulator.dispatched().length, before + 1, "the timer alone dispatched one refresh");
  assert.equal((await fx.refresher.getCohort("daily")).members[0].operation.status, "SUCCEEDED");
  assert.equal((await scheduler.status()).lastPass.dispatched, 1);
  // Re-declared after delivery: the next occurrence waits for the budget day (horizon-capped).
  const next = await scheduler.declare();
  assert.equal(next.value.state, TIMER_STATES.SCHEDULED);
  assert.equal(next.value.dueAt, "2026-10-08T18:01:00.000Z");
});

test("A040-02 recovery hold pauses the background pass before any provider mutation", async () => {
  const { fx, timers, scheduler } = await wired();
  await scheduler.declare();
  await fx.ctx.recoveryHold.enterRecoveryHold({ reason:"p040-test" });
  fx.setNow("2026-10-08T12:01:00.000Z");
  const before = fx.ctx.emulator.dispatched().length;
  await timers.runDue({ now:fx.now });
  assert.equal(fx.ctx.emulator.dispatched().length, before);
  assert.equal((await scheduler.status()).lastPass.held, true);
  assert.equal((await fx.refresher.getCohort("daily")).members[0].operation.status, "IDLE", "no budget is reserved while held");
});

test("A040-02 an assisted-only provider never gets an unattended background dispatch (capability-gated, fails closed)", async () => {
  // The shipped assisted driver declares unattended:false (P042/P044 own enabling it).
  const assisted = { providerId:"perchance", async probeCompatibility() { return { contractVersion:2, capabilities:{ unattended:false } }; } };
  const { fx, timers, scheduler } = await wired({ probe:assisted });
  const declared = await scheduler.declare();
  assert.equal(declared.value.dueAt, "2026-10-08T18:00:00.000Z", "no per-minute wakes while dispatch is gated");
  const before = fx.ctx.emulator.dispatched().length;
  fx.setNow(declared.value.dueAt);
  await timers.runDue({ now:fx.now });
  assert.equal(fx.ctx.emulator.dispatched().length, before);
  assert.equal((await scheduler.status()).lastPass.gated, true);
  assert.equal((await fx.refresher.getCohort("daily")).members[0].operation.status, "IDLE", "no budget is reserved");
  // Unknown or failing providers fail closed too.
  assert.equal(await createUnattendedRefreshCapability({ providerProbes:[] })(), false);
  assert.equal(await createUnattendedRefreshCapability({ providerProbes:[{ providerId:"perchance", async probeCompatibility() { throw new Error("x"); } }] })(), false);
  assert.equal(await createUnattendedRefreshCapability({ providerProbes:[fx.ctx.adapter] })(), true, "the emulator declares unattended");
});

test("A040-02 nothing declared when no automatic cohort follows a release", async () => {
  const fx = createP040Fixture();
  const registry = createCoreServiceRegistry();
  const timers = createTimerService({ storageBroker:fx.ctx.storage, auditJournal:fx.ctx.audit.journal, serviceRegistry:registry, clock:() => fx.now });
  const scheduler = createRefresherBackgroundScheduler({ refresher:fx.refresher, timers, clock:() => fx.now });
  registry.register(scheduler.serviceName, scheduler.service, { ownerId:scheduler.ownerId, generation:scheduler.generation });
  assert.equal(await scheduler.declare(), null);
  assert.equal(await timers.get(REFRESHER_BACKGROUND_TIMER_ID), null);
});

test("A040-02 the background Core registers, declares and re-declares the Refresher timer; the module owns no scheduler", async () => {
  const [factory, refresher, ui] = await Promise.all([
    readFile("extension/pcms/background/core-factory.js", "utf8"),
    readFile("pcms-modules/p017/refresher.js", "utf8"),
    readFile("pcms-modules/p017/ui.js", "utf8")
  ]);
  assert.match(factory, /createRefresherBackgroundScheduler/);
  assert.match(factory, /timerServices\.register\(refresherScheduler\.serviceName/);
  assert.match(factory, /try\{await refresherScheduler\.declare\(\);\}catch\{\}/);
  assert.match(factory, /change\.timerId===REFRESHER_BACKGROUND_TIMER_ID/);
  assert.match(factory, /bindRefresherWake/);
  assert.match(factory, /canDispatch:core\.refresherUnattended/);
  for (const source of [refresher, ui]) assert.doesNotMatch(source, /setInterval|setTimeout|createTimerService|browser\s*\.\s*alarms/);
});
