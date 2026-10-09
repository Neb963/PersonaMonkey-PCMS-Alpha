// Restore preview (A041-01): what a verified backup contains and how it differs from current
// PCMS data. The digest binds only to the backup itself, so a confirmation stays valid while
// background work keeps writing; the "current" side is shown for the operator's judgement.
import { MODULE_REGISTRY_NAMESPACE } from "../modules/registry.js";
import {
  PCMS_BACKUP_EXCLUDED_NAMESPACES,
  PCMS_RESTORE_CONFIRMATION_PHRASE,
  PCMS_RESTORE_PREVIEW_KIND
} from "./schema.js";

const MAX_PREVIEW_NAMESPACES = 200;
const MAX_PREVIEW_MODULES = 100;

function countByNamespace(records) {
  const counts = new Map();
  for (const record of records) counts.set(record.namespace, (counts.get(record.namespace) || 0) + 1);
  return counts;
}

function moduleIdsOf(records) {
  const ids = new Set();
  for (const record of records) {
    if (record.namespace !== MODULE_REGISTRY_NAMESPACE || typeof record.key !== "string" || !record.key.startsWith("module:")) continue;
    ids.add(record.key.slice("module:".length));
  }
  return [...ids].sort();
}

// The canonical text hashed into previewDigest. Only backup facts: never current data.
export function restorePreviewBinding(backup) {
  const counts = countByNamespace(backup.records);
  return JSON.stringify({
    kind: PCMS_RESTORE_PREVIEW_KIND + "-binding",
    backupId: backup.backupId,
    backupSha256: backup.sha256,
    createdAt: backup.createdAt,
    recordCount: backup.recordCount,
    namespaces: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  });
}

export function buildRestorePreview({ backup, currentRecords, previewDigest, previewedAt }) {
  const current = currentRecords.filter((record) => !PCMS_BACKUP_EXCLUDED_NAMESPACES.includes(record.namespace));
  const backupCounts = countByNamespace(backup.records);
  const currentCounts = countByNamespace(current);
  const names = [...new Set([...backupCounts.keys(), ...currentCounts.keys()])].sort();
  const namespaces = names.slice(0, MAX_PREVIEW_NAMESPACES).map((namespace) => Object.freeze({
    namespace,
    backup: backupCounts.get(namespace) || 0,
    current: currentCounts.get(namespace) || 0
  }));

  const id = (record) => record.namespace + "\u0000" + record.key;
  const currentById = new Map(current.map((record) => [id(record), record]));
  const backupIds = new Set();
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const record of backup.records) {
    const key = id(record);
    backupIds.add(key);
    const now = currentById.get(key);
    if (!now) added += 1;
    else if (now.revision === record.revision && JSON.stringify(now.value) === JSON.stringify(record.value)) unchanged += 1;
    else changed += 1;
  }
  const removed = current.filter((record) => !backupIds.has(id(record))).length;

  const backupModules = moduleIdsOf(backup.records);
  const currentModules = moduleIdsOf(current);
  return Object.freeze({
    kind: PCMS_RESTORE_PREVIEW_KIND,
    previewDigest,
    previewedAt,
    backupId: backup.backupId,
    backupSha256: backup.sha256,
    createdAt: backup.createdAt,
    recordCount: backup.recordCount,
    currentRecordCount: current.length,
    namespaces: Object.freeze(namespaces),
    namespacesTruncated: names.length > MAX_PREVIEW_NAMESPACES,
    differences: Object.freeze({ added, changed, removed, unchanged }),
    modules: Object.freeze({
      inBackup: Object.freeze(backupModules.slice(0, MAX_PREVIEW_MODULES)),
      onlyNow: Object.freeze(currentModules.filter((moduleId) => !backupModules.includes(moduleId)).slice(0, MAX_PREVIEW_MODULES))
    }),
    effects: Object.freeze([
      "Restoring replaces current PCMS data with this backup.",
      "PersonaMonkey Personas, routing and browser state are not changed.",
      "PCMS then holds all changes until pending operations are checked.",
      "Backups never contain secret values; credentials are kept as references only."
    ]),
    confirmationPhrase: PCMS_RESTORE_CONFIRMATION_PHRASE
  });
}
