export const EXPLORER_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_EXPLORER_INVALID_ARGUMENT",
  CORRUPT_STATE: "PCMS_EXPLORER_CORRUPT_STATE",
  NOT_FOUND: "PCMS_EXPLORER_NOT_FOUND",
  ACCOUNT_UNAVAILABLE: "PCMS_EXPLORER_ACCOUNT_UNAVAILABLE",
  REVISION_CONFLICT: "PCMS_EXPLORER_REVISION_CONFLICT",
  DISCOVERY_CONFLICT: "PCMS_EXPLORER_DISCOVERY_CONFLICT",
  CLAIM_CONFLICT: "PCMS_EXPLORER_CLAIM_CONFLICT",
  INVALID_TRANSITION: "PCMS_EXPLORER_INVALID_TRANSITION",
  CAPACITY: "PCMS_EXPLORER_CAPACITY"
});

const MESSAGES = Object.freeze({
  [EXPLORER_ERROR_CODES.INVALID_ARGUMENT]: "Explorer argument is invalid",
  [EXPLORER_ERROR_CODES.CORRUPT_STATE]: "Explorer state is corrupt",
  [EXPLORER_ERROR_CODES.NOT_FOUND]: "Explorer record was not found",
  [EXPLORER_ERROR_CODES.ACCOUNT_UNAVAILABLE]: "Explorer account is unavailable",
  [EXPLORER_ERROR_CODES.REVISION_CONFLICT]: "Explorer state revision changed",
  [EXPLORER_ERROR_CODES.DISCOVERY_CONFLICT]: "Explorer discovery identity conflicts with prior content",
  [EXPLORER_ERROR_CODES.CLAIM_CONFLICT]: "Explorer candidate or deployment reservation is already claimed",
  [EXPLORER_ERROR_CODES.INVALID_TRANSITION]: "Explorer transition is invalid",
  [EXPLORER_ERROR_CODES.CAPACITY]: "Explorer capacity was reached"
});

export class PcmsExplorerError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] || MESSAGES[EXPLORER_ERROR_CODES.CORRUPT_STATE]);
    this.name = "PcmsExplorerError";
    this.code = code;
    if (Number.isSafeInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
  }
}

export function explorerError(code, options = {}) {
  return new PcmsExplorerError(code, options);
}
