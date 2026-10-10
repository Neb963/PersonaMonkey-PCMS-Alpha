import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalReleaseId } from '../../../../extension/alpha/features/sources/catalog.mjs';
import { canonicalPjs, prepareRefreshComment } from '../../../../extension/alpha/flows/refresh/comment.mjs';
import { createRefreshExecution } from '../../../../extension/alpha/flows/refresh/service.mjs';
import { emptyRefreshState, validateRefreshState } from '../../../../extension/alpha/flows/refresh/ledger.mjs';

const BASE = Date.parse('2026-10-10T00:00:00.000Z'), MIN = 60_000;
const key = 'refresh-example', original = 'const emoji = "🦊";\n// exact source\n';
const thumb = new Uint8Array([1, 2, 3]);
const files = pjs => ({ pjs, html: '<div>unchanged</div>', thumbnail: new Uint8Array(thumb) });
const copyFiles = obj => ({ pjs: obj.pjs, html: obj.html, thumbnail: new Uint8Array(obj.thumbnail) });
function memoryLedger() {
  let value = emptyRefreshState();
  return {
    read: async () => structuredClone(value),
    async update(fn) {
      const next = structuredClone(value), returned = fn(next);
      assert.equal(returned instanceof Promise, false);
      next.revision++;
      value = validateRefreshState(next);
      return structuredClone(value);
    },
    corrupt(next) { value = next; }
  };
}
async function fixture() {
  let now = BASE, saves = 0, reloads = 0, permitted = true, cause = null;
  let source = files(original), revision = 1, position = 'NOT_VISIBLE', rendered = null;
  let asOf = now, journal = new Map(), notices = [], sourceDrift = false;
  const releaseId = await canonicalReleaseId({
    pjs: new TextEncoder().encode(original),
    html: new TextEncoder().encode(source.html), thumbnail: source.thumbnail
  });
  const release = { releaseId, source: { slug: key, status: 'READY' }, files: files(original) };
  const generator = { key, accountId: 'account-one', personaUid: 'persona-one',
    accountBindingEpoch: 1, fleetIntent: 'MANAGED', listingObserved: 'PUBLIC',
    sourceBinding: { status: 'READY' }, deployState: 'DEPLOYED', attentionRefs: [],
    releaseId, revision: 1 };
  const account = { accountId: 'account-one', personaUid: 'persona-one',
    epoch: 1, sessionState: 'VERIFIED' };
  const scheduler = {
    async planPass() { return { ok: true, result: [] }; },
    async inspect() { return {
      config: { margin: .1 }, health: { state: 'HEALTHY' },
      schedules: { [key]: { key, accountId: generator.accountId,
        personaUid: generator.personaUid, accountBindingEpoch: generator.accountBindingEpoch,
        phase: 'ACTIVE' } }
    }; }
  };
  const visibility = { async getPosition() { return { ok: true, result: {
    key, status: position, renderedPosition: rendered,
    feedPosition: null, asOf: new Date(asOf).toISOString(), evidenceRefs: ['test.feed']
  } }; } };
  const storage = { async read(kind, id) {
    const record = kind === 'release' && id === releaseId ? release :
      kind === 'generator' && id === key ? generator :
      kind === 'account' && id === account.accountId ? account : null;
    return { revision: 1, item: record ? { record: structuredClone(record), revision: 1 } : null };
  } };
  const provider = {
    async probe() { return { ok: true, result: ['generator.save'], revision: 7 }; },
    async read() { return { ok: true, result: {
      sourceRevision: String(revision), ownership: 'CONFIRMED', listing: 'PUBLIC',
      asOf: new Date(now).toISOString(), files: copyFiles(source)
    } }; },
    async save(input) {
      assert.equal(input.expectedSourceRevision, String(revision));
      assert.equal(journal.get(input.opId)?.phase, 'PREPARED');
      if (cause === 'BEFORE_WRITE') throw new Error('lost transport');
      saves++;
      source = copyFiles(input.files);
      revision++;
      journal.get(input.opId).phase = 'APPLIED';
      if (cause === 'AFTER_WRITE') throw new Error('lost response');
      return this.read();
    }
  };
  const opJournal = {
    async prepare(op) {
      assert.equal(journal.has(op.opId), false);
      journal.set(op.opId, { ...op, phase: 'PREPARED' });
    },
    async read(id) { return journal.get(id) ?? null; }
  };
  const core = { async assertCurrent() { if (!permitted) throw Object.assign(
    new Error('RECOVERY_HOLD'), { code: 'RECOVERY_HOLD' }); },
    async assertMutationAllowed() { if (!permitted) throw Object.assign(
      new Error('RECOVERY_HOLD'), { code: 'RECOVERY_HOLD' }); } };
  const ledger = memoryLedger();
  const service = createRefreshExecution({ scheduler, visibility, storage, provider,
    journal: opJournal, core, ledger, clock: () => now,
    contextFor: async ({ account, generator }) => ({
      accountId: account.accountId, personaUid: generator.personaUid, epoch: account.epoch,
      routeRevision: 2, capabilityRevision: 3
    }),
    browser: { async reload({ context }) { assert.equal(context.personaUid, 'persona-one');
      reloads++; return { ok: true, result: { confirmed: true } };
    } },
    attention: { async raise(data) { notices.push(data); } }
  });
  return {
    service, release, generator, account, ledger, journal, core, provider,
    advance(ms) { now += ms; asOf = now; },
    staleAt(ms) { asOf = ms; },
    observe(status, pos = null) { position = status; rendered = pos; asOf = now; },
    replaceSource(pjs) { source.pjs = pjs; },
    setCause(value) { cause = value; },
    deny() { permitted = false; },
    get source() { return copyFiles(source); },
    get saves() { return saves; },
    get reloads() { return reloads; },
    get notices() { return notices; },
    get time() { return now; },
    get rev() { return revision; }
  };
}

test('AP403-01: suffix is exact, byte-offset tracked; hashing original is unchanged', async () => {
  const f = await fixture();
  const before = files(original);
  const staged = await prepareRefreshComment(before, f.release, null, 'token-one');
  assert.equal(staged.comment.insertionOffset, new TextEncoder().encode(original).length);
  assert.ok(staged.comment.insertionOffset > original.length);
  assert.equal(await canonicalPjs(staged.files, f.release, staged.comment), original);
  const second = await prepareRefreshComment(staged.files, f.release, staged.comment, 'token-two');
  assert.equal(await canonicalPjs(second.files, f.release, second.comment), original);
  assert.ok(!second.files.pjs.includes('token-one'));
  await assert.rejects(canonicalPjs({ ...second.files, pjs: second.files.pjs + 'extra' },
    f.release, second.comment), /SOURCE_DRIFT/);
  await assert.rejects(canonicalPjs(staged.files, f.release, null), /SOURCE_DRIFT/);
  await assert.rejects(canonicalPjs({ ...staged.files, html: 'changed' },
    f.release, staged.comment), /SOURCE_DRIFT/);
});
test('AP403-01: provider confirmed exact save is not assumed visible until fresh rendered observation', async () => {
  const f = await fixture();
  let pass = await f.service.pass();
  assert.equal(pass.ok, true, JSON.stringify(pass));
  assert.equal(pass.result.items[0].action, 'SAVED_WAIT_FOR_OBSERVATION');
  assert.equal(f.saves, 1);
  const first = (await f.service.inspect()).jobs[key];
  assert.equal(first.comment.saveReceipt, '2');
  assert.equal(await canonicalPjs(f.source, f.release, first.comment), original);
  pass = await f.service.pass();
  assert.equal(pass.result.items[0].action, 'WAIT_FOR_FRESH_OBSERVATION');
  f.advance(10 * MIN);
  f.observe('VISIBLE', 1);
  pass = await f.service.pass();
  assert.equal(pass.result.items[0].action, 'ON_TARGET');
  assert.equal(f.saves, 1);
  assert.equal((await f.service.inspect()).jobs[key].attempts, 0);
});
test('AP403-02: delayed reload/retry and third failed observation suspend with attention', async () => {
  const f = await fixture();
  assert.equal((await f.service.pass()).result.items[0].action, 'SAVED_WAIT_FOR_OBSERVATION');
  f.advance(11 * MIN);
  assert.equal((await f.service.pass()).result.items[0].action, 'BACKOFF');
  f.advance(61 * MIN);
  assert.equal((await f.service.pass()).result.items[0].action, 'RELOADED');
  assert.equal(f.reloads, 1);
  assert.equal((await f.service.pass()).result.items[0].action, 'WAIT_FOR_FRESH_OBSERVATION' ===
    'BACKOFF' ? 'WAIT_FOR_FRESH_OBSERVATION' : 'BACKOFF');
  f.advance(11 * MIN);
  assert.equal((await f.service.pass()).result.items[0].action, 'SAVED_WAIT_FOR_OBSERVATION');
  f.advance(121 * MIN);
  assert.equal((await f.service.pass()).result.items[0].action, 'RELOADED');
  f.advance(11 * MIN);
  assert.equal((await f.service.pass()).result.items[0].action, 'SAVED_WAIT_FOR_OBSERVATION');
  f.advance(11 * MIN);
  assert.equal((await f.service.pass()).result.items[0].action, 'SUSPENDED');
  assert.equal(f.saves, 3);
  assert.equal(f.reloads, 2);
  assert.equal(f.notices.length, 1);
  f.advance(24 * 60 * MIN);
  assert.equal((await f.service.pass()).result.items[0].action, 'SUSPENDED');
  assert.equal(f.saves, 3);
});
test('AP403-02: lost provider response becomes hold, not a blind retry', async () => {
  const f = await fixture();
  f.setCause('AFTER_WRITE');
  const first = await f.service.pass();
  assert.equal(first.result.items[0].action, 'RECONCILE');
  assert.equal(f.saves, 1);
  f.advance(5 * 60 * MIN);
  assert.equal((await f.service.pass()).result.items[0].action, 'RECONCILE');
  assert.equal(f.saves, 1);
  const record = (await f.service.inspect()).jobs[key];
  assert.equal((await f.service.reconcile({ key })).ok, true);
  assert.equal((await f.service.inspect()).jobs[key].comment.saveReceipt, String(f.rev));
  assert.equal(record.pending?.kind, 'save');
});
test('AP403-02: missing binding, source drift, and Core hold do not save', async () => {
  const f = await fixture();
  f.replaceSource(original + '// not owned by the release\n');
  assert.equal((await f.service.pass()).result.items[0].action, 'SUSPENDED');
  assert.equal(f.saves, 0);
  assert.equal(f.notices[0].code, 'SOURCE_DRIFT');
  const second = await fixture();
  second.generator.accountBindingEpoch++;
  assert.equal((await second.service.pass()).result.items[0].action, 'SUSPENDED');
  assert.equal(second.saves, 0);
  const third = await fixture();
  third.deny();
  assert.equal((await third.service.pass()).result.items[0].action, 'SUSPENDED');
  assert.equal(third.saves, 0);
});
test('AP403-03: a visible but below-target generator can require refresh; no guaranteed first place', async () => {
  const f = await fixture();
  f.observe('VISIBLE', 9);
  assert.equal((await f.service.pass()).result.items[0].action, 'SAVED_WAIT_FOR_OBSERVATION');
  f.advance(11 * MIN);
  f.observe('VISIBLE', 9);
  assert.equal((await f.service.pass()).result.items[0].action, 'BACKOFF');
  assert.equal(f.saves, 1);
  const second = await fixture();
  second.observe('VISIBLE', 1);
  assert.equal((await second.service.pass()).result.items[0].action, 'ON_TARGET');
  assert.equal(second.saves, 0);
});
test('AP403-03: global stagger and unknown observations never trigger rapid saves', async () => {
  const f = await fixture();
  await f.ledger.update(s => { s.lastSaveAtMs = BASE - 30_000; });
  assert.equal((await f.service.pass()).result.items[0].action, 'STAGGERED');
  assert.equal(f.saves, 0);
  f.advance(MIN);
  assert.equal((await f.service.pass()).result.items[0].action, 'SAVED_WAIT_FOR_OBSERVATION');
  const other = await fixture();
  other.observe('UNKNOWN');
  assert.equal((await other.service.pass()).result.items[0].action, 'WAIT_FOR_OBSERVATION');
  assert.equal(other.saves, 0);
});
