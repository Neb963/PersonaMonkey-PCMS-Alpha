export const INTEGRATION_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_INTEGRATION_INVALID_ARGUMENT",
  STORAGE_PROTOCOL: "PCMS_INTEGRATION_STORAGE_PROTOCOL",
  BROKER_PROTOCOL: "PCMS_INTEGRATION_BROKER_PROTOCOL",
  CROSS_MODULE_CONFLICT: "PCMS_INTEGRATION_CROSS_MODULE_CONFLICT",
  RESERVATION_NOT_READY: "PCMS_INTEGRATION_RESERVATION_NOT_READY",
  PROVIDER_UNAVAILABLE: "PCMS_INTEGRATION_PROVIDER_UNAVAILABLE"
});

const MESSAGES=Object.freeze({
  [INTEGRATION_ERROR_CODES.INVALID_ARGUMENT]:"PCMS integration argument is invalid",
  [INTEGRATION_ERROR_CODES.STORAGE_PROTOCOL]:"PCMS integration storage contract failed",
  [INTEGRATION_ERROR_CODES.BROKER_PROTOCOL]:"PCMS Persona Broker integration failed",
  [INTEGRATION_ERROR_CODES.CROSS_MODULE_CONFLICT]:"PCMS cross-module state conflicts",
  [INTEGRATION_ERROR_CODES.RESERVATION_NOT_READY]:"Explorer reservation is not ready for deployment",
  [INTEGRATION_ERROR_CODES.PROVIDER_UNAVAILABLE]:"PCMS provider compatibility is unavailable"
});

export class PcmsIntegrationError extends Error {
  constructor(code,{currentRevision=null}={}) {
    super(MESSAGES[code]||MESSAGES[INTEGRATION_ERROR_CODES.INVALID_ARGUMENT]);
    this.name="PcmsIntegrationError";
    this.code=code;
    if(currentRevision!==null)this.currentRevision=currentRevision;
  }
}

export function integrationError(code,options={}) {
  return new PcmsIntegrationError(code,options);
}
