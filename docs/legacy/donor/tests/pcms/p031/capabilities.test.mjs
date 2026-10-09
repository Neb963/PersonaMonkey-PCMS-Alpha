// P031 A031-02 (SEC): a runtime module reaches PCMS only through capability set v1, only for
// the names its admitted authority grants, within fixed bounds, scoped to itself.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_CAPABILITY_ERROR_CODES as E,
  MODULE_CAPABILITY_LIMITS as L,
  PCMS_MODULE_CAPABILITIES_CONTRACT,
  createModuleCapabilityHandlers,
  createPerchanceModuleCapabilityHandlers,
  redactModuleAuditData
} from "../../../extension/pcms/background/modules/capabilities.js";
import { createModuleScheduleStore } from "../../../extension/pcms/background/modules/schedules.js";
import { generatorSourceFingerprint, sha256Hex } from "../../../extension/pcms/providers/perchance/contract.js";
import { FIXTURE_MODULE_ID, buildCounterArchiveText } from "../../fixtures/modules/counter.mjs";
import { auditEvents, makeWorld, moduleData, openContext } from "./harness.mjs";

const ID = FIXTURE_MODULE_ID;

async function installed(world, options = {}) {
  const ctx = await openContext(world);
  const staged = await ctx.core.modules.install(buildCounterArchiveText(options));
  await ctx.core.modules.approve(ID, staged.candidate.packageHash);
  return ctx;
}

function contextFor(moduleId, generation = 1) {
  return Object.freeze({ moduleId, generation, packageHash: "sha256:" + "0".repeat(64), assertCurrent: async () => {} });
}

test("A031-02 the controller sees only granted capabilities, within bounds, and no browser API", async (t) => {
  const world = makeWorld();
  const ctx = await installed(world, { nonce: "sec" });
  t.after(() => ctx.unload());
  const facts = await ctx.core.modules.call(ID, "probe", null);
  assert.equal(facts.browserAbsent, true);
  assert.equal(facts.chromeAbsent, true);
  assert.equal(facts.ungrantedDenied, true, "core.generators.read is not in the approved authority");
  assert.equal(facts.ungrantedCode, "PCMS_SANDBOX_CAPABILITY_DENIED");
  assert.equal(facts.oversizedRejected, true, "a 40 KiB value exceeds the 32 KiB bound");
  assert.equal(facts.shortTimerRejected, true, "timers shorter than one minute are refused");
  assert.equal(facts.attentionOpened, true);
  assert.equal(facts.attentionSettled, "RESOLVED");
  assert.equal((await moduleData(world, ID)).big, undefined);
  assert.deepEqual(facts.timers.map((timer) => timer.name), ["tick"]);
});

test("A031-02 module audit events are journaled under the module subject with secrets redacted", async (t) => {
  const world = makeWorld();
  const ctx = await installed(world, { nonce: "audit" });
  t.after(() => ctx.unload());
  await ctx.core.modules.call(ID, "probe", null);
  const events = await auditEvents(world);
  const probed = events.find((event) => event.type === "module.event.probed");
  assert.deepEqual(probed.subject, { kind: "module", id: ID });
  assert.equal(probed.data.data.apiToken, "[REDACTED]");
  assert.equal(probed.data.data.ok, true);
  assert.ok(events.some((event) => event.type === "module.lifecycle.approved"));
  const everything = JSON.stringify([...world.shared.rows.values()]);
  assert.equal(everything.includes("fixture-secret-audit"), false, "the secret value is in no durable row");
  assert.deepEqual(redactModuleAuditData({ nested: { password: "x", Authorization: "y", list: [{ sessionCookie: "z" }] }, count: 2 }),
    { nested: { password: "[REDACTED]", Authorization: "[REDACTED]", list: [{ sessionCookie: "[REDACTED]" }] }, count: 2 });
});

test("A031-02 storage is scoped per module, CAS-guarded and bounded", async (t) => {
  const world = makeWorld();
  const ctx = await installed(world);
  t.after(() => ctx.unload());
  const handlers = createModuleCapabilityHandlers({ resolve: () => ({ storageBroker: ctx.core.storageBroker, clock: world.clock }) });
  const a = contextFor(ID);
  const b = contextFor("other.module");
  assert.equal((await handlers["module.storage.write"]({ key: "k", expectedRevision: 0, value: { v: 1 } }, a)).ok, true);
  assert.equal((await handlers["module.storage.read"]({ key: "k" }, b)).value, null, "another module cannot see it");
  const conflict = await handlers["module.storage.write"]({ key: "k", expectedRevision: 0, value: 2 }, a);
  assert.deepEqual({ ...conflict }, { ok: false, code: E.CONFLICT, currentRevision: 1 });
  await assert.rejects(handlers["module.storage.write"]({ key: "k", expectedRevision: 1, value: "x".repeat(L.storageValueBytes) }, a), { code: E.LIMIT });
  await assert.rejects(handlers["module.storage.write"]({ key: "x".repeat(L.storageKeyBytes + 1), expectedRevision: 0, value: 1 }, a), { code: E.INVALID_ARGUMENT });
  await assert.rejects(handlers["module.storage.read"]({ key: "k", extra: true }, a), { code: E.INVALID_ARGUMENT });
  assert.equal((await handlers["module.storage.write"]({ key: "k", expectedRevision: 1, delete: true }, a)).ok, true);
  assert.equal((await handlers["module.storage.read"]({ key: "k" }, a)).revision, 0);
});

test("A031-02 recovery hold blocks module mutations but not reads", async () => {
  const world = makeWorld();
  const ctx = await openContext(world);
  try {
    const recoveryHold = { getStatus: async () => ({ value: { state: "RECOVERY_HOLD" } }) };
    const handlers = createModuleCapabilityHandlers({
      resolve: () => ({ storageBroker: ctx.core.storageBroker, auditJournal: ctx.core.auditJournal, humanTasks: ctx.core.humanTasks,
        timers: ctx.core.timers, schedules: createModuleScheduleStore({ storageBroker: ctx.core.storageBroker }), recoveryHold, clock: world.clock })
    });
    const a = contextFor(ID);
    for (const [name, input] of [
      ["module.storage.write", { key: "k", expectedRevision: 0, value: 1 }],
      ["module.timers.ensure", { name: "tick", delayMs: 60000 }],
      ["module.timers.cancel", { name: "tick" }],
      ["module.attention.open", { key: "a", title: "A" }],
      ["module.audit.append", { type: "x", data: null }]
    ]) {
      await assert.rejects(handlers[name](input, a), { code: E.RECOVERY_HOLD }, name);
    }
    assert.equal((await handlers["module.storage.read"]({ key: "k" }, a)).value, null);
    assert.deepEqual((await handlers["module.timers.list"]({}, a)).timers, []);
  } finally { ctx.unload(); }
});

test("A031-02 timers, Attention and audit stay within capability set v1 bounds", async (t) => {
  const world = makeWorld();
  const ctx = await installed(world);
  t.after(() => ctx.unload());
  const handlers = createModuleCapabilityHandlers({
    resolve: () => ({ storageBroker: ctx.core.storageBroker, auditJournal: ctx.core.auditJournal, humanTasks: ctx.core.humanTasks,
      timers: ctx.core.timers, schedules: createModuleScheduleStore({ storageBroker: ctx.core.storageBroker }), clock: world.clock })
  });
  const a = contextFor(ID);
  await assert.rejects(handlers["module.timers.ensure"]({ name: "long", delayMs: L.timerMaxDelayMs + 1 }, a), { code: E.INVALID_ARGUMENT });
  await assert.rejects(handlers["module.timers.ensure"]({ name: "Bad Name", delayMs: 60000 }, a), { code: E.INVALID_ARGUMENT });
  for (let i = 1; i < L.timers; i += 1) {
    assert.equal((await handlers["module.timers.ensure"]({ name: "t" + i, delayMs: 60000 }, a)).ok, true);
  }
  assert.deepEqual({ ...(await handlers["module.timers.ensure"]({ name: "one-too-many", delayMs: 60000 }, a)) }, { ok: false, code: E.LIMIT });
  assert.equal((await handlers["module.timers.cancel"]({ name: "t1" }, a)).cancelled, true);
  assert.equal((await handlers["module.timers.ensure"]({ name: "one-too-many", delayMs: 60000 }, a)).ok, true);

  await assert.rejects(handlers["module.audit.append"]({ type: "big", data: { text: "x".repeat(L.auditEventBytes) } }, a), { code: E.LIMIT });
  const opened = await handlers["module.attention.open"]({ key: "review", title: "Review", priority: "HIGH" }, a);
  assert.equal(opened.created, true);
  assert.equal((await handlers["module.attention.open"]({ key: "review", title: "Review" }, a)).created, false, "idempotent");
  const task = await ctx.core.humanTasks.get("module:" + ID + "/review");
  assert.deepEqual(task.value.subjectRef, { kind: "module", id: ID });
  assert.equal((await handlers["module.attention.settle"]({ key: "review", outcome: "cancelled" }, a)).state, "CANCELLED");
  assert.equal((await handlers["module.attention.settle"]({ key: "missing", outcome: "resolved" }, a)).code, E.NOT_FOUND);
});

test("A031-02 read projections expose bounded, secret-free views", async () => {
  const handlers = createModuleCapabilityHandlers({
    resolve: () => ({
      accounts: { listAccounts: async () => ({ accounts: Array.from({ length: 150 }, (_, i) => ({
        accountId: "acct-" + i, providerId: "perchance", displayName: "Account " + i, personaUid: "uid-" + i, secretRef: "secret:" + i
      })) }) },
      deployer: { listDeploymentViews: async () => ({ deployments: [{ generatorId: "gen-1", accountId: "acct-1", syncState: "IN_SYNC",
        desiredSourceHash: "h1", observedSourceHash: "h1", source: "never exposed" }] }) }
    })
  });
  const a = contextFor(ID);
  const first = await handlers["core.accounts.read"]({}, a);
  assert.equal(first.items.length, L.readPage);
  assert.equal(first.nextCursor, L.readPage);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ["accountId", "displayName", "providerId"]);
  const second = await handlers["core.accounts.read"]({ cursor: first.nextCursor }, a);
  assert.equal(second.items.length, 50);
  assert.equal(second.nextCursor, null);
  await assert.rejects(handlers["core.accounts.read"]({ limit: L.readPage + 1 }, a), { code: E.INVALID_ARGUMENT });
  const generators = await handlers["core.generators.read"]({}, a);
  assert.equal("source" in generators.items[0], false);
});

test("A031-02 provider mutations go through the account ProviderGate as module-scoped RemoteOperations", async () => {
  const calls = [];
  const gate = { mutate: async (request) => { calls.push(request); return { status: "CONFIRMED", operation: { value: { state: "CONFIRMED" } } }; } };
  const handlers = createPerchanceModuleCapabilityHandlers({ resolve: () => ({ gateFor: async (accountId) => (accountId === "acct-1" ? gate : null) }) });
  const name = "provider.perchance.generator.update";
  const a = contextFor(ID);
  const result = await handlers[name]({ accountId: "acct-1", operationKey: "deploy-1", request: { generatorId: "gen-1", source: "hello" } }, a);
  assert.deepEqual({ ...result }, { ok: true, status: "CONFIRMED", operationState: "CONFIRMED" });
  const hash = await sha256Hex("hello");
  assert.equal(calls[0].operation.operationId, "module." + ID + ".deploy-1");
  assert.equal(calls[0].operation.providerId, "perchance");
  assert.deepEqual(calls[0].operation.targetRef, { kind: "generator", id: "gen-1" });
  assert.equal(calls[0].operation.intentFingerprint, generatorSourceFingerprint(hash));
  assert.deepEqual({ ...calls[0].dispatchInput }, { sourceHash: hash, source: "hello" });
  await assert.rejects(handlers[name]({ accountId: "acct-2", operationKey: "k", request: { generatorId: "g", source: "s" } }, a), { code: E.NOT_FOUND });
  await assert.rejects(handlers[name]({ accountId: "acct-1", operationKey: "k", request: { generatorId: "g" } }, a), { code: E.INVALID_ARGUMENT });
  const fenced = Object.freeze({ ...a, assertCurrent: async () => { throw Object.assign(new Error("stale"), { code: "PCMS_MODULE_RUNTIME_STALE_GENERATION" }); } });
  await assert.rejects(handlers[name]({ accountId: "acct-1", operationKey: "k2", request: { generatorId: "g", source: "s" } }, fenced), /stale/);
  assert.equal(calls.length, 1, "a fenced generation cannot dispatch");
  assert.equal(PCMS_MODULE_CAPABILITIES_CONTRACT, "pcms.module-capabilities/v1");
});
