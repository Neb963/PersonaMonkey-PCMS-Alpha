import { STATISTICS_ERROR_CODES, statisticsError } from "./errors.js";
import { normalizeMetricDefinitions } from "./schema.js";
import {
  applyStatisticsEvents,
  createEmptyStatisticsState,
  normalizeStatisticsState
} from "./projection.js";
import { buildStatisticsView, exportStatisticsCsv } from "./view.js";

function fail(code, message, details = null) {
  throw statisticsError(code, message, details);
}

function snapshotJournal(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.read !== "function") {
    throw new TypeError("Statistics Audit Journal capability must expose read()");
  }
  return Object.freeze({ read: raw.read.bind(raw) });
}

function pageSize(raw) {
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 500) throw new TypeError("Statistics pageSize must be between 1 and 500");
  return raw;
}

export function createStatisticsService({ journal, definitions, pageSize: rawPageSize = 100 } = {}) {
  const audit = snapshotJournal(journal);
  const metrics = normalizeMetricDefinitions(definitions);
  const limit = pageSize(rawPageSize);

  async function refresh(rawState = createEmptyStatisticsState(metrics)) {
    let state = normalizeStatisticsState(rawState, metrics);
    while (true) {
      let page;
      try {
        page = await audit.read(Object.freeze({ afterSequence: state.cursor, limit }));
      } catch (cause) {
        fail(STATISTICS_ERROR_CODES.JOURNAL_UNAVAILABLE, "Statistics Audit Journal read failed", { cause });
      }
      if (!page || typeof page !== "object" || !Array.isArray(page.events) || typeof page.hasMore !== "boolean" || !Number.isSafeInteger(page.lastSequence) || page.lastSequence < state.cursor) {
        fail(STATISTICS_ERROR_CODES.JOURNAL_UNAVAILABLE, "Statistics Audit Journal response is invalid");
      }
      const before = state.cursor;
      state = applyStatisticsEvents(state, page.events, metrics);
      if (page.lastSequence < state.cursor) {
        fail(STATISTICS_ERROR_CODES.JOURNAL_UNAVAILABLE, "Statistics Audit Journal tail is behind the projection");
      }
      if (page.hasMore && state.cursor >= page.lastSequence) {
        fail(STATISTICS_ERROR_CODES.JOURNAL_UNAVAILABLE, "Statistics Audit Journal pagination metadata is inconsistent");
      }
      if (!page.hasMore && state.cursor !== page.lastSequence) {
        fail(STATISTICS_ERROR_CODES.JOURNAL_UNAVAILABLE, "Statistics Audit Journal terminal cursor is inconsistent");
      }
      if (page.hasMore && state.cursor === before) {
        fail(STATISTICS_ERROR_CODES.JOURNAL_UNAVAILABLE, "Statistics Audit Journal cannot advance");
      }
      if (!page.hasMore) return state;
    }
  }

  async function rebuild() {
    return refresh(createEmptyStatisticsState(metrics));
  }

  function view(state, options = {}) {
    return buildStatisticsView(state, metrics, options);
  }

  function exportCsv(state, options = {}) {
    return exportStatisticsCsv(view(state, options));
  }

  return Object.freeze({
    definitions: metrics,
    createEmptyState: () => createEmptyStatisticsState(metrics),
    refresh,
    rebuild,
    view,
    exportCsv
  });
}
