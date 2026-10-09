import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-test-discovery-fixture-'));
  function file(path, content) { const target = join(root, 'tests/alpha', path); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, content); }
  const run = () => spawnSync(process.execPath, [resolve('tools/alpha/run-tests.mjs'), '--root', root], { encoding: 'utf8' });
  try { fn({ file, run }); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('CI discovers disjoint future phase suites without shared package edits', () => fixture(({ file, run }) => {
  file('domain/owned.test.mjs', "import test from 'node:test'; test('domain-owned-fixture',()=>{});\n");
  file('providers/perchance/owned.test.mjs', "import test from 'node:test'; test('provider-owned-fixture',()=>{});\n");
  file('governance/already-ran.test.mjs', "throw new Error('governance is run separately');\n");
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /domain-owned-fixture/); assert.match(result.stdout, /provider-owned-fixture/);
  assert.doesNotMatch(result.stdout, /governance is run separately/);
}));
test('a failing owned phase test fails CI; an empty G0 reports no feature acceptance', () => fixture(({ file, run }) => {
  file('governance/already-ran.test.mjs', '// fixture\n');
  const empty = run(); assert.equal(empty.status, 0); assert.match(empty.stdout, /no feature acceptance/);
  file('ui-shell/failure.test.mjs', "import test from 'node:test'; test('phase-failure-fixture',()=>{throw new Error('fixture fault')});\n");
  const failure = run(); assert.notEqual(failure.status, 0); assert.match(failure.stdout, /phase-failure-fixture/);
}));
