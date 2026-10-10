import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalReleaseId } from '../../../extension/alpha/features/sources/catalog.mjs';
import { createDeployerService } from '../../../extension/alpha/features/deployer/service.mjs';
import { createDeployerJournal } from '../../../extension/alpha/features/deployer/journal.mjs';
import { createPerchanceAdapter } from '../../../extension/alpha/providers/perchance/adapter.mjs';
import { createPerchanceEmulator } from '../../../extension/alpha/providers/perchance/emulator.mjs';
import { normalizeRecord, recordKey, assertRecordUpdate } from '../../../extension/alpha/domain/records.js';

const when = '2026-10-10T00:00:00.000Z';
const key = 'demo';
const context = { accountId: 'account-a', personaUid: 'persona-a', epoch: 1,
  routeRevision: 1, capabilityRevision: 1 };
const copy = value => structuredClone(value);
const snapshotFiles = files => ({
  pjs: files.pjs, html: files.html, thumbnail: [...files.thumbnail]
});
const actualFiles = entry => snapshotFiles(entry.files);

async function release(text, sha = 'c'.repeat(40)) {
  const files = { pjs: text, html: '<main>' + text + '</main>',
    thumbnail: new Uint8Array([17, 22, 99]) };
  const releaseId = await canonicalReleaseId({
    pjs: new TextEncoder().encode(files.pjs),
    html: new TextEncoder().encode(files.html), thumbnail: files.thumbnail
  });
  return { releaseId, source: { repository: 'Neb963/per-gens', ref: 'main',
    root: 'generators/demo', folder: 'demo', slug: key, commitSha: sha,
    blobs: { 'generators/demo/main.pjs': 'b'.repeat(40) },
    status: 'READY', releaseId }, files, createdAt: when };
}

function createStorage(initial) {
  const rows = new Map();
  let version = 15;
  function seed(kind, value) {
    const record = normalizeRecord(kind, copy(value));
    rows.set(kind + '\0' + recordKey(kind, record), {
      revision: kind === 'operation' ? 1 : value.revision || 1, record
    });
  }
  for (const [kind, values] of Object.entries(initial)) for (const value of values) seed(kind, value);
  return Object.freeze({
    async read(kind, keyValue) {
      const item = rows.get(kind + '\0' + keyValue);
      return { revision: version, item: item ? copy(item) : null };
    },
    async list(kind) {
      const items = [...rows.entries()].filter(([k]) => k.startsWith(kind + '\0'))
        .map(([, value]) => copy(value));
      return { revision: version, items };
    },
    async commit({ expectedRevision, writes }) {
      assert.equal(expectedRevision, version, 'Global P102 CAS must not be stale');
      const staged = [];
      for (const w of writes) {
        const normalized = normalizeRecord(w.kind, copy(w.record));
        const k = w.kind + '\0' + recordKey(w.kind, normalized);
        const prior = rows.get(k);
        assert.equal(w.expectedRevision, prior?.revision || 0, 'Per-record CAS');
        assertRecordUpdate(w.kind, prior?.record, normalized);
        if (w.kind === 'generator' || w.kind === 'account') {
          assert.equal(normalized.revision, w.expectedRevision);
          normalized.revision++;
        }
        staged.push([k, { revision: w.expectedRevision + 1, record: normalized }]);
      }
      for (const [k, row] of staged) rows.set(k, row);
      version++;
      return { revision: version, items: staged.map(([, row]) => copy(row)) };
    }
  });
}

async function harness({ existing = false, publicListing = false, state = 'SLEEPING',
  session = 'VERIFIED' } = {}) {
  const old = existing ? await release('last good', 'a'.repeat(40)) : null;
  let candidate = await release('wanted revision');
  const initialFiles = old?.files || { pjs: '', html: '', thumbnail: new Uint8Array() };
  const emulator = createPerchanceEmulator({
    accountId: context.accountId, personaUid: context.personaUid,
    epoch: context.epoch, routeRevision: context.routeRevision,
    capabilityRevision: context.capabilityRevision, session,
    entries: [{ name: key, sourceRevision: 'r1', isPrivate: !publicListing,
      files: initialFiles }] });
  const storage = createStorage({
    account: [{ accountId: context.accountId, personaUid: context.personaUid,
      epoch: context.epoch, name: 'Account A', sessionState: session === 'VERIFIED' ?
        'VERIFIED' : 'WAITING_HUMAN', revision: 1, asOf: when }],
    generator: [{ key, accountId: context.accountId, personaUid: context.personaUid,
      accountBindingEpoch: context.epoch, fleetIntent: 'MANAGED',
      listingObserved: publicListing ? 'PUBLIC' : 'UNLISTED',
      deployState: existing ? 'DEPLOYED' : 'UNDEPLOYED',
      refreshState: state, sourceBinding: old?.source || null,
      releaseId: old?.releaseId || null, revision: 1, asOf: when, attentionRefs: [] }],
    release: old ? [old] : [], operation: []
  });
  const journal = createDeployerJournal({ storage, clock: () => when });
  const provider = createPerchanceAdapter({
    executor: emulator.executor, journal, now: () => when
  });
  const facts = { get: async () => existing ? {
    key, accountId: context.accountId, personaUid: context.personaUid,
    accountBindingEpoch: context.epoch, ownershipObserved: true,
    acceptedSourceRevision: 'r1', providerSourceRevision: 'r1',
    drift: null, ignoredVersion: null
  } : null };
  const core = { assertCurrent: async () => {},
    assertMutationAllowed: async () => {} };
  const sourceCatalog = { resolveRelease: async () => ({
    ok: true, result: copy(candidate), revision: 0
  }) };
  const service = createDeployerService({
    storage, sourceCatalog, provider, journal, core, facts, clock: () => when
  });
  const params = (opId = 'attempt1', options = {}) => ({
    key, accountId: context.accountId, accountBindingEpoch: context.epoch,
    expectedRevision: 1, opId, options: { context: copy(context), ...options }
  });
  return { old, storage, emulator, journal, provider, service, params,
    get candidate() { return candidate; },
    changeCandidate(next) { candidate = next; },
    async gen() { return (await storage.read('generator', key)).item.record; },
    async operation(opId) { return (await storage.read('operation', opId)).item?.record || null; } };
}

test('AP302-01 rejects active generator before any provider write or durable operation', async () => {
  const h = await harness({ existing: true, state: 'ACTIVE' });
  const result = await h.service.prepare(h.params());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFLICT');
  assert.equal(await h.operation('attempt1'), null);
  assert.deepEqual(h.emulator.calls.filter(c => ['save', 'setListing'].includes(c.kind)), []);
});

test('AP302-01 refuses unknown sleep states, stale bindings and unverified sessions', async () => {
  const h = await harness({ existing: true, state: 'UNKNOWN' });
  assert.equal((await h.service.prepare(h.params())).error.code, 'CONFLICT');
  const wrong = h.params(); wrong.accountBindingEpoch = 2;
  assert.equal((await h.service.prepare(wrong)).error.code, 'INVALID_REQUEST');
  const session = await harness({ existing: false, session: 'UNKNOWN' });
  assert.equal((await session.service.prepare(session.params())).error.code, 'WAITING_HUMAN');
});

test('AP302-02 prepares an immutable commit-pinned release and independently verifies unlisted save', async () => {
  const h = await harness({ existing: false, state: 'INELIGIBLE' });
  const prepared = await h.service.prepare(h.params());
  assert.equal(prepared.ok, true);
  assert.equal(prepared.result.phase, 'PREPARED');
  assert.equal(prepared.result.remoteEvidence.intent.releaseId, h.candidate.releaseId);
  assert.equal(prepared.result.remoteEvidence.intent.commitSha, h.candidate.source.commitSha);
  assert.equal((await h.storage.read('release', h.candidate.releaseId)).item.record.releaseId,
    h.candidate.releaseId);
  assert.equal((await h.emulator.listRemote())[0].files.pjs, '');
  const applied = await h.service.apply(h.params());
  assert.equal(applied.ok, true);
  assert.equal(applied.result.phase, 'APPLIED');
  assert.equal(applied.result.remoteEvidence.observation.releaseId, h.candidate.releaseId);
  const state = await h.gen();
  assert.equal(state.releaseId, null, 'Only later approval may adopt the staged release');
  assert.equal(state.deployState, 'STAGED');
  assert.equal(state.refreshState, 'INELIGIBLE');
  assert.equal(state.listingObserved, 'UNLISTED');
  const remote = h.emulator.listRemote()[0];
  assert.equal(remote.isPrivate, true);
  assert.deepEqual(actualFiles(remote), snapshotFiles(h.candidate.files));
  assert.equal((await h.operation('attempt1.save')).phase, 'APPLIED');
  assert.equal((await h.service.prepare({ ...h.params('again'),
    expectedRevision: state.revision })).error.code, 'CONFLICT');
});

test('AP302-02 fences a changed source commit between prepare and dispatch', async () => {
  const h = await harness({ existing: false, state: 'INELIGIBLE' });
  assert.equal((await h.service.prepare(h.params())).ok, true);
  const altered = await release('wanted revision', 'd'.repeat(40));
  assert.equal(altered.releaseId, h.candidate.releaseId, 'Docs-only source move has same bytes');
  h.changeCandidate(altered);
  const result = await h.service.apply(h.params());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONFLICT');
  assert.equal((await h.operation('attempt1')).phase, 'PREPARED');
  assert.equal(h.emulator.calls.filter(c => c.kind === 'save').length, 0);
});

test('AP302-02 detects unexpected provider revision after preparation without dispatch', async () => {
  const h = await harness({ existing: true });
  assert.equal((await h.service.prepare(h.params())).ok, true);
  h.emulator.changeRemote(key, { sourceRevision: 'outside' });
  const result = await h.service.apply(h.params());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SOURCE_DRIFT');
  assert.equal(h.emulator.calls.filter(c => c.kind === 'save').length, 0);
  assert.equal((await h.operation('attempt1')).phase, 'PREPARED');
});

test('AP302-03 failed update stays sleeping/unlisted, restores last good, quarantines exact release', async () => {
  const h = await harness({ existing: true, publicListing: true });
  assert.equal((await h.service.prepare(h.params())).ok, true);
  h.emulator.failNext('save', { status: 'not-applied' });
  const failed = await h.service.apply(h.params());
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'NOT_APPLIED');
  const remote = h.emulator.listRemote()[0];
  assert.equal(remote.isPrivate, true);
  assert.deepEqual(actualFiles(remote), snapshotFiles(h.old.files));
  const generator = await h.gen();
  assert.equal(generator.releaseId, h.old.releaseId);
  assert.equal(generator.refreshState, 'SLEEPING');
  assert.equal(generator.listingObserved, 'UNLISTED');
  assert.equal(generator.deployState, 'QUARANTINED');
  assert.ok(generator.attentionRefs.includes('deployer.failed.' + h.candidate.releaseId));
  assert.equal((await h.operation('attempt1')).phase, 'FAILED');
  assert.deepEqual(h.emulator.calls.filter(c =>
    ['setListing', 'save'].includes(c.kind)).map(c => c.kind), ['setListing', 'save']);
  assert.equal((await h.service.prepare({ ...h.params('retry'),
    expectedRevision: generator.revision })).error.code, 'CONFLICT');
});

test('AP302-03 explicit rollback of staged update uses one independently verified restore save', async () => {
  const h = await harness({ existing: true, publicListing: false });
  assert.equal((await h.service.prepare(h.params())).ok, true);
  assert.equal((await h.service.apply(h.params())).ok, true);
  const current = await h.gen();
  const rollback = await h.service.rollback({
    ...h.params('restore1', { originalOpId: 'attempt1' }),
    expectedRevision: current.revision
  });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.result.phase, 'APPLIED');
  const remote = h.emulator.listRemote()[0];
  assert.equal(remote.isPrivate, true);
  assert.deepEqual(actualFiles(remote), snapshotFiles(h.old.files));
  const generator = await h.gen();
  assert.equal(generator.deployState, 'QUARANTINED');
  assert.equal(generator.refreshState, 'SLEEPING');
  assert.equal(generator.releaseId, h.old.releaseId);
  assert.ok(generator.attentionRefs.includes('deployer.failed.' + h.candidate.releaseId));
  assert.equal((await h.operation('restore1.restore')).phase, 'APPLIED');
  assert.equal(h.emulator.calls.filter(c => c.kind === 'save').length, 2);
  assert.equal((await h.service.rollback({
    ...h.params('restore2', { originalOpId: 'attempt1' }),
    expectedRevision: generator.revision
  })).ok, false, 'A completed rollback cannot be blindly replayed');
});

test('AP302-03 uncertain post-dispatch save never retries or rolls back without readback', async () => {
  const h = await harness({ existing: true });
  assert.equal((await h.service.prepare(h.params())).ok, true);
  h.emulator.failNext('save', { apply: true, throwError: true });
  const failed = await h.service.apply(h.params());
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'UNCERTAIN');
  assert.equal((await h.operation('attempt1')).phase, 'UNCERTAIN');
  assert.equal((await h.operation('attempt1.save')).phase, 'UNCERTAIN');
  assert.equal(h.emulator.calls.filter(c => c.kind === 'save').length, 1);
  const reconciled = await h.service.reconcile(h.params());
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.result.phase, 'APPLIED');
  assert.equal((await h.operation('attempt1.save')).phase, 'APPLIED');
  assert.equal(h.emulator.calls.filter(c => c.kind === 'save').length, 1,
    'Readback reconciles a mutation without a second send');
});

test('AP302-03 refuses rollback after unexpected third-party source and retains recovery hold', async () => {
  const h = await harness({ existing: true });
  assert.equal((await h.service.prepare(h.params())).ok, true);
  h.emulator.failNext('save', { apply: true, throwError: true });
  assert.equal((await h.service.apply(h.params())).error.code, 'UNCERTAIN');
  h.emulator.changeRemote(key, { files: { pjs: 'third party', html: '',
    thumbnail: new Uint8Array([4]) }, sourceRevision: 'external-revision' });
  const rollback = await h.service.rollback(h.params());
  assert.equal(rollback.ok, false);
  assert.equal(rollback.error.code, 'SOURCE_DRIFT');
  assert.equal(h.emulator.calls.filter(c => c.kind === 'save').length, 1);
  assert.equal((await h.operation('attempt1')).phase, 'HELD');
});
