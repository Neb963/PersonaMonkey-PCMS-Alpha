export const ACCOUNTS_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_ACCOUNTS_INVALID_ARGUMENT",
  CORRUPT_STATE: "PCMS_ACCOUNTS_CORRUPT_STATE",
  NOT_FOUND: "PCMS_ACCOUNTS_NOT_FOUND",
  ACCOUNT_CONFLICT: "PCMS_ACCOUNTS_ACCOUNT_CONFLICT",
  PERSONA_CONFLICT: "PCMS_ACCOUNTS_PERSONA_CONFLICT",
  PERSONA_UNAVAILABLE: "PCMS_ACCOUNTS_PERSONA_UNAVAILABLE",
  REVISION_CONFLICT: "PCMS_ACCOUNTS_REVISION_CONFLICT",
  CAPACITY: "PCMS_ACCOUNTS_CAPACITY",
  UNRESOLVED_OPERATION: "PCMS_ACCOUNTS_UNRESOLVED_OPERATION"
});

const MESSAGES = Object.freeze({
  [ACCOUNTS_ERROR_CODES.INVALID_ARGUMENT]: "Accounts argument is invalid",
  [ACCOUNTS_ERROR_CODES.CORRUPT_STATE]: "Accounts state is corrupt",
  [ACCOUNTS_ERROR_CODES.NOT_FOUND]: "Account was not found",
  [ACCOUNTS_ERROR_CODES.ACCOUNT_CONFLICT]: "Account identity conflicts with durable state",
  [ACCOUNTS_ERROR_CODES.PERSONA_CONFLICT]: "Persona is already bound to another account",
  [ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE]: "Persona binding target is unavailable",
  [ACCOUNTS_ERROR_CODES.REVISION_CONFLICT]: "Accounts state revision changed",
  [ACCOUNTS_ERROR_CODES.CAPACITY]: "Accounts capacity was reached",
  [ACCOUNTS_ERROR_CODES.UNRESOLVED_OPERATION]: "Account binding is blocked by unresolved RemoteOperations"
});

export class PcmsAccountsError extends Error {
  constructor(code, options = {}) {
    super(MESSAGES[code] || MESSAGES[ACCOUNTS_ERROR_CODES.CORRUPT_STATE]);
    this.name = "PcmsAccountsError";
    this.code = code;
    if (Number.isSafeInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
  }
}

export function accountsError(code, options = {}) {
  return new PcmsAccountsError(code, options);
}
