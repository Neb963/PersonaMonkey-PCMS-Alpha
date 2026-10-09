import assert from 'node:assert/strict';
import test from 'node:test';
import { createInventoryService, readInventoryFact, ignoreDriftForObservedRevision,
  adoptConfirmedSourceVersion } from '../../../extension/alpha/features/inventory/service.mjs';
import { createGeneratorIndex } from '../../../extension/alpha/features/inventory/index.mjs';
import { normalizeInventoryFact } from '../../../extension/alpha/features/inventory/facts.mjs';

const at = '2026-10-09T12:00:00.000Z';
const context = { accountId: 'account-a', personaUid: 'persona-a', epoch: 1,
  routeRevision: 1, capabilityRevision: 1 };
const account = { accountId: 'account-a', personaUid: 'persona-a', epoch: 1,
  name: 'Fixture', sessionState: 'VERIFIED', revision: 1, asOf: at };
const clone = value => structuredClone(value);
function setup(entries = [], { pageSize = 37 } = {}) {
  const resources = entries.map(clone), rows = new Map([['account\0account-a', clone(account)]]), factsRows = new Map();
  let rev = 1, failAt = -1, readCalls = 0, commitCalls = 0;
  const storage = {
    async read(kind, key) { const row = rows.get(`${kind}\0${key}`); return {
      revision: rev, item: row ? { revision: row.revision, record: clone(row) } : null }; },
    async list(kind) { return { revision: rev, items: [...rows.entries()].filter(([k]) => k.startsWith(`${kind}\0`))
      .map(([, row]) => ({ revision: row.revision, record: clone(row) })) }; },
    async commit({ expectedRevision, writes }) {
      assert.equal(expectedRevision, rev); assert.ok(writes.length <= 64); commitCalls++;
      for (const w of writes) {
        const previous = rows.get(`${w.kind}\0${w.record.key}`);
        assert.equal(w.expectedRevision, previous?.revision ?? 0);
      }
      for (const w of writes) rows.set(`${w.kind}\0${w.record.key}`, clone({ ...w.record,
        revision: w.expectedRevision + 1 }));
      return { revision: ++rev };
    }
  };
  const facts = {
    async get(key) { return clone(factsRows.get(key) ?? null); },
    async list() { return clone([...factsRows.values()]); },
    async putMany(items) {
      assert.ok(items.length <= 64);
      for (const v of items) {
        const old = factsRows.get(v.key);
        assert.equal(v.observationRevision, (old?.observationRevision ?? 0) + 1);
      }
      for (const v of items) factsRows.set(v.key, normalizeInventoryFact(v));
    },
    async compareAndPut(row, expectedRevision) {
      assert.equal(factsRows.get(row.key).observationRevision, expectedRevision);
      factsRows.set(row.key, normalizeInventoryFact(row));
    }
  };
  const provider = {
    async listGenerators({ cursor }) {
      readCalls++;
      if (readCalls === failAt) return { ok: false, error: { code: 'UNAVAILABLE' }, revision: 0 };
      const offset = cursor === undefined ? 0 : Number(cursor.slice(1));
      return { ok: true, revision: 7, result: { asOf: at,
        items: resources.slice(offset, offset + pageSize).map(v => ({ key: v.key, readback: {
          sourceRevision: v.version, listing: v.listing, ownership: 'CONFIRMED', asOf: at } })),
        cursor: offset + pageSize < resources.length ? `p${offset + pageSize}` : null } };
    },
    async observe({ targetKey }) {
      const v = resources.find(x => x.key === targetKey);
      return v ? { ok: true, result: { sourceRevision: v.version,
        ownership: 'CONFIRMED', listing: v.listing, asOf: at }, revision: 7 } :
        { ok: false, error: { code: 'OWNERSHIP_UNKNOWN' }, revision: 0 };
    }
  };
  const service = createInventoryService({ storage, provider, facts, clock: () => at });
  return { resources, storage, facts, provider, service,
    counters: () => ({ readCalls, commitCalls }), failAt: n => { failAt = n; },
    row: key => clone(rows.get(`generator\0${key}`)) };
}
const scan = w => w.service.observe({ accountId: 'account-a', accountBindingEpoch: 1,
  expectedRevision: 1, opId: 'inventory-scan', options: { context } });
const entry = (n, listing = 'UNLISTED') => ({ key: `g${String(n).padStart(4, '0')}`,
  listing, version: 'r1' });

test('AP204-01/02: >1k all-owned account pagination, indexed searching and bounded CAS batches', async () => {
  const world = setup(Array.from({ length: 1001 }, (_, i) => entry(i + 1, i % 3 ? 'UNLISTED' : 'PUBLIC')));
  const result = await scan(world);
  assert.equal(result.ok, true); assert.equal(result.result.count, 1001);
  assert.equal(world.counters().commitCalls, 16);
  assert.ok(world.counters().readCalls > 20);
  const keys = new Set(); let cursor, totalPages = 0;
  do {
    const page = await world.service.list({ limit: 41, ...(cursor ? { cursor } : {}) });
    assert.equal(page.ok, true); assert.ok(page.result.items.length <= 41);
    for (const value of page.result.items) {
      keys.add(value.key); assert.equal(value.fleetIntent, 'EXCLUDED');
      assert.equal(value.refreshState, 'INELIGIBLE');
    }
    cursor = page.result.cursor; totalPages++;
  } while (cursor);
  assert.equal(keys.size, 1001); assert.equal(totalPages, 25);
  const filter = await world.service.list({ key: 'g009', limit: 250 });
  assert.equal(filter.ok, true); assert.equal(filter.result.items.length, 10);
  const publicOnly = await world.service.list({ listingObserved: 'PUBLIC', limit: 250 });
  assert.equal(publicOnly.ok, true); assert.ok(publicOnly.result.items.every(g => g.listingObserved === 'PUBLIC'));
  assert.equal((await world.facts.get('g0002')).ownershipObserved, true);
  // The public recent feed is neither present nor called in the service dependencies.
  assert.equal(world.row('g0002').listingObserved, 'UNLISTED');
});

test('AP204-02: failure or duplicate on later account page does not infer absent generators or modify records', async () => {
  const w = setup(Array.from({ length: 102 }, (_, i) => entry(i + 1)), { pageSize: 9 });
  w.failAt(3); const failed = await scan(w);
  assert.equal(failed.ok, false); assert.equal((await w.storage.list('generator')).items.length, 0);
  const duplicate = setup([entry(1), entry(2), entry(1)], { pageSize: 2 });
  const result = await scan(duplicate);
  assert.equal(result.ok, false); assert.equal((await duplicate.storage.list('generator')).items.length, 0);
  const bad = setup([entry(1), { ...entry(2), key: 'UPPER' }]);
  assert.equal((await scan(bad)).ok, false);
  assert.equal((await bad.storage.list('generator')).items.length, 0);
});

test('AP204-03: listing and provider version are independent of fleet intent and expected GitHub source', async () => {
  const w = setup([entry(1, 'UNLISTED')]);
  assert.equal((await scan(w)).ok, true);
  let observed = await readInventoryFact(w.facts, 'g0001');
  assert.equal(observed.acceptedSourceRevision, 'r1');
  assert.equal(observed.drift, null);
  const current = await w.service.get({ key: 'g0001' });
  assert.equal((await w.service.setIntent({ key: 'g0001', accountId: 'account-a', opId: 'local-intent-1',
    accountBindingEpoch: 1, expectedRevision: current.result.revision, options: { fleetIntent: 'MANAGED' } })).ok, true);
  w.resources[0].version = 'r2'; w.resources[0].listing = 'PUBLIC';
  assert.equal((await scan(w)).ok, true);
  const drifted = (await w.service.inspectDrift({ key: 'g0001' })).result;
  assert.equal(drifted.fleetIntent, 'MANAGED'); assert.equal(drifted.listingObserved, 'PUBLIC');
  assert.equal(drifted.attentionRefs.length, 1);
  observed = await readInventoryFact(w.facts, 'g0001');
  assert.equal(observed.acceptedSourceRevision, 'r1');
  assert.equal(observed.providerSourceRevision, 'r2');
  assert.equal(observed.drift.observed, 'r2');
  const ignored = await ignoreDriftForObservedRevision(w.facts, { key: 'g0001',
    accountId: 'account-a', accountBindingEpoch: 1,
    expectedObservationRevision: observed.observationRevision, sourceRevision: 'r2', at });
  await assert.rejects(() => ignoreDriftForObservedRevision(w.facts, { key: 'g0001',
    accountId: 'account-a', accountBindingEpoch: 1,
    expectedObservationRevision: observed.observationRevision, sourceRevision: 'r2', at }));
  assert.equal(ignored.ignoredVersion, 'r2');
  assert.equal((await scan(w)).ok, true);
  assert.equal((await w.service.get({ key: 'g0001' })).result.attentionRefs.length, 0);
  w.resources[0].version = 'r3';
  assert.equal((await scan(w)).ok, true);
  assert.equal((await w.service.get({ key: 'g0001' })).result.attentionRefs.length, 1);
  const next = await readInventoryFact(w.facts, 'g0001');
  assert.equal(next.ignoredVersion, null);
  assert.equal(next.drift.observed, 'r3');
  await adoptConfirmedSourceVersion(w.facts, { key: 'g0001', accountId: 'account-a',
    accountBindingEpoch: 1, expectedObservationRevision: next.observationRevision,
    operation: { targetKey: 'g0001', phase: 'APPLIED', accountBindingEpoch: 1,
      remoteEvidence: { sourceRevision: 'r3' } }, at });
  assert.equal((await readInventoryFact(w.facts, 'g0001')).acceptedSourceRevision, 'r3');
});

test('AP204-03: stale binding, stale local CAS, conflicting account owner, and exact cursor revisions fail closed', async () => {
  const w = setup([entry(1), entry(2)]);
  assert.equal((await scan(w)).ok, true);
  const row = (await w.service.get({ key: 'g0001' })).result;
  const wrong = await w.service.setIntent({ key: 'g0001', accountId: 'account-a', opId: 'attempt-1',
    accountBindingEpoch: 2, expectedRevision: row.revision, options: { fleetIntent: 'MANAGED' } });
  assert.equal(wrong.ok, false); assert.equal(wrong.error.code, 'STALE_BINDING');
  const a = await w.service.list({ limit: 1 });
  assert.equal(a.ok, true); assert.ok(a.result.cursor);
  await w.service.setIntent({ key: 'g0001', accountId: 'account-a', opId: 'attempt-2',
    accountBindingEpoch: 1, expectedRevision: row.revision, options: { fleetIntent: 'MANAGED' } });
  assert.equal((await w.service.list({ limit: 1, cursor: a.result.cursor })).error.code, 'STALE_REVISION');
  const bad = await w.service.setIntent({ key: 'g0001', accountId: 'account-a', opId: 'attempt-3',
    accountBindingEpoch: 1, expectedRevision: row.revision, options: { fleetIntent: 'EXCLUDED' } });
  assert.equal(bad.ok, false); assert.equal(bad.error.code, 'STALE_REVISION');
  const collision = { ...row, accountId: 'another', personaUid: 'another', accountBindingEpoch: 1 };
  // Simulate a record already owned by another account, without changing P102 storage.
  const other = setup([entry(1)]);
  await other.storage.commit({ expectedRevision: 1, writes: [{ kind: 'generator', expectedRevision: 0, record: collision }] });
  assert.equal((await scan(other)).error.code, 'CONFLICT');
  assert.equal((await w.service.delete({ key: 'g0001' })).error.code, 'UNSUPPORTED_CAPABILITY');
});

test('AP204-01: prefix/bucket index has stable ordering and rejects malformed/mismatched cursors', () => {
  const rows = [entry(2), entry(1)].map(x => ({ ...x, accountId: 'a', fleetIntent: 'MANAGED', listingObserved: x.listing }));
  const index = createGeneratorIndex(rows, 5);
  const a = index.query({ limit: 1 });
  assert.equal(a.items[0].key, 'g0001'); assert.ok(a.cursor);
  assert.equal(index.query({ limit: 1, cursor: a.cursor }).items[0].key, 'g0002');
  assert.throws(() => index.query({ key: 'other', cursor: a.cursor }), { code: 'STALE_REVISION' });
  assert.throws(() => index.query({ cursor: 'bad' }), { code: 'INVALID_REQUEST' });
});
