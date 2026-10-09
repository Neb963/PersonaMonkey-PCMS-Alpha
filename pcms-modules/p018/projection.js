import { STATISTICS_ERROR_CODES, statisticsError } from "./errors.js";
import {
  STATISTICS_AGGREGATIONS,
  STATISTICS_SCHEMA_VERSION,
  isPlainObject,
  normalizeAuditEvent,
  normalizeDay,
  readNumericPath
} from "./schema.js";

function fail(code, message, details = null) {
  throw statisticsError(code, message, details);
}

function finite(value, code = STATISTICS_ERROR_CODES.CORRUPT_STATE) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code, "Statistics numeric state is invalid");
  return value;
}

function nonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics counter state is invalid");
  return value;
}

function definitionKey(definition) {
  return [
    definition.metricId,
    definition.eventType,
    definition.subjectKind ?? "",
    definition.aggregation,
    definition.valuePath ? definition.valuePath.join("/") : ""
  ].join("\u0000");
}

function publicMetric(metric) {
  return Object.freeze({
    metricId: metric.metricId,
    definitionKey: metric.definitionKey,
    value: metric.value,
    matchedEvents: metric.matchedEvents,
    lateMatchedEvents: metric.lateMatchedEvents,
    buckets: Object.freeze(metric.buckets.map((bucket) => Object.freeze({ ...bucket })))
  });
}

export function createEmptyStatisticsState(definitions) {
  return Object.freeze({
    schemaVersion: STATISTICS_SCHEMA_VERSION,
    cursor: 0,
    watermarkTimestamp: null,
    lateEventCount: 0,
    metrics: Object.freeze(definitions.map((definition) => publicMetric({
      metricId: definition.metricId,
      definitionKey: definitionKey(definition),
      value: 0,
      matchedEvents: 0,
      lateMatchedEvents: 0,
      buckets: []
    })))
  });
}

export function normalizeStatisticsState(raw, definitions) {
  if (!isPlainObject(raw) || Object.getOwnPropertySymbols(raw).length) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics state is invalid");
  const d = Object.getOwnPropertyDescriptors(raw);
  const required = ["schemaVersion", "cursor", "watermarkTimestamp", "lateEventCount", "metrics"];
  if (Object.keys(d).length !== required.length || required.some((key) => !Object.hasOwn(d, key))) {
    fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics state shape is invalid");
  }
  for (const descriptor of Object.values(d)) if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics state is unsafe");
  if (d.schemaVersion.value !== STATISTICS_SCHEMA_VERSION) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics state schema is unsupported");
  const cursor = nonNegativeInteger(d.cursor.value);
  const lateEventCount = nonNegativeInteger(d.lateEventCount.value);
  if (lateEventCount > cursor) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics late-event count is invalid");
  const watermarkTimestamp = d.watermarkTimestamp.value;
  if (watermarkTimestamp !== null && (typeof watermarkTimestamp !== "string" || !Number.isFinite(Date.parse(watermarkTimestamp)))) {
    fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics watermark is invalid");
  }
  if ((cursor === 0) !== (watermarkTimestamp === null)) {
    fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics watermark/cursor state is inconsistent");
  }
  if (!Array.isArray(d.metrics.value) || d.metrics.value.length !== definitions.length) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics metric state is invalid");
  const metrics = d.metrics.value.map((rawMetric, index) => {
    if (!isPlainObject(rawMetric) || Object.getOwnPropertySymbols(rawMetric).length) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics metric state is invalid");
    const m = Object.getOwnPropertyDescriptors(rawMetric);
    const keys = ["metricId", "definitionKey", "value", "matchedEvents", "lateMatchedEvents", "buckets"];
    if (Object.keys(m).length !== keys.length || keys.some((key) => !Object.hasOwn(m, key))) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics metric state shape is invalid");
    for (const descriptor of Object.values(m)) if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics metric state is unsafe");
    if (m.metricId.value !== definitions[index].metricId || m.definitionKey.value !== definitionKey(definitions[index])) {
      fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics metric definitions changed");
    }
    const value = finite(m.value.value);
    const matchedEvents = nonNegativeInteger(m.matchedEvents.value);
    const lateMatchedEvents = nonNegativeInteger(m.lateMatchedEvents.value);
    if (lateMatchedEvents > matchedEvents || !Array.isArray(m.buckets.value)) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics metric counters are invalid");
    let previousDay = null;
    const buckets = m.buckets.value.map((rawBucket) => {
      if (!isPlainObject(rawBucket) || Object.getOwnPropertySymbols(rawBucket).length) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics bucket is invalid");
      const b = Object.getOwnPropertyDescriptors(rawBucket);
      const bkeys = ["day", "value", "matchedEvents", "lateMatchedEvents"];
      if (Object.keys(b).length !== bkeys.length || bkeys.some((key) => !Object.hasOwn(b, key))) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics bucket shape is invalid");
      for (const descriptor of Object.values(b)) if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics bucket is unsafe");
      const day = normalizeDay(b.day.value, STATISTICS_ERROR_CODES.CORRUPT_STATE);
      if (previousDay !== null && day <= previousDay) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics buckets are not strictly ordered");
      previousDay = day;
      const bucket = {
        day,
        value: finite(b.value.value),
        matchedEvents: nonNegativeInteger(b.matchedEvents.value),
        lateMatchedEvents: nonNegativeInteger(b.lateMatchedEvents.value)
      };
      if (bucket.lateMatchedEvents > bucket.matchedEvents) fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics bucket counters are invalid");
      return Object.freeze(bucket);
    });
    const bucketValue = buckets.reduce((sum, bucket) => sum + bucket.value, 0);
    const bucketMatches = buckets.reduce((sum, bucket) => sum + bucket.matchedEvents, 0);
    const bucketLateMatches = buckets.reduce((sum, bucket) => sum + bucket.lateMatchedEvents, 0);
    if (bucketValue !== value || bucketMatches !== matchedEvents || bucketLateMatches !== lateMatchedEvents) {
      fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics metric totals do not match buckets");
    }
    if (definitions[index].aggregation === STATISTICS_AGGREGATIONS.COUNT && value !== matchedEvents) {
      fail(STATISTICS_ERROR_CODES.CORRUPT_STATE, "Statistics COUNT metric total is invalid");
    }
    return publicMetric({ metricId: m.metricId.value, definitionKey: m.definitionKey.value, value, matchedEvents, lateMatchedEvents, buckets });
  });
  return Object.freeze({
    schemaVersion: STATISTICS_SCHEMA_VERSION,
    cursor,
    watermarkTimestamp: watermarkTimestamp === null ? null : new Date(Date.parse(watermarkTimestamp)).toISOString(),
    lateEventCount,
    metrics: Object.freeze(metrics)
  });
}

function contribution(definition, event) {
  if (event.type !== definition.eventType) return null;
  if (definition.subjectKind !== null && event.subject?.kind !== definition.subjectKind) return null;
  return definition.aggregation === STATISTICS_AGGREGATIONS.COUNT ? 1 : readNumericPath(event.data, definition.valuePath);
}

function updateMetric(metric, day, amount, late) {
  const buckets = metric.buckets.map((bucket) => ({ ...bucket }));
  let index = buckets.findIndex((bucket) => bucket.day >= day);
  if (index < 0) index = buckets.length;
  if (buckets[index]?.day === day) {
    const current = buckets[index];
    buckets[index] = {
      day,
      value: current.value + amount,
      matchedEvents: current.matchedEvents + 1,
      lateMatchedEvents: current.lateMatchedEvents + (late ? 1 : 0)
    };
  } else {
    buckets.splice(index, 0, { day, value: amount, matchedEvents: 1, lateMatchedEvents: late ? 1 : 0 });
  }
  return publicMetric({
    metricId: metric.metricId,
    definitionKey: metric.definitionKey,
    value: metric.value + amount,
    matchedEvents: metric.matchedEvents + 1,
    lateMatchedEvents: metric.lateMatchedEvents + (late ? 1 : 0),
    buckets
  });
}

export function applyStatisticsEvents(rawState, rawEvents, definitions) {
  let state = normalizeStatisticsState(rawState, definitions);
  if (!Array.isArray(rawEvents)) fail(STATISTICS_ERROR_CODES.INVALID_ARGUMENT, "Statistics event page must be an array");
  for (const rawEvent of rawEvents) {
    const event = normalizeAuditEvent(rawEvent);
    if (event.sequence !== state.cursor + 1) {
      fail(STATISTICS_ERROR_CODES.CURSOR_GAP, "Statistics audit cursor is not contiguous", { expected: state.cursor + 1, actual: event.sequence });
    }
    const late = state.watermarkTimestamp !== null && event.timestamp < state.watermarkTimestamp;
    const watermarkTimestamp = state.watermarkTimestamp === null || event.timestamp > state.watermarkTimestamp
      ? event.timestamp
      : state.watermarkTimestamp;
    const day = event.timestamp.slice(0, 10);
    const metrics = state.metrics.map((metric, index) => {
      const amount = contribution(definitions[index], event);
      return amount === null ? metric : updateMetric(metric, day, amount, late);
    });
    state = Object.freeze({
      schemaVersion: STATISTICS_SCHEMA_VERSION,
      cursor: event.sequence,
      watermarkTimestamp,
      lateEventCount: state.lateEventCount + (late ? 1 : 0),
      metrics: Object.freeze(metrics)
    });
  }
  return state;
}

export function rebuildStatistics(rawEvents, definitions) {
  return applyStatisticsEvents(createEmptyStatisticsState(definitions), rawEvents, definitions);
}
