import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import {
  SANDBOX_FRAME_ERROR_CODES,
  createBackgroundSandboxFrameFactory,
  createSandboxIsolationProbe
} from "../../../extension/pcms/background/sandbox/frame-factory.js";
import { createModuleRuntimeSupport, MODULE_RUNTIME_AVAILABILITY } from "../../../extension/pcms/runtime/browser-floor.js";
import { createModuleRuntimeBroker, MODULE_RUNTIME_STATES } from "../../../extension/pcms/runtime/module-runtime.js";
import { MODULE_RUNTIME_ERROR_CODES } from "../../../extension/pcms/runtime/errors.js";
import { createSandboxControllerHost } from "../../../extension/pcms/runtime/sandbox-host.js";
import {
  SANDBOX_ERROR_CODES,
  SANDBOX_MAX_MESSAGE_BYTES,
  SANDBOX_MAX_SOURCE_BYTES
} from "../../../extension/pcms/sandbox/protocol.js";
import { admit, makeRegistry, makeStorage, moduleArchive } from "../p011-harness.mjs";
import { CONTROLLER_URL, makeBackgroundDocument } from "./harness.mjs";

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
let session = 0;
const hostFactory = (options) => createSandboxControllerHost({
  ...options,
  messageChannelFactory: () => new MessageChannel(),
  sessionIdFactory: () => "session-p030-" + (++session),
  timeoutMs: 750
});

const SOURCE = `(api) => ({
  start(initial){ return { started:true, browser:typeof browser, chrome:typeof chrome }; },
  write(args){ return api.call("test.write", args); },
  forbidden(){ return api.call("module.storage.write", { key:"x" }); },
  dispose(){ return null; }
})`;

async function setup({ mode = "sandboxed", capabilities = ["test.write"], support = null } = {}) {
  const storage = makeStorage();
  const registry = makeRegistry(storage);
  await admit(registry, moduleArchive({ moduleId: "demo.module", source: SOURCE, capabilities }));
  const doc = makeBackgroundDocument({ mode });
  const factory = createBackgroundSandboxFrameFactory({ documentRef: doc, pageUrl: CONTROLLER_URL, loadTimeoutMs: 200 });
  const writes = [];
  const runtime = createModuleRuntimeBroker({
    storageBroker: storage,
    moduleRegistry: registry,
    frameFactory: factory.create,
    sandboxHostFactory: hostFactory,
    support,
    capabilities: { "test.write": async (args, context) => { writes.push({ args, generation: context.generation }); return true; } }
  });
  return { storage, registry, doc, factory, runtime, writes };
}

test("A030-03 frame factory creates one isolated controller frame per module generation in the background document", async () => {
  const doc = makeBackgroundDocument();
  const factory = createBackgroundSandboxFrameFactory({ documentRef: doc, pageUrl: CONTROLLER_URL });
  const first = await factory.create({ moduleId: "demo.module", generation: 1 });
  assert.equal(first.frame.getAttribute("src"), CONTROLLER_URL);
  assert.equal(first.frame.getAttribute("sandbox"), "allow-scripts");
  assert.equal(first.frame.getAttribute("data-pcms-generation"), "1");
  assert.equal(first.frame.getAttribute("hidden"), "");
  assert.deepEqual(doc.frames, [first.frame]);
  await assert.rejects(factory.create({ moduleId: "demo.module", generation: 1 }),
    { code: SANDBOX_FRAME_ERROR_CODES.DUPLICATE_GENERATION });
  const second = await factory.create({ moduleId: "demo.module", generation: 2 });
  assert.deepEqual(factory.list(), ["demo.module#1", "demo.module#2"]);
  assert.equal(first.dispose(), true);
  assert.equal(first.dispose(), false);
  assert.deepEqual(doc.frames, [second.frame]);
  assert.equal(factory.disposeAll(), 1);
  assert.deepEqual(doc.frames, []);
  for (const request of [{ moduleId: "Bad Id", generation: 1 }, { moduleId: "demo.module", generation: 0 }, {}]) {
    await assert.rejects(factory.create(request), { code: SANDBOX_FRAME_ERROR_CODES.INVALID_REQUEST });
  }
  assert.throws(() => createBackgroundSandboxFrameFactory({ documentRef: doc, pageUrl: "moz-extension://x/pcms/app/index.html" }), TypeError);
});

test("A030-01 SEC a frame whose document is reachable (no manifest sandbox) is removed and never used", async () => {
  const doc = makeBackgroundDocument({ mode: "same-origin" });
  const factory = createBackgroundSandboxFrameFactory({ documentRef: doc, pageUrl: CONTROLLER_URL });
  await assert.rejects(factory.create({ moduleId: "demo.module", generation: 1 }),
    { code: SANDBOX_FRAME_ERROR_CODES.NOT_ISOLATED });
  assert.deepEqual(doc.frames, []);
  assert.equal(factory.size, 0);

  const support = createModuleRuntimeSupport({
    getBrowserInfo: async () => ({ name: "Firefox", version: "154.0b10" }),
    getManifest: () => manifest,
    probeIsolation: createSandboxIsolationProbe(factory)
  });
  const status = await support.getStatus();
  assert.equal(status.state, MODULE_RUNTIME_AVAILABILITY.UNAVAILABLE);
  assert.equal(status.reason, "SANDBOX_NOT_ISOLATED");
  assert.deepEqual(doc.frames, []);
});

test("A030-03 load timeout and load error remove the frame", async () => {
  for (const [mode, code] of [["hang", SANDBOX_FRAME_ERROR_CODES.LOAD_TIMEOUT], ["error", SANDBOX_FRAME_ERROR_CODES.LOAD_FAILED]]) {
    const doc = makeBackgroundDocument({ mode });
    const factory = createBackgroundSandboxFrameFactory({ documentRef: doc, pageUrl: CONTROLLER_URL, loadTimeoutMs: 100 });
    await assert.rejects(factory.create({ moduleId: "demo.module", generation: 3 }), { code });
    assert.deepEqual(doc.frames, [], mode);
    assert.equal(factory.size, 0);
  }
});

test("A030-03 runtime binds frame lifetime to the generation: fence and disable dispose it, a new generation gets a new frame", async () => {
  const { doc, runtime, writes } = await setup();
  const first = await runtime.activate("demo.module", { expectedRevision: 0 });
  assert.equal(first.generation, 1);
  assert.deepEqual(first.startResult, { started: true, browser: "undefined", chrome: "undefined" });
  assert.equal(doc.frames.length, 1);
  const firstFrame = doc.frames[0];
  assert.equal(firstFrame.getAttribute("data-pcms-generation"), "1");
  assert.equal(await runtime.invoke("demo.module", "write", { n: 1 }), true);
  await assert.rejects(runtime.invoke("demo.module", "forbidden"), { code: SANDBOX_ERROR_CODES.CAPABILITY_DENIED });

  const fenced = await runtime.prepareUpdate("demo.module", { expectedRevision: first.revision });
  assert.equal(fenced.value.state, MODULE_RUNTIME_STATES.IDLE);
  assert.equal(fenced.value.generation, 2);
  assert.equal(firstFrame.removed, true, "fence removes the old generation's frame");
  assert.deepEqual(doc.frames, []);
  await assert.rejects(runtime.invoke("demo.module", "write", { n: 2 }), { code: MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION });

  const second = await runtime.activate("demo.module", { expectedRevision: fenced.revision });
  assert.equal(second.generation, 2);
  assert.equal(doc.frames.length, 1);
  assert.notEqual(doc.frames[0], firstFrame);
  assert.equal(doc.frames[0].getAttribute("data-pcms-generation"), "2");
  await runtime.invoke("demo.module", "write", { n: 3 });
  assert.deepEqual(writes.map((w) => [w.args.n, w.generation]), [[1, 1], [3, 2]]);

  const disabled = await runtime.disable("demo.module", { expectedRevision: second.revision });
  assert.equal(disabled.value.state, MODULE_RUNTIME_STATES.DISABLED);
  assert.deepEqual(doc.frames, []);
  assert.equal(doc.created.length, 2, "exactly one frame per activated generation");
});

test("A030-03 a failed activation removes its frame and fences the generation", async () => {
  const storage = makeStorage();
  const registry = makeRegistry(storage);
  await admit(registry, moduleArchive({ moduleId: "broken.module", source: "(api) => ({ start(){ throw new Error('boom'); } })" }));
  const doc = makeBackgroundDocument();
  const factory = createBackgroundSandboxFrameFactory({ documentRef: doc, pageUrl: CONTROLLER_URL });
  const runtime = createModuleRuntimeBroker({ storageBroker: storage, moduleRegistry: registry,
    frameFactory: factory.create, sandboxHostFactory: hostFactory });
  await assert.rejects(runtime.activate("broken.module", { expectedRevision: 0 }), { code: SANDBOX_ERROR_CODES.CONTROLLER_FAILED });
  assert.deepEqual(doc.frames, []);
  assert.equal(factory.size, 0);
  const state = await runtime.getState("broken.module");
  assert.equal(state.value.state, MODULE_RUNTIME_STATES.IDLE);
  assert.equal(state.value.generation, 2);
});

test("A030-01 UNAVAILABLE support blocks activation before any frame or state change", async () => {
  const support = createModuleRuntimeSupport({
    getBrowserInfo: async () => ({ name: "Firefox", version: "153.0" }),
    getManifest: () => manifest
  });
  const { doc, runtime } = await setup({ support });
  await assert.rejects(runtime.activate("demo.module", { expectedRevision: 0 }), { code: MODULE_RUNTIME_ERROR_CODES.RUNTIME_UNAVAILABLE });
  assert.equal(doc.created.length, 0);
  assert.equal((await runtime.getState("demo.module")).revision, 0);
  const status = await runtime.getSupport();
  assert.equal(status.message, "Requires Firefox 154+");
});

test("A030-03 caller-owned frames (P004/P011 contract) are not removed by the runtime", async () => {
  const { doc, factory, runtime } = await setup();
  const owned = await factory.create({ moduleId: "demo.module", generation: 9 });
  const active = await runtime.activate("demo.module", { expectedRevision: 0, frame: owned.frame });
  await runtime.prepareUpdate("demo.module", { expectedRevision: active.revision });
  assert.deepEqual(doc.frames, [owned.frame]);
  owned.dispose();
});

test("A030-03 P004 bootstrap and RPC bounds are preserved", async () => {
  assert.equal(SANDBOX_MAX_SOURCE_BYTES, 256 * 1024);
  assert.equal(SANDBOX_MAX_MESSAGE_BYTES, 64 * 1024);
  const host = await readFile("extension/pcms/runtime/sandbox-host.js", "utf8");
  assert.match(host, /timeoutMs = 5_000/);
  assert.match(host, /maxInFlightCapabilityCalls = 16/);
  assert.match(host, /"\*", \[channel\.port2\]\)/);
  const child = await readFile("extension/pcms/sandbox/controller-runtime.js", "utf8");
  assert.match(child, /event\?\.source !== windowRef\.parent \|\| event\?\.origin !== windowRef\.location\.origin/);
  assert.match(child, /windowRef\.removeEventListener\("message", onBootstrap\)/);
});
