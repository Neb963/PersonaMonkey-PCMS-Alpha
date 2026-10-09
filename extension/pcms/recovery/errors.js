export const BACKUP_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_BACKUP_INVALID_ARGUMENT",
  CORRUPT_BACKUP: "PCMS_BACKUP_CORRUPT_BACKUP",
  INTEGRITY_MISMATCH: "PCMS_BACKUP_INTEGRITY_MISMATCH",
  RESTORE_STATE: "PCMS_BACKUP_RESTORE_STATE",
  RECONCILIATION_INCOMPLETE: "PCMS_BACKUP_RECONCILIATION_INCOMPLETE",
  CAPACITY: "PCMS_BACKUP_CAPACITY",
  CONFIRMATION_REQUIRED: "PCMS_BACKUP_CONFIRMATION_REQUIRED",
  PREVIEW_MISMATCH: "PCMS_BACKUP_PREVIEW_MISMATCH",
  SECRET_MATERIAL: "PCMS_BACKUP_SECRET_MATERIAL",
  NOT_HELD: "PCMS_BACKUP_NOT_HELD",
  OPERATION_NOT_FOUND: "PCMS_BACKUP_OPERATION_NOT_FOUND"
});

const MESSAGES = Object.freeze({
  [BACKUP_ERROR_CODES.INVALID_ARGUMENT]: "Backup or restore argument is invalid",
  [BACKUP_ERROR_CODES.CORRUPT_BACKUP]: "Backup payload is corrupt",
  [BACKUP_ERROR_CODES.INTEGRITY_MISMATCH]: "Backup integrity check failed",
  [BACKUP_ERROR_CODES.RESTORE_STATE]: "Restore state is invalid",
  [BACKUP_ERROR_CODES.RECONCILIATION_INCOMPLETE]: "Restore reconciliation is incomplete",
  [BACKUP_ERROR_CODES.CAPACITY]: "Backup capacity was exceeded",
  [BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED]: "Restore needs a reviewed preview and the typed confirmation RESTORE (Settings → Backup & restore)",
  [BACKUP_ERROR_CODES.PREVIEW_MISMATCH]: "The restore preview does not match this backup or has expired; preview it again",
  [BACKUP_ERROR_CODES.SECRET_MATERIAL]: "Backup data contains a credential value instead of a SecretRef; nothing was exported or restored",
  [BACKUP_ERROR_CODES.NOT_HELD]: "PCMS is not on recovery hold",
  [BACKUP_ERROR_CODES.OPERATION_NOT_FOUND]: "That operation no longer needs checking"
});

export class PcmsBackupError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES[BACKUP_ERROR_CODES.CORRUPT_BACKUP]);
    this.name = "PcmsBackupError";
    this.code = code;
  }
}

export function backupError(code) {
  return new PcmsBackupError(code);
}
