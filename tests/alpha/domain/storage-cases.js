import { createAlphaStorage } from '../../../extension/alpha/storage/store.js';
import { openAlphaDatabase, ALPHA_MIGRATIONS, RECORDS, JOURNAL, META, JOURNAL_LIMIT } from '../../../extension/alpha/storage/migrations.js';
import { account, generator, release, operation, write, WHEN } from './fixtures.js';

function assert(value) { if (!value) throw new Error('P102 storage assertion failed'); }
async function rejects(fn, code) {
  let error;
  try { await fn(); } catch (e) { error = e; }
  assert(error?.code === code);
}
function rawOpen(name, version = 1, upgrade) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = () => upgrade?.(r.result, r.transaction);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function rawTransaction(db, store, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode); let result;
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error);
    const request = action(tx.objectStore(store));
    if (request) request.onsuccess = () => { result = request.result; };
  });
}
const nameFor = suffix => 'persona-monkey-pcms-alpha-test-' + suffix;
const storage = suffix => createAlphaStorage({ dbName: nameFor(suffix), clock: () => WHEN });

export async function runStorageCases() {
  const passed = [];
  const check = async (name, run) => { await run(); passed.push(name); };

  await check('AP102-01: isolated schema never opens or imports legacy PCMS', async () => {
    const legacy = await rawOpen('persona-monkey-pcms', 17, db => db.createObjectStore('historical'));
    await rawTransaction(legacy, 'historical', 'readwrite', s => s.put({ marker: 'historical-only' }, 'sentinel'));
    const alpha = createAlphaStorage({ clock: () => WHEN });
    await alpha.open(); assert((await alpha.snapshot()).records.length === 0); alpha.close();
    assert(legacy.version === 17 && (await rawTransaction(legacy, 'historical', 'readonly', s => s.get('sentinel'))).marker === 'historical-only');
    await rejects(() => openAlphaDatabase({ dbName: 'persona-monkey-pcms' }), 'INVALID_REQUEST'); legacy.close();
  });

  await check('AP102-01: four records and journal commit with strict durability and detached exact source bytes', async () => {
    let db;
    const s = createAlphaStorage({ dbName: nameFor('four-records'), clock: () => WHEN,
      openDatabase: async options => (db = await openAlphaDatabase(options)) });
    await s.open(); const original = db.transaction.bind(db);
    db.transaction = (...args) => {
      const tx = original(...args);
      if (args[1] === 'readwrite') assert(args[2]?.durability === 'strict' && tx.durability === 'strict');
      return tx;
    };
    const a = account(); const r = release();
    const pending = s.commit({ expectedRevision: 0, writes: [write('generator', generator()), write('account', a), write('release', r), write('operation', operation())] });
    a.name = 'Changed by caller'; r.files.thumbnail[0] = 0;
    const result = await pending;
    assert(result.revision === 1 && result.items.length === 4);
    const saved = await s.read('account', 'account-one'); assert(saved.item.record.name === 'Synthetic account' && saved.item.record.revision === 1);
    const snapshot = await s.snapshot(); assert(snapshot.records.length === 4 && snapshot.journal.length === 1 && snapshot.journal[0].changes.length === 4);
    const image = await s.read('release', release().releaseId); assert(image.item.record.files.thumbnail[0] === 255);
    image.item.record.files.thumbnail[0] = 0;
    assert((await s.read('release', release().releaseId)).item.record.files.thumbnail[0] === 255); s.close();
  });

  await check('AP102-02: independent connections race on CAS; exactly one wins', async () => {
    const one = storage('cas-race'), two = storage('cas-race'); await Promise.all([one.open(), two.open()]);
    const results = await Promise.allSettled([
      one.commit({ expectedRevision: 0, writes: [write('account', account({ name: 'First candidate' }))] }),
      two.commit({ expectedRevision: 0, writes: [write('account', account({ name: 'Second candidate' }))] })
    ]);
    assert(results.filter(r => r.status === 'fulfilled').length === 1);
    assert(results.find(r => r.status === 'rejected').reason.code === 'STALE_REVISION');
    const snap = await one.snapshot(); assert(snap.revision === 1 && snap.journal.length === 1 && snap.records[0].revision === 1);
    one.close(); two.close();
  });

  await check('AP102-02: store and record revisions fence stale workers independently', async () => {
    const s = storage('revisions');
    await s.commit({ expectedRevision: 0, writes: [write('account', account())] });
    await s.commit({ expectedRevision: 1, writes: [write('operation', operation())] });
    await rejects(() => s.commit({ expectedRevision: 1, writes: [write('account', account({ revision: 1 }))] }), 'STALE_REVISION');
    await rejects(() => s.commit({ expectedRevision: 2, writes: [write('account', account())] }), 'STALE_REVISION');
    assert((await s.snapshot()).revision === 2); s.close();
  });

  await check('AP102-02: unique dedicated Persona and binding epoch reject collisions without partial writes', async () => {
    const s = storage('bindings');
    await s.commit({ expectedRevision: 0, writes: [write('account', account()), write('generator', generator())] });
    await rejects(() => s.commit({ expectedRevision: 1, writes: [write('account', account({ accountId: 'account-two' }))] }), 'CONFLICT');
    await rejects(() => s.commit({ expectedRevision: 1, writes: [write('generator', generator({ revision: 1, accountBindingEpoch: 2 }))] }), 'STALE_BINDING');
    await s.commit({ expectedRevision: 1, writes: [write('account', account({ revision: 1, personaUid: 'persona-two', epoch: 2 })),
      write('generator', generator({ revision: 1, personaUid: 'persona-two', accountBindingEpoch: 2 }))] });
    await rejects(() => s.commit({ expectedRevision: 2, writes: [write('generator', generator({ revision: 2 }))] }), 'STALE_BINDING');
    assert((await s.snapshot()).records.length === 2); s.close();
  });

  await check('AP102-02: immutable operation identity, uncertain reconciliation and terminal records', async () => {
    const s = storage('operations'); const commit = (expectedRevision, phase, extra = {}) =>
      s.commit({ expectedRevision, writes: [write('operation', operation({ phase, ...extra }), expectedRevision)] });
    await commit(0, 'PREPARED'); await commit(1, 'DISPATCHING'); await commit(2, 'UNCERTAIN');
    await rejects(() => commit(3, 'DISPATCHING'), 'CONFLICT');
    await rejects(() => commit(3, 'APPLIED'), 'CONFLICT');
    await rejects(() => commit(3, 'HELD', { sourceRevision: 'other-revision' }), 'CONFLICT');
    await commit(3, 'APPLIED', { remoteEvidence: { observedRevision: 'verified-revision', ownership: 'CONFIRMED' } });
    await rejects(() => commit(4, 'FAILED'), 'CONFLICT');
    s.close(); const reopened = storage('operations');
    assert((await reopened.read('operation', 'operation-one')).item.record.phase === 'APPLIED'); reopened.close();
  });

  await check('AP102-01: releases are immutable and preserve line endings and thumbnail bytes on reopen', async () => {
    const s = storage('release'); await s.commit({ expectedRevision: 0, writes: [write('release', release())] });
    const changed = release(); changed.files.html = 'changed';
    await rejects(() => s.commit({ expectedRevision: 1, writes: [write('release', changed, 1)] }), 'CONFLICT');
    s.close(); const reopened = storage('release'); const r = (await reopened.read('release', release().releaseId)).item.record;
    assert(r.files.pjs === release().files.pjs && r.files.html === release().files.html && r.files.thumbnail[0] === 255); reopened.close();
  });

  for (const afterSuccess of [false, true]) await check('AP102-02: transaction abort ' + (afterSuccess ? 'after successful journal request' : 'after record writes are queued') + ' rolls back everything', async () => {
    let db;
    const s = createAlphaStorage({ dbName: nameFor(afterSuccess ? 'abort-success' : 'abort-queued'), clock: () => WHEN,
      openDatabase: async opts => (db = await openAlphaDatabase(opts)) });
    await s.open(); const original = db.transaction.bind(db);
    db.transaction = (...args) => {
      const tx = original(...args);
      if (args[1] === 'readwrite') {
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = name => {
          const store = objectStore(name);
          if (name === JOURNAL) {
            const add = store.add.bind(store);
            store.add = (...params) => {
              if (!afterSuccess) throw new DOMException('Synthetic quota fault', 'QuotaExceededError');
              const request = add(...params); request.addEventListener('success', () => tx.abort(), { once: true }); return request;
            };
          }
          return store;
        };
      }
      return tx;
    };
    await rejects(() => s.commit({ expectedRevision: 0, writes: [write('account', account()), write('generator', generator())] }), 'UNAVAILABLE');
    db.transaction = original;
    const snapshot = await s.snapshot(); assert(snapshot.revision === 0 && snapshot.records.length === 0 && snapshot.journal.length === 0); s.close();
  });

  await check('AP102-02: an interrupted migration rolls back schema and data, then reopens v1', async () => {
    const s = storage('migration'); await s.commit({ expectedRevision: 0, writes: [write('account', account())] }); s.close();
    const migrations = [...ALPHA_MIGRATIONS, { version: 2, apply({ db, transaction }) {
      db.createObjectStore('interrupted-upgrade'); transaction.objectStore(META).put({ id: 'state', revision: 99 }); throw new Error('Synthetic migration failure');
    } }];
    await rejects(() => openAlphaDatabase({ dbName: nameFor('migration'), version: 2, migrations }), 'RECOVERY_HOLD');
    const reopened = storage('migration'); assert((await reopened.read('account', 'account-one')).item.record.name === 'Synthetic account');
    assert((await reopened.snapshot()).revision === 1); reopened.close();
    const db = await rawOpen(nameFor('migration')); assert(!db.objectStoreNames.contains('interrupted-upgrade')); db.close();
  });

  await check('AP102-02: asynchronous migrations abort and preserve the original version', async () => {
    const s = storage('async-migration'); await s.open(); s.close();
    await rejects(() => openAlphaDatabase({ dbName: nameFor('async-migration'), version: 2,
      migrations: [...ALPHA_MIGRATIONS, { version: 2, apply: () => Promise.resolve() }] }), 'RECOVERY_HOLD');
    const db = await rawOpen(nameFor('async-migration')); assert(db.version === 1); db.close();
  });

  await check('AP102-02: blocked upgrade cannot migrate later after its caller was rejected', async () => {
    const s = storage('blocked'); await s.open(); s.close();
    const held = await rawOpen(nameFor('blocked')); held.onversionchange = () => {};
    let applied = false, finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const factory = { open(...args) { const request = indexedDB.open(...args); request.addEventListener('error', finish, { once: true }); return request; } };
    await rejects(() => openAlphaDatabase({ indexedDB: factory, dbName: nameFor('blocked'), version: 2,
      migrations: [...ALPHA_MIGRATIONS, { version: 2, apply() { applied = true; } }] }), 'UNAVAILABLE');
    held.close(); await finished; assert(!applied);
    const db = await rawOpen(nameFor('blocked')); assert(db.version === 1); db.close();
  });

  await check('AP102-02: versionchange closes stale connections and a future schema is held', async () => {
    const s = storage('future'); await s.open();
    const db = await openAlphaDatabase({ dbName: nameFor('future'), version: 2,
      migrations: [...ALPHA_MIGRATIONS, { version: 2, apply({ db }) { db.createObjectStore('future-only'); } }] });
    db.close(); await rejects(() => s.read('account', 'account-one'), 'RECOVERY_HOLD'); s.close();
  });

  await check('AP102-02: malformed existing schema enters hold without creating missing indexes', async () => {
    const db = await rawOpen(nameFor('malformed-schema'), 1, db => {
      db.createObjectStore(RECORDS, { keyPath: 'id' });
      db.createObjectStore(JOURNAL, { keyPath: 'revision' });
      db.createObjectStore(META, { keyPath: 'id' });
    }); db.close();
    const s = storage('malformed-schema'); await rejects(() => s.open(), 'RECOVERY_HOLD');
    const raw = await rawOpen(nameFor('malformed-schema'));
    assert(raw.transaction(RECORDS).objectStore(RECORDS).indexNames.length === 0); raw.close();
  });

  await check('AP102-02: close during pending open cannot resurrect a connection', async () => {
    let releaseOpen; const gate = new Promise(resolve => { releaseOpen = resolve; });
    const s = createAlphaStorage({ dbName: nameFor('pending-open'), openDatabase: async options => {
      const db = await openAlphaDatabase(options); await gate; return db;
    } });
    const pending = s.open(); const rejection = rejects(() => pending, 'UNAVAILABLE'); s.close(); releaseOpen(); await rejection;
    const reopened = storage('pending-open'); await reopened.open(); reopened.close();
  });

  await check('AP102-02: valid-shaped record corruption triggers hold and never resets stored data', async () => {
    const s = storage('corruption'); await s.commit({ expectedRevision: 0, writes: [write('account', account())] });
    const db = await rawOpen(nameFor('corruption'));
    const row = await rawTransaction(db, RECORDS, 'readonly', store => store.get('account\u0000account-one'));
    row.record.name = 'Synthetic corrupted value';
    await rawTransaction(db, RECORDS, 'readwrite', store => store.put(row));
    await rejects(() => s.read('account', 'account-one'), 'RECOVERY_HOLD'); s.close();
    const reopened = storage('corruption'); await rejects(() => reopened.open(), 'RECOVERY_HOLD');
    assert((await rawTransaction(db, RECORDS, 'readonly', store => store.get(row.id))).record.name === 'Synthetic corrupted value'); db.close();
  });

  await check('AP102-02: journal corruption and missing metadata fail closed on reopen', async () => {
    for (const target of [JOURNAL, META]) {
      const suffix = 'corrupt-' + target; const s = storage(suffix);
      await s.commit({ expectedRevision: 0, writes: [write('account', account())] }); s.close();
      const db = await rawOpen(nameFor(suffix));
      if (target === META) await rawTransaction(db, META, 'readwrite', store => store.delete('state'));
      else {
        const row = await rawTransaction(db, JOURNAL, 'readonly', store => store.get(1)); row.changes[0].revision = 99;
        await rawTransaction(db, JOURNAL, 'readwrite', store => store.put(row));
      }
      db.close(); const reopened = storage(suffix); await rejects(() => reopened.open(), 'RECOVERY_HOLD');
    }
  });

  await check('AP102-03: rejected credentials, duplicate writes and revision overflow leave no journal entries', async () => {
    const s = storage('rejected-inputs');
    await rejects(() => s.commit({ expectedRevision: 0, writes: [write('operation', operation({ result: { authorization: 'not-a-credential' } }))] }), 'INVALID_REQUEST');
    await rejects(() => s.commit({ expectedRevision: 0, writes: [write('account', account()), write('account', account())] }), 'CONFLICT');
    await rejects(() => s.commit({ expectedRevision: Number.MAX_SAFE_INTEGER, writes: [write('account', account())] }), 'INVALID_REQUEST');
    const snapshot = await s.snapshot(); assert(snapshot.records.length === 0 && snapshot.journal.length === 0); s.close();
  });

  await check('AP102-02: journal retention is bounded and revisions never reset after compaction', async () => {
    const s = storage('retention');
    for (let i = 0; i < JOURNAL_LIMIT + 3; i++)
      await s.commit({ expectedRevision: i, writes: [write('account', account({ revision: i, name: 'Synthetic ' + i }))] });
    s.close(); const reopened = storage('retention'), snapshot = await reopened.snapshot();
    assert(snapshot.revision === JOURNAL_LIMIT + 3 && snapshot.journal.length === JOURNAL_LIMIT && snapshot.journal[0].revision === 4);
    assert(snapshot.records[0].revision === JOURNAL_LIMIT + 3); reopened.close();
  });

  const durable = storage('browser-restart');
  await durable.commit({ expectedRevision: 0, writes: [write('account', account()), write('generator', generator()), write('release', release()), write('operation', operation())] });
  await durable.commit({ expectedRevision: 1, writes: [write('operation', operation({ phase: 'DISPATCHING' }), 1)] }); durable.close();
  return { passed: true, cases: passed, count: passed.length, providerLive: false };
}

export async function verifyAfterBrowserRestart() {
  const s = storage('browser-restart'); const snapshot = await s.snapshot();
  assert(snapshot.revision === 2 && snapshot.records.length === 4 && snapshot.journal.length === 2);
  assert((await s.read('operation', 'operation-one')).item.record.phase === 'DISPATCHING');
  assert((await s.read('generator', 'generator-one')).item.record.accountBindingEpoch === 1);
  assert((await s.read('release', release().releaseId)).item.record.files.pjs === release().files.pjs); s.close();
  return { passed: true, cases: ['AP102-02: four records, revisions and unresolved operation survive actual Firefox process restart'], count: 1, providerLive: false };
}
