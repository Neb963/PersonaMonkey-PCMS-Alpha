import { CORE_SERVICE_ERROR_CODES, coreServiceError } from "./errors.js";

const SERVICE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const METHOD_PATTERN = /^[a-z][A-Za-z0-9]{0,95}$/;
const RESERVED_METHODS = new Set(["constructor", "prototype", "__proto__"]);

function fail(code, options = {}) { throw coreServiceError(code, options); }

function assertServiceName(value) {
  if (typeof value !== "string" || value.length > 128 || !SERVICE_PATTERN.test(value)) {
    fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  }
  return value;
}

function assertOwnerId(value) {
  if (typeof value !== "string" || !OWNER_PATTERN.test(value)) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  return value;
}

function assertGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  return value;
}

function normalizeMethods(service) {
  if (!service || typeof service !== "object" || Array.isArray(service)) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  const prototype = Object.getPrototypeOf(service);
  if (prototype !== Object.prototype && prototype !== null) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  if (Object.getOwnPropertySymbols(service).length) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  const methods = new Map();
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(service))) {
    if (!METHOD_PATTERN.test(name)
        || RESERVED_METHODS.has(name)
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
        || typeof descriptor.value !== "function") {
      fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
    }
    methods.set(name, descriptor.value);
  }
  if (methods.size < 1 || methods.size > 64) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  return methods;
}

export function createCoreServiceRegistry({ tokenFactory = null } = {}) {
  if (tokenFactory !== null && typeof tokenFactory !== "function") fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  let sequence = 0;
  const registrations = new Map();
  const issuedTokens = new Set();

  function nextToken() {
    const token = tokenFactory ? tokenFactory() : "service-reg-" + (++sequence);
    if (typeof token !== "string" || token.length < 1 || token.length > 128 || issuedTokens.has(token)) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
    issuedTokens.add(token);
    return token;
  }

  function register(name, service, { ownerId = "core", generation = 0 } = {}) {
    const serviceName = assertServiceName(name);
    const owner = assertOwnerId(ownerId);
    const gen = assertGeneration(generation);
    const methods = normalizeMethods(service);
    const current = registrations.get(serviceName);
    if (current) {
      if (current.ownerId !== owner) fail(CORE_SERVICE_ERROR_CODES.SERVICE_CONFLICT);
      if (gen <= current.generation) {
        fail(CORE_SERVICE_ERROR_CODES.STALE_SERVICE, { currentGeneration: current.generation });
      }
    }
    const record = Object.freeze({
      name: serviceName,
      ownerId: owner,
      generation: gen,
      token: nextToken(),
      methods
    });
    registrations.set(serviceName, record);
    return Object.freeze({ name:serviceName, ownerId:owner, generation:gen, token:record.token });
  }

  function unregister(name, { token } = {}) {
    const serviceName = assertServiceName(name);
    const current = registrations.get(serviceName);
    if (!current) return false;
    if (token !== current.token) fail(CORE_SERVICE_ERROR_CODES.STALE_SERVICE, { currentGeneration: current.generation });
    registrations.delete(serviceName);
    return true;
  }

  function describe(name) {
    const serviceName = assertServiceName(name);
    const current = registrations.get(serviceName);
    if (!current) return null;
    return Object.freeze({
      name: current.name,
      ownerId: current.ownerId,
      generation: current.generation,
      methods: Object.freeze([...current.methods.keys()].sort())
    });
  }

  async function call(name, method, args = null, { ownerId = null, generation = null } = {}) {
    const serviceName = assertServiceName(name);
    if (typeof method !== "string" || !METHOD_PATTERN.test(method)) fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
    const current = registrations.get(serviceName);
    if (!current) fail(CORE_SERVICE_ERROR_CODES.SERVICE_UNAVAILABLE);
    if (ownerId !== null && current.ownerId !== assertOwnerId(ownerId)) {
      fail(CORE_SERVICE_ERROR_CODES.STALE_SERVICE, { currentGeneration: current.generation });
    }
    if (generation !== null && current.generation !== assertGeneration(generation)) {
      fail(CORE_SERVICE_ERROR_CODES.STALE_SERVICE, { currentGeneration: current.generation });
    }
    const fn = current.methods.get(method);
    if (!fn) fail(CORE_SERVICE_ERROR_CODES.SERVICE_UNAVAILABLE);
    return fn(args);
  }

  function clear() { registrations.clear(); }

  return Object.freeze({ register, unregister, describe, call, clear });
}
