import { STATISTICS_ERROR_CODES, statisticsError } from "./errors.js";

export const STATISTICS_SCHEMA_VERSION = 1;
export const STATISTICS_MAX_METRICS = 256;
export const STATISTICS_AGGREGATIONS = Object.freeze({
  COUNT: "COUNT",
  SUM: "SUM"
});

const METRIC_ID = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const EVENT_TYPE = /^[a-z0-9](?:[a-z0-9._:-]{0,127})$/;
const SUBJECT_KIND = /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,255})$/;
const PATH_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,127})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function fail(code, message, details = null) {
  throw statisticsError(code, message, details);
}

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function descriptors(value, code, message) {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length) fail(code, message);
  const result = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(result)) {
    if (FORBIDDEN.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code, message);
  }
  return result;
}

function exactKeys(value, allowed, code, message) {
  const result = descriptors(value, code, message);
  for (const key of Object.keys(result)) if (!allowed.has(key)) fail(code, message);
  return result;
}

export function normalizeMetricDefinitions(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > STATISTICS_MAX_METRICS) {
    fail(STATISTICS_ERROR_CODES.INVALID_DEFINITION, "Statistics metric definitions are invalid");
  }
  const seen = new Set();
  const output = raw.map((entry) => {
    const d = exactKeys(
      entry,
      new Set(["metricId", "label", "eventType", "aggregation", "valuePath", "subjectKind"]),
      STATISTICS_ERROR_CODES.INVALID_DEFINITION,
      "Statistics metric definition is invalid"
    );
    const metricId = d.metricId?.value;
    const label = d.label?.value;
    const eventType = d.eventType?.value;
    const aggregation = d.aggregation?.value;
    const subjectKind = d.subjectKind?.value ?? null;
    const valuePath = d.valuePath?.value ?? null;
    if (typeof metricId !== "string" || !METRIC_ID.test(metricId) || seen.has(metricId)) {
      fail(STATISTICS_ERROR_CODES.INVALID_DEFINITION, "Statistics metric id is invalid");
    }
    seen.add(metricId);
    if (typeof label !== "string" || label.length < 1 || label.length > 128) {
      fail(STATISTICS_ERROR_CODES.INVALID_DEFINITION, "Statistics metric label is invalid");
    }
    if (typeof eventType !== "string" || !EVENT_TYPE.test(eventType)) {
      fail(STATISTICS_ERROR_CODES.INVALID_DEFINITION, "Statistics event type is invalid");
    }
    if (!Object.values(STATISTICS_AGGREGATIONS).includes(aggregation)) {
      fail(STATISTICS_ERROR_CODES.INVALID_DEFINITION, "Statistics aggregation is invalid");
    }
    if (subjectKind !== null && (typeof subjectKind !== "string" || !SUBJECT_KIND.test(subjectKind))) {
      fail(STATISTICS_ERROR_CODES.INVALID_DEFINITION, "Statistics subject selector is invalid");
    }
    let normalizedPath = null;
    if (aggregation === STATISTICS_AGGREGATIONS.SUM) {
      if (!Array.isArray(valuePath) || valuePath.length < 1 || valuePath.length > 16) {
        fail(STATISTICS_ERROR_CODES.INVALID_DEFINITION, "SUM metrics require a bounded valuePath");
      }
      normalizedPath = Object.freeze(valuePath.map((part) => {
        if (typeof part !== "string" || !PATH_SEGMENT.test(part) || FORBIDDEN.has(part)) {
          fail(STATISTICS_ERROR_CODES.INVALID_DEFINITION, "Statistics valuePath is invalid");
        }
        return part;
      }));
    } else if (valuePath !== null) {
      fail(STATISTICS_ERROR_CODES.INVALID_DEFINITION, "COUNT metrics must not define valuePath");
    }
    return Object.freeze({ metricId, label, eventType, aggregation, valuePath: normalizedPath, subjectKind });
  });
  return Object.freeze(output);
}

export function normalizeAuditEvent(raw) {
  const d = descriptors(raw, STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics received an invalid audit event");
  const sequence = d.sequence?.value;
  const eventId = d.eventId?.value;
  const schemaVersion = d.schemaVersion?.value;
  const timestamp = d.timestamp?.value;
  const type = d.type?.value;
  const subject = d.subject?.value ?? null;
  const data = d.data?.value ?? null;
  if (schemaVersion !== 1 || !Number.isSafeInteger(sequence) || sequence < 1) {
    fail(STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics audit identity is invalid");
  }
  const expectedEventId = "audit-" + String(sequence).padStart(16, "0");
  if (eventId !== expectedEventId) fail(STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics audit event id is invalid");
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    fail(STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics audit timestamp is invalid");
  }
  const normalizedTimestamp = new Date(Date.parse(timestamp)).toISOString();
  if (typeof type !== "string" || !EVENT_TYPE.test(type)) {
    fail(STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics audit type is invalid");
  }
  let normalizedSubject = null;
  if (subject !== null) {
    const s = exactKeys(subject, new Set(["kind", "id"]), STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics audit subject is invalid");
    if (typeof s.kind?.value !== "string" || !SUBJECT_KIND.test(s.kind.value) || typeof s.id?.value !== "string" || !SUBJECT_KIND.test(s.id.value)) {
      fail(STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics audit subject is invalid");
    }
    normalizedSubject = Object.freeze({ kind: s.kind.value, id: s.id.value });
  }
  return Object.freeze({ schemaVersion, sequence, eventId, timestamp: normalizedTimestamp, type, subject: normalizedSubject, data });
}

export function readNumericPath(root, path) {
  let value = root;
  for (const part of path) {
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length) {
      fail(STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics SUM source is not an object");
    }
    const d = Object.getOwnPropertyDescriptor(value, part);
    if (!d) fail(STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics SUM source value is missing");
    if (!d.enumerable || !Object.hasOwn(d, "value")) {
      fail(STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics SUM source value is unsafe");
    }
    value = d.value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(STATISTICS_ERROR_CODES.INVALID_EVENT, "Statistics SUM source value is not finite");
  }
  return value;
}

export function normalizeDay(raw, code = STATISTICS_ERROR_CODES.INVALID_ARGUMENT) {
  const parsed = typeof raw === "string" && DAY.test(raw) ? Date.parse(raw + "T00:00:00.000Z") : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== raw) {
    fail(code, "Statistics day is invalid");
  }
  return raw;
}
