import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { materializeDonor, DONOR } from '../../../tools/alpha/ci-migration/donor.mjs';
import { verifyDerivative, P201_FILE, P201_CASES } from '../../../tools/alpha/ci-migration/policy.mjs';

const root = resolve('.'), env = { ...process.env };
delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
const command = (cwd, executable, args) => spawnSync(executable, args,
  { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000 });
async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'alpha-ci-migration-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function derivative(dir) {
  await cp(join(root, 'extension'), join(dir, 'extension'), { recursive: true });
  const bootstrap = 'extension/lib/recovery-bootstrap.js';
  await mkdir(join(dir, 'docs/legacy/donor/extension/lib'), { recursive: true });
  await cp(join(root, 'docs/legacy/donor', bootstrap), join(dir, 'docs/legacy/donor', bootstrap));
  for (const args of [['init', '-q'], ['add', '--all'], ['-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'Immutable pre-P201 fixture'], ['update-ref', 'refs/remotes/origin/main', 'HEAD']])
    assert.equal(command(dir, 'git', args).status, 0);
}
async function alpha(dir, keepLegacy = false) {
  await mkdir(join(dir, 'extension/alpha/bootstrap'), { recursive: true });
  await writeFile(join(dir, 'extension/alpha/bootstrap/entry.js'), 'export const fixture = true;\n');
  const file = join(dir, 'extension/lib/recovery-bootstrap.js');
  let source = await readFile(file, 'utf8');
  if (!keepLegacy) source = source.replace(/^import .* from "\.\.\/pcms\/background\/entry.js";\n/m, '')
    .replace('setPcmsPersonaMonkeyBootstrap(bootstrap);', '');
  await writeFile(file, source.replace('from "./routing-gate.js";\n',
    'from "./routing-gate.js";\nimport "../alpha/bootstrap/entry.js";\n'));
}

test('frozen donor tree and XPI are exact; unchanged historical tests detect donor Core regression', async () => {
  await temporary(async dir => {
    const donor = join(dir, 'donor');
    const report = await materializeDonor({ root, authority: root, destination: donor });
    assert.equal(report.donorTree, DONOR.tree); assert.equal(report.xpiSha256, DONOR.xpi);
    const args = ['--test', 'tests/pcms/p028/boundary.test.mjs'];
    const original = await readFile(join(donor, args[1]));
    const pass = command(donor, process.execPath, args);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    const boot = join(donor, 'extension/lib/recovery-bootstrap.js');
    await writeFile(boot, (await readFile(boot, 'utf8')).replace(
      /^import .* from "\.\.\/pcms\/background\/entry.js";\n/m, ''));
    const fail = command(donor, process.execPath, args);
    assert.notEqual(fail.status, 0); assert.match(fail.stdout, /PCMS entry is statically imported/);
    assert.deepEqual(await readFile(join(donor, args[1])), original, 'Historical test bytes were not edited');
  });
});

test('candidate cannot substitute altered donor bytes or branch-controlled donor provenance', async () => {
  await temporary(async dir => {
    const candidate = join(dir, 'candidate');
    await cp(join(root, 'docs/legacy/donor'), join(candidate, 'docs/legacy/donor'), { recursive: true });
    const file = join(candidate, 'docs/legacy/donor/extension/lib/recovery-bootstrap.js');
    await writeFile(file, (await readFile(file, 'utf8')).replace('let recoveryTimer', 'var recoveryTimer'));
    await assert.rejects(materializeDonor({ root: candidate, authority: root, destination: join(dir, 'bad-donor') }),
      /Frozen donor (file or size|blob) changed/);
    await mkdir(join(candidate, 'docs/provenance'), { recursive: true });
    const manifest = JSON.parse(await readFile(join(root, 'docs/provenance/alpha-donor.json')));
    manifest.commitSha = 'a'.repeat(40);
    await writeFile(join(candidate, 'docs/provenance/alpha-donor.json'), JSON.stringify(manifest));
    // Even supplied false provenance cannot change the helper's fixed product.
    await assert.rejects(materializeDonor({ root: candidate, authority: candidate, destination: join(dir, 'wrong-target') }),
      /Trusted donor provenance differs/);
  });
});

test('the real derivative PersonaMonkey regression detects missing routing authority', async () => {
  await temporary(async dir => {
    await derivative(dir);
    assert.equal((await verifyDerivative(dir, 'origin/main')).p201, 'NOT_IMPLEMENTED');
    const source = await readFile(join(dir, 'extension/lib/recovery-bootstrap.js'), 'utf8');
    await writeFile(join(dir, 'extension/lib/recovery-bootstrap.js'), source.replace(
      /^import .* from "\.\/routing-gate.js";\n/m, ''));
    await assert.rejects(verifyDerivative(dir, 'origin/main'), /missing PersonaMonkey/);
    const args = ['extension/tests/background-routing-init.test.mjs'];
    const failure = command(dir, process.execPath, args);
    assert.notEqual(failure.status, 0, 'The preserved derivative safety test must reject missing gate authority');
  });
});

test('active Alpha Core cannot coexist with reachable legacy Core authority', async () => {
  await temporary(async dir => {
    await derivative(dir); await alpha(dir, true);
    await assert.rejects(verifyDerivative(dir, 'origin/main'), /cannot coexist/);
  });
});

test('Core introduction requires packaged P201 acceptance; deleting implementation cannot downgrade verification', async () => {
  await temporary(async dir => {
    await derivative(dir); await alpha(dir);
    await assert.rejects(verifyDerivative(dir, 'origin/main'), /Required P201 packaged acceptance file is missing/);
    assert.equal(command(dir, 'git', ['add', '--all']).status, 0);
    assert.equal(command(dir, 'git', ['-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-qm', 'Fixture Core introduction']).status, 0);
    assert.equal(command(dir, 'git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']).status, 0);
    await rm(join(dir, 'extension/alpha/bootstrap'), { recursive: true });
    await cp(join(root, 'extension/lib/recovery-bootstrap.js'), join(dir, 'extension/lib/recovery-bootstrap.js'));
    await assert.rejects(verifyDerivative(dir, 'origin/main'), /cannot coexist/);
  });
});

test('real runner events fail for missing, skipped, TODO, failed and wrong-source P201 cases', async () => {
  await temporary(async dir => {
    const file = join(dir, 'packaged.test.mjs');
    const module = pathToFileURL(join(root, 'tools/alpha/ci-migration/policy.mjs')).href;
    const evaluate = async source => {
      await writeFile(file, source);
      const script = `import {run} from 'node:test'; import {validateP201Events} from ${JSON.stringify(module)};
        const events=[]; for await(const e of run({files:[${JSON.stringify(file)}],cwd:${JSON.stringify(dir)},execArgv:[]}))
          if(['test:pass','test:fail','test:summary'].includes(e.type))events.push(e);
        validateP201Events(events,${JSON.stringify(file)});`;
      const runner = join(dir, 'runner.mjs');
      await writeFile(runner, script);
      return command(dir, process.execPath, [runner]);
    };
    const cases = P201_CASES.map(name => `test(${JSON.stringify(name)},()=>{});`);
    for (const source of [
      cases.slice(1).join('\n'),
      cases.join('\n').replace('test(', 'test.skip('),
      cases.join('\n').replace('test(', 'test.todo('),
      cases.join('\n').replace('()=>{}', '()=>{throw new Error("deliberate fixture failure")}'),
      `import ${JSON.stringify(pathToFileURL(join(dir, 'elsewhere.mjs')).href)};`
    ]) {
      await writeFile(join(dir, 'elsewhere.mjs'), "import test from 'node:test';\n" + cases.join('\n'));
      const result = await evaluate("import test from 'node:test';\n" + source);
      assert.notEqual(result.status, 0, 'Invalid test execution must not silently skip acceptance');
      assert.match(result.stderr, /Required P201 case did not execute|P201 tests failed/);
    }
    // This validates runner plumbing using disposable no-op fixtures only.
    // It is never product acceptance or an AP201 PASS.
    const result = await evaluate("import test from 'node:test';\n" + cases.join('\n'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test('status, branch settings, environment flags and alternate CLI modes cannot select easier verification', async () => {
  await temporary(async dir => {
    await derivative(dir); await alpha(dir);
    await mkdir(join(dir, 'docs/implementation/alpha'), { recursive: true });
    await writeFile(join(dir, 'docs/implementation/alpha/plan.json'), '{"P201":"READY"}');
    await writeFile(join(dir, 'ci-settings.json'), '{"target":"donor","skipP201":true}');
    process.env.ALPHA_SKIP_P201 = '1';
    try { await assert.rejects(verifyDerivative(dir, 'origin/main'), /Required P201 packaged acceptance/); }
    finally { delete process.env.ALPHA_SKIP_P201; }
    const result = command(root, process.execPath, ['tools/alpha/ci-migration/core.mjs', '--skip', 'true']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Usage:/);
  });
});

test('each inherited workflow command keeps its donor target and the mandatory derivative job cannot be optional', async () => {
  const original = await readFile(join(root, 'docs/legacy/donor/.github/workflows/firefox.yml'), 'utf8');
  const workflow = await readFile(join(root, '.github/workflows/firefox.yml'), 'utf8');
  for (const match of original.matchAll(/^        run: (npm .+)$/gm)) {
    assert.ok(workflow.includes(`working-directory: \${{ runner.temp }}/alpha-frozen-donor\n        run: |\n` +
      `          export GITHUB_SHA=${DONOR.commit}\n          ${match[1]}\n`), match[1]);
  }
  const job = workflow.slice(workflow.indexOf('  alpha-core:\n'));
  assert.match(job, /core.mjs" --root "\$GITHUB_WORKSPACE" --main-ref/);
  assert.match(job, /node tests\/alpha\/browser-baseline\/packaged.mjs/,
    'PersonaMonkey packaged safety must run inside the policy-required Firefox workflow');
  assert.match(job, /node extension\/tests\/background-routing-init.test.mjs/);
  assert.doesNotMatch(job, /continue-on-error:|\n    if:|skipP201|ALPHA_SKIP/);
  assert.match(workflow, /git archive origin\/main tools\/alpha docs\/provenance\/alpha-donor.json/);
  assert.ok(workflow.indexOf('node "$authority_dir/tools/alpha/ci.mjs"') < workflow.indexOf('infra_dir="$GITHUB_WORKSPACE/'));
  const derivativeWorkflow = await readFile(join(root, '.github/workflows/alpha-firefox.yml'), 'utf8');
  assert.match(derivativeWorkflow, /node tests\/alpha\/browser-baseline\/packaged.mjs/);
  assert.match(derivativeWorkflow, /node extension\/tests\/background-routing-init.test.mjs/);
  assert.doesNotMatch(derivativeWorkflow, /tests\/pcms\/p008|tests\/pcms\/p009/);
  assert.equal(P201_FILE, 'tests/alpha/core/packaged.test.mjs');
});
