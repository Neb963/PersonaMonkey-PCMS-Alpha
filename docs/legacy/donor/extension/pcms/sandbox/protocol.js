const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_OWN_PROPERTY_SYMBOLS = Object.getOwnPropertySymbols;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_ENTRIES = Object.entries;
const OBJECT_KEYS = Object.keys;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const NUMBER_IS_FINITE = Number.isFinite;
const NativeWeakSet = WeakSet;
const NativeSet = Set;
const SET_HAS = Function.call.bind(Set.prototype.has);
const JSON_STRINGIFY = JSON.stringify.bind(JSON);
const TEXT_ENCODER = new TextEncoder();
const TEXT_ENCODE = TEXT_ENCODER.encode.bind(TEXT_ENCODER);

export const SANDBOX_PROTOCOL_VERSION = 1;
export const SANDBOX_BOOTSTRAP_TYPE = "pcms.sandbox.bootstrap";
export const SANDBOX_MAX_MESSAGE_BYTES = 64 * 1024;
export const SANDBOX_MAX_ENVELOPE_BYTES = 384 * 1024;
export const SANDBOX_MAX_SOURCE_BYTES = 256 * 1024;
export const SANDBOX_MAX_DEPTH = 10;
export const SANDBOX_MAX_NODES = 4096;
export const SANDBOX_MAX_STRING_LENGTH = 256 * 1024;
export const SANDBOX_MAX_ID_LENGTH = 128;
export const SANDBOX_MAX_CAPABILITY_NAME_LENGTH = 128;

export const SANDBOX_ERROR_CODES = Object.freeze({
  PROTOCOL: "PCMS_SANDBOX_PROTOCOL",
  CAPABILITY_DENIED: "PCMS_SANDBOX_CAPABILITY_DENIED",
  CAPABILITY_FAILED: "PCMS_SANDBOX_CAPABILITY_FAILED",
  RPC_CAPACITY: "PCMS_SANDBOX_RPC_CAPACITY",
  CONTROLLER_INVALID: "PCMS_SANDBOX_CONTROLLER_INVALID",
  CONTROLLER_FAILED: "PCMS_SANDBOX_CONTROLLER_FAILED",
  NOT_READY: "PCMS_SANDBOX_NOT_READY",
  DISPOSED: "PCMS_SANDBOX_DISPOSED",
  TIMEOUT: "PCMS_SANDBOX_TIMEOUT"
});

const SAFE_ERROR_MESSAGES = Object.freeze({
  [SANDBOX_ERROR_CODES.PROTOCOL]: "Sandbox protocol violation",
  [SANDBOX_ERROR_CODES.CAPABILITY_DENIED]: "Capability is not granted",
  [SANDBOX_ERROR_CODES.CAPABILITY_FAILED]: "Capability call failed",
  [SANDBOX_ERROR_CODES.RPC_CAPACITY]: "Sandbox RPC capacity is exhausted",
  [SANDBOX_ERROR_CODES.CONTROLLER_INVALID]: "Dynamic controller is invalid",
  [SANDBOX_ERROR_CODES.CONTROLLER_FAILED]: "Dynamic controller operation failed",
  [SANDBOX_ERROR_CODES.NOT_READY]: "Sandbox controller is not ready",
  [SANDBOX_ERROR_CODES.DISPOSED]: "Sandbox controller is disposed",
  [SANDBOX_ERROR_CODES.TIMEOUT]: "Sandbox operation timed out"
});

const STABLE_ERROR_CODES = OBJECT_FREEZE(Object.values(SANDBOX_ERROR_CODES));
const STABLE_ERROR_CODE_SET = new NativeSet(STABLE_ERROR_CODES);
const FORBIDDEN_KEYS = new NativeSet(["__proto__", "prototype", "constructor"]);

export class SandboxProtocolError extends Error {
  constructor(code, message = SAFE_ERROR_MESSAGES[code] || SAFE_ERROR_MESSAGES[SANDBOX_ERROR_CODES.PROTOCOL]) {
    super(message);
    this.name = "SandboxProtocolError";
    this.code = code;
  }
}

function fail(code = SANDBOX_ERROR_CODES.PROTOCOL) {
  throw new SandboxProtocolError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || ARRAY_IS_ARRAY(value)) return false;
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === OBJECT_PROTOTYPE || prototype === null;
}

function setHas(set, value) {
  return SET_HAS(set, value);
}

function assertExactKeys(value, expected) {
  const actual = OBJECT_KEYS(value);
  if (actual.length !== expected.length) fail();
  for (let index = 0; index < expected.length; index += 1) {
    if (!OBJECT_HAS_OWN(value, expected[index])) fail();
  }
}

export function sandboxSerializedBytes(value) {
  return TEXT_ENCODE(JSON_STRINGIFY(value)).byteLength;
}

export function cloneSandboxJson(value, {
  maxBytes = SANDBOX_MAX_MESSAGE_BYTES,
  maxDepth = SANDBOX_MAX_DEPTH,
  maxNodes = SANDBOX_MAX_NODES,
  maxStringLength = SANDBOX_MAX_STRING_LENGTH
} = {}) {
  const ancestors = new NativeWeakSet();
  let nodes = 0;

  const visit = (input, depth) => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) fail();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!NUMBER_IS_FINITE(input)) fail();
      return input;
    }
    if (typeof input === "string") {
      if (input.length > maxStringLength) fail();
      return input;
    }
    if (typeof input !== "object") fail();
    if (ancestors.has(input)) fail();
    if (OBJECT_GET_OWN_PROPERTY_SYMBOLS(input).length) fail();

    ancestors.add(input);
    try {
      const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(input);
      if (ARRAY_IS_ARRAY(input)) {
        if (OBJECT_GET_PROTOTYPE_OF(input) !== ARRAY_PROTOTYPE) fail();
        const out = new Array(input.length);
        for (const [key, descriptor] of OBJECT_ENTRIES(descriptors)) {
          if (key === "length") continue;
          if (!/^(0|[1-9][0-9]*)$/.test(key)
              || Number(key) >= input.length
              || !descriptor.enumerable
              || !OBJECT_HAS_OWN(descriptor, "value")) fail();
        }
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !OBJECT_HAS_OWN(descriptor, "value")) fail();
          out[index] = visit(descriptor.value, depth + 1);
        }
        return out;
      }

      if (!isPlainObject(input)) fail();
      const out = {};
      for (const [key, descriptor] of OBJECT_ENTRIES(descriptors)) {
        if (setHas(FORBIDDEN_KEYS, key)
            || key.length > 256
            || !descriptor.enumerable
            || !OBJECT_HAS_OWN(descriptor, "value")) fail();
        out[key] = visit(descriptor.value, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(input);
    }
  };

  const cloned = visit(value, 0);
  if (sandboxSerializedBytes(cloned) > maxBytes) fail();
  return cloned;
}

export function assertSandboxId(value, label = "id") {
  if (typeof value !== "string" || value.length < 1 || value.length > SANDBOX_MAX_ID_LENGTH) {
    throw new SandboxProtocolError(SANDBOX_ERROR_CODES.PROTOCOL, label + " is invalid");
  }
  return value;
}

export function assertSandboxRpcName(value, label = "RPC name") {
  if (typeof value !== "string"
      || value.length < 1
      || value.length > SANDBOX_MAX_CAPABILITY_NAME_LENGTH
      || setHas(FORBIDDEN_KEYS, value)) {
    throw new SandboxProtocolError(SANDBOX_ERROR_CODES.PROTOCOL, label + " is invalid");
  }
  return value;
}

export function validateSandboxBootstrap(value) {
  const message = cloneSandboxJson(value, { maxBytes: 4096, maxDepth: 3, maxNodes: 32, maxStringLength: 256 });
  if (!isPlainObject(message)
      || message.type !== SANDBOX_BOOTSTRAP_TYPE
      || message.version !== SANDBOX_PROTOCOL_VERSION) fail();
  assertSandboxId(message.sessionId, "sessionId");
  assertExactKeys(message, ["type", "version", "sessionId"]);
  return message;
}

export function validateSandboxPortMessage(value, expectedSessionId) {
  const message = cloneSandboxJson(value, { maxBytes: SANDBOX_MAX_ENVELOPE_BYTES });
  if (!isPlainObject(message) || message.version !== SANDBOX_PROTOCOL_VERSION) fail();
  assertSandboxId(message.sessionId, "sessionId");
  if (message.sessionId !== expectedSessionId) fail();
  assertSandboxRpcName(message.type, "message type");

  switch (message.type) {
    case "ready":
      assertExactKeys(message, ["version", "sessionId", "type"]);
      return message;
    case "request":
      assertSandboxId(message.requestId, "requestId");
      assertSandboxRpcName(message.method, "method");
      cloneSandboxJson(message.params ?? {}, { maxBytes: SANDBOX_MAX_ENVELOPE_BYTES });
      assertExactKeys(message, ["version", "sessionId", "type", "requestId", "method", "params"]);
      return message;
    case "response":
      assertSandboxId(message.requestId, "requestId");
      if (typeof message.ok !== "boolean") fail();
      if (message.ok) {
        if (!OBJECT_HAS_OWN(message, "result")) fail();
        cloneSandboxJson(message.result, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES });
        assertExactKeys(message, ["version", "sessionId", "type", "requestId", "ok", "result"]);
      } else {
        validateSandboxError(message.error);
        assertExactKeys(message, ["version", "sessionId", "type", "requestId", "ok", "error"]);
      }
      return message;
    case "capability.call":
      assertSandboxId(message.callId, "callId");
      assertSandboxRpcName(message.capability, "capability");
      cloneSandboxJson(message.args ?? {}, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES });
      assertExactKeys(message, ["version", "sessionId", "type", "callId", "capability", "args"]);
      return message;
    case "capability.result":
      assertSandboxId(message.callId, "callId");
      if (typeof message.ok !== "boolean") fail();
      if (message.ok) {
        if (!OBJECT_HAS_OWN(message, "result")) fail();
        cloneSandboxJson(message.result, { maxBytes: SANDBOX_MAX_MESSAGE_BYTES });
        assertExactKeys(message, ["version", "sessionId", "type", "callId", "ok", "result"]);
      } else {
        validateSandboxError(message.error);
        assertExactKeys(message, ["version", "sessionId", "type", "callId", "ok", "error"]);
      }
      return message;
    default:
      fail();
  }
}

export function validateSandboxError(error) {
  if (!isPlainObject(error)
      || typeof error.code !== "string"
      || !setHas(STABLE_ERROR_CODE_SET, error.code)
      || typeof error.message !== "string"
      || error.message.length > 256) fail();
  assertExactKeys(error, ["code", "message"]);
  return error;
}

export function safeSandboxError(code) {
  const safeCode = setHas(STABLE_ERROR_CODE_SET, code) ? code : SANDBOX_ERROR_CODES.PROTOCOL;
  return OBJECT_FREEZE({ code: safeCode, message: SAFE_ERROR_MESSAGES[safeCode] });
}
