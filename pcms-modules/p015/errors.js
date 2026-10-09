export const DEPLOYER_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_DEPLOYER_INVALID_ARGUMENT",
  CORRUPT_STATE: "PCMS_DEPLOYER_CORRUPT_STATE",
  NOT_FOUND: "PCMS_DEPLOYER_NOT_FOUND",
  ACCOUNT_UNAVAILABLE: "PCMS_DEPLOYER_ACCOUNT_UNAVAILABLE",
  PROVIDER_UNAVAILABLE: "PCMS_DEPLOYER_PROVIDER_UNAVAILABLE",
  TARGET_CONFLICT: "PCMS_DEPLOYER_TARGET_CONFLICT",
  REVISION_CONFLICT: "PCMS_DEPLOYER_REVISION_CONFLICT",
  OPERATION_BUSY: "PCMS_DEPLOYER_OPERATION_BUSY",
  INVALID_TRANSITION: "PCMS_DEPLOYER_INVALID_TRANSITION",
  SOURCE_MISMATCH: "PCMS_DEPLOYER_SOURCE_MISMATCH",
  CONTENT_MISMATCH: "PCMS_DEPLOYER_CONTENT_MISMATCH",
  REMOTE_STATE: "PCMS_DEPLOYER_REMOTE_STATE",
  CAPACITY: "PCMS_DEPLOYER_CAPACITY"
});

const MESSAGES = Object.freeze({
  [DEPLOYER_ERROR_CODES.INVALID_ARGUMENT]: "Deployer argument is invalid",
  [DEPLOYER_ERROR_CODES.CORRUPT_STATE]: "Deployer state is corrupt",
  [DEPLOYER_ERROR_CODES.NOT_FOUND]: "Deployment was not found",
  [DEPLOYER_ERROR_CODES.ACCOUNT_UNAVAILABLE]: "Deployment account is unavailable",
  [DEPLOYER_ERROR_CODES.PROVIDER_UNAVAILABLE]: "Deployment provider gate is unavailable",
  [DEPLOYER_ERROR_CODES.TARGET_CONFLICT]: "Generator target is already owned by another deployment",
  [DEPLOYER_ERROR_CODES.REVISION_CONFLICT]: "Deployer state revision changed",
  [DEPLOYER_ERROR_CODES.OPERATION_BUSY]: "Deployment operation is still dispatching",
  [DEPLOYER_ERROR_CODES.INVALID_TRANSITION]: "Deployment transition is invalid",
  [DEPLOYER_ERROR_CODES.SOURCE_MISMATCH]: "Deployment source does not match desired source hash",
  [DEPLOYER_ERROR_CODES.CONTENT_MISMATCH]: "Deployment content does not match the desired release",
  [DEPLOYER_ERROR_CODES.REMOTE_STATE]: "Remote operation state could not be reconciled safely",
  [DEPLOYER_ERROR_CODES.CAPACITY]: "Deployer capacity was reached"
});

export class PcmsDeployerError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] || MESSAGES[DEPLOYER_ERROR_CODES.CORRUPT_STATE]);
    this.name = "PcmsDeployerError";
    this.code = code;
    if (Number.isSafeInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
  }
}

export function deployerError(code, options = {}) {
  return new PcmsDeployerError(code, options);
}
