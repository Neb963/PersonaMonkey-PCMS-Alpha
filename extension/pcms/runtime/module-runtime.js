import { createSandboxControllerHost } from "./sandbox-host.js";
import { assertModuleId, assertModulePackageHash } from "../modules/package.js";
import { MODULE_RUNTIME_ERROR_CODES, moduleRuntimeError } from "./errors.js";
import { MODULE_RUNTIME_AVAILABILITY } from "./browser-floor.js";

export const MODULE_RUNTIME_NAMESPACE = "core.module-runtime";
export const MODULE_RUNTIME_SCHEMA_VERSION = 1;
export const MODULE_RUNTIME_STATES = Object.freeze({
  IDLE: "IDLE",
  ACTIVE: "ACTIVE",
  DRAINING: "DRAINING",
  DISABLED: "DISABLED"
});

const STATE_SET = new Set(Object.values(MODULE_RUNTIME_STATES));

function fail(code, options = {}) {
  throw moduleRuntimeError(code, options);
}

function runtimeKey(moduleId) {
  return "runtime:" + assertModuleId(moduleId);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function defaultValue(moduleId) {
  return {
    schemaVersion: MODULE_RUNTIME_SCHEMA_VERSION,
    kind: "module-runtime",
    moduleId,
    generation: 0,
    state: MODULE_RUNTIME_STATES.IDLE,
    activePackageHash: null
  };
}

function normalizeValue(value, moduleId) {
  if (!plainObject(value)
      || !exactKeys(value, ["schemaVersion", "kind", "moduleId", "generation", "state", "activePackageHash"])
      || value.schemaVersion !== MODULE_RUNTIME_SCHEMA_VERSION
      || value.kind !== "module-runtime"
      || value.moduleId !== moduleId
      || !Number.isSafeInteger(value.generation)
      || value.generation < 0
      || !STATE_SET.has(value.state)) {
    fail(MODULE_RUNTIME_ERROR_CODES.CORRUPT_STATE);
  }
  if (value.activePackageHash !== null) {
    try {
      assertModulePackageHash(value.activePackageHash);
    } catch {
      fail(MODULE_RUNTIME_ERROR_CODES.CORRUPT_STATE);
    }
  }
  if (value.state === MODULE_RUNTIME_STATES.ACTIVE || value.state === MODULE_RUNTIME_STATES.DRAINING) {
    if (value.generation < 1 || value.activePackageHash === null) fail(MODULE_RUNTIME_ERROR_CODES.CORRUPT_STATE);
  } else if (value.activePackageHash !== null) {
    fail(MODULE_RUNTIME_ERROR_CODES.CORRUPT_STATE);
  }
  return Object.freeze({ ...value });
}

function publicRecord(record, moduleId) {
  if (!record) return Object.freeze({ revision: 0, value: Object.freeze(defaultValue(moduleId)) });
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) fail(MODULE_RUNTIME_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({
    revision: record.revision,
    updatedAt: record.updatedAt,
    value: normalizeValue(record.value, moduleId)
  });
}

function validateExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(MODULE_RUNTIME_ERROR_CODES.REVISION_CONFLICT);
  return value;
}

function normalizeCapabilityHandlers(value) {
  if (!plainObject(value)) throw new TypeError("Module runtime capabilities must be a plain object");
  const handlers = new Map();
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new TypeError("Module runtime capability handlers must be enumerable functions");
    }
    handlers.set(name, descriptor.value);
  }
  return handlers;
}

// A frame factory may return the frame itself (caller-owned, as in P004/P011) or a
// handle { frame, dispose } whose frame lifetime is bound to this generation (P030).
function frameLease(produced) {
  if (produced && typeof produced === "object" && produced.frame && typeof produced.dispose === "function") {
    return { frame:produced.frame, release:() => produced.dispose() };
  }
  return { frame:produced || null, release:null };
}

function releaseFrame(runtime) {
  const release = runtime.releaseFrame;
  runtime.releaseFrame = null;
  if (!release) return;
  try { release(); } catch {}
}

function freezeContext(moduleId, generation, packageHash, assertCurrent) {
  return Object.freeze({ moduleId, generation, packageHash, assertCurrent });
}

export function createModuleRuntimeBroker({
  storageBroker,
  moduleRegistry,
  frameFactory = null,
  sandboxHostFactory = createSandboxControllerHost,
  capabilities = {},
  recoveryHold = null,
  support = null,
  maxMailboxDepth = 64
} = {}) {
  if (!storageBroker || typeof storageBroker.namespace !== "function") {
    throw new TypeError("Module runtime requires the PCMS storage broker");
  }
  if (!moduleRegistry
      || typeof moduleRegistry.getModule !== "function"
      || typeof moduleRegistry.getPackage !== "function") {
    throw new TypeError("Module runtime requires the module package registry");
  }
  if (frameFactory !== null && typeof frameFactory !== "function") {
    throw new TypeError("Module runtime frame factory is invalid");
  }
  if (typeof sandboxHostFactory !== "function") {
    throw new TypeError("Module runtime sandbox host factory is invalid");
  }
  if (!Number.isInteger(maxMailboxDepth) || maxMailboxDepth < 1 || maxMailboxDepth > 1024) {
    throw new RangeError("Module runtime mailbox depth is out of bounds");
  }
  if (recoveryHold !== null && typeof recoveryHold.getStatus !== "function") {
    throw new TypeError("Module runtime recovery hold is invalid");
  }
  if (support !== null && typeof support.getStatus !== "function") {
    throw new TypeError("Module runtime support detection is invalid");
  }

  const capabilityHandlers = normalizeCapabilityHandlers(capabilities);
  const store = storageBroker.namespace(MODULE_RUNTIME_NAMESPACE);
  const runtimes = new Map();

  async function read(moduleId) {
    const id = assertModuleId(moduleId);
    return publicRecord(await store.get(runtimeKey(id)), id);
  }

  async function compareAndSwap(moduleId, expectedRevision, value) {
    try {
      const record = await store.compareAndSwap(runtimeKey(moduleId), { expectedRevision, value });
      return publicRecord(record, moduleId);
    } catch (error) {
      if (error?.code === "PCMS_STORAGE_CAS_MISMATCH") {
        fail(MODULE_RUNTIME_ERROR_CODES.REVISION_CONFLICT, { currentRevision: error.currentRevision });
      }
      throw error;
    }
  }

  async function assertGeneration(moduleId, generation, packageHash, { allowDraining = false } = {}) {
    const current = await read(moduleId);
    const validState = current.value.state === MODULE_RUNTIME_STATES.ACTIVE
      || (allowDraining && current.value.state === MODULE_RUNTIME_STATES.DRAINING);
    if (!validState
        || current.value.generation !== generation
        || current.value.activePackageHash !== packageHash) {
      fail(MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION, {
        currentRevision: current.revision,
        currentGeneration: current.value.generation
      });
    }
    return current;
  }

  async function assertRecoveryClear() {
    if (!recoveryHold) return;
    const status = await recoveryHold.getStatus();
    if (status?.value?.state === "RECOVERY_HOLD") fail(MODULE_RUNTIME_ERROR_CODES.RECOVERY_HOLD);
  }

  async function getSupport() {
    if (!support) return null;
    let status;
    try { status = await support.getStatus(); } catch { status = null; }
    return status && typeof status === "object"
      ? status
      : Object.freeze({ state:MODULE_RUNTIME_AVAILABILITY.UNAVAILABLE, reason:"SUPPORT_UNKNOWN", message:null, browser:null });
  }

  async function assertRuntimeAvailable() {
    const status = await getSupport();
    if (status && status.state !== MODULE_RUNTIME_AVAILABILITY.AVAILABLE) {
      fail(MODULE_RUNTIME_ERROR_CODES.RUNTIME_UNAVAILABLE);
    }
  }

  function notifyQuiescent(runtime) {
    if (runtime.processing || runtime.queue.length || runtime.capabilityCalls.size) return;
    for (const resolve of runtime.quiescentWaiters) resolve();
    runtime.quiescentWaiters.clear();
  }

  function waitForQuiescent(runtime) {
    if (!runtime.processing && runtime.queue.length === 0 && runtime.capabilityCalls.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => runtime.quiescentWaiters.add(resolve));
  }

  function pump(runtime) {
    if (runtime.processing || runtime.queue.length === 0) {
      notifyQuiescent(runtime);
      return;
    }
    const item = runtime.queue.shift();
    runtime.processing = true;
    void (async () => {
      try {
        await assertGeneration(runtime.moduleId, runtime.generation, runtime.packageHash, { allowDraining:true });
        const result = await runtime.host.invoke(item.method, item.args);
        await assertGeneration(runtime.moduleId, runtime.generation, runtime.packageHash, { allowDraining:true });
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      } finally {
        runtime.processing = false;
        notifyQuiescent(runtime);
        pump(runtime);
      }
    })();
  }

  function enqueue(runtime, method, args) {
    if (!runtime.accepting) {
      return Promise.reject(moduleRuntimeError(MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION, {
        currentGeneration: runtime.generation
      }));
    }
    const depth = runtime.queue.length + (runtime.processing ? 1 : 0);
    if (depth >= maxMailboxDepth) {
      return Promise.reject(moduleRuntimeError(MODULE_RUNTIME_ERROR_CODES.CAPACITY));
    }
    return new Promise((resolve, reject) => {
      runtime.queue.push({ method, args, resolve, reject });
      pump(runtime);
    });
  }

  function capabilitySetFor(pkg, runtime) {
    const exposed = Object.create(null);
    for (const name of pkg.manifest.authority.capabilities) {
      const handler = capabilityHandlers.get(name);
      if (!handler) fail(MODULE_RUNTIME_ERROR_CODES.CAPABILITY_UNAVAILABLE);
      exposed[name] = async (args) => {
        if (!runtime.accepting) fail(MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION);
        let task;
        task = (async () => {
          await assertGeneration(runtime.moduleId, runtime.generation, runtime.packageHash, { allowDraining:true });
          const context = freezeContext(
            runtime.moduleId,
            runtime.generation,
            runtime.packageHash,
            () => assertGeneration(runtime.moduleId, runtime.generation, runtime.packageHash, { allowDraining:true })
          );
          const result = await handler(args, context);
          await assertGeneration(runtime.moduleId, runtime.generation, runtime.packageHash, { allowDraining:true });
          return result;
        })();
        runtime.capabilityCalls.add(task);
        try {
          return await task;
        } finally {
          runtime.capabilityCalls.delete(task);
          notifyQuiescent(runtime);
        }
      };
    }
    return exposed;
  }

  async function activate(moduleId, { expectedRevision, frame = null, initial = null } = {}) {
    const id = assertModuleId(moduleId);
    const expected = validateExpectedRevision(expectedRevision);
    await assertRecoveryClear();
    await assertRuntimeAvailable();

    const current = await read(id);
    if (current.revision !== expected) {
      fail(MODULE_RUNTIME_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    }
    if (current.value.state === MODULE_RUNTIME_STATES.ACTIVE
        || current.value.state === MODULE_RUNTIME_STATES.DRAINING) {
      fail(MODULE_RUNTIME_ERROR_CODES.RECOVERY_REQUIRED, {
        currentRevision: current.revision,
        currentGeneration: current.value.generation
      });
    }
    if (current.value.state !== MODULE_RUNTIME_STATES.IDLE) fail(MODULE_RUNTIME_ERROR_CODES.INVALID_STATE);
    if (runtimes.has(id)) fail(MODULE_RUNTIME_ERROR_CODES.INVALID_STATE);

    const module = await moduleRegistry.getModule(id);
    const packageHash = module?.value?.activePackageHash;
    if (!packageHash) fail(MODULE_RUNTIME_ERROR_CODES.MODULE_NOT_ADMITTED);
    const pkg = await moduleRegistry.getPackage(packageHash);
    if (pkg.manifest.moduleId !== id || pkg.packageHash !== packageHash) {
      fail(MODULE_RUNTIME_ERROR_CODES.PACKAGE_MISMATCH);
    }

    for (const capability of pkg.manifest.authority.capabilities) {
      if (!capabilityHandlers.has(capability)) fail(MODULE_RUNTIME_ERROR_CODES.CAPABILITY_UNAVAILABLE);
    }

    const generation = Math.max(1, current.value.generation);
    const active = await compareAndSwap(id, current.revision, {
      ...defaultValue(id),
      generation,
      state: MODULE_RUNTIME_STATES.ACTIVE,
      activePackageHash: packageHash
    });

    const runtime = {
      moduleId:id,
      generation,
      packageHash,
      host:null,
      releaseFrame:null,
      accepting:true,
      queue:[],
      processing:false,
      capabilityCalls:new Set(),
      quiescentWaiters:new Set()
    };

    try {
      const lease = frame
        ? { frame, release:null }
        : frameLease(await frameFactory?.({ moduleId:id, generation, packageHash }));
      runtime.releaseFrame = lease.release;
      const targetFrame = lease.frame;
      if (!targetFrame) throw new TypeError("Module runtime activation requires a sandbox frame");
      const host = sandboxHostFactory({
        frame:targetFrame,
        capabilities:capabilitySetFor(pkg, runtime)
      });
      if (!host || typeof host.start !== "function" || typeof host.invoke !== "function" || typeof host.dispose !== "function") {
        throw new TypeError("Module runtime sandbox host is invalid");
      }
      runtime.host = host;
      runtimes.set(id, runtime);
      const source = pkg.files[pkg.manifest.controller];
      const started = await host.start({ source, initial });
      await assertGeneration(id, generation, packageHash);
      return Object.freeze({
        revision: active.revision,
        generation,
        packageHash,
        sessionId: started.sessionId,
        startResult: started.startResult
      });
    } catch (error) {
      runtime.accepting = false;
      runtimes.delete(id);
      try { await runtime.host?.dispose(); } catch {}
      releaseFrame(runtime);
      try {
        const latest = await read(id);
        if (latest.value.state === MODULE_RUNTIME_STATES.ACTIVE
            && latest.value.generation === generation
            && latest.value.activePackageHash === packageHash) {
          await compareAndSwap(id, latest.revision, {
            ...defaultValue(id),
            generation:generation + 1,
            state:MODULE_RUNTIME_STATES.IDLE
          });
        }
      } catch {}
      throw error;
    }
  }

  async function invoke(moduleId, method, args = null) {
    const id = assertModuleId(moduleId);
    const runtime = runtimes.get(id);
    if (!runtime) fail(MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION);
    return enqueue(runtime, method, args);
  }

  async function finishDrain(id, current, targetState) {
    const runtime = runtimes.get(id);
    if (!runtime
        || runtime.generation !== current.value.generation
        || runtime.packageHash !== current.value.activePackageHash) {
      fail(MODULE_RUNTIME_ERROR_CODES.RECOVERY_REQUIRED, {
        currentRevision: current.revision,
        currentGeneration: current.value.generation
      });
    }
    runtime.accepting = false;
    await waitForQuiescent(runtime);
    try { await runtime.host.dispose(); } finally {
      releaseFrame(runtime);
      runtimes.delete(id);
    }
    return compareAndSwap(id, current.revision, {
      ...defaultValue(id),
      generation:current.value.generation + 1,
      state:targetState
    });
  }

  async function transitionRunning(id, current, targetState) {
    const runtime = runtimes.get(id);
    if (!runtime
        || runtime.generation !== current.value.generation
        || runtime.packageHash !== current.value.activePackageHash) {
      fail(MODULE_RUNTIME_ERROR_CODES.RECOVERY_REQUIRED, {
        currentRevision: current.revision,
        currentGeneration: current.value.generation
      });
    }
    runtime.accepting = false;
    let draining;
    try {
      draining = await compareAndSwap(id, current.revision, {
        ...current.value,
        state:MODULE_RUNTIME_STATES.DRAINING
      });
    } catch (error) {
      runtime.accepting = true;
      throw error;
    }
    return finishDrain(id, draining, targetState);
  }

  async function prepareUpdate(moduleId, { expectedRevision } = {}) {
    const id = assertModuleId(moduleId);
    const expected = validateExpectedRevision(expectedRevision);
    const current = await read(id);
    if (current.revision !== expected) {
      fail(MODULE_RUNTIME_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    }
    if (current.value.state === MODULE_RUNTIME_STATES.ACTIVE) {
      return transitionRunning(id, current, MODULE_RUNTIME_STATES.IDLE);
    }
    if (current.value.state === MODULE_RUNTIME_STATES.DRAINING) {
      return finishDrain(id, current, MODULE_RUNTIME_STATES.IDLE);
    }
    const targetState = current.value.state === MODULE_RUNTIME_STATES.DISABLED
      ? MODULE_RUNTIME_STATES.DISABLED
      : MODULE_RUNTIME_STATES.IDLE;
    return compareAndSwap(id, current.revision, {
      ...defaultValue(id),
      generation:current.value.generation + 1,
      state:targetState
    });
  }

  async function disable(moduleId, { expectedRevision } = {}) {
    const id = assertModuleId(moduleId);
    const expected = validateExpectedRevision(expectedRevision);
    const current = await read(id);
    if (current.revision !== expected) {
      fail(MODULE_RUNTIME_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    }
    if (current.value.state === MODULE_RUNTIME_STATES.DISABLED) return current;
    if (current.value.state === MODULE_RUNTIME_STATES.ACTIVE) {
      return transitionRunning(id, current, MODULE_RUNTIME_STATES.DISABLED);
    }
    if (current.value.state === MODULE_RUNTIME_STATES.DRAINING) {
      return finishDrain(id, current, MODULE_RUNTIME_STATES.DISABLED);
    }
    return compareAndSwap(id, current.revision, {
      ...defaultValue(id),
      generation:current.value.generation + 1,
      state:MODULE_RUNTIME_STATES.DISABLED
    });
  }

  async function enable(moduleId, { expectedRevision } = {}) {
    const id = assertModuleId(moduleId);
    const expected = validateExpectedRevision(expectedRevision);
    const current = await read(id);
    if (current.revision !== expected) {
      fail(MODULE_RUNTIME_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    }
    if (current.value.state !== MODULE_RUNTIME_STATES.DISABLED) fail(MODULE_RUNTIME_ERROR_CODES.INVALID_STATE);
    return compareAndSwap(id, current.revision, {
      ...defaultValue(id),
      generation:current.value.generation + 1,
      state:MODULE_RUNTIME_STATES.IDLE
    });
  }

  async function recoverAll() {
    if (runtimes.size) fail(MODULE_RUNTIME_ERROR_CODES.RECOVERY_REQUIRED);
    const rows = await store.list();
    const recovered = [];
    for (const row of rows) {
      if (typeof row.key !== "string" || !row.key.startsWith("runtime:")) {
        fail(MODULE_RUNTIME_ERROR_CODES.CORRUPT_STATE);
      }
      const id = assertModuleId(row.key.slice("runtime:".length));
      const current = publicRecord(row, id);
      if (current.value.state !== MODULE_RUNTIME_STATES.ACTIVE
          && current.value.state !== MODULE_RUNTIME_STATES.DRAINING) continue;
      await compareAndSwap(id, current.revision, {
        ...defaultValue(id),
        generation:current.value.generation + 1,
        state:MODULE_RUNTIME_STATES.IDLE
      });
      recovered.push(id);
    }
    return Object.freeze(recovered.sort());
  }

  async function listStates() {
    const rows = await store.list();
    const out = [];
    for (const row of rows) {
      if (typeof row.key !== "string" || !row.key.startsWith("runtime:")) {
        fail(MODULE_RUNTIME_ERROR_CODES.CORRUPT_STATE);
      }
      const id = assertModuleId(row.key.slice("runtime:".length));
      out.push(Object.freeze({ moduleId:id, ...publicRecord(row, id) }));
    }
    out.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
    return Object.freeze(out);
  }

  // In-memory only: whether this background context hosts a live generation.
  function isRunning(moduleId) {
    const runtime = runtimes.get(assertModuleId(moduleId));
    return Boolean(runtime && runtime.accepting);
  }

  function listRunning() {
    return Object.freeze([...runtimes.values()]
      .filter((runtime) => runtime.accepting)
      .map((runtime) => Object.freeze({ moduleId:runtime.moduleId, generation:runtime.generation, packageHash:runtime.packageHash }))
      .sort((a, b) => a.moduleId.localeCompare(b.moduleId)));
  }

  return Object.freeze({
    activate,
    invoke,
    isRunning,
    listRunning,
    prepareUpdate,
    disable,
    enable,
    recoverAll,
    getState:read,
    listStates,
    assertGeneration,
    getSupport
  });
}
