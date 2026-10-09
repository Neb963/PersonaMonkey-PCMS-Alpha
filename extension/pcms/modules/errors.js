export const MODULE_ERROR_CODES = Object.freeze({
  INVALID_ARCHIVE: "PCMS_MODULE_INVALID_ARCHIVE",
  ARCHIVE_TOO_LARGE: "PCMS_MODULE_ARCHIVE_TOO_LARGE",
  INVALID_MANIFEST: "PCMS_MODULE_INVALID_MANIFEST",
  INVALID_PATH: "PCMS_MODULE_INVALID_PATH",
  INVALID_AUTHORITY: "PCMS_MODULE_INVALID_AUTHORITY",
  HASH_UNAVAILABLE: "PCMS_MODULE_HASH_UNAVAILABLE",
  IDENTITY_CONFLICT: "PCMS_MODULE_IDENTITY_CONFLICT",
  REVISION_CONFLICT: "PCMS_MODULE_REVISION_CONFLICT",
  CANDIDATE_EXISTS: "PCMS_MODULE_CANDIDATE_EXISTS",
  CANDIDATE_MISMATCH: "PCMS_MODULE_CANDIDATE_MISMATCH",
  APPROVAL_REQUIRED: "PCMS_MODULE_APPROVAL_REQUIRED",
  INVALID_TRANSITION: "PCMS_MODULE_INVALID_TRANSITION",
  PACKAGE_MISSING: "PCMS_MODULE_PACKAGE_MISSING",
  PACKAGE_REFERENCED: "PCMS_MODULE_PACKAGE_REFERENCED",
  CORRUPT_STATE: "PCMS_MODULE_CORRUPT_STATE"
});

const SAFE_MESSAGES = Object.freeze({
  [MODULE_ERROR_CODES.INVALID_ARCHIVE]: "Module archive is invalid",
  [MODULE_ERROR_CODES.ARCHIVE_TOO_LARGE]: "Module archive exceeds size limits",
  [MODULE_ERROR_CODES.INVALID_MANIFEST]: "Module manifest is invalid",
  [MODULE_ERROR_CODES.INVALID_PATH]: "Module archive path is invalid",
  [MODULE_ERROR_CODES.INVALID_AUTHORITY]: "Module authority envelope is invalid",
  [MODULE_ERROR_CODES.HASH_UNAVAILABLE]: "Module package hashing is unavailable",
  [MODULE_ERROR_CODES.IDENTITY_CONFLICT]: "Module package identity conflicts with stored content",
  [MODULE_ERROR_CODES.REVISION_CONFLICT]: "Module state revision changed",
  [MODULE_ERROR_CODES.CANDIDATE_EXISTS]: "A different module candidate is already staged",
  [MODULE_ERROR_CODES.CANDIDATE_MISMATCH]: "The requested module candidate does not match",
  [MODULE_ERROR_CODES.APPROVAL_REQUIRED]: "Module authority expansion requires approval",
  [MODULE_ERROR_CODES.INVALID_TRANSITION]: "Module candidate transition is invalid",
  [MODULE_ERROR_CODES.PACKAGE_MISSING]: "Referenced module package is unavailable",
  [MODULE_ERROR_CODES.PACKAGE_REFERENCED]: "Module package is still referenced",
  [MODULE_ERROR_CODES.CORRUPT_STATE]: "Module registry state is corrupt"
});

export class PcmsModuleError extends Error {
  constructor(code, message = SAFE_MESSAGES[code] || SAFE_MESSAGES[MODULE_ERROR_CODES.CORRUPT_STATE], options = {}) {
    super(message, options);
    this.name = "PcmsModuleError";
    this.code = code;
    if (Number.isInteger(options.currentRevision)) this.currentRevision = options.currentRevision;
  }
}

export function moduleError(code, options = {}) {
  return new PcmsModuleError(code, undefined, options);
}
