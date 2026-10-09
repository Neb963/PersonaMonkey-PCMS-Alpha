import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('real Git fixtures serialize five CLI claims, reject a resumed old epoch and reject a competing main push', { timeout: 90000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'alpha-governance-git-fixture-'));
  const work = join(temp, 'work'), bare = join(temp, 'remote.git');
  const env = { ...process.env, GITHUB_ACTIONS: 'false', ALPHA_EVENT: 'local' };
  delete env.ALPHA_HEAD_SHA; delete env.ALPHA_HEAD_BRANCH;
  function run(command, args, cwd = work) { return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 }); }
  const git = (...args) => run('git', args).trim();
  const claim = (...args) => run(process.execPath, ['tools/alpha/claim.mjs', ...args]);
  function save(path, value) { writeFileSync(join(work, path), JSON.stringify(value, null, 2) + '\n'); }
  function commit(message) { git('add', '-A'); git('commit', '-qm', message); }
  try {
    run('git', ['clone', '--no-hardlinks', '--quiet', resolve('.'), work], temp);
    run('git', ['init', '--bare', '--quiet', bare], temp);
    git('remote', 'set-url', 'origin', bare);
    git('config', 'user.name', 'Governance fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('switch', '-C', 'main');
    const plan = JSON.parse(readFileSync(join(work, 'docs/implementation/alpha/plan.json')));
    // A test-only accepted prerequisite. This fixture never updates the real repository.
    plan.bootstrap.state = 'ACCEPTED'; plan.bootstrap.evidence = 'docs/evidence/alpha/G0/independent-ci.json';
    for (const p of plan.phases) p.status = p.round === 1 ? 'READY' : 'LOCKED';
    for (const r of plan.rounds) r.status = r.round === 1 ? 'READY' : 'LOCKED';
    save('docs/implementation/alpha/plan.json', plan);
    run(process.execPath, ['tools/generate-views.mjs']); commit('fixture prerequisite'); git('push', 'origin', 'HEAD:main');
    for (let i = 1; i <= 5; i++) {
      git('fetch', 'origin', 'main'); git('switch', '-C', `agent/worker-${i}/p10${i}`, 'origin/main');
      claim('acquire', '--phase', `P10${i}`, '--agent', `worker-${i}`, '--epoch', '0');
      commit(`fixture claim ${i}`); git('push', 'origin', 'HEAD:main');
    }
    const registry = JSON.parse(readFileSync(join(work, 'docs/implementation/alpha/claims.json')));
    assert.equal(registry.claims.filter(c => c.state === 'ACTIVE').length, 5);
    git('switch', '-C', 'agent/worker-1/p101', 'origin/main');
    claim('context', '--phase', 'P101', '--agent', 'worker-1', '--epoch', '1');
    const oldContext = JSON.parse(readFileSync(join(work, 'docs/evidence/alpha/P101/context.json')));
    mkdirSync(join(work, 'tests/alpha/browser-baseline'), { recursive: true });
    writeFileSync(join(work, 'tests/alpha/browser-baseline/fixture.mjs'), '// test-only owned fixture\n');
    commit('fixture product candidate');
    assert.equal(JSON.parse(run(process.execPath, ['tools/alpha/ci.mjs']).trim().split('\n').at(-1)).passed, true);
    git('switch', '-C', 'agent/replacement/p101', 'origin/main');
    claim('reassign', '--phase', 'P101', '--agent', 'replacement', '--epoch', '1');
    commit('fixture reassignment'); git('push', 'origin', 'HEAD:main'); git('fetch', 'origin', 'main');
    git('switch', '-C', 'agent/worker-1/p101', 'origin/main');
    save('docs/evidence/alpha/P101/context.json', oldContext); commit('fixture resumed stale claimant');
    const stale = spawnSync(process.execPath, ['tools/alpha/ci.mjs'], { cwd: work, env, encoding: 'utf8' });
    assert.notEqual(stale.status, 0); assert.match(stale.stderr, /Stale epoch/);
    const base = git('rev-parse', 'origin/main');
    git('switch', '-C', 'race-a', base); writeFileSync(join(work, 'race-a.txt'), 'fixture\n'); commit('fixture competing main a');
    const first = git('rev-parse', 'HEAD');
    git('switch', '-C', 'race-b', base); writeFileSync(join(work, 'race-b.txt'), 'fixture\n'); commit('fixture competing main b');
    git('push', 'origin', `${first}:main`);
    const race = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: work, env, encoding: 'utf8' });
    assert.notEqual(race.status, 0); assert.match(race.stderr, /non-fast-forward|fetch first/);
    assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], first);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
