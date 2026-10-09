export const STATISTICS_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "STATS_INVALID_ARGUMENT",
  INVALID_DEFINITION: "STATS_INVALID_DEFINITION",
  INVALID_EVENT: "STATS_INVALID_EVENT",
  CORRUPT_STATE: "STATS_CORRUPT_STATE",
  CURSOR_GAP: "STATS_CURSOR_GAP",
  JOURNAL_UNAVAILABLE: "STATS_JOURNAL_UNAVAILABLE"
});

export class StatisticsError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "StatisticsError";
    this.code = code;
    this.details = details;
  }
}

export function statisticsError(code, message, details = null) {
  return new StatisticsError(code, message, details);
}
