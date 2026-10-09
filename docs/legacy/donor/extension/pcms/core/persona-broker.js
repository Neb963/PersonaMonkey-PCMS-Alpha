import {
  PERSONA_BROKER_COMMAND_NAMES,
  PERSONA_BROKER_COMMANDS,
  PERSONA_BROKER_CONTRACT_VERSION,
  createPersonaBrokerRequest,
  getPersonaBrokerCommand,
  validatePersonaBrokerEvent,
  validatePersonaBrokerResponse
} from "./persona-broker-contract.js";

export const PERSONA_BROKER_INTEGRATION_REQUEST_TYPE = "PERSONAMONKEY_INTEGRATION_REQUEST";
export const PERSONA_BROKER_INTEGRATION_EVENTS_PORT = "PERSONAMONKEY_INTEGRATION_EVENTS";
export const PERSONA_BROKER_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const PERSONA_BROKER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const PERSONA_BROKER_MAX_EVENT_BYTES = 32 * 1024;

export const PERSONA_BROKER_ADAPTER_ERROR_CODES = Object.freeze({
  CLOSED: "PCMS_PERSONA_BROKER_CLOSED",
  TRANSPORT_UNAVAILABLE: "PCMS_PERSONA_BROKER_TRANSPORT_UNAVAILABLE",
  PROTOCOL: "PCMS_PERSONA_BROKER_PROTOCOL"
});

const SAFE_ERROR_MESSAGES = Object.freeze({
  [PERSONA_BROKER_ADAPTER_ERROR_CODES.CLOSED]: "Persona Broker is closed",
  [PERSONA_BROKER_ADAPTER_ERROR_CODES.TRANSPORT_UNAVAILABLE]: "Persona Broker transport is unavailable",
  [PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL]: "Persona Broker transport protocol failed"
});

const MAX_DATA_DEPTH = 20;
const MAX_DATA_NODES = 100_000;
const MAX_KEY_LENGTH = 512;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TEXT_ENCODER = new TextEncoder();
const EMPTY_COMMANDS = Object.freeze([]);

export class PersonaBrokerAdapterError extends Error {
  constructor(code, options = {}) {
    super(SAFE_ERROR_MESSAGES[code] || SAFE_ERROR_MESSAGES[PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL], options);
    this.name = "PersonaBrokerAdapterError";
    this.code = code;
  }
}

function fail(code) {
  throw new PersonaBrokerAdapterError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneBrokerData(input, maxBytes) {
  const ancestors = new WeakSet();
  let nodes = 0;

  function visit(value, depth) {
    nodes += 1;
    if (nodes > MAX_DATA_NODES || depth > MAX_DATA_DEPTH) fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
    if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);

    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
        const output = new Array(value.length);
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (key === "length") continue;
          if (!/^(0|[1-9][0-9]*)$/.test(key)
              || Number(key) >= value.length
              || !descriptor.enumerable
              || !Object.hasOwn(descriptor, "value")) fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
        }
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
          output[index] = visit(descriptor.value, depth + 1);
        }
        return output;
      }

      if (!isPlainObject(value)) fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
      const output = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key.length < 1 || key.length > MAX_KEY_LENGTH || FORBIDDEN_KEYS.has(key)
            || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
        }
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(value);
    }
  }

  const cloned = visit(input, 0);
  let bytes;
  try { bytes = TEXT_ENCODER.encode(JSON.stringify(cloned)).byteLength; }
  catch { fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL); }
  if (bytes > maxBytes) fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
  return cloned;
}

function freezeBrokerData(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeBrokerData(item);
    Object.freeze(value);
  }
  return value;
}

function assertTransport(transport) {
  if (!isPlainObject(transport)
      || typeof transport.send !== "function"
      || typeof transport.openEvents !== "function") {
    throw new TypeError("Persona Broker transport must expose send() and openEvents()");
  }
  return transport;
}

function normalizeRequest(rawRequest) {
  const cloned = cloneBrokerData(rawRequest, PERSONA_BROKER_MAX_REQUEST_BYTES);
  try {
    return createPersonaBrokerRequest(cloned);
  } catch (error) {
    if (error instanceof PersonaBrokerAdapterError) throw error;
    fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
  }
}

function wireEnvelope(request) {
  const envelope = {
    type: PERSONA_BROKER_INTEGRATION_REQUEST_TYPE,
    version: PERSONA_BROKER_CONTRACT_VERSION,
    requestId: request.requestId,
    command: request.command,
    params: request.params
  };
  if (request.operationId !== undefined) envelope.operationId = request.operationId;
  if (request.precondition !== undefined) envelope.precondition = request.precondition;
  return freezeBrokerData(envelope);
}

function buildCapabilityMap() {
  const byCapability = new Map();
  for (const command of PERSONA_BROKER_COMMAND_NAMES) {
    const descriptor = PERSONA_BROKER_COMMANDS[command];
    const commands = byCapability.get(descriptor.capability) || [];
    commands.push(command);
    byCapability.set(descriptor.capability, commands);
  }
  const output = Object.create(null);
  for (const [capability, commands] of [...byCapability.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    output[capability] = Object.freeze(commands.sort());
  }
  return Object.freeze(output);
}

export const PERSONA_BROKER_CAPABILITY_COMMANDS = buildCapabilityMap();
export const PERSONA_BROKER_CONTROL_COMMANDS = Object.freeze(
  PERSONA_BROKER_COMMAND_NAMES.filter((command) => command.startsWith("persona.control.")).sort()
);
export const PERSONA_BROKER_EXECUTION_COMMANDS = Object.freeze(
  PERSONA_BROKER_COMMAND_NAMES.filter((command) => command.startsWith("execution.")).sort()
);

export function getPersonaBrokerCapabilityCommands(capability) {
  if (typeof capability !== "string" || !Object.hasOwn(PERSONA_BROKER_CAPABILITY_COMMANDS, capability)) return EMPTY_COMMANDS;
  return PERSONA_BROKER_CAPABILITY_COMMANDS[capability];
}

export function createPersonaBroker({ transport } = {}) {
  const wire = assertTransport(transport);
  const subscriptions = new Set();
  let closed = false;

  async function request(rawRequest) {
    if (closed) fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.CLOSED);
    const normalized = normalizeRequest(rawRequest);
    let rawResponse;
    try {
      rawResponse = await wire.send(wireEnvelope(normalized));
    } catch {
      fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.TRANSPORT_UNAVAILABLE);
    }

    let response;
    try {
      response = cloneBrokerData(rawResponse, PERSONA_BROKER_MAX_RESPONSE_BYTES);
      validatePersonaBrokerResponse(response, normalized);
    } catch (error) {
      if (error instanceof PersonaBrokerAdapterError) throw error;
      fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
    }
    return freezeBrokerData(response);
  }

  function subscribe(listener) {
    if (closed) fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.CLOSED);
    if (typeof listener !== "function") throw new TypeError("Persona Broker listener must be a function");

    let disconnected = false;
    let connection = null;
    let lastBootId = null;
    let lastSequence = 0;

    const subscription = {
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        subscriptions.delete(subscription);
        try { connection?.disconnect?.(); } catch {}
      }
    };

    function onEvent(rawEvent) {
      if (disconnected || closed) return;
      let event;
      try {
        event = cloneBrokerData(rawEvent, PERSONA_BROKER_MAX_EVENT_BYTES);
        validatePersonaBrokerEvent(event);
        if (lastBootId === null) lastBootId = event.bootId;
        else if (event.bootId !== lastBootId) throw new TypeError("Persona Broker event boot changed on an active stream");
        if (event.sequence <= lastSequence) throw new TypeError("Persona Broker event sequence regressed");
        lastSequence = event.sequence;
        event = freezeBrokerData(event);
      } catch {
        subscription.disconnect();
        return;
      }
      try { listener(event); } catch {}
    }

    try {
      connection = wire.openEvents(PERSONA_BROKER_INTEGRATION_EVENTS_PORT, onEvent);
    } catch {
      fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.TRANSPORT_UNAVAILABLE);
    }
    if (!connection || typeof connection.disconnect !== "function") {
      try { connection?.disconnect?.(); } catch {}
      fail(PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL);
    }
    if (disconnected) {
      try { connection.disconnect(); } catch {}
      return Object.freeze(subscription);
    }
    subscriptions.add(subscription);
    return Object.freeze(subscription);
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const subscription of [...subscriptions]) subscription.disconnect();
  }

  return Object.freeze({ request, subscribe, close });
}

export function getPersonaBrokerCommandCapability(command) {
  return getPersonaBrokerCommand(command)?.capability || null;
}
