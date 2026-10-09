export const REFRESHER_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_REFRESHER_INVALID_ARGUMENT",
  CORRUPT_STATE: "PCMS_REFRESHER_CORRUPT_STATE",
  NOT_FOUND: "PCMS_REFRESHER_NOT_FOUND",
  ACCOUNT_UNAVAILABLE: "PCMS_REFRESHER_ACCOUNT_UNAVAILABLE",
  PROVIDER_UNAVAILABLE: "PCMS_REFRESHER_PROVIDER_UNAVAILABLE",
  TARGET_CONFLICT: "PCMS_REFRESHER_TARGET_CONFLICT",
  REVISION_CONFLICT: "PCMS_REFRESHER_REVISION_CONFLICT",
  OPERATION_BUSY: "PCMS_REFRESHER_OPERATION_BUSY",
  INVALID_TRANSITION: "PCMS_REFRESHER_INVALID_TRANSITION",
  SOURCE_MISMATCH: "PCMS_REFRESHER_SOURCE_MISMATCH",
  REMOTE_STATE: "PCMS_REFRESHER_REMOTE_STATE",
  BUDGET_EXHAUSTED: "PCMS_REFRESHER_BUDGET_EXHAUSTED",
  SCHEDULE_INACTIVE: "PCMS_REFRESHER_SCHEDULE_INACTIVE",
  CAPACITY: "PCMS_REFRESHER_CAPACITY",
  RELEASE_UNAVAILABLE: "PCMS_REFRESHER_RELEASE_UNAVAILABLE"
});

const MESSAGES = Object.freeze({
  [REFRESHER_ERROR_CODES.INVALID_ARGUMENT]: "Refresher argument is invalid",
  [REFRESHER_ERROR_CODES.CORRUPT_STATE]: "Refresher state is corrupt",
  [REFRESHER_ERROR_CODES.NOT_FOUND]: "Refresher record was not found",
  [REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE]: "Refresher account is unavailable",
  [REFRESHER_ERROR_CODES.PROVIDER_UNAVAILABLE]: "Refresher provider gate is unavailable",
  [REFRESHER_ERROR_CODES.TARGET_CONFLICT]: "Generator target is already owned by another Refresher cohort",
  [REFRESHER_ERROR_CODES.REVISION_CONFLICT]: "Refresher state revision changed",
  [REFRESHER_ERROR_CODES.OPERATION_BUSY]: "Refresh operation is unresolved",
  [REFRESHER_ERROR_CODES.INVALID_TRANSITION]: "Refresh transition is invalid",
  [REFRESHER_ERROR_CODES.SOURCE_MISMATCH]: "Refresh source does not match the member source hash",
  [REFRESHER_ERROR_CODES.REMOTE_STATE]: "Refresh RemoteOperation state could not be reconciled safely",
  [REFRESHER_ERROR_CODES.BUDGET_EXHAUSTED]: "Refresher daily budget is exhausted",
  [REFRESHER_ERROR_CODES.SCHEDULE_INACTIVE]: "Refresher cohort is outside its active schedule",
  [REFRESHER_ERROR_CODES.CAPACITY]: "Refresher capacity was reached",
  [REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE]: "No refreshable Deployer-confirmed release is available"
});

export class PcmsRefresherError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] || MESSAGES[REFRESHER_ERROR_CODES.CORRUPT_STATE]);
    this.name = "PcmsRefresherError";
    this.code = code;
    if (Number.isSafeInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
  }
}

export function refresherError(code, options = {}) {
  return new PcmsRefresherError(code, options);
}
