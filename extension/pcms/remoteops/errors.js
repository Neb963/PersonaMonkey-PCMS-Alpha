export const REMOTE_OP_ERROR_CODES = Object.freeze({
  INVALID_OPERATION: "PCMS_REMOTE_OP_INVALID_OPERATION",
  OPERATION_CONFLICT: "PCMS_REMOTE_OP_OPERATION_CONFLICT",
  REVISION_CONFLICT: "PCMS_REMOTE_OP_REVISION_CONFLICT",
  NOT_FOUND: "PCMS_REMOTE_OP_NOT_FOUND",
  INVALID_TRANSITION: "PCMS_REMOTE_OP_INVALID_TRANSITION",
  RECONCILE_REQUIRED: "PCMS_REMOTE_OP_RECONCILE_REQUIRED",
  CORRUPT_STATE: "PCMS_REMOTE_OP_CORRUPT_STATE",
  RECOVERY_HOLD: "PCMS_RECOVERY_HOLD",
  RECOVERY_INCOMPLETE: "PCMS_RECOVERY_INCOMPLETE",
  PROVIDER_UNKNOWN: "PCMS_PROVIDER_UNKNOWN",
  ACTION_UNKNOWN: "PCMS_PROVIDER_ACTION_UNKNOWN",
  PROVIDER_PROTOCOL: "PCMS_PROVIDER_PROTOCOL"
});

const MESSAGES = Object.freeze({
  [REMOTE_OP_ERROR_CODES.INVALID_OPERATION]: "Remote operation is invalid",
  [REMOTE_OP_ERROR_CODES.OPERATION_CONFLICT]: "Remote operation identity conflicts with durable state",
  [REMOTE_OP_ERROR_CODES.REVISION_CONFLICT]: "Remote operation revision changed",
  [REMOTE_OP_ERROR_CODES.NOT_FOUND]: "Remote operation was not found",
  [REMOTE_OP_ERROR_CODES.INVALID_TRANSITION]: "Remote operation transition is invalid",
  [REMOTE_OP_ERROR_CODES.RECONCILE_REQUIRED]: "Remote operation requires reconciliation before retry",
  [REMOTE_OP_ERROR_CODES.CORRUPT_STATE]: "Remote operation state is corrupt",
  [REMOTE_OP_ERROR_CODES.RECOVERY_HOLD]: "External mutation is blocked by recovery hold",
  [REMOTE_OP_ERROR_CODES.RECOVERY_INCOMPLETE]: "Recovery reconciliation is incomplete",
  [REMOTE_OP_ERROR_CODES.PROVIDER_UNKNOWN]: "Provider behavior is not registered",
  [REMOTE_OP_ERROR_CODES.ACTION_UNKNOWN]: "Provider mutation behavior is not registered",
  [REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL]: "Provider mutation outcome is ambiguous"
});

export class PcmsRemoteOpError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] || MESSAGES[REMOTE_OP_ERROR_CODES.CORRUPT_STATE], options);
    this.name = "PcmsRemoteOpError";
    this.code = code;
    if (Number.isInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
  }
}

export function remoteOpError(code, options = {}) {
  return new PcmsRemoteOpError(code, options);
}
