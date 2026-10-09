import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAlphaPin, assertExactVersion, artifactTreeHash, artifactInventory, inventoryTreeHash, inventoryDelta, verifyArtifactInventory, verifyInstallation } from '../../../tools/alpha/firefox/pin.mjs';
import { validateOrigins, IsolatedFirefox } from '../../../tools/alpha/firefox/harness.mjs';

test('AP101-03 Alpha consumes the accepted exact donor/Mozilla pin', async () => {
  const pin = await loadAlphaPin();
  assert.equal(pin.version, '154.0b10');
  assert.equal(pin.archive.sha256, '681913108bba655d7ec6fadfac2731141b23e48dca88d1988a4d95a6bdaff164');
  assertExactVersion('Mozilla Firefox 154.0b10\n', pin.version);
  for (const output of ['Mozilla Firefox 154.0b100', 'Mozilla Firefox 154.0', 'Mozilla Firefox 155.0b1', 'not Firefox 154.0b10']) {
    assert.throws(() => assertExactVersion(output, pin.version), /exact pin/);
  }
});

test('AP101-03 artifact tree hashing is reproducible and detects content, path, mode and symlink changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p101-tree-'));
  try {
    const a = join(root, 'a'), b = join(root, 'b'); await mkdir(a); await mkdir(b);
    await writeFile(join(a, 'binary'), 'fixture binary', { mode: 0o755 });
    await writeFile(join(b, 'binary'), 'fixture binary', { mode: 0o755 });
    const expected = await artifactTreeHash(a);
    assert.equal(await artifactTreeHash(b), expected);
    await writeFile(join(b, 'binary'), 'tampered binary'); assert.notEqual(await artifactTreeHash(b), expected);
    await writeFile(join(b, 'binary'), 'fixture binary'); await chmod(join(b, 'binary'), 0o644);
    assert.notEqual(await artifactTreeHash(b), expected);
    await chmod(join(b, 'binary'), 0o755); await symlink('binary', join(b, 'link'));
    assert.notEqual(await artifactTreeHash(b), expected);
    await rm(join(b, 'link')); await rm(join(b, 'binary'));
    await writeFile(join(b, 'other-path'), 'fixture binary', { mode: 0o755 });
    assert.notEqual(await artifactTreeHash(b), expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('AP101-03 unproven executables and a missing installation manifest fail before launch', async () => {
  await assert.rejects(() => verifyInstallation({ firefoxBin: '/unproven/firefox', manifestPath: '' }), /Alpha installer/);
});

test('AP101-03 integrity evidence identifies exact changed bytes/modes/links and bounds unexpected paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p101-delta-'));
  try {
    await writeFile(join(root, 'binary'), 'original', { mode: 0o755 });
    await symlink('binary', join(root, 'link'));
    const before = await artifactInventory(root);
    assert.equal(inventoryTreeHash(before), await artifactTreeHash(root));
    assert.deepEqual(inventoryDelta(before, before), { changeCount: 0, truncated: false, changes: [] });
    await writeFile(join(root, 'binary'), 'tampered'); await chmod(join(root, 'binary'), 0o644);
    await rm(join(root, 'link')); await symlink('elsewhere', join(root, 'link'));
    const delta = inventoryDelta(before, await artifactInventory(root));
    assert.deepEqual(delta.changes.map(e => e.path), ['binary', 'link']);
    assert.notEqual(delta.changes[0].before.sha256, delta.changes[0].after.sha256);
    assert.equal(delta.changes[0].before.mode, 0o755); assert.equal(delta.changes[0].after.mode, 0o644);
    assert.equal(delta.changes[1].before.target, 'binary'); assert.equal(delta.changes[1].after.target, 'elsewhere');
    for (let i = 0; i < 20; i++) await writeFile(join(root, `unexpected-${i}`), 'fixture');
    const bounded = inventoryDelta(before, await artifactInventory(root));
    assert.equal(bounded.changeCount, 22); assert.equal(bounded.changes.length, 16); assert.equal(bounded.truncated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function integrityFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'p101-integrity-'));
  try {
    await mkdir(join(root, 'defaults'), { mode: 0o755 });
    await writeFile(join(root, 'binary'), 'immutable Firefox fixture', { mode: 0o755 });
    await writeFile(join(root, 'defaults', 'prefs'), 'immutable prefs', { mode: 0o644 });
    await symlink('binary', join(root, 'binary-link'));
    const baseline = await artifactInventory(root), digest = inventoryTreeHash(baseline);
    const verify = async () => verifyArtifactInventory(baseline, await artifactInventory(root), digest);
    await run({ root, baseline, digest, verify });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('AP101-03 empty updater lock creation, active mutex and release preserve the immutable digest', async () => {
  await integrityFixture(async ({ root, digest, verify }) => {
    assert.equal((await verify()).changeCount, 0);
    await writeFile(join(root, '.parentlock'), '', { mode: 0o644 });
    let proof = await verify();
    assert.equal(proof.immutableTreeSha256, digest);
    assert.notEqual(proof.observedTreeSha256, digest); // the old assertion failed here
    assert.deepEqual(proof.changes.map(change => change.path), ['.parentlock']);
    await symlink('127.0.0.1:+1234', join(root, 'lock'));
    proof = await verify();
    assert.equal(proof.immutableTreeSha256, digest);
    assert.deepEqual(proof.runtimeMetadata.map(entry => entry.path), ['.parentlock', 'lock']);
    await rm(join(root, 'lock'));
    assert.deepEqual((await verify()).runtimeMetadata.map(entry => entry.path), ['.parentlock']);
    for (const mode of [0o600, 0o640, 0o644]) {
      await chmod(join(root, '.parentlock'), mode); await verify();
    }
  });
});

test('AP101-03 archive bytes, file/directory modes, symlinks and unknown additions fail even with legitimate mutex metadata', async t => {
  const cases = [
    ['binary bytes', root => writeFile(join(root, 'binary'), 'tampered')],
    ['prefs bytes', root => writeFile(join(root, 'defaults', 'prefs'), 'tampered')],
    ['binary mode', root => chmod(join(root, 'binary'), 0o644)],
    ['setuid binary', root => chmod(join(root, 'binary'), 0o4755)],
    ['directory mode', root => chmod(join(root, 'defaults'), 0o777)],
    ['missing member', root => rm(join(root, 'binary-link'))],
    ['changed symlink', async root => { await rm(join(root, 'binary-link')); await symlink('defaults/prefs', join(root, 'binary-link')); }],
    ['hardlinked member', root => link(join(root, 'binary'), join(root, 'unexpected-hardlink'))],
    ['unknown cache', root => writeFile(join(root, 'cache'), '')],
    ['nested lock name', root => writeFile(join(root, 'defaults', '.parentlock'), '')],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => integrityFixture(async ({ root, verify }) => {
    await writeFile(join(root, '.parentlock'), '', { mode: 0o644 });
    await symlink('127.0.0.1:+1234', join(root, 'lock'));
    await mutate(root);
    await assert.rejects(verify, error => {
      assert.match(error.message, /artifact changed/);
      assert.ok(error.artifactIntegrity.changeCount >= 3);
      assert.equal(error.artifactIntegrity.runtimeMetadata.length, 2);
      return true;
    });
  }));
});

test('AP101-03 lookalike or unsafe updater metadata remains fatal', async t => {
  const cases = [
    ['nonempty parentlock', root => writeFile(join(root, '.parentlock'), 'tampered', { mode: 0o644 })],
    ['executable parentlock', root => writeFile(join(root, '.parentlock'), '', { mode: 0o755 })],
    ['writable parentlock', async root => {
      await writeFile(join(root, '.parentlock'), '', { mode: 0o644 }); await chmod(join(root, '.parentlock'), 0o666);
    }],
    ['symlink parentlock', root => symlink('binary', join(root, '.parentlock'))],
    ['directory parentlock', root => mkdir(join(root, '.parentlock'))],
    ['hardlinked empty parentlock', async root => {
      await writeFile(join(root, 'empty'), '', { mode: 0o644 });
      await link(join(root, 'empty'), join(root, '.parentlock'));
    }],
    ['file named lock', root => writeFile(join(root, 'lock'), '')],
    ...['binary', '../binary', '/tmp/binary', '127.0.0.1:+0', '127.0.0.1:+2147483648',
      '999.0.0.1:+1234', '127.0.0.1:1234', '127.0.0.1:+1234\n'].map(target =>
      [`invalid lock target ${JSON.stringify(target)}`, root => symlink(target, join(root, 'lock'))]),
  ];
  for (const [name, mutate] of cases) await t.test(name, () => integrityFixture(async ({ root, verify }) => {
    await mutate(root); await assert.rejects(verify, /artifact changed/);
  }));
});

test('AP101-03 an archive-owned lock is immutable and incomplete baseline provenance fails closed', async () => {
  await integrityFixture(async ({ root, baseline, digest }) => {
    assert.throws(() => verifyArtifactInventory(undefined, baseline, digest), /baseline inventory/);
    assert.throws(() => verifyArtifactInventory(baseline, baseline, '0'.repeat(64)), /baseline inventory/);
    assert.throws(() => verifyArtifactInventory([...baseline, baseline[0]], baseline, digest), /baseline inventory/);
    const incomplete = baseline.map(({ nlink, ...entry }) => entry);
    assert.throws(() => verifyArtifactInventory(incomplete, baseline, digest), /baseline inventory/);
    await writeFile(join(root, '.parentlock'), '', { mode: 0o644 });
    const withLock = await artifactInventory(root), withLockHash = inventoryTreeHash(withLock);
    await chmod(join(root, '.parentlock'), 0o600); // valid runtime shape, but an immutable archive member
    assert.throws(() => verifyArtifactInventory(withLock, baseline, withLockHash), /artifact changed/);
    const actual = await artifactInventory(root);
    assert.throws(() => verifyArtifactInventory(withLock, actual, withLockHash), /artifact changed/);
  });
});

test('AP101-01 fixtures accept only exact loopback origins, never a public host or widened URL', () => {
  assert.deepEqual(validateOrigins(['http://127.0.0.1:41234']), ['http://127.0.0.1:41234']);
  for (const origins of [['https://perchance.org'], ['http://localhost:41234'], ['http://127.0.0.1'],
    ['http://127.0.0.1:41234/'], ['http://127.0.0.1:41234/path'], ['http://x:y@127.0.0.1:41234'],
    ['http://127.0.0.1:41234', 'http://127.0.0.1:41234'], ['file:///tmp/fixture']]) {
    assert.throws(() => validateOrigins(origins));
  }
});

test('AP101-03 browser CI rejects the disabled-content-sandbox local workaround', async () => {
  const oldCi = process.env.CI, oldFlag = process.env.MOZ_DISABLE_CONTENT_SANDBOX;
  process.env.CI = 'true'; process.env.MOZ_DISABLE_CONTENT_SANDBOX = '1';
  try { await assert.rejects(() => IsolatedFirefox.create(), /CI must enable/); }
  finally {
    if (oldCi === undefined) delete process.env.CI; else process.env.CI = oldCi;
    if (oldFlag === undefined) delete process.env.MOZ_DISABLE_CONTENT_SANDBOX; else process.env.MOZ_DISABLE_CONTENT_SANDBOX = oldFlag;
  }
});
