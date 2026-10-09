import {
  SANDBOX_BOOTSTRAP_TYPE,
  SANDBOX_ERROR_CODES,
  SANDBOX_MAX_MESSAGE_BYTES,
  SANDBOX_MAX_SOURCE_BYTES,
  SANDBOX_PROTOCOL_VERSION,
  SandboxProtocolError,
  assertSandboxId,
  assertSandboxRpcName,
  cloneSandboxJson,
  safeSandboxError,
  validateSandboxPortMessage
} from "../sandbox/protocol.js";

const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_OWN_PROPERTY_SYMBOLS = Object.getOwnPropertySymbols;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_ENTRIES = Object.entries;
const OBJECT_FREEZE = Object.freeze;
const ARRAY_IS_ARRAY = Array.isArray;
const TEXT_ENCODER = new TextEncoder();
const TEXT_ENCODE = TEXT_ENCODER.encode.bind(TEXT_ENCODER);
const NativePromise = Promise;

function protocolError(code) {
  return new SandboxProtocolError(code);
}

function defaultSessionIdFactory() {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Sandbox host requires crypto.randomUUID");
  }
  return globalThis.crypto.randomUUID();
}

function normalizeCapabilities(capabilities) {
  if (capabilities === null || typeof capabilities !== "object" || ARRAY_IS_ARRAY(capabilities)) {
    throw new TypeError("Sandbox capabilities must be a plain object");
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF(capabilities);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Sandbox capabilities must be a plain object");
  }
  if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(capabilities).length) {
    throw new TypeError("Sandbox capabilities may not use symbol keys");
  }
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(capabilities);
  const normalized = new Map();
  for (const [name, descriptor] of OBJECT_ENTRIES(descriptors)) {
    assertSandboxRpcName(name, "capability");
    if (!descriptor.enumerable || !OBJECT_HAS_OWN(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new TypeError("Sandbox capability values must be functions");
    }
    normalized.set(name, descriptor.value);
  }
  return normalized;
}

export function createSandboxControllerHost({
  frame,
  capabilities = {},
  messageChannelFactory = () => new MessageChannel(),
  sessionIdFactory = defaultSessionIdFactory,
  timeoutMs = 5_000,
  maxInFlightCapabilityCalls = 16,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis)
} = {}) {
  if (!frame?.contentWindow || typeof frame.contentWindow.postMessage !== "function") {
    throw new TypeError("Sandbox host requires a loaded iframe-like target");
  }
  if (typeof messageChannelFactory !== "function"
      || typeof sessionIdFactory !== "function"
      || typeof setTimer !== "function"
      || typeof clearTimer !== "function") {
    throw new TypeError("Sandbox host prerequisites are unavailable");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new RangeError("Sandbox timeout is out of bounds");
  }
  if (!Number.isInteger(maxInFlightCapabilityCalls)
      || maxInFlightCapabilityCalls < 1
      || maxInFlightCapabilityCalls > 128) {
    throw new RangeError("Sandbox capability concurrency is out of bounds");
  }

  const handlers = normalizeCapabilities(capabilities);
  let state = "idle";
  let sessionId = null;
  let port = null;
  let postPortMessage = null;
  let closePort = null;
  let requestSequence = 0;
  let inFlightCapabilityCalls = 0;
  let readyPending = null;
  const pendingRequests = new Map();

  function rejectPending(code) {
    if (readyPending) {
      clearTimer(readyPending.timer);
      readyPending.reject(protocolError(code));
      readyPending = null;
    }
    for (const pending of pendingRequests.values()) {
      clearTimer(pending.timer);
      pending.reject(protocolError(code));
    }
    pendingRequests.clear();
  }

  function shutdown(code = SANDBOX_ERROR_CODES.DISPOSED) {
    if (state === "disposed") return;
    state = "disposed";
    rejectPending(code);
    try { closePort?.(); } catch {}
    port = null;
    postPortMessage = null;
    closePort = null;
  }

  function post(message) {
    if (state === "disposed" || !postPortMessage) {
      throw protocolError(SANDBOX_ERROR_CODES.DISPOSED);
    }
    postPortMessage(message);
  }

  function sendCapabilityResult(callId, ok, value) {
    const base = {
      version: SANDBOX_PROTOCOL_VERSION,
      sessionId,
      type: "capability.result",
      callId,
      ok
    };
    post(ok
      ? { ...base, result: cloneSandboxJson(value === undefined ? null : value, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES }) }
      : { ...base, error: safeSandboxError(value) });
  }

  async function dispatchCapability(message) {
    const handler = handlers.get(message.capability);
    if (!handler) {
      sendCapabilityResult(message.callId, false, SANDBOX_ERROR_CODES.CAPABILITY_DENIED);
      return;
    }
    if (inFlightCapabilityCalls >= maxInFlightCapabilityCalls) {
      sendCapabilityResult(message.callId, false, SANDBOX_ERROR_CODES.RPC_CAPACITY);
      return;
    }

    inFlightCapabilityCalls += 1;
    try {
      const args = cloneSandboxJson(message.args, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES });
      const result = await handler(args);
      sendCapabilityResult(message.callId, true, result);
    } catch {
      sendCapabilityResult(message.callId, false, SANDBOX_ERROR_CODES.CAPABILITY_FAILED);
    } finally {
      inFlightCapabilityCalls -= 1;
    }
  }

  function onPortMessage(event) {
    if (state === "disposed") return;
    let message;
    try {
      message = validateSandboxPortMessage(event?.data, sessionId);
    } catch {
      shutdown(SANDBOX_ERROR_CODES.PROTOCOL);
      return;
    }

    if (message.type === "ready") {
      if (state !== "booting" || !readyPending) {
        shutdown(SANDBOX_ERROR_CODES.PROTOCOL);
        return;
      }
      const pending = readyPending;
      readyPending = null;
      clearTimer(pending.timer);
      pending.resolve();
      return;
    }

    if (message.type === "response") {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) {
        shutdown(SANDBOX_ERROR_CODES.PROTOCOL);
        return;
      }
      pendingRequests.delete(message.requestId);
      clearTimer(pending.timer);
      if (message.ok) pending.resolve(cloneSandboxJson(message.result, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES }));
      else pending.reject(protocolError(message.error.code));
      return;
    }

    if (message.type === "capability.call") {
      void dispatchCapability(message).catch(() => shutdown(SANDBOX_ERROR_CODES.PROTOCOL));
      return;
    }

    shutdown(SANDBOX_ERROR_CODES.PROTOCOL);
  }

  function request(method, params) {
    if (state === "disposed" || !postPortMessage) {
      return NativePromise.reject(protocolError(SANDBOX_ERROR_CODES.DISPOSED));
    }
    try {
      assertSandboxRpcName(method, "method");
      const safeParams = cloneSandboxJson(params, {
        maxBytes: method === "controller.load"
          ? SANDBOX_MAX_SOURCE_BYTES + SANDBOX_MAX_MESSAGE_BYTES + 4096
          : SANDBOX_MAX_MESSAGE_BYTES
      });
      const requestId = "req-" + (++requestSequence);
      return new NativePromise((resolve, reject) => {
        const timer = setTimer(() => {
          pendingRequests.delete(requestId);
          reject(protocolError(SANDBOX_ERROR_CODES.TIMEOUT));
        }, timeoutMs);
        pendingRequests.set(requestId, { resolve, reject, timer });
        post({
          version: SANDBOX_PROTOCOL_VERSION,
          sessionId,
          type: "request",
          requestId,
          method,
          params: safeParams
        });
      });
    } catch (error) {
      return NativePromise.reject(error);
    }
  }

  async function start({ source, initial = null } = {}) {
    if (state !== "idle") {
      throw protocolError(state === "disposed" ? SANDBOX_ERROR_CODES.DISPOSED : SANDBOX_ERROR_CODES.PROTOCOL);
    }
    if (typeof source !== "string" || !source.trim() || TEXT_ENCODE(source).byteLength > SANDBOX_MAX_SOURCE_BYTES) {
      throw protocolError(SANDBOX_ERROR_CODES.CONTROLLER_INVALID);
    }

    sessionId = assertSandboxId(sessionIdFactory(), "sessionId");
    const channel = messageChannelFactory();
    if (!channel?.port1 || !channel?.port2
        || typeof channel.port1.postMessage !== "function"
        || typeof channel.port1.close !== "function"
        || typeof channel.port1.addEventListener !== "function") {
      throw new TypeError("Sandbox host requires a MessageChannel-compatible factory");
    }

    port = channel.port1;
    postPortMessage = port.postMessage.bind(port);
    closePort = port.close.bind(port);
    port.addEventListener("message", onPortMessage);
    port.start?.();
    state = "booting";

    const ready = new NativePromise((resolve, reject) => {
      const timer = setTimer(() => {
        readyPending = null;
        reject(protocolError(SANDBOX_ERROR_CODES.TIMEOUT));
      }, timeoutMs);
      readyPending = { resolve, reject, timer };
    });

    try {
      frame.contentWindow.postMessage({
        type: SANDBOX_BOOTSTRAP_TYPE,
        version: SANDBOX_PROTOCOL_VERSION,
        sessionId
      }, "*", [channel.port2]);
      await ready;
      const startResult = await request("controller.load", { source, initial });
      state = "active";
      return OBJECT_FREEZE({ sessionId, startResult });
    } catch (error) {
      shutdown(error instanceof SandboxProtocolError ? error.code : SANDBOX_ERROR_CODES.PROTOCOL);
      throw error;
    }
  }

  async function invoke(method, args = null) {
    if (state !== "active") {
      throw protocolError(state === "disposed" ? SANDBOX_ERROR_CODES.DISPOSED : SANDBOX_ERROR_CODES.NOT_READY);
    }
    assertSandboxRpcName(method, "controller method");
    return request("controller.invoke", { method, args });
  }

  async function dispose() {
    if (state === "disposed") return null;
    let result = null;
    try {
      if (state === "active") result = await request("controller.dispose", {});
      return result;
    } finally {
      shutdown();
    }
  }

  return OBJECT_FREEZE({
    start,
    invoke,
    dispose,
    get state() { return state; },
    get sessionId() { return sessionId; },
    get capabilityNames() { return OBJECT_FREEZE([...handlers.keys()]); }
  });
}
