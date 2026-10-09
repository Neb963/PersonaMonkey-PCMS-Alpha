import { SECRET_ERROR_CODES, secretError } from "./errors.js";
import { assertSecretRef } from "./secret-ref.js";

export const SECRET_HOST_PROTOCOL_VERSION = 1;
export const SECRET_HOST_NAME = "com.persona.pcms_secret_store";
export const MAX_SECRET_BYTES = 256 * 1024;
export const DEFAULT_SECRET_TIMEOUT_MS = 5000;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST_ERROR_CODES = new Set(["NOT_FOUND", "LOCKED", "UNAVAILABLE", "INVALID_REQUEST"]);

function ownKeysExactly(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const actual = keys.slice().sort();
  const wanted = expected.slice().sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function assertRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    throw secretError(SECRET_ERROR_CODES.PROTOCOL);
  }
  return value.toLowerCase();
}

export function assertSecretValue(value) {
  if (typeof value !== "string") throw secretError(SECRET_ERROR_CODES.INVALID_VALUE);
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 1 || bytes > MAX_SECRET_BYTES) {
    throw secretError(SECRET_ERROR_CODES.INVALID_VALUE);
  }
  return value;
}

export function makeSecretHostRequest({ id, op, secretRef, value }) {
  const requestId = assertRequestId(id);
  if (op === "probe") {
    return Object.freeze({ version: SECRET_HOST_PROTOCOL_VERSION, id: requestId, op });
  }
  const ref = assertSecretRef(secretRef);
  if (op === "put") {
    return Object.freeze({
      version: SECRET_HOST_PROTOCOL_VERSION,
      id: requestId,
      op,
      secretRef: ref,
      value: assertSecretValue(value)
    });
  }
  if (op === "get" || op === "delete") {
    return Object.freeze({ version: SECRET_HOST_PROTOCOL_VERSION, id: requestId, op, secretRef: ref });
  }
  throw secretError(SECRET_ERROR_CODES.PROTOCOL);
}

function mapHostError(code) {
  if (code === "NOT_FOUND") return SECRET_ERROR_CODES.NOT_FOUND;
  if (code === "LOCKED" || code === "UNAVAILABLE") return SECRET_ERROR_CODES.UNAVAILABLE;
  return SECRET_ERROR_CODES.PROTOCOL;
}

export function parseSecretHostResponse(response, { id, op }) {
  const requestId = assertRequestId(id);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw secretError(SECRET_ERROR_CODES.PROTOCOL);
  }
  if (response.version !== SECRET_HOST_PROTOCOL_VERSION || response.id !== requestId || typeof response.ok !== "boolean") {
    throw secretError(SECRET_ERROR_CODES.PROTOCOL);
  }

  if (response.ok === false) {
    if (!ownKeysExactly(response, ["version", "id", "ok", "error"])
        || !ownKeysExactly(response.error, ["code"])
        || typeof response.error.code !== "string"
        || !HOST_ERROR_CODES.has(response.error.code)) {
      throw secretError(SECRET_ERROR_CODES.PROTOCOL);
    }
    throw secretError(mapHostError(response.error.code));
  }

  if (!ownKeysExactly(response, ["version", "id", "ok", "result"])) {
    throw secretError(SECRET_ERROR_CODES.PROTOCOL);
  }

  if (op === "probe") {
    if (!ownKeysExactly(response.result, ["ready"]) || response.result.ready !== true) {
      throw secretError(SECRET_ERROR_CODES.PROTOCOL);
    }
    return Object.freeze({ ready: true });
  }
  if (op === "put") {
    if (!ownKeysExactly(response.result, ["stored"]) || response.result.stored !== true) {
      throw secretError(SECRET_ERROR_CODES.PROTOCOL);
    }
    return Object.freeze({ stored: true });
  }
  if (op === "delete") {
    if (!ownKeysExactly(response.result, ["deleted"]) || typeof response.result.deleted !== "boolean") {
      throw secretError(SECRET_ERROR_CODES.PROTOCOL);
    }
    return Object.freeze({ deleted: response.result.deleted });
  }
  if (op === "get") {
    if (!ownKeysExactly(response.result, ["value"])) {
      throw secretError(SECRET_ERROR_CODES.PROTOCOL);
    }
    return Object.freeze({ value: assertSecretValue(response.result.value) });
  }
  throw secretError(SECRET_ERROR_CODES.PROTOCOL);
}
