/** P204-only durable observation ledger; GeneratorRecord ownership remains in P102. */
import { exact, id, instant, member, revision, text, requireData } from '../../domain/validation.js';
import { normalizeGeneratorKey } from '../../domain/records.js';

const DB = 'persona-monkey-alpha-inventory-facts-v1';
const STORE = 'facts';
const version = value => value === null ? null : text(value, 256);

export function normalizeInventoryFact(input) {
  const v = exact(input, ['key', 'accountId', 'personaUid', 'accountBindingEpoch',
    'providerSourceRevision', 'acceptedSourceRevision', 'listing', 'observedAt',
    'lastSeenAt', 'ownershipObserved', 'discoveryRevision', 'observationRevision',
    'ignoredVersion', 'drift']);
  const drift = v.drift === null ? null : exact(v.drift, ['id', 'expected', 'observed', 'firstSeenAt']);
  requireData(typeof v.ownershipObserved === 'boolean');
  return {
    key: normalizeGeneratorKey(v.key), accountId: id(v.accountId), personaUid: id(v.personaUid),
    accountBindingEpoch: revision(v.accountBindingEpoch, 1),
    providerSourceRevision: version(v.providerSourceRevision),
    acceptedSourceRevision: version(v.acceptedSourceRevision),
    listing: member(v.listing, ['PUBLIC', 'UNLISTED', 'UNKNOWN']),
    observedAt: instant(v.observedAt), lastSeenAt: instant(v.lastSeenAt),
    ownershipObserved: v.ownershipObserved, discoveryRevision: revision(v.discoveryRevision),
    observationRevision: revision(v.observationRevision, 1),
    ignoredVersion: version(v.ignoredVersion),
    drift: drift === null ? null : {
      id: id(drift.id), expected: version(drift.expected), observed: version(drift.observed),
      firstSeenAt: instant(drift.firstSeenAt)
    }
  };
}

/** All operations settle on tx completion, never on request success. */
export function createInventoryFactsStore({ indexedDB = globalThis.indexedDB, databaseName = DB } = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function' || typeof databaseName !== 'string' || !databaseName)
    throw new TypeError('IndexedDB is required for durable inventory observations');
  let connection;
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      let request;
      try { request = indexedDB.open(databaseName, 1); } catch { reject(new Error('RECOVERY_HOLD')); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onerror = () => reject(new Error('RECOVERY_HOLD'));
      request.onblocked = () => reject(new Error('RECOVERY_HOLD'));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    }).catch(error => { connection = null; throw error; });
    return connection;
  }
  async function transact(mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx, output, failed = false;
      try { tx = db.transaction(STORE, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
      catch { reject(new Error('RECOVERY_HOLD')); return; }
      const fail = () => { failed = true; try { tx.abort(); } catch {} };
      tx.onerror = fail;
      tx.onabort = () => reject(new Error('RECOVERY_HOLD'));
      tx.oncomplete = () => failed ? reject(new Error('RECOVERY_HOLD')) : resolve(output);
      try { run(tx.objectStore(STORE), value => { output = value; }, fail); }
      catch { fail(); }
    });
  }
  return Object.freeze({
    async get(key) {
      normalizeGeneratorKey(key);
      const row = await transact('readonly', (s, set, fail) => {
        const request = s.get(key);
        request.onsuccess = () => set(request.result ?? null);
        request.onerror = fail;
      });
      try { return row === null ? null : normalizeInventoryFact(row); }
      catch { throw new Error('RECOVERY_HOLD'); }
    },
    async list() {
      const rows = await transact('readonly', (s, set, fail) => {
        const request = s.getAll(); request.onsuccess = () => set(request.result);
        request.onerror = fail;
      });
      try { return rows.map(normalizeInventoryFact); }
      catch { throw new Error('RECOVERY_HOLD'); }
    },
    async putMany(input) {
      if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw new Error('INVALID_REQUEST');
      const rows = input.map(normalizeInventoryFact);
      if (new Set(rows.map(r => r.key)).size !== rows.length) throw new Error('CONFLICT');
      await transact('readwrite', (s, set, fail) => {
        for (const row of rows) {
          const get = s.get(row.key);
          get.onerror = fail;
          get.onsuccess = () => {
            const old = get.result;
            if (old && (old.observationRevision !== row.observationRevision - 1 ||
                old.accountId !== row.accountId || old.personaUid !== row.personaUid ||
                old.accountBindingEpoch !== row.accountBindingEpoch)) { fail(); return; }
            if (!old && row.observationRevision !== 1) { fail(); return; }
            const put = s.put(row); put.onerror = fail;
          };
        }
      });
    },
    async compareAndPut(input, expectedRevision) {
      const row = normalizeInventoryFact(input);
      revision(expectedRevision);
      if (row.observationRevision !== expectedRevision + 1) throw new Error('STALE_REVISION');
      await transact('readwrite', (s, set, fail) => {
        const get = s.get(row.key);
        get.onerror = fail;
        get.onsuccess = () => {
          if (!get.result || get.result.observationRevision !== expectedRevision ||
              get.result.accountId !== row.accountId ||
              get.result.personaUid !== row.personaUid ||
              get.result.accountBindingEpoch !== row.accountBindingEpoch) { fail(); return; }
          const put = s.put(row); put.onerror = fail;
        };
      });
    },
    close() { if (connection) connection.then(db => db.close()).catch(() => {}); connection = null; }
  });
}
