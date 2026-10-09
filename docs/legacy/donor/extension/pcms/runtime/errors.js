export const MODULE_RUNTIME_ERROR_CODES = Object.freeze({
  INVALID_STATE: "PCMS_MODULE_RUNTIME_INVALID_STATE",
  REVISION_CONFLICT: "PCMS_MODULE_RUNTIME_REVISION_CONFLICT",
  MODULE_NOT_ADMITTED: "PCMS_MODULE_RUNTIME_MODULE_NOT_ADMITTED",
  PACKAGE_MISMATCH: "PCMS_MODULE_RUNTIME_PACKAGE_MISMATCH",
  STALE_GENERATION: "PCMS_MODULE_RUNTIME_STALE_GENERATION",
  CAPABILITY_UNAVAILABLE: "PCMS_MODULE_RUNTIME_CAPABILITY_UNAVAILABLE",
  CAPACITY: "PCMS_MODULE_RUNTIME_CAPACITY",
  RECOVERY_HOLD: "PCMS_MODULE_RUNTIME_RECOVERY_HOLD",
  RECOVERY_REQUIRED: "PCMS_MODULE_RUNTIME_RECOVERY_REQUIRED",
  RUNTIME_UNAVAILABLE: "PCMS_MODULE_RUNTIME_UNAVAILABLE",
  CORRUPT_STATE: "PCMS_MODULE_RUNTIME_CORRUPT_STATE"
});

const MESSAGES = Object.freeze({
  [MODULE_RUNTIME_ERROR_CODES.INVALID_STATE]: "Module runtime state transition is invalid",
  [MODULE_RUNTIME_ERROR_CODES.REVISION_CONFLICT]: "Module runtime revision conflict",
  [MODULE_RUNTIME_ERROR_CODES.MODULE_NOT_ADMITTED]: "Module has no admitted active package",
  [MODULE_RUNTIME_ERROR_CODES.PACKAGE_MISMATCH]: "Module runtime package identity mismatch",
  [MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION]: "Module runtime generation is stale",
  [MODULE_RUNTIME_ERROR_CODES.CAPABILITY_UNAVAILABLE]: "Granted module capability is unavailable",
  [MODULE_RUNTIME_ERROR_CODES.CAPACITY]: "Module runtime mailbox capacity is exhausted",
  [MODULE_RUNTIME_ERROR_CODES.RECOVERY_HOLD]: "Module activation is blocked by recovery hold",
  [MODULE_RUNTIME_ERROR_CODES.RECOVERY_REQUIRED]: "Module runtime recovery is required",
  [MODULE_RUNTIME_ERROR_CODES.RUNTIME_UNAVAILABLE]: "Module runtime is unavailable · Requires Firefox 154+",
  [MODULE_RUNTIME_ERROR_CODES.CORRUPT_STATE]: "Module runtime persisted state is corrupt"
});

export class ModuleRuntimeError extends Error {
  constructor(code, { currentRevision = null, currentGeneration = null } = {}) {
    super(MESSAGES[code] || MESSAGES[MODULE_RUNTIME_ERROR_CODES.INVALID_STATE]);
    this.name = "ModuleRuntimeError";
    this.code = code;
    if (currentRevision !== null) this.currentRevision = currentRevision;
    if (currentGeneration !== null) this.currentGeneration = currentGeneration;
  }
}

export function moduleRuntimeError(code, options = {}) {
  return new ModuleRuntimeError(code, options);
}
