export const MODULE_LIFECYCLE_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_MODULE_LIFECYCLE_INVALID_ARGUMENT",
  REVISION_CONFLICT: "PCMS_MODULE_LIFECYCLE_REVISION_CONFLICT",
  INVALID_STATE: "PCMS_MODULE_LIFECYCLE_INVALID_STATE",
  CANDIDATE_MISMATCH: "PCMS_MODULE_LIFECYCLE_CANDIDATE_MISMATCH",
  ROLLBACK_NOT_RETAINED: "PCMS_MODULE_LIFECYCLE_ROLLBACK_NOT_RETAINED",
  ACTIVATION_FAILED: "PCMS_MODULE_LIFECYCLE_ACTIVATION_FAILED",
  PURGE_INCOMPLETE: "PCMS_MODULE_LIFECYCLE_PURGE_INCOMPLETE",
  CORRUPT_STATE: "PCMS_MODULE_LIFECYCLE_CORRUPT_STATE"
});

const MESSAGES=Object.freeze({
  [MODULE_LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT]:"Module lifecycle argument is invalid",
  [MODULE_LIFECYCLE_ERROR_CODES.REVISION_CONFLICT]:"Module lifecycle revision changed",
  [MODULE_LIFECYCLE_ERROR_CODES.INVALID_STATE]:"Module lifecycle transition is invalid",
  [MODULE_LIFECYCLE_ERROR_CODES.CANDIDATE_MISMATCH]:"Module lifecycle candidate does not match",
  [MODULE_LIFECYCLE_ERROR_CODES.ROLLBACK_NOT_RETAINED]:"Requested rollback package is not retained",
  [MODULE_LIFECYCLE_ERROR_CODES.ACTIVATION_FAILED]:"Module activation failed and was fenced",
  [MODULE_LIFECYCLE_ERROR_CODES.PURGE_INCOMPLETE]:"Module purge did not complete",
  [MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE]:"Module lifecycle state is corrupt"
});

export class ModuleLifecycleError extends Error {
  constructor(code,{currentRevision=null}={}) {
    super(MESSAGES[code]||MESSAGES[MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE]);
    this.name="ModuleLifecycleError";
    this.code=code;
    if(currentRevision!==null) this.currentRevision=currentRevision;
  }
}

export function moduleLifecycleError(code,options={}) {
  return new ModuleLifecycleError(code,options);
}
