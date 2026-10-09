import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AlphaDataError, safeDetails } from '../../../extension/alpha/domain/validation.js';
import { normalizeAccount, normalizeGenerator, normalizeGeneratorKey, normalizeSourceBinding, normalizeRelease,
  normalizeOperation, normalizeRecord, assertRecordUpdate, OPERATION_PHASES } from '../../../extension/alpha/domain/records.js';
import { applyAlphaMigrations, ALPHA_DB_NAME } from '../../../extension/alpha/storage/migrations.js';
import { account, generator, binding, release, operation } from './fixtures.js';
const invalid = fn => assert.throws(fn, e => e instanceof AlphaDataError && e.code === 'INVALID_REQUEST');

test('AP102-01: four normalizers implement the frozen fields, without merging independent Generator facts', async () => {
  const types = await readFile(new URL('../../../extension/alpha/contracts/index.d.ts', import.meta.url), 'utf8');
  const expectations = [
    ['AccountRecord', normalizeAccount(account()), ['accountId', 'personaUid', 'epoch']],
    ['GeneratorRecord', normalizeGenerator(generator({ fleetIntent: 'EXCLUDED', listingObserved: 'PUBLIC', refreshState: 'ACTIVE' })), []],
    ['ReleaseRecord', normalizeRelease(release()), []],
    ['Operation', normalizeOperation(operation()), []]
  ];
  for (const [name, actual, inherited] of expectations) {
    const body = types.match(new RegExp('interface ' + name + '[^{]*\\{([^}]+)\\}'))[1];
    const required = Array.from(body.matchAll(/readonly (\w+)(\?)?:/g)).filter(m => !m[2]).map(m => m[1]);
    assert.deepEqual(Object.keys(actual).sort(), [...required, ...inherited].sort());
  }
  const g = expectations[1][1];
  assert.equal(g.fleetIntent, 'EXCLUDED'); assert.equal(g.listingObserved, 'PUBLIC'); assert.equal(g.refreshState, 'ACTIVE');
  const surface = JSON.parse(await readFile(new URL('../../../extension/alpha/contracts/surface.json', import.meta.url)));
  assert.deepEqual(OPERATION_PHASES, surface.enums.OperationPhase);
});

test('AP102-01: canonical donor slug grammar avoids aliases and fleet collisions', () => {
  assert.equal(normalizeGeneratorKey('generator_1-test'), 'generator_1-test');
  for (const key of ['UPPER', ' generator', 'generator ', '-generator', 'a/b', 'https://perchance.org/a', 'a'.repeat(101)])
    invalid(() => normalizeGeneratorKey(key));
});

test('AP102-03: unknown credential/container fields are rejected in every normal record without echoing data', () => {
  for (const [kind, record] of [['account', account()], ['generator', generator()], ['release', release()], ['operation', operation()]]) {
    for (const key of ['password', 'token', 'cookies', 'cookieStoreId', 'extra']) {
      const marker = 'discarded-input-marker';
      assert.throws(() => normalizeRecord(kind, { ...record, [key]: marker }), error => {
        assert.equal(error.code, 'INVALID_REQUEST'); assert.equal(JSON.stringify(error).includes(marker), false);
        assert.equal(error.stack.includes(marker), false); return true;
      });
    }
  }
});

test('AP102-03: nested operation metadata rejects credential names and keeps opaque SecretRefs only', () => {
  for (const key of ['password', 'access_token', 'Authorization', 'Cookie', 'sessionToken', 'apiKey', 'private-key', 'credentials'])
    invalid(() => normalizeOperation(operation({ remoteEvidence: { observed: { [key]: 'not-a-credential' } } })));
  const result = normalizeOperation(operation({ result: { secretRef: 'fixture-secret-reference', saved: true } }));
  assert.equal(result.result.secretRef, 'fixture-secret-reference');
});

test('AP102-03: recognizable credential material is rejected without a credential fixture', () => {
  // Construct a nonfunctional canary at runtime; never store or print its value.
  const canary = ['gh', 'p_', 'x'.repeat(30)].join('');
  invalid(() => normalizeAccount(account({ name: canary })));
  invalid(() => normalizeOperation(operation({ remoteEvidence: { message: canary } })));
  const r = release(); r.files.pjs = canary; invalid(() => normalizeRelease(r));
});

test('AP102-01: unknown fields, exotic objects, accessors and symbols fail without executing getters', () => {
  let executed = false;
  const input = account(); Object.defineProperty(input, 'name', { enumerable: true, get() { executed = true; return 'unsafe'; } });
  invalid(() => normalizeAccount(input)); assert.equal(executed, false);
  invalid(() => normalizeAccount(Object.assign(Object.create({ inherited: true }), account())));
  invalid(() => normalizeAccount({ ...account(), [Symbol('extra')]: true }));
  const proto = Object.create(null); Object.assign(proto, account()); assert.equal(normalizeAccount(proto).accountId, 'account-one');
});

test('AP102-02: revisions, binding epochs and timestamps are bounded and canonical', () => {
  for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) invalid(() => normalizeAccount(account({ revision })));
  invalid(() => normalizeAccount(account({ epoch: 0 })));
  invalid(() => normalizeAccount(account({ asOf: '2026-02-30T00:00:00.000Z' })));
  assert.equal(normalizeAccount(account({ asOf: '2026-10-09T00:00:00Z' })).asOf, '2026-10-09T00:00:00.000Z');
  invalid(() => normalizeGenerator(generator({ accountBindingEpoch: 0 })));
});

test('AP102-01: exact Alpha enums and explicit source slug mapping are retained', () => {
  invalid(() => normalizeGenerator(generator({ listingObserved: 'PUBLICLY_LISTED' })));
  invalid(() => normalizeGenerator(generator({ fleetIntent: 'ACTIVE' })));
  const source = binding({ folder: 'different-folder' });
  assert.equal(normalizeGenerator(generator({ sourceBinding: source })).sourceBinding.folder, 'different-folder');
  invalid(() => normalizeGenerator(generator({ sourceBinding: binding({ slug: 'other-slug' }) })));
  invalid(() => normalizeGenerator(generator({ attentionRefs: ['same', 'same'] })));
});

test('AP102-01: source references are commit-pinned on main and safe relative paths', () => {
  invalid(() => normalizeSourceBinding(binding({ ref: 'generator/work' })));
  invalid(() => normalizeSourceBinding(binding({ commitSha: 'main' })));
  for (const folder of ['../escape', '/absolute', 'a//b', 'a\\b', 'a/%2e%2e/b', 'a/./b'])
    invalid(() => normalizeSourceBinding(binding({ folder })));
  assert.equal(normalizeSourceBinding(binding({ root: '' })).root, '');
  invalid(() => normalizeSourceBinding(binding({ blobs: { 'main.pjs': 'not-a-blob' } })));
});

test('AP102-01: Release files preserve exact UTF-8 text and detached thumbnail bytes', () => {
  const input = release(); const output = normalizeRelease(input);
  assert.equal(output.files.pjs, input.files.pjs); assert.equal(output.files.html, input.files.html);
  input.files.thumbnail[0] = 0; assert.equal(output.files.thumbnail[0], 255);
  invalid(() => normalizeRelease(release({ source: binding({ releaseId: null }) })));
  const bad = release(); bad.files.pjs = String.fromCharCode(0xd800); invalid(() => normalizeRelease(bad));
  const empty = release(); empty.files.thumbnail = new Uint8Array(); invalid(() => normalizeRelease(empty));
  const extra = release(); extra.files.thumbnail.token = 'not-a-credential'; invalid(() => normalizeRelease(extra));
  const getter = release(); let ran = false;
  Object.defineProperty(getter.files.thumbnail, 'length', { get() { ran = true; throw new Error('Unsafe getter'); } });
  invalid(() => normalizeRelease(getter)); assert.equal(ran, false);
});

test('AP102-03: operation evidence is bounded data, rejects cycles and unsafe arrays/prototypes', () => {
  const cycle = {}; cycle.self = cycle; invalid(() => safeDetails(cycle));
  invalid(() => safeDetails({ unsafe: () => {} }));
  invalid(() => safeDetails({ unsafe: new Date() }));
  invalid(() => safeDetails(JSON.parse('{"__proto__":{"unsafe":true}}')));
  invalid(() => safeDetails({ sparse: new Array(2) }));
  const refs = ['one']; refs.extra = true; invalid(() => safeDetails({ refs }));
  const deep = {}; let cursor = deep; for (let i = 0; i < 18; i++) cursor = cursor.next = {};
  invalid(() => safeDetails(deep));
});

test('AP102-02: immutable operation target and uncertainty prohibit blind replay', () => {
  const prepared = normalizeOperation(operation()), dispatching = normalizeOperation(operation({ phase: 'DISPATCHING' }));
  assertRecordUpdate('operation', prepared, dispatching);
  const uncertain = normalizeOperation(operation({ phase: 'UNCERTAIN' }));
  assertRecordUpdate('operation', dispatching, uncertain);
  for (const next of [dispatching, normalizeOperation(operation({ phase: 'APPLIED' }))])
    assert.throws(() => assertRecordUpdate('operation', uncertain, next), { code: 'CONFLICT' });
  assertRecordUpdate('operation', uncertain, normalizeOperation(operation({ phase: 'APPLIED', remoteEvidence: { revision: 'verified-revision' } })));
  assert.throws(() => assertRecordUpdate('operation', dispatching, normalizeOperation(operation({ phase: 'UNCERTAIN', targetKey: 'other-target' }))), { code: 'CONFLICT' });
  assert.throws(() => assertRecordUpdate('operation', dispatching, normalizeOperation(operation({ phase: 'FAILED' }))), { code: 'CONFLICT' });
  assert.throws(() => assertRecordUpdate('operation', dispatching, normalizeOperation(operation({ phase: 'APPLIED' }))), { code: 'CONFLICT' });
  assert.throws(() => assertRecordUpdate('operation', null, dispatching), { code: 'CONFLICT' });
});

test('AP102-02: a Persona rebind requires a monotone epoch and releases cannot be rewritten', () => {
  assert.throws(() => assertRecordUpdate('account', account(), account({ personaUid: 'persona-two' })), { code: 'STALE_BINDING' });
  assertRecordUpdate('account', account(), account({ personaUid: 'persona-two', epoch: 2 }));
  const changed = release(); changed.files.html = 'changed';
  assert.throws(() => assertRecordUpdate('release', release(), changed), { code: 'CONFLICT' });
});

test('AP102-02: isolated Alpha migration authority is contiguous, synchronous and rejects unsupported versions', () => {
  assert.notEqual(ALPHA_DB_NAME, 'persona-monkey-pcms');
  const apply = () => {};
  for (const migrations of [[], [{ version: 2, apply }], [{ version: 1, apply }, { version: 3, apply }],
    [{ version: 1, apply: async () => {} }], [{ version: 1, apply: async () => { throw new Error('Synthetic migration fault'); } }]])
    assert.throws(() => applyAlphaMigrations({ oldVersion: 0, newVersion: 1, migrations }), { code: 'RECOVERY_HOLD' });
  assert.throws(() => applyAlphaMigrations({ oldVersion: 1, newVersion: 2 }), { code: 'RECOVERY_HOLD' });
});
