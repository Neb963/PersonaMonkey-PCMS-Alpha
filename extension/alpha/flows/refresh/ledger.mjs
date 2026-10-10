/** Durable atomic Refresher execution journal, not a replacement for P102 operations. */
const validTime = t => t === null || (Number.isSafeInteger(t) && t >= 0);
const validJob = job => job && typeof job === 'object' &&
  ['OBSERVE', 'BACKOFF', 'PREPARED', 'DISPATCHING', 'RELOADING', 'RECONCILE',
    'SUSPENDED', 'ON_TARGET'].includes(job.state) &&
  Number.isSafeInteger(job.attempts) && job.attempts >= 0 && job.attempts <= 3 &&
  validTime(job.lastAttemptAtMs) && validTime(job.nextAllowedAtMs) &&
  validTime(job.lastSavedAtMs) && Number.isSafeInteger(job.reloadForAttempt) &&
  job.reloadForAttempt >= 0 && job.reloadForAttempt <= 3;
export const emptyRefreshState = () => ({
  schemaVersion: 1, revision: 0, lastSaveAtMs: null, jobs: {}
});
export function validateRefreshState(state) {
  if (!state || state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !validTime(state.lastSaveAtMs) || !state.jobs || typeof state.jobs !== 'object' ||
    Array.isArray(state.jobs) || Object.keys(state.jobs).some(key =>
      !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(key) || !validJob(state.jobs[key])))
    throw Object.assign(new Error('RECOVERY_HOLD'), { code: 'RECOVERY_HOLD' });
  return state;
}
export function createRefreshLedger({ indexedDB = globalThis.indexedDB,
  databaseName = 'persona-monkey-alpha-refresh-execution-v1' } = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function' ||
    typeof databaseName !== 'string' || !databaseName)
    throw new TypeError('Durable IndexedDB required');
  let pending;
  async function connection() {
    if (!pending) pending = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(databaseName, 1); }
      catch { reject(new Error('RECOVERY_HOLD')); return; }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('state'))
          req.result.createObjectStore('state');
      };
      req.onerror = () => reject(new Error('RECOVERY_HOLD'));
      req.onblocked = () => reject(new Error('RECOVERY_HOLD'));
      req.onsuccess = () => {
        req.result.onversionchange = () => { req.result.close(); pending = null; };
        resolve(req.result);
      };
    }).catch(error => { pending = null; throw error; });
    return pending;
  }
  async function transact(mutator) {
    const db = await connection();
    return new Promise((resolve, reject) => {
      let tx, output, failure;
      try { tx = db.transaction('state', mutator ? 'readwrite' : 'readonly',
        mutator ? { durability: 'strict' } : undefined); }
      catch { reject(new Error('RECOVERY_HOLD')); return; }
      tx.onerror = () => { failure ||= new Error('RECOVERY_HOLD'); };
      tx.onabort = () => reject(failure ?? new Error('RECOVERY_HOLD'));
      tx.oncomplete = () => resolve(output);
      const store = tx.objectStore('state'), req = store.get('journal');
      req.onerror = () => { try { tx.abort(); } catch {} };
      req.onsuccess = () => {
        try {
          const prior = validateRefreshState(req.result ?? emptyRefreshState());
          const next = structuredClone(prior);
          if (!mutator) { output = next; return; }
          const changed = mutator(next);
          if (changed instanceof Promise) throw new Error('RECOVERY_HOLD');
          next.revision++;
          validateRefreshState(next);
          store.put(next, 'journal');
          output = structuredClone(next);
        } catch (error) {
          failure = error;
          try { tx.abort(); } catch {}
        }
      };
    });
  }
  return Object.freeze({
    read: () => transact(null),
    update: fn => {
      if (typeof fn !== 'function') throw new TypeError('Atomic update callback required');
      return transact(fn);
    },
    close() {
      if (pending) void pending.then(db => db.close()).catch(() => {});
      pending = null;
    }
  });
}
