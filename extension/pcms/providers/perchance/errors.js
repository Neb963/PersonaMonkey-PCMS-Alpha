export const PERCHANCE_PROVIDER_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_PERCHANCE_INVALID_ARGUMENT",
  INCOMPATIBLE: "PCMS_PERCHANCE_INCOMPATIBLE",
  PROTOCOL: "PCMS_PERCHANCE_PROTOCOL"
});

const MESSAGES = Object.freeze({
  [PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT]: "Perchance provider argument is invalid",
  [PERCHANCE_PROVIDER_ERROR_CODES.INCOMPATIBLE]: "Perchance provider compatibility is not proven",
  [PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL]: "Perchance provider protocol failed"
});

export class PcmsPerchanceProviderError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES[PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL]);
    this.name = "PcmsPerchanceProviderError";
    this.code = code;
  }
}

export function perchanceProviderError(code) {
  return new PcmsPerchanceProviderError(code);
}
