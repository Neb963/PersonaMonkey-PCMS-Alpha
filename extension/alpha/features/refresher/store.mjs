/** Strictly durable, single-record Refresher ledger. Independent of P102's frozen schema. */
import { initialState, assertState, check, invalid } from './model.mjs';

export function createRefresherStore({ indexedDB = globalThis.indexedDB,
  databaseName = 'persona-monkey-alpha-refresher-v1' } = {}) {
  check(indexedDB && typeof indexedDB.open === 'function' && typeof databaseName === 'string' && databaseName.length > 0);
  let opened = null;
  async function connection() {
    if (!opened) opened = new Promise((resolve, reject) => {
      let request;
      try { request = indexedDB.open(databaseName, 1); } catch { reject(new Error('UNAVAILABLE')); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('ledger'))
          request.result.createObjectStore('ledger', { keyPath: 'id' });
      };
      request.onerror = () => reject(new Error('UNAVAILABLE'));
      request.onblocked = () => reject(new Error('RECOVERY_HOLD'));
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); opened = null; };
        resolve(request.result);
      };
    }).catch(e => { opened = null; throw e; });
    return opened;
  }
  async function transact(expectedRevision, mutate) {
    check(expectedRevision === null || (Number.isSafeInteger(expectedRevision) && expectedRevision >= 0));
    check(typeof mutate === 'function');
    const db = await connection();
    return new Promise((resolve, reject) => {
      let tx, outcome, fault;
      try { tx = db.transaction('ledger', 'readwrite', { durability: 'strict' }); }
      catch { reject(new Error('UNAVAILABLE')); return; }
      const abort = e => { fault ||= e; try { tx.abort(); } catch {} };
      tx.onerror = () => abort(new Error('UNAVAILABLE'));
      tx.onabort = () => reject(fault ?? new Error('UNAVAILABLE'));
      tx.oncomplete = () => resolve(outcome);
      const req = tx.objectStore('ledger').get('state');
      req.onerror = () => abort(new Error('UNAVAILABLE'));
      req.onsuccess = () => {
        try {
          const prior = assertState(req.result ? req.result.value : initialState());
          if (expectedRevision !== null && prior.revision !== expectedRevision) invalid('STALE_REVISION');
          const next = structuredClone(prior);
          const result = mutate(next);
          check(!(result instanceof Promise), 'INVALID_REQUEST');
          next.revision++;
          assertState(next);
          tx.objectStore('ledger').put({ id: 'state', value: next });
          outcome = { revision: next.revision, value: structuredClone(next), result: structuredClone(result) };
        } catch (e) { abort(e); }
      };
    });
  }
  async function read() {
    const db = await connection();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction('ledger', 'readonly'); }
      catch { reject(new Error('UNAVAILABLE')); return; }
      const req = tx.objectStore('ledger').get('state');
      let state;
      req.onerror = () => reject(new Error('UNAVAILABLE'));
      req.onsuccess = () => {
        try { state = structuredClone(assertState(req.result ? req.result.value : initialState())); }
        catch { reject(new Error('RECOVERY_HOLD')); try { tx.abort(); } catch {} }
      };
      tx.oncomplete = () => resolve(state);
      tx.onabort = () => reject(new Error('RECOVERY_HOLD'));
      tx.onerror = () => reject(new Error('UNAVAILABLE'));
    });
  }
  function close() { if (opened) void opened.then(db => db.close()).catch(() => {}); opened = null; }
  return Object.freeze({ read, transact, close });
}
