import { exact, id, revision, instant, safeDetails, canonical, requireData, AlphaDataError } from '../domain/validation.js';

export const CORE_DB = 'persona-monkey-pcms-alpha-core';
export const OWNERS = Object.freeze(['core', 'accounts', 'inventory', 'sourceCatalog', 'reservation', 'deployer', 'aiReview', 'refresher', 'visibility', 'attention', 'backup']);
export const LIMITS = Object.freeze({ timers: 64, operations: 2, tabs: 4, pending: 64, ledger: 1024, pass: 16, passMs: 2000, handlerMs: 1000, continuationMs: 5000 });
const initial = () => ({ schemaVersion: 1, revision: 0, generation: 0, ownerId: 'unclaimed', timers: [], slots: [], lastPassAt: null, passCount: 0, recoveryReason: null });
const check = (condition) => requireData(condition, 'RECOVERY_HOLD');
export function validateControl(input) {
  const s = exact(input, ['schemaVersion', 'revision', 'generation', 'ownerId', 'timers', 'slots', 'lastPassAt', 'passCount', 'recoveryReason']);
  check(s.schemaVersion === 1); revision(s.revision); revision(s.generation); id(s.ownerId); revision(s.passCount);
  check(s.lastPassAt === null || instant(s.lastPassAt) === s.lastPassAt);
  check(s.recoveryReason === null || ['INTERRUPTED_TIMER', 'STORAGE_FAILURE', 'TAB_OWNERSHIP_UNKNOWN'].includes(s.recoveryReason));
  check(Array.isArray(s.timers) && s.timers.length <= LIMITS.timers && Array.isArray(s.slots) && s.slots.length <= LIMITS.pending);
  for (const t of s.timers) {
    exact(t, ['id', 'owner', 'generation', 'dueAt', 'intervalMs', 'mutating', 'phase', 'attempt', 'completedAt', 'receipt']);
    id(t.id); check(OWNERS.includes(t.owner)); revision(t.generation, 1); instant(t.dueAt); revision(t.attempt);
    check(t.intervalMs === null || (Number.isSafeInteger(t.intervalMs) && t.intervalMs >= 1000));
    check(typeof t.mutating === 'boolean' && ['SCHEDULED', 'RUNNING', 'COMPLETED', 'MISSED', 'HELD'].includes(t.phase));
    check(t.completedAt === null || instant(t.completedAt) === t.completedAt);
    check(t.receipt === null || (typeof t.receipt === 'object' && t.receipt !== null && !Array.isArray(t.receipt)));
  }
  for (const slot of s.slots) {
    exact(slot, ['id', 'owner', 'generation', 'coreGeneration', 'kind', 'opId', 'targetKey', 'accountId', 'personaUid', 'epoch', 'tabId', 'phase']);
    for (const key of ['id', 'opId', 'targetKey', 'accountId', 'personaUid']) id(slot[key]);
    check(OWNERS.includes(slot.owner)); revision(slot.generation, 1); revision(slot.coreGeneration, 1); revision(slot.epoch, 1);
    check(['operation', 'tab'].includes(slot.kind) && ['RESERVED', 'ACTIVE', 'HELD'].includes(slot.phase));
    check(slot.tabId === null || (Number.isSafeInteger(slot.tabId) && slot.tabId >= 0));
  }
  check(new Set(s.timers.map(t => t.id)).size === s.timers.length && new Set(s.slots.map(t => t.id)).size === s.slots.length);
  return safeDetails(s);
}
async function digest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}
const unavailable = () => new AlphaDataError('UNAVAILABLE');

/** Core-only state; P102 remains the authoritative domain/operation ledger.
 * Checksum and exact-byte CAS protect a strict-durability transaction. No await
 * occurs inside its lifetime, and request success is never a commit receipt. */
export function createControlStore({ indexedDB = globalThis.indexedDB, databaseName = CORE_DB } = {}) {
  requireData(databaseName === CORE_DB || /^persona-monkey-pcms-alpha-core-test-[a-z0-9-]+$/.test(databaseName));
  let connection = null, opening = null;
  async function open() {
    if (connection) return connection;
    if (!opening) opening = (async () => {
      const seed = initial(), checksum = await digest(seed);
      return new Promise((resolve, reject) => {
        let request, rejected = false;
        try { request = indexedDB.open(databaseName, 1); } catch { reject(unavailable()); return; }
        request.onblocked = () => { rejected = true; reject(unavailable()); };
        request.onupgradeneeded = () => {
          if (rejected) { request.transaction.abort(); return; }
          request.result.createObjectStore('control').add({ state: seed, checksum }, 'state');
        };
        request.onerror = () => reject(new AlphaDataError('RECOVERY_HOLD'));
        request.onsuccess = () => {
          if (rejected) { request.result.close(); return; }
          const db = request.result;
          if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('control')) { db.close(); reject(new AlphaDataError('RECOVERY_HOLD')); return; }
          db.onversionchange = () => { db.close(); connection = null; };
          connection = db; resolve(db);
        };
      });
    })().finally(() => { opening = null; });
    return opening;
  }
  async function transact(mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx, output, failure;
      const abort = error => { failure = error; try { tx.abort(); } catch {} };
      try { tx = db.transaction('control', mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); }
      catch { reject(unavailable()); return; }
      tx.onabort = () => reject(failure || unavailable());
      tx.onerror = () => {};
      tx.oncomplete = () => resolve(output);
      const request = tx.objectStore('control').get('state');
      request.onerror = () => abort(unavailable());
      request.onsuccess = () => { try { output = run(request.result, tx.objectStore('control')); } catch (e) { abort(e); } };
    });
  }
  async function envelope() {
    try {
      const e = await transact('readonly', value => value);
      exact(e, ['state', 'checksum']); const state = validateControl(e.state);
      check(e.checksum === await digest(state)); return e;
    } catch (e) {
      // Invalid on-disk fields are a recovery fault, never a caller-validation
      // error. Temporary I/O failure remains separately observable.
      throw e instanceof AlphaDataError && e.code === 'UNAVAILABLE' ? e : new AlphaDataError('RECOVERY_HOLD');
    }
  }
  return Object.freeze({
    async read() { return structuredClone((await envelope()).state); },
    async change(expected, update) {
      const before = await envelope(), next = structuredClone(before.state);
      if (expected) requireData(next.generation === expected.generation && next.ownerId === expected.ownerId, 'CONFLICT');
      const result = update(next); requireData(!(result && typeof result.then === 'function'));
      next.revision++; validateControl(next); const checksum = await digest(next);
      await transact('readwrite', (current, store) => {
        requireData(canonical(current) === canonical(before), 'STALE_REVISION');
        store.put({ state: next, checksum }, 'state');
      });
      return structuredClone(next);
    },
    close() { connection?.close(); connection = null; }
  });
}
