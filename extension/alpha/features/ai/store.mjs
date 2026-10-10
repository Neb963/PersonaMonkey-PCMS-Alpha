/** P303's durable, bounded AI task ledger. Not a browser execution authority. */
export const AI_TASK_DB = 'persona-monkey-pcms-alpha-ai';
export const AI_STATES = Object.freeze(['READY', 'ACTIVE', 'WAITING_HUMAN', 'COMPLETED', 'FAILED', 'RECOVERING']);
const BUSY = new Set(['ACTIVE', 'WAITING_HUMAN', 'RECOVERING']);
const HEX = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const positive = x => Number.isSafeInteger(x) && x >= 0;
const validDate = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const validRef = x => typeof x === 'string' && IDENTIFIER.test(x);
const validHash = x => typeof x === 'string' && HEX.test(x);
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const ensure = (v, code = 'RECOVERY_HOLD') => { if (!v) fail(code); };
const fields = (v, required, optional = []) => isObject(v) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)) && required.every(k => Object.hasOwn(v,k));

export function validateAiTask(task) {
  ensure(fields(task, ['id','key','accountId','personaUid','bindingEpoch','revision','state','createdAt','updatedAt',
    'sourceHash','sourceRevision','savedSourceHash','savedSourceRevision','sessionId','opId','dispatchPhase',
    'provenanceRefs','approvalRevision','approvalOpId','reviewPending','failureCode']));
  ensure(validRef(task.id) && SLUG.test(task.key) && validRef(task.accountId) && validRef(task.personaUid) &&
    positive(task.bindingEpoch) && task.bindingEpoch > 0 && positive(task.revision) && task.revision > 0 &&
    AI_STATES.includes(task.state) && validDate(task.createdAt) && validDate(task.updatedAt));
  ensure(validHash(task.sourceHash) && typeof task.sourceRevision === 'string' && task.sourceRevision.length > 0 &&
    (task.savedSourceHash === null || validHash(task.savedSourceHash)) &&
    (task.savedSourceRevision === null || (typeof task.savedSourceRevision === 'string' && task.savedSourceRevision.length > 0)));
  ensure((task.sessionId === null || validRef(task.sessionId)) && validRef(task.opId) &&
    ['PREPARED','DISPATCHING','APPLIED','UNCERTAIN'].includes(task.dispatchPhase));
  ensure(Array.isArray(task.provenanceRefs) && task.provenanceRefs.length <= 128 &&
    task.provenanceRefs.every(validRef) && new Set(task.provenanceRefs).size === task.provenanceRefs.length);
  ensure((task.approvalRevision === null || (positive(task.approvalRevision) && task.approvalRevision > 0)) &&
    (task.approvalOpId === null || validRef(task.approvalOpId)) && typeof task.reviewPending === 'boolean' &&
    (task.failureCode === null || validRef(task.failureCode)));
  ensure((task.approvalRevision === null) === (task.approvalOpId === null));
  ensure(task.state !== 'COMPLETED' || (task.savedSourceHash !== null && task.savedSourceRevision !== null &&
    task.dispatchPhase === 'APPLIED'));
  ensure(task.reviewPending === (task.state === 'COMPLETED' && task.approvalRevision === null));
  ensure(task.approvalRevision === null || (task.state === 'COMPLETED' && task.approvalRevision <= task.revision));
  return task;
}

export function validateAiLedger(state) {
  ensure(fields(state,['schemaVersion','revision','tasks']) && state.schemaVersion === 1 && positive(state.revision) &&
    Array.isArray(state.tasks) && state.tasks.length <= 10000);
  const ids = new Set(), ops = new Set();
  for (const task of state.tasks) {
    validateAiTask(task);
    ensure(!ids.has(task.id) && !ops.has(task.opId));
    ids.add(task.id); ops.add(task.opId);
  }
  return state;
}

/** Exactly the states occupying an AI session slot; human approval is NOT busy. */
export function countAiSlots(tasks, accountId) {
  return tasks.filter(t => t.accountId === accountId && BUSY.has(t.state)).length;
}

/** Single-state-row strict transaction; no await occurs between read and put.
 * `change` is a synchronous pure updater fenced by durable revision. */
export function createAiTaskStore({ indexedDB = globalThis.indexedDB, databaseName = AI_TASK_DB } = {}) {
  ensure(indexedDB && typeof indexedDB.open === 'function', 'UNAVAILABLE');
  ensure(databaseName === AI_TASK_DB || /^persona-monkey-pcms-alpha-ai-test-[a-z0-9-]+$/.test(databaseName), 'INVALID_REQUEST');
  let db = null, opening = null;
  async function connect() {
    if (db) return db;
    if (!opening) opening = new Promise((resolve, reject) => {
      let request, finished = false;
      try { request = indexedDB.open(databaseName, 1); } catch { reject(Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'})); return; }
      request.onblocked = () => { finished = true; reject(Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'})); };
      request.onupgradeneeded = () => {
        if (finished) { request.transaction.abort(); return; }
        request.result.createObjectStore('ledger').add({schemaVersion:1,revision:0,tasks:[]}, 'state');
      };
      request.onerror = () => reject(Object.assign(new Error('RECOVERY_HOLD'),{code:'RECOVERY_HOLD'}));
      request.onsuccess = () => {
        if (finished) { request.result.close(); return; }
        const connection = request.result;
        if (connection.version !== 1 || connection.objectStoreNames.length !== 1 ||
          !connection.objectStoreNames.contains('ledger')) { connection.close(); reject(Object.assign(new Error('RECOVERY_HOLD'),{code:'RECOVERY_HOLD'})); return; }
        connection.onversionchange = () => { connection.close(); db = null; };
        db = connection; resolve(connection);
      };
    }).finally(() => { opening = null; });
    return opening;
  }
  async function transaction(mode, updater, expectedRevision) {
    const connection = await connect();
    return new Promise((resolve,reject) => {
      let tx, output, error;
      try { tx = connection.transaction('ledger',mode,mode === 'readwrite' ? {durability:'strict'} : undefined); }
      catch { reject(Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'})); return; }
      const abort = cause => { error = cause; try { tx.abort(); } catch {} };
      tx.onabort = () => reject(error || Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'}));
      tx.oncomplete = () => resolve(output);
      tx.onerror = () => {};
      const get = tx.objectStore('ledger').get('state');
      get.onerror = () => abort(Object.assign(new Error('UNAVAILABLE'),{code:'UNAVAILABLE'}));
      get.onsuccess = () => {
        try {
          const current = structuredClone(validateAiLedger(get.result));
          if (mode === 'readonly') { output = current; return; }
          ensure(current.revision === expectedRevision, 'STALE_REVISION');
          const draft = structuredClone(current), changed = updater(draft);
          ensure(!(changed && typeof changed.then === 'function'), 'INVALID_REQUEST');
          ensure(draft.schemaVersion === 1 && draft.revision === expectedRevision, 'INVALID_REQUEST');
          draft.revision++;
          validateAiLedger(draft);
          output = structuredClone(draft);
          tx.objectStore('ledger').put(draft, 'state');
        } catch (e) { abort(e?.code ? e : Object.assign(new Error('RECOVERY_HOLD'),{code:'RECOVERY_HOLD'})); }
      };
    });
  }
  return Object.freeze({
    read: () => transaction('readonly'),
    change: (revision, update) => { ensure(positive(revision) && typeof update === 'function', 'INVALID_REQUEST'); return transaction('readwrite',update,revision); },
    close() { db?.close(); db = null; }
  });
}
