export const AUDIT_ERROR_CODES = Object.freeze({
  UNAVAILABLE: "PCMS_AUDIT_UNAVAILABLE",
  INVALID_EVENT: "PCMS_AUDIT_INVALID_EVENT",
  INVALID_CURSOR: "PCMS_AUDIT_INVALID_CURSOR",
  INVALID_TRANSITION: "PCMS_AUDIT_INVALID_TRANSITION",
  CONFLICT: "PCMS_AUDIT_CONFLICT",
  CORRUPT: "PCMS_AUDIT_CORRUPT",
  STALE_CONNECTION: "PCMS_AUDIT_STALE_CONNECTION",
  CLOSED: "PCMS_AUDIT_CLOSED",
  PROJECTION_FAILED: "PCMS_AUDIT_PROJECTION_FAILED"
});

export class PcmsAuditError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PcmsAuditError";
    this.code = code;
    if (Number.isSafeInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
    if (Number.isSafeInteger(options.lastSequence)) this.lastSequence = options.lastSequence;
  }
}

export function auditError(code, message, options = {}) {
  return new PcmsAuditError(code, message, options);
}
