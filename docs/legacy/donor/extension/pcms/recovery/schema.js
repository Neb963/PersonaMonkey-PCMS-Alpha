import { BACKUP_ERROR_CODES, backupError } from "./errors.js";

export const PCMS_BACKUP_SCHEMA_VERSION = 1;
export const PCMS_BACKUP_KIND = "pcms-backup";
export const PCMS_STAGED_RESTORE_KIND = "pcms-staged-restore";
export const PCMS_BACKUP_MAX_RECORDS = 10000;
export const PCMS_BACKUP_EXCLUDED_NAMESPACES = Object.freeze(["core.backups", "core.recovery"]);
export const PCMS_RESTORE_PREVIEW_KIND = "pcms-restore-preview";
export const PCMS_RESTORE_CONFIRMATION_PHRASE = "RESTORE";
// A preview older than this must be produced again before it can be confirmed.
export const PCMS_RESTORE_PREVIEW_TTL_MS = 60 * 60 * 1000;

// Field names that may only ever carry a SecretRef (or nothing). Secret values live in the
// dedicated secret host; a value under one of these names in an ordinary PCMS record means
// something leaked, so backup export and restore import both fail closed (AGENTS §8).
const CREDENTIAL_FIELD = /^(?:secret(?:value)?|client[-_]?secret|pass(?:word|phrase)|api[-_]?key|private[-_]?key|credential|(?:access|refresh|bearer|auth|session|api)[-_]?token)$/i;
const SECRET_REF = /^pcms-secret:v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Redaction markers written by the audit journal and diagnostics are not values.
const REDACTION_MARKERS = new Set(["[REDACTED]", "pcms-secret:v1:[opaque]"]);
const MAX_SCAN_DEPTH = 64;

const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function fail(code = BACKUP_ERROR_CODES.INVALID_ARGUMENT) {
  throw backupError(code);
}

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value, names, code) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== names.length
      || !names.every((name) => Object.hasOwn(descriptors, name)
        && descriptors[name].enumerable
        && Object.hasOwn(descriptors[name], "value"))) {
    fail(code);
  }
  return descriptors;
}

export function normalizeBackupId(value, code = BACKUP_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string" || !BACKUP_ID_PATTERN.test(value)) fail(code);
  return value;
}

export function normalizeBackupTimestamp(value, code = BACKUP_ERROR_CODES.CORRUPT_BACKUP) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || Number.isNaN(Date.parse(value))) fail(code);
  return new Date(value).toISOString();
}

export function normalizeBackupDigest(value, code = BACKUP_ERROR_CODES.CORRUPT_BACKUP) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) fail(code);
  return value;
}

export function normalizeBackupEnvelope(raw, validateRecords) {
  if (typeof validateRecords !== "function") throw new TypeError("Backup validation requires storage record validation");
  const d = exact(raw, ["schemaVersion","kind","backupId","createdAt","recordCount","records","sha256"], BACKUP_ERROR_CODES.CORRUPT_BACKUP);
  if (d.schemaVersion.value !== PCMS_BACKUP_SCHEMA_VERSION || d.kind.value !== PCMS_BACKUP_KIND) fail(BACKUP_ERROR_CODES.CORRUPT_BACKUP);
  const backupId = normalizeBackupId(d.backupId.value, BACKUP_ERROR_CODES.CORRUPT_BACKUP);
  const createdAt = normalizeBackupTimestamp(d.createdAt.value);
  if (!Number.isSafeInteger(d.recordCount.value) || d.recordCount.value < 0 || d.recordCount.value > PCMS_BACKUP_MAX_RECORDS) fail(BACKUP_ERROR_CODES.CORRUPT_BACKUP);
  let records;
  try { records = validateRecords(d.records.value); } catch { fail(BACKUP_ERROR_CODES.CORRUPT_BACKUP); }
  if (records.length !== d.recordCount.value || records.length > PCMS_BACKUP_MAX_RECORDS) fail(BACKUP_ERROR_CODES.CORRUPT_BACKUP);
  if (records.some((record) => PCMS_BACKUP_EXCLUDED_NAMESPACES.includes(record.namespace))) fail(BACKUP_ERROR_CODES.CORRUPT_BACKUP);
  return Object.freeze({
    schemaVersion:PCMS_BACKUP_SCHEMA_VERSION,
    kind:PCMS_BACKUP_KIND,
    backupId,
    createdAt,
    recordCount:records.length,
    records,
    sha256:normalizeBackupDigest(d.sha256.value)
  });
}

// A staged restore carries the preview it was staged with; applying it additionally needs
// `confirmation: {phrase:"RESTORE", previewDigest}` naming that exact preview (A041-01).
export function normalizeStagedRestore(raw, normalizeBackup, { requireConfirmation = false } = {}) {
  if (typeof normalizeBackup !== "function") throw new TypeError("Staged restore requires backup normalization");
  if (requireConfirmation && (!plain(raw) || !Object.hasOwn(raw, "confirmation") || !Object.hasOwn(raw, "preview"))) {
    fail(BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED);
  }
  const names = ["schemaVersion","kind","stagedAt","backup","preview"];
  const d=exact(raw,requireConfirmation?[...names,"confirmation"]:names,BACKUP_ERROR_CODES.RESTORE_STATE);
  if(d.schemaVersion.value!==PCMS_BACKUP_SCHEMA_VERSION || d.kind.value!==PCMS_STAGED_RESTORE_KIND) fail(BACKUP_ERROR_CODES.RESTORE_STATE);
  const preview=d.preview.value;
  if(!plain(preview)||preview.kind!==PCMS_RESTORE_PREVIEW_KIND) fail(BACKUP_ERROR_CODES.PREVIEW_MISMATCH);
  const previewDigest=normalizeBackupDigest(preview.previewDigest,BACKUP_ERROR_CODES.PREVIEW_MISMATCH);
  let confirmation=null;
  if(requireConfirmation){
    const c=d.confirmation.value;
    if(!plain(c)||Object.keys(c).length!==2||c.phrase!==PCMS_RESTORE_CONFIRMATION_PHRASE) fail(BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED);
    if(normalizeBackupDigest(c.previewDigest,BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED)!==previewDigest) fail(BACKUP_ERROR_CODES.PREVIEW_MISMATCH);
    confirmation=Object.freeze({phrase:PCMS_RESTORE_CONFIRMATION_PHRASE,previewDigest});
  }
  return Object.freeze({
    schemaVersion:PCMS_BACKUP_SCHEMA_VERSION,
    kind:PCMS_STAGED_RESTORE_KIND,
    stagedAt:normalizeBackupTimestamp(d.stagedAt.value,BACKUP_ERROR_CODES.RESTORE_STATE),
    backup:normalizeBackup(d.backup.value),
    previewDigest,
    confirmation
  });
}

// The dashboard-side step that turns a reviewed preview into an applicable restore. It
// adds nothing Core trusts by itself: Core recomputes the preview digest from the backup.
export function confirmStagedRestore(stage, typedPhrase) {
  if (!plain(stage) || !plain(stage.preview)) fail(BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED);
  if (typeof typedPhrase !== "string" || typedPhrase !== PCMS_RESTORE_CONFIRMATION_PHRASE) fail(BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED);
  return Object.freeze({
    schemaVersion: stage.schemaVersion,
    kind: stage.kind,
    stagedAt: stage.stagedAt,
    backup: stage.backup,
    preview: stage.preview,
    confirmation: Object.freeze({ phrase: typedPhrase, previewDigest: stage.preview.previewDigest })
  });
}

function scanForCredentialValues(value, depth) {
  if (depth > MAX_SCAN_DEPTH) fail(BACKUP_ERROR_CODES.SECRET_MATERIAL);
  if (Array.isArray(value)) { for (const item of value) scanForCredentialValues(item, depth + 1); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_FIELD.test(key) && !(item === null || item === undefined || (typeof item === "string" && (SECRET_REF.test(item) || REDACTION_MARKERS.has(item))))) {
      fail(BACKUP_ERROR_CODES.SECRET_MATERIAL);
    }
    scanForCredentialValues(item, depth + 1);
  }
}

// Fails closed when any record holds a value under a credential field that is not a SecretRef.
export function assertNoCredentialValues(records) {
  if (!Array.isArray(records)) fail(BACKUP_ERROR_CODES.CORRUPT_BACKUP);
  for (const record of records) scanForCredentialValues(record?.value, 0);
  return records;
}

export function backupDigestPayload(backup) {
  return Object.freeze({
    schemaVersion:backup.schemaVersion,
    kind:backup.kind,
    backupId:backup.backupId,
    createdAt:backup.createdAt,
    recordCount:backup.recordCount,
    records:backup.records
  });
}
