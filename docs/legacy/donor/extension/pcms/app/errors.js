export const PCMS_UI_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_UI_INVALID_ARGUMENT",
  PROJECTION_PROTOCOL: "PCMS_UI_PROJECTION_PROTOCOL",
  DEEP_LINK_INVALID: "PCMS_UI_DEEP_LINK_INVALID"
});

const MESSAGES = Object.freeze({
  [PCMS_UI_ERROR_CODES.INVALID_ARGUMENT]: "PCMS UI argument is invalid",
  [PCMS_UI_ERROR_CODES.PROJECTION_PROTOCOL]: "PCMS UI projection source is invalid",
  [PCMS_UI_ERROR_CODES.DEEP_LINK_INVALID]: "PCMS UI deep link is invalid"
});

export class PcmsUiError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES[PCMS_UI_ERROR_CODES.PROJECTION_PROTOCOL]);
    this.name = "PcmsUiError";
    this.code = code;
  }
}

export function pcmsUiError(code) {
  return new PcmsUiError(code);
}
