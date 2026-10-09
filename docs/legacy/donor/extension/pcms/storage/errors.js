export const STORAGE_ERROR_CODES = Object.freeze({
  UNAVAILABLE: "PCMS_STORAGE_UNAVAILABLE",
  BLOCKED: "PCMS_STORAGE_BLOCKED",
  MIGRATION_FAILED: "PCMS_STORAGE_MIGRATION_FAILED",
  STALE_CONNECTION: "PCMS_STORAGE_STALE_CONNECTION",
  INVALID_NAMESPACE: "PCMS_STORAGE_INVALID_NAMESPACE",
  INVALID_KEY: "PCMS_STORAGE_INVALID_KEY",
  INVALID_VALUE: "PCMS_STORAGE_INVALID_VALUE",
  CAS_MISMATCH: "PCMS_STORAGE_CAS_MISMATCH",
  CLOSED: "PCMS_STORAGE_CLOSED"
});

export class PcmsStorageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PcmsStorageError";
    this.code = code;
    if (Number.isInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
  }
}

export function storageError(code, message, options = {}) {
  return new PcmsStorageError(code, message, options);
}
