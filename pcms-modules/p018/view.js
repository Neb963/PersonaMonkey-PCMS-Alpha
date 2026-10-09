import { STATISTICS_ERROR_CODES, statisticsError } from "./errors.js";
import { normalizeDay } from "./schema.js";
import { normalizeStatisticsState } from "./projection.js";

function fail(message) {
  throw statisticsError(STATISTICS_ERROR_CODES.INVALID_ARGUMENT, message);
}

function csv(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function buildStatisticsView(rawState, definitions, { metricIds = null, fromDay = null, toDay = null } = {}) {
  const state = normalizeStatisticsState(rawState, definitions);
  if (fromDay !== null) fromDay = normalizeDay(fromDay);
  if (toDay !== null) toDay = normalizeDay(toDay);
  if (fromDay !== null && toDay !== null && fromDay > toDay) fail("Statistics day range is invalid");
  let selected = null;
  if (metricIds !== null) {
    if (!Array.isArray(metricIds) || metricIds.some((id) => typeof id !== "string") || new Set(metricIds).size !== metricIds.length) {
      fail("Statistics metric filter is invalid");
    }
    selected = new Set(metricIds);
    for (const id of selected) if (!definitions.some((definition) => definition.metricId === id)) fail("Statistics metric filter is unknown");
  }
  const metrics = definitions.flatMap((definition, index) => {
    if (selected && !selected.has(definition.metricId)) return [];
    const metric = state.metrics[index];
    const series = metric.buckets
      .filter((bucket) => (fromDay === null || bucket.day >= fromDay) && (toDay === null || bucket.day <= toDay))
      .map((bucket) => Object.freeze({ ...bucket }));
    const ranged = fromDay !== null || toDay !== null;
    return [Object.freeze({
      metricId: definition.metricId,
      label: definition.label,
      aggregation: definition.aggregation,
      value: ranged ? series.reduce((sum, bucket) => sum + bucket.value, 0) : metric.value,
      matchedEvents: ranged ? series.reduce((sum, bucket) => sum + bucket.matchedEvents, 0) : metric.matchedEvents,
      lateMatchedEvents: ranged ? series.reduce((sum, bucket) => sum + bucket.lateMatchedEvents, 0) : metric.lateMatchedEvents,
      series: Object.freeze(series)
    })];
  });
  return Object.freeze({
    schemaVersion: state.schemaVersion,
    cursor: state.cursor,
    watermarkTimestamp: state.watermarkTimestamp,
    lateEventCount: state.lateEventCount,
    metrics: Object.freeze(metrics)
  });
}

export function exportStatisticsCsv(view) {
  if (!view || !Array.isArray(view.metrics)) fail("Statistics view is invalid");
  const lines = ["metric_id,label,aggregation,day,value,matched_events,late_matched_events"];
  for (const metric of view.metrics) {
    lines.push([
      metric.metricId,
      metric.label,
      metric.aggregation,
      "TOTAL",
      metric.value,
      metric.matchedEvents,
      metric.lateMatchedEvents
    ].map(csv).join(","));
    for (const bucket of metric.series) {
      lines.push([
        metric.metricId,
        metric.label,
        metric.aggregation,
        bucket.day,
        bucket.value,
        bucket.matchedEvents,
        bucket.lateMatchedEvents
      ].map(csv).join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}
