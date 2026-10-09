export const CORE_SERVICE_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_CORE_SERVICE_INVALID_ARGUMENT",
  NOT_FOUND: "PCMS_CORE_SERVICE_NOT_FOUND",
  REVISION_CONFLICT: "PCMS_CORE_SERVICE_REVISION_CONFLICT",
  INVALID_TRANSITION: "PCMS_CORE_SERVICE_INVALID_TRANSITION",
  SERVICE_CONFLICT: "PCMS_CORE_SERVICE_CONFLICT",
  SERVICE_UNAVAILABLE: "PCMS_CORE_SERVICE_UNAVAILABLE",
  STALE_SERVICE: "PCMS_CORE_SERVICE_STALE_SERVICE",
  TIMER_CAPACITY: "PCMS_CORE_TIMER_CAPACITY",
  CORRUPT_STATE: "PCMS_CORE_SERVICE_CORRUPT_STATE"
});

const MESSAGES = Object.freeze({
  [CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT]: "Core service argument is invalid",
  [CORE_SERVICE_ERROR_CODES.NOT_FOUND]: "Core service record was not found",
  [CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT]: "Core service record revision changed",
  [CORE_SERVICE_ERROR_CODES.INVALID_TRANSITION]: "Core service state transition is invalid",
  [CORE_SERVICE_ERROR_CODES.SERVICE_CONFLICT]: "Core service registration conflicts with an active owner",
  [CORE_SERVICE_ERROR_CODES.SERVICE_UNAVAILABLE]: "Core service is unavailable",
  [CORE_SERVICE_ERROR_CODES.STALE_SERVICE]: "Core service generation is stale",
  [CORE_SERVICE_ERROR_CODES.TIMER_CAPACITY]: "Core timer due-work capacity is exhausted",
  [CORE_SERVICE_ERROR_CODES.CORRUPT_STATE]: "Core service persisted state is corrupt"
});

export class PcmsCoreServiceError extends Error {
  constructor(code, { currentRevision = null, currentGeneration = null } = {}) {
    super(MESSAGES[code] || MESSAGES[CORE_SERVICE_ERROR_CODES.CORRUPT_STATE]);
    this.name = "PcmsCoreServiceError";
    this.code = code;
    if (currentRevision !== null) this.currentRevision = currentRevision;
    if (currentGeneration !== null) this.currentGeneration = currentGeneration;
  }
}

export function coreServiceError(code, options = {}) {
  return new PcmsCoreServiceError(code, options);
}
