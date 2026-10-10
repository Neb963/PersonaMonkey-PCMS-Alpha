import test from 'node:test';
import assert from 'node:assert/strict';
import {createAttentionStore} from '../../../extension/alpha/features/attention/store.mjs';

function fakeIndexedDB() {
  const data = new Map();
  return {
    corrupt(name, value) { data.get(name).rows.set('state', value); },
    open(name, version) {
      const request = {};
      queueMicrotask(() => {
        let state = data.get(name), first = !state;
        if (!state) { state = {rows: new Map()}; data.set(name, state); }
        const db = {
          version, objectStoreNames: {length: 1, contains: name => name === 'inbox'}, close() {},
          createObjectStore(key) {assert.equal(key, 'inbox'); return {add(value, id) {state.rows.set(id, structuredClone(value));}};},
          transaction(key, mode) {
            assert.equal(key, 'inbox'); let pending = 0, aborted = false;
            const tx = {onabort: null, oncomplete: null, onerror: null,
              abort() {aborted = true; queueMicrotask(() => tx.onabort?.());},
              objectStore(name) {assert.equal(name, 'inbox'); return {
                get(id) {const q = {}; pending++; queueMicrotask(() => {
                  if (aborted) return;
                  q.result = structuredClone(state.rows.get(id)); q.onsuccess?.(); pending--;
                  queueMicrotask(() => {if (!pending && !aborted) tx.oncomplete?.();});
                }); return q;},
                put(value, id) {assert.equal(mode, 'readwrite'); pending++;
                  queueMicrotask(() => {if (aborted) return;
                    state.rows.set(id, structuredClone(value)); pending--;
                    queueMicrotask(() => {if (!pending && !aborted) tx.oncomplete?.();});});
                }
              };}
            }; return tx;
          }
        };
        request.result = db; if (first) request.onupgradeneeded?.(); request.onsuccess?.();
      }); return request;
    }
  };
}
const time = '2026-10-10T12:00:00.000Z';
const row = {id: 'attention:test', kind: 'SYSTEM_WARNING', accountId: 'acct-1', key: null,
  bindingEpoch: 1, occurrence: 'warning-1', taskId: null, state: 'OPEN', notice: 'DISPATCHING',
  revision: 1, createdAt: time, updatedAt: time};

test('AP404-02 IndexedDB survives restart with DISPATCHING dedup fence and strict CAS', async () => {
  const indexedDB = fakeIndexedDB(), databaseName = 'persona-monkey-pcms-alpha-attention-test-restart';
  let store = createAttentionStore({indexedDB, databaseName});
  assert.deepEqual(await store.read(), {schemaVersion: 1, revision: 0, items: []});
  await store.change(0, draft => {draft.items.push(structuredClone(row));});
  store.close(); store = createAttentionStore({indexedDB, databaseName});
  assert.deepEqual((await store.read()).items, [row]);
  await assert.rejects(store.change(0, draft => {draft.items.splice(0);}), e => e.code === 'STALE_REVISION');
  assert.equal((await store.read()).items[0].notice, 'DISPATCHING');
});

test('AP404-02 corrupt persistent state and asynchronous mutation both fail closed', async () => {
  const indexedDB = fakeIndexedDB(), databaseName = 'persona-monkey-pcms-alpha-attention-test-corrupt';
  const store = createAttentionStore({indexedDB, databaseName});
  await store.read();
  await assert.rejects(store.change(0, async () => {}), e => e.code === 'INVALID_REQUEST');
  assert.equal((await store.read()).revision, 0);
  indexedDB.corrupt(databaseName, {schemaVersion: 1, revision: 0, items: [{...row, rawCredential: 'forbidden'}]});
  await assert.rejects(store.read(), e => e.code === 'RECOVERY_HOLD');
  await assert.rejects(store.change(0, draft => {draft.items.splice(0);}), e => e.code === 'RECOVERY_HOLD');
});
