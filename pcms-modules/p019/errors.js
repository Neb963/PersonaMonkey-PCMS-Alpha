export const PROVISIONING_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_PROVISIONING_INVALID_ARGUMENT",
  CORRUPT_STATE: "PCMS_PROVISIONING_CORRUPT_STATE",
  NOT_FOUND: "PCMS_PROVISIONING_NOT_FOUND",
  REVISION_CONFLICT: "PCMS_PROVISIONING_REVISION_CONFLICT",
  INVALID_TRANSITION: "PCMS_PROVISIONING_INVALID_TRANSITION",
  ACCOUNT_CONFLICT: "PCMS_PROVISIONING_ACCOUNT_CONFLICT",
  PERSONA_CONFLICT: "PCMS_PROVISIONING_PERSONA_CONFLICT",
  SESSION_UNAVAILABLE: "PCMS_PROVISIONING_SESSION_UNAVAILABLE",
  HUMAN_TASK_CONFLICT: "PCMS_PROVISIONING_HUMAN_TASK_CONFLICT",
  REMOTE_PROTOCOL: "PCMS_PROVISIONING_REMOTE_PROTOCOL",
  RECONCILE_REQUIRED: "PCMS_PROVISIONING_RECONCILE_REQUIRED",
  CAPACITY: "PCMS_PROVISIONING_CAPACITY"
});

const MESSAGES = Object.freeze({
  [PROVISIONING_ERROR_CODES.INVALID_ARGUMENT]: "Provisioning argument is invalid",
  [PROVISIONING_ERROR_CODES.CORRUPT_STATE]: "Provisioning state is corrupt",
  [PROVISIONING_ERROR_CODES.NOT_FOUND]: "Provisioning attempt was not found",
  [PROVISIONING_ERROR_CODES.REVISION_CONFLICT]: "Provisioning attempt revision changed",
  [PROVISIONING_ERROR_CODES.INVALID_TRANSITION]: "Provisioning state transition is invalid",
  [PROVISIONING_ERROR_CODES.ACCOUNT_CONFLICT]: "Provisioning account identity conflicts with durable Accounts state",
  [PROVISIONING_ERROR_CODES.PERSONA_CONFLICT]: "Provisioning Persona is already reserved by another account",
  [PROVISIONING_ERROR_CODES.SESSION_UNAVAILABLE]: "Provisioning guarded session is unavailable",
  [PROVISIONING_ERROR_CODES.HUMAN_TASK_CONFLICT]: "Provisioning HumanTask identity conflicts with durable state",
  [PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL]: "Provisioning remote-operation state is invalid",
  [PROVISIONING_ERROR_CODES.RECONCILE_REQUIRED]: "Provisioning remote outcome must be reconciled before retry",
  [PROVISIONING_ERROR_CODES.CAPACITY]: "Provisioning attempt capacity was reached"
});

export class PcmsProvisioningError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] || MESSAGES[PROVISIONING_ERROR_CODES.CORRUPT_STATE]);
    this.name = "PcmsProvisioningError";
    this.code = code;
    if (Number.isSafeInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
  }
}

export function provisioningError(code, options = {}) {
  return new PcmsProvisioningError(code, options);
}
