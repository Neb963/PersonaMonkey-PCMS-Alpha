// P031 Node regressions: runtime-module lifecycle executed live by the background Core.
// A031-01 install/approve/activate through PCMS without rebuild or reload.
// A031-03 update to a new generation, disable/enable/rollback/remove/purge, all live.
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import { createPcmsInternalBrokerEndpointRegistry } from "../../../extension/lib/pcms-internal-broker-endpoint.js";
import { createModuleCapabilityHandlers } from "../../../extension/pcms/background/modules/capabilities.js";
import { createModuleScheduleStore } from "../../../extension/pcms/background/modules/schedules.js";
import { MODULE_STATUS, MODULE_SUPERVISOR_ERROR_CODES } from "../../../extension/pcms/background/modules/supervisor.js";
import { createBackgroundPcmsCore } from "../../../extension/pcms/background/core-factory.js";
import { createPcmsCoreHost } from "../../../extension/pcms/background/core-host.js";
import { createBackgroundSandboxFrameFactory } from "../../../extension/pcms/background/sandbox/frame-factory.js";
import { createPcmsUiClient } from "../../../extension/pcms/app/ui-client.js";
import { PCMS_UI_OPERATIONS } from "../../../extension/pcms/integration/ui-client-contract.js";
import { createModuleRuntimeBroker } from "../../../extension/pcms/runtime/module-runtime.js";
import { MODULE_RUNTIME_ERROR_CODES } from "../../../extension/pcms/runtime/errors.js";
import { createSandboxControllerHost } from "../../../extension/pcms/runtime/sandbox-host.js";
import { createPcmsAuditJournal } from "../../../extension/pcms/audit/journal.js";
import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";
import { createModulePackageRegistry } from "../../../extension/pcms/modules/registry.js";
import { makeAuditBackend, makeMemoryBackend } from "../p023/harness.mjs";
import { admit, moduleArchive } from "../p011-harness.mjs";
import { BASE_URL, PCMS_SENDER, RUNTIME_ID, integrationHandler, makeSessionStore } from "../p028/harness.mjs";
import { CONTROLLER_URL, makeBackgroundDocument } from "../p030/harness.mjs";
import { FIXTURE_MODULE_ID, buildCounterArchiveText } from "../../fixtures/modules/counter.mjs";
import { AVAILABLE, FEATURE_FACTORIES, UNAVAILABLE, makeWorld, moduleData, openContext, settle } from "./harness.mjs";

const ID = FIXTURE_MODULE_ID;

async function installAndApprove(core, options = {}) {
  const staged = await core.modules.install(buildCounterArchiveText(options));
  if (staged.status !== MODULE_STATUS.AWAITING_APPROVAL) return staged;
  return core.modules.approve(ID, staged.candidate.packageHash);
}

test("A031-01 an archive never compiled into the XPI installs, awaits approval and runs live", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world);
  t.after(() => ctx.unload());

  const staged = await ctx.core.modules.install(buildCounterArchiveText({ nonce: "first" }));
  assert.equal(staged.status, MODULE_STATUS.AWAITING_APPROVAL);
  assert.equal(staged.running, false);
  assert.equal(ctx.document.created.length, 0, "no frame exists before the operator approves the authority");
  const tasks = await ctx.core.humanTasks.listAttention();
  const approval = tasks.find((item) => item.value.taskKind === "module.approval");
  assert.ok(approval, "an approval Attention task is open");
  assert.match(approval.value.instructions, /module\.storage\.write/);

  const active = await ctx.core.modules.approve(ID, staged.candidate.packageHash);
  assert.equal(active.status, MODULE_STATUS.ACTIVE);
  assert.equal(active.version, "1.0.0");
  assert.equal(active.generation, 1);
  assert.equal(ctx.document.frames.length, 1, "one controller frame in the background document");
  assert.equal(ctx.document.loads[0], CONTROLLER_URL);
  assert.equal((await ctx.core.humanTasks.get(approval.value.taskId)).value.state, "RESOLVED");
  assert.deepEqual(active.timers.map((timer) => [timer.name, timer.state]), [["tick", "SCHEDULED"]]);

  const probe = await ctx.core.modules.call(ID, "probe", null);
  assert.equal(probe.nonce, "first");
  assert.equal(probe.browserAbsent, true);
  assert.equal(probe.chromeAbsent, true);

  const listed = await ctx.core.modules.list();
  assert.equal(listed.runtime.state, "AVAILABLE");
  assert.deepEqual(listed.modules.map((module) => [module.moduleId, module.status]), [[ID, MODULE_STATUS.ACTIVE]]);
});

test("A031-01 the dashboard installs and drives a module only through UI client commands", async (t) => {
  const world = makeWorld();
  const backend = makeMemoryBackend(world.shared);
  const storageBroker = createPcmsStorageBroker({ backend, clock: world.clock });
  const auditJournal = createPcmsAuditJournal({ backend: makeAuditBackend(backend), clock: world.clock });
  const endpoints = createPcmsInternalBrokerEndpointRegistry();
  const handler = integrationHandler();
  endpoints.register({ ready: async () => {}, handleRequest: (request) => handler.handleRequest(request), attachEvents: async () => true });
  const document = makeBackgroundDocument();
  const factory = createBackgroundSandboxFrameFactory({ documentRef: document, pageUrl: CONTROLLER_URL });
  let core = null;
  const host = createPcmsCoreHost({
    personaMonkeyReady: async () => {},
    createCore: () => (core = createBackgroundPcmsCore({
      transport: endpoints.createEndpoint(),
      featureFactories: FEATURE_FACTORIES,
      storageBroker,
      auditJournal,
      clock: world.clock,
      moduleHost: { frameFactory: (request) => factory.create(request), support: { getStatus: async () => AVAILABLE } }
    })),
    sessionStore: makeSessionStore(),
    runtimeId: RUNTIME_ID,
    extensionBaseUrl: BASE_URL,
    clock: world.clock
  });
  t.after(() => { for (const frame of document.frames) frame.remove(); core?.close(); });
  const client = createPcmsUiClient({
    transport: {
      async send(message) { return structuredClone(await host.handleUiMessage(structuredClone(message), PCMS_SENDER)); },
      subscribeRevision() { return () => {}; }
    }
  });
  const modules = client.runtime.modules;
  const staged = await modules.install(buildCounterArchiveText({ nonce: "ui" }));
  assert.equal(staged.status, MODULE_STATUS.AWAITING_APPROVAL);
  const active = await modules.approve(ID, staged.candidate.packageHash);
  assert.equal(active.status, MODULE_STATUS.ACTIVE);
  assert.equal((await modules.call(ID, "probe", null)).nonce, "ui");
  assert.equal((await modules.get(ID)).status, MODULE_STATUS.ACTIVE);
  assert.equal((await modules.list()).modules.length, 1);
  await assert.rejects(modules.call(ID, "start", null), (error) => error.code === MODULE_SUPERVISOR_ERROR_CODES.INVALID_ARGUMENT);
  assert.equal((await modules.disable(ID)).status, MODULE_STATUS.DISABLED);
  assert.equal((await modules.enable(ID)).status, MODULE_STATUS.ACTIVE);
  client.close();
});

test("A031-01 the ui-client contract names every module lifecycle operation", () => {
  for (const name of ["modules.list", "modules.get"]) assert.equal(PCMS_UI_OPERATIONS[name].kind, "query");
  for (const name of ["install", "approve", "reject", "disable", "enable", "rollback", "remove", "purge", "call"]) {
    const operation = PCMS_UI_OPERATIONS["modules." + name];
    assert.equal(operation.kind, "command", name);
    assert.ok(operation.topics.includes("modules"), name);
  }
});

test("A031-01 an unsupported Firefox keeps Core running and reports the module runtime UNAVAILABLE", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world, { support: UNAVAILABLE });
  t.after(() => ctx.unload());
  const staged = await ctx.core.modules.install(buildCounterArchiveText());
  await assert.rejects(ctx.core.modules.approve(ID, staged.candidate.packageHash), { code: MODULE_SUPERVISOR_ERROR_CODES.RUNTIME_UNAVAILABLE });
  const listed = await ctx.core.modules.list();
  assert.equal(listed.runtime.state, "UNAVAILABLE");
  assert.equal(listed.runtime.message, "Requires Firefox 154+");
  assert.equal(ctx.document.created.length, 0);
  assert.ok(Array.isArray((await ctx.core.accounts.listAccounts()).accounts), "built-in modules keep working");
});

test("A031-01 reject settles the approval task and admits nothing", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world);
  t.after(() => ctx.unload());
  const staged = await ctx.core.modules.install(buildCounterArchiveText());
  const rejected = await ctx.core.modules.reject(ID, staged.candidate.packageHash);
  assert.equal(rejected.activePackageHash, null);
  assert.equal(ctx.document.created.length, 0);
  const tasks = (await ctx.core.humanTasks.listAttention()).filter((item) => item.value.taskKind === "module.approval");
  assert.deepEqual(tasks, []);
});

test("A031-03 update activates a new generation live, removes the old frame and stops its work", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world);
  t.after(() => ctx.unload());
  const v1 = await installAndApprove(ctx.core, { version: "1.0.0", nonce: "v1" });
  const firstFrame = ctx.document.frames[0];
  assert.equal((await ctx.core.modules.call(ID, "beat", null)).version, "1.0.0");
  await new Promise((resolve) => setTimeout(resolve, 450));
  const beating = (await moduleData(world, ID)).beat;
  assert.ok(beating.count >= 2, "v1 loop writes while it is current");

  // Same authority: the update applies without approval, without reload.
  const v2 = await ctx.core.modules.install(buildCounterArchiveText({ version: "2.0.0", nonce: "v2" }));
  assert.equal(v2.status, MODULE_STATUS.ACTIVE);
  assert.equal(v2.version, "2.0.0");
  assert.ok(v2.generation > v1.generation);
  assert.equal(firstFrame.removed, true, "the previous generation's frame is gone");
  assert.equal(ctx.document.frames.length, 1);
  const frozen = (await moduleData(world, ID)).beat.count;
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal((await moduleData(world, ID)).beat.count, frozen, "the previous generation no longer writes");
  assert.equal((await ctx.core.modules.call(ID, "probe", null)).version, "2.0.0");
});

test("A031-03 an update requesting new authority waits for approval while the current version keeps running", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world);
  t.after(() => ctx.unload());
  const v1 = await installAndApprove(ctx.core, { nonce: "v1" });
  const staged = await ctx.core.modules.install(buildCounterArchiveText({
    version: "2.0.0", nonce: "v2",
    capabilities: ["core.accounts.read", "module.audit.append", "module.storage.read", "module.storage.write", "module.timers.ensure", "module.timers.list"]
  }));
  assert.equal(staged.status, MODULE_STATUS.ACTIVE, "v1 keeps running while v2 awaits approval");
  assert.equal(staged.version, "1.0.0");
  assert.equal(staged.candidate.state, "AWAITING_APPROVAL");
  assert.deepEqual([...staged.candidate.addedCapabilities], ["core.accounts.read"]);
  const approved = await ctx.core.modules.approve(ID, staged.candidate.packageHash);
  assert.equal(approved.version, "2.0.0");
  assert.ok(approved.generation > v1.generation);
});

test("A031-03 disable, enable, rollback, remove, reinstall and purge work live", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world);
  t.after(() => ctx.unload());
  const v1 = await installAndApprove(ctx.core, { version: "1.0.0", nonce: "v1" });
  world.clock.advance(61 * 1000);
  await ctx.duePass();
  assert.equal((await moduleData(world, ID)).ticks.count, 1);
  const v2 = await ctx.core.modules.install(buildCounterArchiveText({ version: "2.0.0", nonce: "v2" }));

  const disabled = await ctx.core.modules.disable(ID);
  assert.equal(disabled.status, MODULE_STATUS.DISABLED);
  assert.equal(disabled.running, false);
  assert.equal(ctx.document.frames.length, 0);
  assert.deepEqual(disabled.timers.map((timer) => timer.state), ["CANCELLED"], "a disabled module's schedules stop");
  await assert.rejects(ctx.core.modules.call(ID, "probe", null), { code: MODULE_SUPERVISOR_ERROR_CODES.NOT_RUNNABLE });

  const enabled = await ctx.core.modules.enable(ID);
  assert.equal(enabled.status, MODULE_STATUS.ACTIVE);
  assert.equal(enabled.version, "2.0.0");
  assert.deepEqual(enabled.timers.map((timer) => timer.state), ["SCHEDULED"], "start re-declares the schedule");

  const rolledBack = await ctx.core.modules.rollback(ID, v1.activePackageHash);
  assert.equal(rolledBack.status, MODULE_STATUS.ACTIVE);
  assert.equal(rolledBack.version, "1.0.0");
  assert.equal((await ctx.core.modules.call(ID, "probe", null)).nonce, "v1");
  assert.ok(rolledBack.retainedPackageHashes.includes(v2.activePackageHash));

  const removed = await ctx.core.modules.remove(ID);
  assert.equal(removed.status, MODULE_STATUS.REMOVED);
  assert.equal(removed.running, false);
  assert.equal(ctx.document.frames.length, 0);
  assert.ok(Object.keys(await moduleData(world, ID)).length > 0, "remove keeps module data");
  await assert.rejects(ctx.core.modules.call(ID, "probe", null), { code: MODULE_SUPERVISOR_ERROR_CODES.NOT_RUNNABLE });

  // A removed module holds no authority: reinstalling it asks for approval again.
  const again = await ctx.core.modules.install(buildCounterArchiveText({ version: "1.0.0", nonce: "v1" }));
  assert.equal(again.status, MODULE_STATUS.AWAITING_APPROVAL);
  const back = await ctx.core.modules.approve(ID, again.candidate.packageHash);
  assert.equal(back.status, MODULE_STATUS.ACTIVE, "reinstalling a removed module brings it back running");
  assert.equal((await ctx.core.modules.call(ID, "probe", null)).nonce, "v1");

  await ctx.core.modules.remove(ID);
  const purged = await ctx.core.modules.purge(ID);
  assert.equal(purged.purged, true);
  assert.ok(purged.dataKeysDeleted >= 1);
  assert.deepEqual(await moduleData(world, ID), {});
  const gone = await ctx.core.modules.get(ID);
  assert.equal(gone.installed, false);
});

test("A031-03 a fenced generation can no longer write, call services or schedule", async () => {
  const world = makeWorld();
  const backend = makeMemoryBackend(world.shared);
  const storageBroker = createPcmsStorageBroker({ backend, clock: world.clock });
  const registry = createModulePackageRegistry({ storageBroker, clock: world.clock });
  const archive = moduleArchive({
    moduleId: ID,
    capabilities: ["module.storage.read", "module.storage.write"],
    source: `(api) => ({ write(args){ return api.call("module.storage.write", args); } })`
  });
  await admit(registry, archive);
  const document = makeBackgroundDocument();
  const factory = createBackgroundSandboxFrameFactory({ documentRef: document, pageUrl: CONTROLLER_URL });
  const handlers = createModuleCapabilityHandlers({
    resolve: () => ({ storageBroker, schedules: createModuleScheduleStore({ storageBroker }), clock: world.clock })
  });
  const contexts = [];
  const capabilities = Object.fromEntries(Object.entries(handlers).map(([name, handle]) => [name, (args, context) => {
    contexts.push(context);
    return handle(args, context);
  }]));
  let session = 0;
  const runtime = createModuleRuntimeBroker({
    storageBroker,
    moduleRegistry: registry,
    frameFactory: (request) => factory.create(request),
    sandboxHostFactory: (options) => createSandboxControllerHost({
      ...options,
      messageChannelFactory: () => new MessageChannel(),
      sessionIdFactory: () => "session-p031-" + (++session),
      timeoutMs: 750
    }),
    capabilities
  });
  const first = await runtime.activate(ID, { expectedRevision: 0 });
  assert.equal((await runtime.invoke(ID, "write", { key: "seen", expectedRevision: 0, value: 1 })).ok, true);
  const old = contexts.at(-1);
  assert.equal(old.generation, first.generation);

  // Update: the running generation is fenced and a new one activated, no reload.
  const fenced = await runtime.prepareUpdate(ID, { expectedRevision: first.revision });
  const second = await runtime.activate(ID, { expectedRevision: fenced.revision });
  assert.ok(second.generation > first.generation);
  assert.equal(document.frames.length, 1, "only the new generation's frame remains");

  await assert.rejects(old.assertCurrent(), { code: MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION });
  for (const [name, args] of [
    ["module.storage.write", { key: "fenced", expectedRevision: 0, value: 1 }],
    ["module.storage.write", { key: "seen", expectedRevision: 1, delete: true }]
  ]) {
    await assert.rejects(handlers[name](args, old), { code: MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION }, name);
  }
  assert.deepEqual(await moduleData(world, ID), { seen: 1 }, "nothing was written by the fenced generation");
  assert.equal((await runtime.invoke(ID, "write", { key: "fresh", expectedRevision: 0, value: 2 })).ok, true);
  assert.equal(contexts.at(-1).generation, second.generation);
  for (const frame of document.frames) frame.remove();
});
