import { openPcmsDatabase } from "../storage/indexeddb-backend.js";
import { PCMS_NAMESPACE_INDEX, PCMS_RECORD_STORE } from "../storage/migrations.js";
import { AUDIT_ERROR_CODES, PcmsAuditError, auditError } from "./errors.js";
import {
  AUDIT_META_KEY,
  AUDIT_NAMESPACE,
  auditEventKey,
  createAuditEvent,
  parseAuditEventKey,
  validatePersistedAuditEvent
} from "./schema.js";

function asAuditError(error, code, message, options = {}) {
  if (error instanceof PcmsAuditError) return error;
  return auditError(code, message, { ...options, cause: error });
}

function recordId(namespace, key) {
  return namespace + "\u0000" + key;
}

function requestFailure(request, message) {
  return asAuditError(request?.error, AUDIT_ERROR_CODES.UNAVAILABLE, message);
}

function transactionFailure(transaction, message, preferredError) {
  if (preferredError) return preferredError;
  return asAuditError(transaction?.error, AUDIT_ERROR_CODES.UNAVAILABLE, message);
}

function parseMeta(record) {
  if (!record) return { lastSequence: 0, revision: 0 };
  if (
    record.namespace !== AUDIT_NAMESPACE ||
    record.key !== AUDIT_META_KEY ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    !record.value ||
    typeof record.value !== "object" ||
    !Number.isSafeInteger(record.value.lastSequence) ||
    record.value.lastSequence < 1 ||
    record.revision !== record.value.lastSequence
  ) {
    throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Audit journal metadata is corrupt");
  }
  return { lastSequence: record.value.lastSequence, revision: record.revision };
}

function makeMetaRecord(lastSequence, timestamp) {
  return {
    id: recordId(AUDIT_NAMESPACE, AUDIT_META_KEY),
    namespace: AUDIT_NAMESPACE,
    key: AUDIT_META_KEY,
    revision: lastSequence,
    value: { lastSequence },
    updatedAt: timestamp
  };
}

function makeEventRecord(event) {
  const key = auditEventKey(event.sequence);
  return {
    id: recordId(AUDIT_NAMESPACE, key),
    namespace: AUDIT_NAMESPACE,
    key,
    revision: 1,
    value: event,
    updatedAt: event.timestamp
  };
}

function attachMutationError(request, transaction, setError, message) {
  request.onerror = () => {
    setError(requestFailure(request, message));
    try { transaction.abort(); } catch {}
  };
}

export function createIndexedDbAuditBackend({ openDatabase = openPcmsDatabase, ...openOptions } = {}) {
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
    if (!db) throw auditError(AUDIT_ERROR_CODES.CLOSED, "Audit journal storage is not open");
    if (stale) throw auditError(AUDIT_ERROR_CODES.STALE_CONNECTION, "Audit journal storage connection is stale");
    return db;
  }

  function append({ draft, timestamp }) {
    const active = currentDb();
    return new Promise((resolve, reject) => {
      let result = null;
      let operationError = null;
      const transaction = active.transaction(PCMS_RECORD_STORE, "readwrite");
      const store = transaction.objectStore(PCMS_RECORD_STORE);
      const metaRequest = store.get(recordId(AUDIT_NAMESPACE, AUDIT_META_KEY));

      metaRequest.onerror = () => {
        operationError = requestFailure(metaRequest, "Audit journal metadata read failed");
        try { transaction.abort(); } catch {}
      };
      metaRequest.onsuccess = () => {
        let meta;
        try {
          meta = parseMeta(metaRequest.result || null);
          if (meta.lastSequence >= Number.MAX_SAFE_INTEGER) {
            throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Audit journal sequence is exhausted");
          }
          const event = createAuditEvent({ sequence: meta.lastSequence + 1, timestamp, draft });
          const eventRequest = store.add(makeEventRecord(event));
          const metadataRequest = store.put(makeMetaRecord(event.sequence, event.timestamp));
          attachMutationError(eventRequest, transaction, (error) => { operationError = error; }, "Audit journal append failed");
          attachMutationError(metadataRequest, transaction, (error) => { operationError = error; }, "Audit journal metadata write failed");
          result = event;
        } catch (error) {
          operationError = asAuditError(error, AUDIT_ERROR_CODES.CORRUPT, "Audit journal append preparation failed");
          try { transaction.abort(); } catch {}
        }
      };

      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transactionFailure(transaction, "Audit journal append transaction aborted", operationError));
      transaction.onerror = () => {};
    });
  }

  function transitionAndAppend({ transition, draft, timestamp }) {
    const active = currentDb();
    return new Promise((resolve, reject) => {
      let result = null;
      let operationError = null;
      let stateDone = false;
      let metaDone = false;
      let stateRecord = null;
      let metaRecord = null;
      let prepared = false;
      const transaction = active.transaction(PCMS_RECORD_STORE, "readwrite");
      const store = transaction.objectStore(PCMS_RECORD_STORE);
      const stateId = recordId(transition.namespace, transition.key);
      const stateRequest = store.get(stateId);
      const metaRequest = store.get(recordId(AUDIT_NAMESPACE, AUDIT_META_KEY));

      function fail(error) {
        if (!operationError) operationError = error;
        try { transaction.abort(); } catch {}
      }

      function prepare() {
        if (prepared || !stateDone || !metaDone || operationError) return;
        prepared = true;
        try {
          const currentRevision = stateRecord?.revision || 0;
          if (currentRevision !== transition.expectedRevision) {
            throw auditError(AUDIT_ERROR_CODES.CONFLICT, "PCMS state revision mismatch", { currentRevision });
          }
          const meta = parseMeta(metaRecord);
          if (meta.lastSequence >= Number.MAX_SAFE_INTEGER) {
            throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Audit journal sequence is exhausted");
          }

          const event = createAuditEvent({ sequence: meta.lastSequence + 1, timestamp, draft });
          const nextState = {
            id: stateId,
            namespace: transition.namespace,
            key: transition.key,
            revision: currentRevision + 1,
            value: transition.value,
            updatedAt: event.timestamp
          };
          const stateWrite = store.put(nextState);
          const eventWrite = store.add(makeEventRecord(event));
          const metaWrite = store.put(makeMetaRecord(event.sequence, event.timestamp));

          attachMutationError(stateWrite, transaction, fail, "PCMS state write failed during audited transition");
          attachMutationError(eventWrite, transaction, fail, "Audit journal append failed during state transition");
          attachMutationError(metaWrite, transaction, fail, "Audit journal metadata write failed during state transition");
          result = { state: nextState, event };
        } catch (error) {
          fail(asAuditError(error, AUDIT_ERROR_CODES.UNAVAILABLE, "Audited state transition preparation failed"));
        }
      }

      stateRequest.onerror = () => fail(requestFailure(stateRequest, "PCMS state read failed during audited transition"));
      stateRequest.onsuccess = () => {
        stateRecord = stateRequest.result || null;
        stateDone = true;
        prepare();
      };
      metaRequest.onerror = () => fail(requestFailure(metaRequest, "Audit journal metadata read failed during state transition"));
      metaRequest.onsuccess = () => {
        metaRecord = metaRequest.result || null;
        metaDone = true;
        prepare();
      };

      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transactionFailure(transaction, "Audited state transition aborted", operationError));
      transaction.onerror = () => {};
    });
  }

  function read({ afterSequence, limit }) {
    const active = currentDb();
    return new Promise((resolve, reject) => {
      let metaRecord = null;
      const eventRecords = [];
      const transaction = active.transaction(PCMS_RECORD_STORE, "readonly");
      const store = transaction.objectStore(PCMS_RECORD_STORE);
      const request = store.index(PCMS_NAMESPACE_INDEX).openCursor();

      request.onerror = () => reject(requestFailure(request, "Audit journal scan failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value;
        if (record?.namespace === AUDIT_NAMESPACE) {
          if (record.key === AUDIT_META_KEY) metaRecord = record;
          else if (typeof record.key === "string" && record.key.startsWith("event:")) eventRecords.push(record);
        }
        cursor.continue();
      };
      transaction.oncomplete = () => {
        try {
          const meta = parseMeta(metaRecord);
          const events = eventRecords.map((record) => {
            const keySequence = parseAuditEventKey(record.key);
            const event = validatePersistedAuditEvent(record.value);
            if (
              keySequence === null ||
              keySequence !== event.sequence ||
              record.revision !== 1 ||
              record.id !== recordId(AUDIT_NAMESPACE, record.key)
            ) {
              throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Audit journal event record is corrupt");
            }
            return event;
          }).sort((a, b) => a.sequence - b.sequence);

          if (events.length !== meta.lastSequence) {
            throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Audit journal sequence coverage is incomplete", { lastSequence: meta.lastSequence });
          }
          for (let index = 0; index < events.length; index += 1) {
            if (events[index].sequence !== index + 1) {
              throw auditError(AUDIT_ERROR_CODES.CORRUPT, "Audit journal contains a sequence gap", { lastSequence: meta.lastSequence });
            }
          }

          const remaining = events.filter((event) => event.sequence > afterSequence);
          const page = remaining.slice(0, limit);
          resolve({
            events: page,
            lastSequence: meta.lastSequence,
            hasMore: remaining.length > page.length
          });
        } catch (error) {
          reject(asAuditError(error, AUDIT_ERROR_CODES.CORRUPT, "Audit journal read validation failed"));
        }
      };
      transaction.onabort = () => reject(transactionFailure(transaction, "Audit journal read transaction aborted"));
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
    append,
    transitionAndAppend,
    read
  });
}
