import { AlphaDataError, requireData } from '../domain/validation.js';

export const ALPHA_DB_NAME = 'persona-monkey-pcms-alpha';
export const ALPHA_DB_VERSION = 1;
export const RECORDS = 'records';
export const JOURNAL = 'journal';
export const META = 'meta';
export const JOURNAL_LIMIT = 1024;

export const ALPHA_MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, apply({ db, transaction }) {
    const records = db.createObjectStore(RECORDS, { keyPath: 'id' });
    records.createIndex('byKind', 'kind');
    records.createIndex('byAccount', ['kind', 'record.accountId']);
    // Sparse index: only account envelopes carry this key. Never cookieStoreId.
    records.createIndex('accountPersona', 'accountPersonaUid', { unique: true });
    db.createObjectStore(JOURNAL, { keyPath: 'revision' });
    db.createObjectStore(META, { keyPath: 'id' });
    transaction.objectStore(META).add({ id: 'state', schemaVersion: 1, revision: 0, journalLimit: JOURNAL_LIMIT });
  } })
]);

export function applyAlphaMigrations({ db, transaction, oldVersion, newVersion, migrations = ALPHA_MIGRATIONS }) {
  requireData(Array.isArray(migrations) && migrations.length > 0, 'RECOVERY_HOLD');
  migrations.forEach((m, i) => requireData(m.version === i + 1 && typeof m.apply === 'function', 'RECOVERY_HOLD'));
  requireData(Number.isSafeInteger(oldVersion) && oldVersion >= 0 && Number.isSafeInteger(newVersion) &&
    newVersion > 0 && oldVersion <= newVersion && newVersion <= migrations.length, 'RECOVERY_HOLD');
  for (let v = oldVersion + 1; v <= newVersion; v++) {
    const result = migrations[v - 1].apply({ db, transaction, oldVersion, newVersion });
    requireData(!result || typeof result.then !== 'function', 'RECOVERY_HOLD');
  }
}

export function openAlphaDatabase({ indexedDB = globalThis.indexedDB, dbName = ALPHA_DB_NAME,
  version = ALPHA_DB_VERSION, migrations = ALPHA_MIGRATIONS } = {}) {
  // Overrides are confined to disposable Alpha tests, never donor/PersonaMonkey DBs.
  requireData(dbName === ALPHA_DB_NAME || (typeof dbName === 'string' && /^persona-monkey-pcms-alpha-test-[a-z0-9-]+$/.test(dbName)));
  requireData(Number.isSafeInteger(version) && version > 0);
  requireData(indexedDB && typeof indexedDB.open === 'function', 'UNAVAILABLE');
  return new Promise((resolve, reject) => {
    let settled = false, failure;
    let request;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    try { request = indexedDB.open(dbName, version); }
    catch { fail(new AlphaDataError('UNAVAILABLE')); return; }
    request.onupgradeneeded = event => {
      try {
        // A blocked request can later resume. It must not mutate after rejection.
        requireData(!settled, 'UNAVAILABLE');
        applyAlphaMigrations({ db: request.result, transaction: request.transaction,
          oldVersion: event.oldVersion, newVersion: event.newVersion, migrations });
      } catch {
        failure = new AlphaDataError(settled ? 'UNAVAILABLE' : 'RECOVERY_HOLD');
        request.transaction.abort();
      }
    };
    request.onblocked = () => fail(new AlphaDataError('UNAVAILABLE'));
    request.onerror = () => fail(failure || new AlphaDataError(request.error?.name === 'VersionError' ? 'RECOVERY_HOLD' : 'UNAVAILABLE'));
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      resolve(request.result);
    };
  });
}
