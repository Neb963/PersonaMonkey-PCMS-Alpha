import { SECRET_ERROR_CODES, secretError } from "./errors.js";

export const SECRET_REF_PREFIX = "pcms-secret:v1:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_REF_PATTERN = /^pcms-secret:v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function isSecretRef(value) {
  return typeof value === "string" && SECRET_REF_PATTERN.test(value);
}

export function assertSecretRef(value) {
  if (!isSecretRef(value)) throw secretError(SECRET_ERROR_CODES.INVALID_REF);
  return value.toLowerCase();
}

export function createSecretRef({
  randomUUID = () => globalThis.crypto?.randomUUID?.()
} = {}) {
  const id = randomUUID();
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw secretError(SECRET_ERROR_CODES.UNAVAILABLE);
  }
  return SECRET_REF_PREFIX + id.toLowerCase();
}

export function secretRefId(value) {
  const ref = assertSecretRef(value);
  return ref.slice(SECRET_REF_PREFIX.length);
}

export function secretRefDiagnostic(value) {
  assertSecretRef(value);
  return "pcms-secret:v1:[opaque]";
}
