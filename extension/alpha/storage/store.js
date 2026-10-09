import { AlphaDataError, requireData, exact, revision, instant, canonical, arrayData } from '../domain/validation.js';
import { normalizeRecord, normalizeRecordKey, recordKey, assertRecordUpdate, RECORD_KINDS } from '../domain/records.js';
import { openAlphaDatabase, ALPHA_DB_VERSION, RECORDS, JOURNAL, META, JOURNAL_LIMIT } from './migrations.js';

const stores = [RECORDS, JOURNAL, META];
const address = (kind, key) => kind + '\u0000' + key;
const dataError = error => error instanceof AlphaDataError ? error : new AlphaDataError(error?.name === 'ConstraintError' ? 'CONFLICT' : 'UNAVAILABLE');

async function digest(value) {
  try {
    const bytes = new TextEncoder().encode(canonical(value));
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  } catch { throw new AlphaDataError('UNAVAILABLE'); }
}

function validateMeta(input) {
  const m = exact(input, ['id', 'schemaVersion', 'revision', 'journalLimit']);
  requireData(m.id === 'state' && m.schemaVersion === 1 && m.journalLimit === JOURNAL_LIMIT, 'RECOVERY_HOLD');
  revision(m.revision);
  return m;
}

async function verifyEnvelope(input, storeRevision) {
  if (input === undefined) return;
  try {
    const e = exact(input, ['id', 'schemaVersion', 'kind', 'key', 'revision', 'record', 'checksum'], ['accountPersonaUid']);
    requireData(e.schemaVersion === 1 && RECORD_KINDS.includes(e.kind));
    const record = normalizeRecord(e.kind, e.record);
    requireData(e.key === recordKey(e.kind, record) && e.id === address(e.kind, e.key));
    requireData(revision(e.revision, 1) <= storeRevision && canonical(record) === canonical(e.record));
    if (['account', 'generator'].includes(e.kind)) requireData(record.revision === e.revision);
    requireData(e.kind === 'account' ? e.accountPersonaUid === record.personaUid : !Object.hasOwn(e, 'accountPersonaUid'));
    const { checksum, ...payload } = e;
    requireData(typeof checksum === 'string' && /^[a-f0-9]{64}$/.test(checksum) && checksum === await digest(payload));
  } catch { throw new AlphaDataError('RECOVERY_HOLD'); }
}

async function verifyJournal(input) {
  try {
    const j = exact(input, ['revision', 'previousRevision', 'asOf', 'changes', 'checksum']);
    revision(j.revision, 1);
    requireData(j.previousRevision === j.revision - 1 && instant(j.asOf) === j.asOf);
    requireData(Array.isArray(j.changes) && j.changes.length > 0 && j.changes.length <= 64);
    const ids = new Set();
    for (const raw of j.changes) {
      const c = exact(raw, ['kind', 'key', 'previousRevision', 'revision', 'checksum']);
      normalizeRecordKey(c.kind, c.key);
      revision(c.previousRevision);
      requireData(c.revision === c.previousRevision + 1 && c.revision <= j.revision && typeof c.checksum === 'string' && /^[a-f0-9]{64}$/.test(c.checksum));
      const key = address(c.kind, c.key);
      requireData(!ids.has(key)); ids.add(key);
    }
    const { checksum, ...payload } = j;
    requireData(typeof checksum === 'string' && checksum === await digest(payload));
  } catch { throw new AlphaDataError('RECOVERY_HOLD'); }
}

// Only oncomplete acknowledges durability. A request succeeding can still roll back.
function transaction(db, mode, enqueue) {
  return new Promise((resolve, reject) => {
    let tx, preferred, result;
    try { tx = db.transaction(stores, mode); }
    catch { reject(new AlphaDataError('UNAVAILABLE')); return; }
    const abort = error => { preferred ||= dataError(error); try { tx.abort(); } catch { /* already aborted */ } };
    const watch = (request, done = () => {}) => {
      request.onerror = () => abort(request.error);
      request.onsuccess = () => { try { done(request.result); } catch (e) { abort(e); } };
    };
    tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
    tx.onabort = () => reject(preferred || dataError(tx.error));
    tx.onerror = () => {}; // IndexedDB's default action aborts the entire transaction.
    try { result = enqueue(tx, watch); } catch (e) { abort(e); }
  });
}

async function readSelection(db, ids, kind, all = false) {
  const state = await transaction(db, 'readonly', (tx, watch) => {
    const result = { meta: null, records: [], journal: [] };
    watch(tx.objectStore(META).get('state'), meta => {
      try { result.meta = validateMeta(meta); } catch { throw new AlphaDataError('RECOVERY_HOLD'); }
      if (!all && meta.revision > 0) watch(tx.objectStore(JOURNAL).get(meta.revision), j => {
        requireData(j !== undefined, 'RECOVERY_HOLD'); result.journal.push(j);
      });
    });
    const records = tx.objectStore(RECORDS);
    if (all) {
      watch(records.getAll(), rows => { result.records = rows; });
      watch(tx.objectStore(JOURNAL).getAll(), rows => { result.journal = rows; });
    } else if (kind) watch(records.index('byKind').getAll(kind), rows => { result.records = rows; });
    else for (const key of ids) watch(records.get(key), row => { if (row !== undefined) result.records.push(row); });
    return result;
  });
  const meta = state.meta;
  requireData(meta, 'RECOVERY_HOLD');
  await Promise.all(state.records.map(e => verifyEnvelope(e, meta.revision)));
  await Promise.all(state.journal.map(verifyJournal));
  if (all) {
    requireData(state.journal.length === Math.min(meta.revision, JOURNAL_LIMIT), 'RECOVERY_HOLD');
    const floor = Math.max(1, meta.revision - JOURNAL_LIMIT + 1);
    state.journal.forEach((j, i) => requireData(j.revision === floor + i, 'RECOVERY_HOLD'));
    requireData(meta.revision > 0 || state.records.length === 0, 'RECOVERY_HOLD');
  } else if (meta.revision) requireData(state.journal.length === 1 && state.journal[0].revision === meta.revision, 'RECOVERY_HOLD');
  return state;
}

/**
 * Background-only Alpha persistence. Nothing here executes browser/provider actions.
 * commit uses a store revision and per-record revisions; no physical deletion/ABA.
 * openDatabase injection is useful for faults against real IndexedDB in tests.
 */
export function createAlphaStorage({ openDatabase = openAlphaDatabase, clock = () => new Date().toISOString(), ...options } = {}) {
  let db = null, opening = null, lifecycle = 0;
  async function open() {
    if (db) return;
    if (opening) return opening;
    const token = lifecycle;
    const pending = (async () => {
      const connection = await openDatabase(options);
      connection.onversionchange = () => { lifecycle++; connection.close(); if (db === connection) db = null; };
      try {
        requireData(connection.version === ALPHA_DB_VERSION && connection.objectStoreNames.length === stores.length &&
          stores.every(s => connection.objectStoreNames.contains(s)), 'RECOVERY_HOLD');
        try {
          const schema = connection.transaction(stores);
          const recordStore = schema.objectStore(RECORDS);
          requireData(recordStore.keyPath === 'id' && recordStore.index('accountPersona').unique &&
            recordStore.index('accountPersona').keyPath === 'accountPersonaUid' && recordStore.index('byKind').keyPath === 'kind' &&
            canonical(recordStore.index('byAccount').keyPath) === canonical(['kind', 'record.accountId']) &&
            schema.objectStore(JOURNAL).keyPath === 'revision' && schema.objectStore(META).keyPath === 'id', 'RECOVERY_HOLD');
        } catch { throw new AlphaDataError('RECOVERY_HOLD'); }
        await readSelection(connection, [], null, true);
        requireData(lifecycle === token, 'UNAVAILABLE');
        db = connection;
      } catch (e) { connection.close(); throw dataError(e); }
    })();
    opening = pending;
    try { await pending; } finally { if (opening === pending) opening = null; }
  }
  function close() { lifecycle++; db?.close(); db = null; opening = null; }
  async function connection() { await open(); requireData(db, 'UNAVAILABLE'); return db; }
  const item = e => ({ revision: e.revision, record: structuredClone(e.record) });

  return Object.freeze({
    open, close,
    async read(kind, key) {
      const k = normalizeRecordKey(kind, key);
      const s = await readSelection(await connection(), [address(kind, k)]);
      return { revision: s.meta.revision, item: s.records.length ? item(s.records[0]) : null };
    },
    async list(kind) {
      requireData(RECORD_KINDS.includes(kind));
      const s = await readSelection(await connection(), [], kind);
      return { revision: s.meta.revision, items: s.records.map(item) };
    },
    async snapshot() {
      const s = await readSelection(await connection(), [], null, true);
      return { schemaVersion: 1, revision: s.meta.revision, records: structuredClone(s.records), journal: structuredClone(s.journal) };
    },
    async commit(input) {
      const batch = exact(input, ['expectedRevision', 'writes']);
      revision(batch.expectedRevision);
      requireData(batch.expectedRevision < Number.MAX_SAFE_INTEGER);
      const rawWrites = arrayData(batch.writes, 64); requireData(rawWrites.length > 0);
      // Normalize/copy everything before the first await; callers cannot change a queued write.
      const writes = rawWrites.map(raw => {
        const w = exact(raw, ['kind', 'expectedRevision', 'record']);
        revision(w.expectedRevision); requireData(w.expectedRevision < Number.MAX_SAFE_INTEGER);
        const record = normalizeRecord(w.kind, w.record), key = recordKey(w.kind, record);
        if (['account', 'generator'].includes(w.kind)) requireData(record.revision === w.expectedRevision, 'STALE_REVISION');
        return { kind: w.kind, key, expectedRevision: w.expectedRevision, record };
      });
      const writeIds = new Set(writes.map(w => address(w.kind, w.key)));
      requireData(writeIds.size === writes.length, 'CONFLICT');
      const ids = new Set(writeIds);
      for (const w of writes) if (w.kind === 'generator') ids.add(address('account', w.record.accountId));
      const active = await connection(), before = await readSelection(active, ids);
      requireData(before.meta.revision === batch.expectedRevision, 'STALE_REVISION', before.meta.revision);
      const existing = new Map(before.records.map(e => [e.id, e]));
      const projected = new Map(existing);
      const envelopes = [];
      for (const w of writes) {
        const previous = existing.get(address(w.kind, w.key));
        requireData((previous?.revision || 0) === w.expectedRevision, 'STALE_REVISION', previous?.revision || 0);
        assertRecordUpdate(w.kind, previous?.record, w.record);
        const record = ['account', 'generator'].includes(w.kind) ? { ...w.record, revision: w.expectedRevision + 1 } : w.record;
        const e = { id: address(w.kind, w.key), schemaVersion: 1, kind: w.kind, key: w.key,
          revision: w.expectedRevision + 1, record, ...(w.kind === 'account' ? { accountPersonaUid: record.personaUid } : {}) };
        const envelope = { ...e, checksum: await digest(e) };
        envelopes.push(envelope); projected.set(e.id, envelope);
      }
      for (const w of writes) if (w.kind === 'generator') {
        const account = projected.get(address('account', w.record.accountId))?.record;
        requireData(account && account.personaUid === w.record.personaUid && account.epoch === w.record.accountBindingEpoch, 'STALE_BINDING');
      }
      const nextRevision = batch.expectedRevision + 1;
      const event = { revision: nextRevision, previousRevision: batch.expectedRevision, asOf: instant(clock()),
        changes: envelopes.map(e => ({ kind: e.kind, key: e.key, previousRevision: e.revision - 1, revision: e.revision, checksum: e.checksum })) };
      const entry = { ...event, checksum: await digest(event) };
      await transaction(active, 'readwrite', (tx, watch) => {
        const current = new Map(); let meta, journal;
        let remaining = ids.size + 1;
        const ready = () => {
          if (--remaining !== 0) return;
          try { validateMeta(meta); } catch { throw new AlphaDataError('RECOVERY_HOLD'); }
          requireData(meta.revision === batch.expectedRevision, 'STALE_REVISION', meta.revision);
          // Recheck the exact verified bytes inside the write transaction. Hashing never
          // awaits inside IndexedDB's transaction lifetime, and raw corruption cannot race it.
          requireData(canonical(journal) === canonical(before.journal[0]), 'RECOVERY_HOLD');
          for (const key of ids) requireData(canonical(current.get(key)) === canonical(existing.get(key)), 'RECOVERY_HOLD');
          for (const e of envelopes) watch(tx.objectStore(RECORDS).put(e));
          watch(tx.objectStore(JOURNAL).add(entry));
          if (nextRevision > JOURNAL_LIMIT) watch(tx.objectStore(JOURNAL).delete(nextRevision - JOURNAL_LIMIT));
          watch(tx.objectStore(META).put({ ...meta, revision: nextRevision }));
        };
        watch(tx.objectStore(META).get('state'), value => {
          meta = value;
          if (value?.revision > 0) watch(tx.objectStore(JOURNAL).get(value.revision), j => { journal = j; ready(); });
          else ready();
        });
        for (const key of ids) watch(tx.objectStore(RECORDS).get(key), value => { current.set(key, value); ready(); });
      });
      return { revision: nextRevision, items: envelopes.map(item) };
    }
  });
}
