import {
  SANDBOX_ERROR_CODES,
  SANDBOX_MAX_MESSAGE_BYTES,
  SANDBOX_MAX_SOURCE_BYTES,
  SANDBOX_PROTOCOL_VERSION,
  SandboxProtocolError,
  assertSandboxRpcName,
  cloneSandboxJson,
  safeSandboxError,
  validateSandboxBootstrap,
  validateSandboxPortMessage
} from "./protocol.js";

const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_OWN_PROPERTY_SYMBOLS = Object.getOwnPropertySymbols;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_ENTRIES = Object.entries;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const TEXT_ENCODER = new TextEncoder();
const TEXT_ENCODE = TEXT_ENCODER.encode.bind(TEXT_ENCODER);
const NativePromise = Promise;

function protocolError(code) {
  return new SandboxProtocolError(code);
}

function jsonResult(value) {
  return cloneSandboxJson(value === undefined ? null : value, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES });
}

function validateController(controller) {
  if (controller === null || typeof controller !== "object" || ARRAY_IS_ARRAY(controller)) {
    throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF(controller);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
    throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
  }
  if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(controller).length) {
    throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
  }
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(controller);
  for (const [name, descriptor] of OBJECT_ENTRIES(descriptors)) {
    assertSandboxRpcName(name, "controller method");
    if (!descriptor.enumerable
        || !OBJECT_HAS_OWN(descriptor, "value")
        || typeof descriptor.value !== "function") {
      throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
    }
  }
  return controller;
}

export function installSandboxControllerRuntime({
  windowRef = globalThis.window,
  FunctionCtor = globalThis.Function,
  capabilityTimeoutMs = 15_000,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  queueTask = globalThis.queueMicrotask?.bind(globalThis)
} = {}) {
  if (!windowRef?.addEventListener || !windowRef?.removeEventListener || !windowRef?.location) {
    throw new TypeError("Sandbox controller runtime requires a Window-like object");
  }
  if (typeof FunctionCtor !== "function"
      || typeof setTimer !== "function"
      || typeof clearTimer !== "function"
      || typeof queueTask !== "function") {
    throw new TypeError("Sandbox controller runtime prerequisites are unavailable");
  }

  let port = null;
  let postPortMessage = null;
  let closePort = null;
  let sessionId = null;
  let controller = null;
  let disposed = false;
  let capabilitySequence = 0;
  const pendingCapabilities = new Map();
  const pendingGet = pendingCapabilities.get.bind(pendingCapabilities);
  const pendingSet = pendingCapabilities.set.bind(pendingCapabilities);
  const pendingDelete = pendingCapabilities.delete.bind(pendingCapabilities);
  const pendingValues = pendingCapabilities.values.bind(pendingCapabilities);
  const pendingClear = pendingCapabilities.clear.bind(pendingCapabilities);

  function rejectPending(code) {
    for (const pending of pendingValues()) {
      clearTimer(pending.timer);
      pending.reject(protocolError(code));
    }
    pendingClear();
  }

  function shutdown(code = SANDBOX_ERROR_CODES.DISPOSED) {
    if (disposed) return;
    disposed = true;
    rejectPending(code);
    try { closePort?.(); } catch {}
    port = null;
    postPortMessage = null;
    closePort = null;
  }

  function post(message) {
    if (disposed || !postPortMessage) throw protocolError(SANDBOX_ERROR_CODES.DISPOSED);
    postPortMessage(message);
  }

  function sendResponse(requestId, ok, value) {
    const base = { version: SANDBOX_PROTOCOL_VERSION, sessionId, type: "response", requestId, ok };
    post(ok
      ? { ...base, result: jsonResult(value) }
      : { ...base, error: safeSandboxError(value) });
  }

  function callCapability(capability, args = {}) {
    if (disposed) return NativePromise.reject(protocolError(SANDBOX_ERROR_CODES.DISPOSED));
    try {
      assertSandboxRpcName(capability, "capability");
      const safeArgs = cloneSandboxJson(args, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES });
      const callId = "cap-" + (++capabilitySequence);
      return new NativePromise((resolve, reject) => {
        const timer = setTimer(() => {
          pendingDelete(callId);
          reject(protocolError(SANDBOX_ERROR_CODES.TIMEOUT));
        }, capabilityTimeoutMs);
        pendingSet(callId, { resolve, reject, timer });
        post({
          version: SANDBOX_PROTOCOL_VERSION,
          sessionId,
          type: "capability.call",
          callId,
          capability,
          args: safeArgs
        });
      });
    } catch (error) {
      return NativePromise.reject(error);
    }
  }

  const api = OBJECT_FREEZE({
    version: SANDBOX_PROTOCOL_VERSION,
    call: callCapability
  });

  async function loadController(params) {
    if (controller) throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
    const safeParams = cloneSandboxJson(params, {
      maxBytes: SANDBOX_MAX_SOURCE_BYTES + SANDBOX_MAX_MESSAGE_BYTES + 4096
    });
    const source = safeParams.source;
    if (typeof source !== "string"
        || !source.trim()
        || TEXT_ENCODE(source).byteLength > SANDBOX_MAX_SOURCE_BYTES) {
      throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
    }

    let factory;
    try {
      factory = FunctionCtor('"use strict"; return (' + source + '\n);')();
    } catch {
      throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
    }
    if (typeof factory !== "function") {
      throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
    }

    try {
      const candidate = await factory(api);
      controller = OBJECT_FREEZE(validateController(candidate));
      const startResult = typeof controller.start === "function"
        ? await controller.start(cloneSandboxJson(safeParams.initial ?? null, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES }))
        : null;
      return jsonResult(startResult);
    } catch (error) {
      controller = null;
      if (error instanceof SandboxProtocolError) throw error;
      throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_FAILED);
    }
  }

  async function invokeController(params) {
    if (!controller) throw protocolError(SANDBOX_ERROR_CODES.NOT_READY);
    const safeParams = cloneSandboxJson(params, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES });
    const method = assertSandboxRpcName(safeParams.method, "controller method");
    if (method === "start"
        || method === "dispose"
        || !OBJECT_HAS_OWN(controller, method)
        || typeof controller[method] !== "function") {
      throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
    }
    try {
      return jsonResult(await controller[method](safeParams.args ?? null));
    } catch (error) {
      if (error instanceof SandboxProtocolError) throw error;
      throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_FAILED);
    }
  }

  async function disposeController() {
    if (!controller) return null;
    const active = controller;
    controller = null;
    try {
      return typeof active.dispose === "function" ? jsonResult(await active.dispose()) : null;
    } catch {
      throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_FAILED);
    }
  }

  async function onPortMessage(event) {
    if (disposed) return;
    let message;
    try {
      message = validateSandboxPortMessage(event?.data, sessionId);
    } catch {
      shutdown(SANDBOX_ERROR_CODES.PROTOCOL);
      return;
    }

    if (message.type === "capability.result") {
      const pending = pendingGet(message.callId);
      if (!pending) {
        shutdown(SANDBOX_ERROR_CODES.PROTOCOL);
        return;
      }
      pendingDelete(message.callId);
      clearTimer(pending.timer);
      if (message.ok) pending.resolve(jsonResult(message.result));
      else pending.reject(protocolError(message.error.code));
      return;
    }

    if (message.type !== "request") {
      shutdown(SANDBOX_ERROR_CODES.PROTOCOL);
      return;
    }

    try {
      let result;
      if (message.method === "controller.load") result = await loadController(message.params);
      else if (message.method === "controller.invoke") result = await invokeController(message.params);
      else if (message.method === "controller.dispose") result = await disposeController();
      else throw protocolError(SANDBOX_ERROR_CODES.PROTOCOL);
      sendResponse(message.requestId, true, result);
      if (message.method === "controller.dispose") queueTask(() => shutdown());
    } catch (error) {
      const code = error instanceof SandboxProtocolError
        ? error.code
        : SANDBOX_ERROR_CODES.CONTROLLER_FAILED;
      sendResponse(message.requestId, false, code);
      if (message.method === "controller.dispose") queueTask(() => shutdown());
    }
  }

  function onBootstrap(event) {
    if (disposed || port) return;
    if (event?.source !== windowRef.parent || event?.origin !== windowRef.location.origin) return;

    let bootstrap;
    try {
      bootstrap = validateSandboxBootstrap(event.data);
      if (event?.ports?.length !== 1 || !event.ports[0]) return;
    } catch {
      return;
    }

    const candidatePort = event.ports[0];
    if (typeof candidatePort.postMessage !== "function"
        || typeof candidatePort.close !== "function"
        || typeof candidatePort.addEventListener !== "function") return;

    sessionId = bootstrap.sessionId;
    port = candidatePort;
    postPortMessage = candidatePort.postMessage.bind(candidatePort);
    closePort = candidatePort.close.bind(candidatePort);
    windowRef.removeEventListener("message", onBootstrap);
    candidatePort.addEventListener("message", onPortMessage);
    candidatePort.start?.();
    post({ version: SANDBOX_PROTOCOL_VERSION, sessionId, type: "ready" });
  }

  windowRef.addEventListener("message", onBootstrap);

  return OBJECT_FREEZE({
    get bootstrapped() { return Boolean(port); },
    get disposed() { return disposed; },
    dispose() {
      windowRef.removeEventListener("message", onBootstrap);
      shutdown();
    }
  });
}
