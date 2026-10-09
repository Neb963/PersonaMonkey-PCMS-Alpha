import assert from "node:assert/strict";
import test from "node:test";

import { SANDBOX_ERROR_CODES } from "../../extension/pcms/sandbox/protocol.js";
import {
  MODULE_RUNTIME_NAMESPACE,
  MODULE_RUNTIME_STATES,
  createModuleRuntimeBroker
} from "../../extension/pcms/runtime/module-runtime.js";
import { MODULE_RUNTIME_ERROR_CODES } from "../../extension/pcms/runtime/errors.js";
import {
  admit,
  makeRegistry,
  makeSandboxFactories,
  makeStorage,
  moduleArchive
} from "./p011-harness.mjs";

test("A011-01 admitted controller runs through a bounded FIFO runtime mailbox", async (t) => {
  const storage = makeStorage();
  const registry = makeRegistry(storage);
  await admit(registry, moduleArchive({
    source:`(api) => ({
      start(){ return { ready:true }; },
      run(args){ return api.call("test.sequence", args); },
      dispose(){ return null; }
    })`,
    capabilities:["test.sequence"]
  }));

  let activeCalls = 0;
  let maxActiveCalls = 0;
  const order = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const factories = makeSandboxFactories();
  t.after(() => factories.dispose());

  const broker = createModuleRuntimeBroker({
    storageBroker:storage,
    moduleRegistry:registry,
    frameFactory:factories.frameFactory,
    sandboxHostFactory:factories.sandboxHostFactory,
    capabilities:{
      "test.sequence":async ({ value }) => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        if (value === 1) {
          markFirstStarted();
          await firstGate;
        }
        order.push(value);
        activeCalls -= 1;
        return value;
      }
    },
    maxMailboxDepth:4
  });

  const started = await broker.activate("demo.module", { expectedRevision:0 });
  assert.equal(started.generation, 1);
  assert.deepEqual(started.startResult, { ready:true });
  assert.equal((await broker.getState("demo.module")).value.state, MODULE_RUNTIME_STATES.ACTIVE);

  const first = broker.invoke("demo.module", "run", { value:1 });
  await firstStarted;
  const second = broker.invoke("demo.module", "run", { value:2 });
  await Promise.resolve();

  assert.equal(maxActiveCalls, 1);
  assert.deepEqual(order, []);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(maxActiveCalls, 1);
  assert.equal(storage.shared.namespaces.has(MODULE_RUNTIME_NAMESPACE), true);
});

test("A011-02 sandbox receives only admitted capabilities with generation-fenced core context", async (t) => {
  const storage = makeStorage();
  const registry = makeRegistry(storage);
  await admit(registry, moduleArchive({
    capabilities:["data.read"],
    source:`(api) => ({
      start(){ return null; },
      read(args){ return api.call("data.read", args); },
      denied(){ return api.call("data.write", {}); },
      dispose(){ return null; }
    })`
  }));

  let capturedContext;
  const factories = makeSandboxFactories();
  t.after(() => factories.dispose());
  const broker = createModuleRuntimeBroker({
    storageBroker:storage,
    moduleRegistry:registry,
    frameFactory:factories.frameFactory,
    sandboxHostFactory:factories.sandboxHostFactory,
    capabilities:{
      "data.read":async ({ key }, context) => {
        capturedContext = context;
        await context.assertCurrent();
        return { key, value:"ok" };
      },
      "data.write":async () => {
        throw new Error("must never be exposed without authority");
      }
    }
  });

  const started = await broker.activate("demo.module", { expectedRevision:0 });
  assert.deepEqual(await broker.invoke("demo.module", "read", { key:"alpha" }), {
    key:"alpha",
    value:"ok"
  });
  assert.equal(capturedContext.moduleId, "demo.module");
  assert.equal(capturedContext.generation, started.generation);
  assert.equal(capturedContext.packageHash, started.packageHash);
  await capturedContext.assertCurrent();

  await assert.rejects(
    broker.invoke("demo.module", "denied"),
    (error) => error?.code === SANDBOX_ERROR_CODES.CAPABILITY_DENIED
  );
});

test("A011-03 update drains privileged work, advances generation before replacement activation, and fences stale context", async (t) => {
  const storage = makeStorage();
  const registry = makeRegistry(storage);
  await admit(registry, moduleArchive({
    version:"1.0.0",
    capabilities:["ops.hold"],
    source:`(api) => ({
      start(){ return "v1"; },
      slow(){ return api.call("ops.hold", {}); },
      version(){ return "v1"; },
      dispose(){ return null; }
    })`
  }));

  let release;
  let enteredResolve;
  let staleContext;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const factories = makeSandboxFactories();
  t.after(() => factories.dispose());
  const broker = createModuleRuntimeBroker({
    storageBroker:storage,
    moduleRegistry:registry,
    frameFactory:factories.frameFactory,
    sandboxHostFactory:factories.sandboxHostFactory,
    capabilities:{
      "ops.hold":async (_args, context) => {
        staleContext = context;
        enteredResolve();
        await gate;
        return "done";
      }
    }
  });

  const first = await broker.activate("demo.module", { expectedRevision:0 });
  const slow = broker.invoke("demo.module", "slow");
  await entered;
  const alreadyAccepted = broker.invoke("demo.module", "version");

  const updating = broker.prepareUpdate("demo.module", { expectedRevision:first.revision });
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if ((await broker.getState("demo.module")).value.state === MODULE_RUNTIME_STATES.DRAINING) break;
    await Promise.resolve();
  }
  assert.equal((await broker.getState("demo.module")).value.state, MODULE_RUNTIME_STATES.DRAINING);
  await assert.rejects(
    broker.invoke("demo.module", "version"),
    (error) => error?.code === MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION
  );

  release();
  assert.equal(await slow, "done");
  assert.equal(await alreadyAccepted, "v1");
  const drained = await updating;
  assert.equal(drained.value.state, MODULE_RUNTIME_STATES.IDLE);
  assert.equal(drained.value.generation, first.generation + 1);
  await assert.rejects(
    staleContext.assertCurrent(),
    (error) => error?.code === MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION
  );

  await admit(registry, moduleArchive({
    version:"2.0.0",
    capabilities:["ops.hold"],
    source:`(api) => ({
      start(){ return "v2"; },
      version(){ return "v2"; },
      dispose(){ return null; }
    })`
  }));

  const second = await broker.activate("demo.module", { expectedRevision:drained.revision });
  assert.equal(second.generation, drained.value.generation);
  assert.equal(await broker.invoke("demo.module", "version"), "v2");
});

test("A011-03 restart recovery fences persisted active generations and recovery hold blocks replay", async (t) => {
  const shared = { namespaces:new Map() };
  const storage1 = makeStorage(shared);
  const registry1 = makeRegistry(storage1);
  await admit(registry1, moduleArchive({
    source:`() => ({
      start(){ return null; },
      ping(){ return "pong"; },
      dispose(){ return null; }
    })`
  }));

  const factories1 = makeSandboxFactories();
  t.after(() => factories1.dispose());
  const broker1 = createModuleRuntimeBroker({
    storageBroker:storage1,
    moduleRegistry:registry1,
    frameFactory:factories1.frameFactory,
    sandboxHostFactory:factories1.sandboxHostFactory
  });
  const original = await broker1.activate("demo.module", { expectedRevision:0 });
  assert.equal(await broker1.invoke("demo.module", "ping"), "pong");

  let holdState = "RECOVERY_HOLD";
  const storage2 = makeStorage(shared);
  const registry2 = makeRegistry(storage2);
  const factories2 = makeSandboxFactories();
  t.after(() => factories2.dispose());
  const broker2 = createModuleRuntimeBroker({
    storageBroker:storage2,
    moduleRegistry:registry2,
    frameFactory:factories2.frameFactory,
    sandboxHostFactory:factories2.sandboxHostFactory,
    recoveryHold:{
      async getStatus() {
        return { value:{ state:holdState } };
      }
    }
  });

  assert.deepEqual(await broker2.recoverAll(), ["demo.module"]);
  const recovered = await broker2.getState("demo.module");
  assert.equal(recovered.value.state, MODULE_RUNTIME_STATES.IDLE);
  assert.equal(recovered.value.generation, original.generation + 1);

  await assert.rejects(
    broker1.invoke("demo.module", "ping"),
    (error) => error?.code === MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION
  );
  await assert.rejects(
    broker2.activate("demo.module", { expectedRevision:recovered.revision }),
    (error) => error?.code === MODULE_RUNTIME_ERROR_CODES.RECOVERY_HOLD
  );

  holdState = "NORMAL";
  const restarted = await broker2.activate("demo.module", { expectedRevision:recovered.revision });
  assert.equal(restarted.generation, recovered.value.generation);
  assert.equal(await broker2.invoke("demo.module", "ping"), "pong");
});
