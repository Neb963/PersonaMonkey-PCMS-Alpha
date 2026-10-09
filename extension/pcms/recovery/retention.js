import { BACKUP_ERROR_CODES, backupError } from "./errors.js";
import { normalizeBackupId, normalizeBackupTimestamp } from "./schema.js";

function fail() { throw backupError(BACKUP_ERROR_CODES.INVALID_ARGUMENT); }

export function planBackupRetention(backups, { keepLatest = 5 } = {}) {
  if (!Array.isArray(backups) || !Number.isSafeInteger(keepLatest) || keepLatest < 1 || keepLatest > 100) fail();
  const seen=new Set();
  const normalized=backups.map((item)=>{
    if(!item || typeof item!=="object" || Array.isArray(item)) fail();
    const backupId=normalizeBackupId(item.backupId);
    const createdAt=normalizeBackupTimestamp(item.createdAt,BACKUP_ERROR_CODES.INVALID_ARGUMENT);
    if(seen.has(backupId)) fail();
    seen.add(backupId);
    return Object.freeze({backupId,createdAt});
  });
  normalized.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.backupId.localeCompare(a.backupId));
  return Object.freeze({
    retain:Object.freeze(normalized.slice(0,keepLatest).map((item)=>item.backupId)),
    delete:Object.freeze(normalized.slice(keepLatest).map((item)=>item.backupId))
  });
}
