import { MODULE_ERROR_CODES, moduleError } from "./errors.js";

export const MODULE_MAX_CAPABILITIES = 64;
export const MODULE_MAX_CAPABILITY_LENGTH = 96;

const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const RESERVED_ROOTS = new Set(["browser", "chrome", "indexeddb", "native", "personamonkey"]);

function fail() {
  throw moduleError(MODULE_ERROR_CODES.INVALID_AUTHORITY);
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

function validateCapability(value) {
  if (typeof value !== "string"
      || value.length < 3
      || value.length > MODULE_MAX_CAPABILITY_LENGTH
      || !CAPABILITY_PATTERN.test(value)
      || RESERVED_ROOTS.has(value.split(".", 1)[0])) fail();
  return value;
}

export function normalizeModuleAuthority(value) {
  if (!plainObject(value) || !exactKeys(value, ["capabilities"]) || !Array.isArray(value.capabilities)) fail();
  if (value.capabilities.length > MODULE_MAX_CAPABILITIES) fail();

  const capabilities = [];
  const seen = new Set();
  for (const raw of value.capabilities) {
    const capability = validateCapability(raw);
    if (seen.has(capability)) fail();
    seen.add(capability);
    capabilities.push(capability);
  }
  capabilities.sort();
  return Object.freeze({ capabilities: Object.freeze(capabilities) });
}

export function diffModuleAuthority(previous, next) {
  const before = normalizeModuleAuthority(previous);
  const after = normalizeModuleAuthority(next);
  const beforeSet = new Set(before.capabilities);
  const afterSet = new Set(after.capabilities);
  const added = after.capabilities.filter((item) => !beforeSet.has(item));
  const removed = before.capabilities.filter((item) => !afterSet.has(item));
  const unchanged = after.capabilities.filter((item) => beforeSet.has(item));

  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    unchanged: Object.freeze(unchanged),
    requiresApproval: added.length > 0
  });
}

export const EMPTY_MODULE_AUTHORITY = normalizeModuleAuthority({ capabilities: [] });
