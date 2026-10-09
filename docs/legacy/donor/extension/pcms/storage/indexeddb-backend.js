import {
  PCMS_DB_NAME,
  PCMS_DB_VERSION,
  PCMS_NAMESPACE_INDEX,
  PCMS_RECORD_STORE,
  applyPcmsMigrations
} from "./migrations.js";
import { STORAGE_ERROR_CODES, PcmsStorageError, storageError } from "./errors.js";

function asStorageError(error, code, message) {
  if (error instanceof PcmsStorageError) return error;
  return storageError(code, message, { cause: error });
}

export function openPcmsDatabase({
  indexedDB = globalThis.indexedDB,
  dbName = PCMS_DB_NAME,
  version = PCMS_DB_VERSION,
  migrations
} = {}) {
  if (!indexedDB || typeof indexedDB.open !== "function") {
    return Promise.reject(storageError(STORAGE_ERROR_CODES.UNAVAILABLE, "IndexedDB is unavailable"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let migrationError = null;
    const request = indexedDB.open(dbName, version);

    request.onupgradeneeded = (event) => {
      try {
        applyPcmsMigrations({
          db: request.result,
          transaction: request.transaction,
          oldVersion: event.oldVersion,
          newVersion: event.newVersion ?? version,
          migrations
        });
      } catch (error) {
        migrationError = asStorageError(error, STORAGE_ERROR_CODES.MIGRATION_FAILED, "PCMS database migration failed");
        try { request.transaction?.abort(); } catch {}
      }
    };

    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(storageError(STORAGE_ERROR_CODES.BLOCKED, "PCMS database upgrade is blocked by another connection"));
    };

    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(migrationError || asStorageError(request.error, STORAGE_ERROR_CODES.UNAVAILABLE, "PCMS database open failed"));
    };

    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        try { db.close(); } catch {}
        return;
      }
      settled = true;
      resolve(db);
    };
  });
}

function requestFailure(request, fallback) {
  return asStorageError(request?.error, STORAGE_ERROR_CODES.UNAVAILABLE, fallback);
}

function transactionFailure(transaction, fallback, preferredError) {
  if (preferredError) return preferredError;
  return asStorageError(transaction?.error, STORAGE_ERROR_CODES.UNAVAILABLE, fallback);
}

function recordId(namespace, key) {
  return namespace + "\u0000" + key;
}

export function createIndexedDbStorageBackend({ openDatabase = openPcmsDatabase, ...openOptions } = {}) {
  let db = null;
  let stale = false;
  let opening = null;

  async function open() {
    if (db && !stale) return;
    if (opening) return opening;
    opening = openDatabase(openOptions).then((opened) => {
      db = opened;
      stale = false;
      db.onversionchange = () => {
        stale = true;
        try { db.close(); } catch {}
      };
    }).finally(() => { opening = null; });
    return opening;
  }

  function currentDb() {
    if (!db) throw storageError(STORAGE_ERROR_CODES.CLOSED, "PCMS storage is not open");
    if (stale) throw storageError(STORAGE_ERROR_CODES.STALE_CONNECTION, "PCMS storage connection is stale");
    return db;
  }

  function runRead(namespace, key) {
    const active = currentDb();
    return new Promise((resolve, reject) => {
      let settled = false;
      const transaction = active.transaction(PCMS_RECORD_STORE, "readonly");
      const request = transaction.objectStore(PCMS_RECORD_STORE).get(recordId(namespace, key));
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(requestFailure(request, "PCMS storage read failed"));
      };
      request.onsuccess = () => {
        if (settled) return;
        settled = true;
        resolve(request.result || null);
      };
    });
  }

  function runCas({ namespace, key, expectedRevision, value, deleted, updatedAt }) {
    const active = currentDb();
    return new Promise((resolve, reject) => {
      let result = null;
      let operationError = null;
      let readDone = false;
      const transaction = active.transaction(PCMS_RECORD_STORE, "readwrite");
      const store = transaction.objectStore(PCMS_RECORD_STORE);
      const getRequest = store.get(recordId(namespace, key));

      getRequest.onerror = () => {
        operationError = requestFailure(getRequest, "PCMS storage compare-and-swap read failed");
        try { transaction.abort(); } catch {}
      };

      getRequest.onsuccess = () => {
        readDone = true;
        const existing = getRequest.result || null;
        const currentRevision = existing?.revision || 0;
        if (currentRevision !== expectedRevision) {
          operationError = storageError(
            STORAGE_ERROR_CODES.CAS_MISMATCH,
            "PCMS storage revision mismatch",
            { currentRevision }
          );
          try { transaction.abort(); } catch {}
          return;
        }

        if (deleted) {
          if (!existing) {
            result = { deleted: false, revision: 0 };
            return;
          }
          const deleteRequest = store.delete(existing.id);
          deleteRequest.onerror = () => {
            operationError = requestFailure(deleteRequest, "PCMS storage delete failed");
            try { transaction.abort(); } catch {}
          };
          result = { deleted: true, revision: currentRevision };
          return;
        }

        const record = {
          id: recordId(namespace, key),
          namespace,
          key,
          revision: currentRevision + 1,
          value,
          updatedAt
        };
        const putRequest = store.put(record);
        putRequest.onerror = () => {
          operationError = requestFailure(putRequest, "PCMS storage write failed");
          try { transaction.abort(); } catch {}
        };
        result = record;
      };

      transaction.oncomplete = () => {
        if (!readDone) {
          reject(storageError(STORAGE_ERROR_CODES.UNAVAILABLE, "PCMS storage transaction completed without reading state"));
          return;
        }
        resolve(result);
      };
      transaction.onabort = () => reject(transactionFailure(transaction, "PCMS storage transaction aborted", operationError));
      transaction.onerror = () => {};
    });
  }

  function listNamespace(namespace) {
    const active = currentDb();
    return new Promise((resolve, reject) => {
      const results = [];
      const transaction = active.transaction(PCMS_RECORD_STORE, "readonly");
      const store = transaction.objectStore(PCMS_RECORD_STORE);
      const index = store.index(PCMS_NAMESPACE_INDEX);
      const request = index.openCursor();

      request.onerror = () => reject(requestFailure(request, "PCMS storage namespace scan failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value;
        if (record?.namespace === namespace) results.push(record);
        cursor.continue();
      };
      transaction.oncomplete = () => {
        results.sort((a, b) => a.key.localeCompare(b.key));
        resolve(results);
      };
      transaction.onabort = () => reject(transactionFailure(transaction, "PCMS storage namespace scan aborted"));
      transaction.onerror = () => {};
    });
  }


  function listAllRecords() {
    const active = currentDb();
    return new Promise((resolve, reject) => {
      const results = [];
      const transaction = active.transaction(PCMS_RECORD_STORE, "readonly");
      const store = transaction.objectStore(PCMS_RECORD_STORE);
      const request = store.openCursor();

      request.onerror = () => reject(requestFailure(request, "PCMS storage full snapshot scan failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        results.push(cursor.value);
        cursor.continue();
      };
      transaction.oncomplete = () => {
        results.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
        resolve(results);
      };
      transaction.onabort = () => reject(transactionFailure(transaction, "PCMS storage full snapshot scan aborted"));
      transaction.onerror = () => {};
    });
  }

  function replaceAllRecords(records) {
    const active = currentDb();
    return new Promise((resolve, reject) => {
      let operationError = null;
      const transaction = active.transaction(PCMS_RECORD_STORE, "readwrite");
      const store = transaction.objectStore(PCMS_RECORD_STORE);
      const clearRequest = store.clear();

      clearRequest.onerror = () => {
        operationError = requestFailure(clearRequest, "PCMS storage restore clear failed");
        try { transaction.abort(); } catch {}
      };
      clearRequest.onsuccess = () => {
        for (const record of records) {
          const putRequest = store.put({
            id: recordId(record.namespace, record.key),
            namespace: record.namespace,
            key: record.key,
            revision: record.revision,
            value: record.value,
            updatedAt: record.updatedAt
          });
          putRequest.onerror = () => {
            if (!operationError) operationError = requestFailure(putRequest, "PCMS storage restore write failed");
            try { transaction.abort(); } catch {}
          };
        }
      };
      transaction.oncomplete = () => resolve(Object.freeze({ replaced:records.length }));
      transaction.onabort = () => reject(transactionFailure(transaction, "PCMS storage restore transaction aborted", operationError));
      transaction.onerror = () => {};
    });
  }

  return Object.freeze({
    async open() { await open(); },
    close() {
      if (db) {
        try { db.close(); } catch {}
      }
      db = null;
      stale = false;
    },
    get: runRead,
    compareAndSwap(namespace, key, expectedRevision, value, updatedAt) {
      return runCas({ namespace, key, expectedRevision, value, deleted: false, updatedAt });
    },
    deleteCompareAndSwap(namespace, key, expectedRevision) {
      return runCas({ namespace, key, expectedRevision, deleted: true, updatedAt: null });
    },
    listNamespace,
    listAllRecords,
    replaceAllRecords
  });
}
