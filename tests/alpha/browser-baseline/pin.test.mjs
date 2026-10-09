import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAlphaPin, assertExactVersion, artifactTreeHash, artifactInventory, inventoryTreeHash, inventoryDelta, verifyInstallation } from '../../../tools/alpha/firefox/pin.mjs';
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
