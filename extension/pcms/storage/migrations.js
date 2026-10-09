import { STORAGE_ERROR_CODES, storageError } from "./errors.js";

export const PCMS_DB_NAME = "persona-monkey-pcms";
export const PCMS_DB_VERSION = 1;
export const PCMS_RECORD_STORE = "records";
export const PCMS_NAMESPACE_INDEX = "byNamespace";

function migrationV1({ db }) {
  const store = db.createObjectStore(PCMS_RECORD_STORE, { keyPath: "id" });
  store.createIndex(PCMS_NAMESPACE_INDEX, "namespace", { unique: false });
}

export const PCMS_MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, apply: migrationV1 })
]);

function assertMigrationTable(migrations) {
  let expected = 1;
  for (const migration of migrations) {
    if (migration?.version !== expected || typeof migration.apply !== "function") {
      throw storageError(STORAGE_ERROR_CODES.MIGRATION_FAILED, "PCMS migration table is not contiguous");
    }
    expected += 1;
  }
}

export function applyPcmsMigrations({
  db,
  transaction,
  oldVersion,
  newVersion,
  migrations = PCMS_MIGRATIONS
}) {
  assertMigrationTable(migrations);
  const latest = migrations.length;
  if (!Number.isInteger(oldVersion) || oldVersion < 0 || !Number.isInteger(newVersion) || newVersion < 0) {
    throw storageError(STORAGE_ERROR_CODES.MIGRATION_FAILED, "PCMS migration version is invalid");
  }
  if (newVersion > latest || oldVersion > newVersion) {
    throw storageError(STORAGE_ERROR_CODES.MIGRATION_FAILED, "PCMS database version is unsupported");
  }

  for (let version = oldVersion + 1; version <= newVersion; version += 1) {
    const migration = migrations[version - 1];
    const result = migration.apply({ db, transaction, oldVersion, newVersion });
    if (result && typeof result.then === "function") {
      throw storageError(STORAGE_ERROR_CODES.MIGRATION_FAILED, "PCMS migrations must be synchronous");
    }
  }
}
