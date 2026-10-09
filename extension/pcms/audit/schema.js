import { AUDIT_ERROR_CODES, auditError } from "./errors.js";

export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_NAMESPACE = "core.audit";
export const AUDIT_META_KEY = "$meta";
export const AUDIT_EVENT_PREFIX = "event:";
export const AUDIT_DEFAULT_READ_LIMIT = 100;
export const AUDIT_MAX_READ_LIMIT = 500;

const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_SUBJECT_PART_LENGTH = 256;
const MAX_KEY_LENGTH = 512;
const MAX_DEPTH = 32;
const MAX_NODES = 100000;
const TYPE_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,127})$/;
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,255})$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownDataEntries(value, code, message) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key) || !("value" in descriptor)) {
      throw auditError(code, message);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

export function cloneAuditValue(input) {
  let nodes = 0;
  const seen = new WeakSet();

  function clone(value, depth) {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit value exceeds structural limits");
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") {
      throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit value must contain data only");
    }
    if (seen.has(value)) {
      throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit value must not contain cycles");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > MAX_NODES) {
          throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit array exceeds structural limits");
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const output = new Array(value.length);
        for (const key of Reflect.ownKeys(descriptors)) {
          if (key === "length") continue;
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
            throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit array contains an unsafe property");
          }
          const descriptor = descriptors[key];
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || !("value" in descriptor)) {
            throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit array contains an unsafe property");
          }
          output[index] = clone(descriptor.value, depth + 1);
        }
        return output;
      }
      if (!plainObject(value)) {
        throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit value must use plain objects");
      }
      const output = Object.create(null);
      for (const [key, nested] of ownDataEntries(
        value,
        AUDIT_ERROR_CODES.INVALID_EVENT,
        "Audit value contains an unsafe property"
      )) {
        output[key] = clone(nested, depth + 1);
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }

  return clone(input, 0);
}

function exactKeys(value, allowed, code, message) {
  for (const [key] of ownDataEntries(value, code, message)) {
    if (!allowed.has(key)) throw auditError(code, message);
  }
}

export function normalizeAuditDraft(raw) {
  if (!plainObject(raw)) {
    throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit event must be a plain object");
  }
  exactKeys(raw, new Set(["type", "subject", "data"]), AUDIT_ERROR_CODES.INVALID_EVENT, "Audit event has an unsupported field");

  const type = raw.type;
  if (typeof type !== "string" || type.length > MAX_EVENT_TYPE_LENGTH || !TYPE_PATTERN.test(type)) {
    throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit event type is invalid");
  }

  let subject = null;
  if (raw.subject !== undefined && raw.subject !== null) {
    if (!plainObject(raw.subject)) {
      throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit subject must be a plain object");
    }
    exactKeys(raw.subject, new Set(["kind", "id"]), AUDIT_ERROR_CODES.INVALID_EVENT, "Audit subject has an unsupported field");
    const { kind, id } = raw.subject;
    if (
      typeof kind !== "string" || kind.length > MAX_SUBJECT_PART_LENGTH || !SUBJECT_PATTERN.test(kind) ||
      typeof id !== "string" || id.length > MAX_SUBJECT_PART_LENGTH || !SUBJECT_PATTERN.test(id)
    ) {
      throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit subject is invalid");
    }
    subject = Object.freeze({ kind, id });
  }

  const data = raw.data === undefined ? null : cloneAuditValue(raw.data);
  return Object.freeze({ type, subject, data });
}

export function normalizeAuditTimestamp(raw) {
  const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(parsed)) {
    throw auditError(AUDIT_ERROR_CODES.INVALID_EVENT, "Audit timestamp is invalid");
  }
  return new Date(parsed).toISOString();
}

export function validateAuditSequence(sequence, code = AUDIT_ERROR_CODES.INVALID_CURSOR) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw auditError(code, "Audit sequence is invalid");
  }
  return sequence;
}

export function auditEventKey(sequence) {
  validateAuditSequence(sequence, AUDIT_ERROR_CODES.CORRUPT);
  if (sequence < 1) throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Audit event sequence must be positive");
  return AUDIT_EVENT_PREFIX + String(sequence).padStart(16, "0");
}

export function parseAuditEventKey(key) {
  if (typeof key !== "string" || !key.startsWith(AUDIT_EVENT_PREFIX)) return null;
  const suffix = key.slice(AUDIT_EVENT_PREFIX.length);
  if (!/^[0-9]{16}$/.test(suffix)) return null;
  const sequence = Number(suffix);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

export function createAuditEvent({ sequence, timestamp, draft }) {
  validateAuditSequence(sequence, AUDIT_ERROR_CODES.CORRUPT);
  if (sequence < 1) throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Audit event sequence must be positive");
  const normalizedDraft = normalizeAuditDraft(draft);
  const normalizedTimestamp = normalizeAuditTimestamp(timestamp);
  return Object.freeze({
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventId: "audit-" + String(sequence).padStart(16, "0"),
    sequence,
    timestamp: normalizedTimestamp,
    type: normalizedDraft.type,
    subject: normalizedDraft.subject,
    data: cloneAuditValue(normalizedDraft.data)
  });
}

export function validatePersistedAuditEvent(raw) {
  if (!plainObject(raw)) throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Persisted audit event is invalid");
  exactKeys(
    raw,
    new Set(["schemaVersion", "eventId", "sequence", "timestamp", "type", "subject", "data"]),
    AUDIT_ERROR_CODES.CORRUPT,
    "Persisted audit event has an unsupported field"
  );
  if (raw.schemaVersion !== AUDIT_SCHEMA_VERSION) {
    throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Persisted audit event schema is unsupported");
  }
  validateAuditSequence(raw.sequence, AUDIT_ERROR_CODES.CORRUPT);
  if (raw.sequence < 1 || raw.eventId !== "audit-" + String(raw.sequence).padStart(16, "0")) {
    throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Persisted audit event identity is invalid");
  }
  try {
    return createAuditEvent({
      sequence: raw.sequence,
      timestamp: raw.timestamp,
      draft: { type: raw.type, subject: raw.subject, data: raw.data }
    });
  } catch (error) {
    if (error?.code === AUDIT_ERROR_CODES.CORRUPT) throw error;
    throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Persisted audit event payload is invalid", { cause: error });
  }
}

export function normalizeReadRequest({ afterSequence = 0, limit = AUDIT_DEFAULT_READ_LIMIT } = {}) {
  validateAuditSequence(afterSequence);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUDIT_MAX_READ_LIMIT) {
    throw auditError(AUDIT_ERROR_CODES.INVALID_CURSOR, "Audit read limit is invalid");
  }
  return Object.freeze({ afterSequence, limit });
}

export function normalizeTransition(raw) {
  if (!plainObject(raw)) {
    throw auditError(AUDIT_ERROR_CODES.INVALID_TRANSITION, "Audit state transition must be a plain object");
  }
  exactKeys(
    raw,
    new Set(["namespace", "key", "expectedRevision", "value"]),
    AUDIT_ERROR_CODES.INVALID_TRANSITION,
    "Audit state transition has an unsupported field"
  );
  if (typeof raw.namespace !== "string" || !NAMESPACE_PATTERN.test(raw.namespace) || raw.namespace === AUDIT_NAMESPACE) {
    throw auditError(AUDIT_ERROR_CODES.INVALID_TRANSITION, "Audit state transition namespace is invalid");
  }
  if (typeof raw.key !== "string" || raw.key.length < 1 || raw.key.length > MAX_KEY_LENGTH || raw.key.includes("\u0000")) {
    throw auditError(AUDIT_ERROR_CODES.INVALID_TRANSITION, "Audit state transition key is invalid");
  }
  if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) {
    throw auditError(AUDIT_ERROR_CODES.INVALID_TRANSITION, "Audit state transition revision is invalid");
  }
  return Object.freeze({
    namespace: raw.namespace,
    key: raw.key,
    expectedRevision: raw.expectedRevision,
    value: cloneAuditValue(raw.value)
  });
}
