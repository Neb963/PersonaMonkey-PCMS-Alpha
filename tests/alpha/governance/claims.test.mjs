import assert from 'node:assert/strict';
import test from 'node:test';
import { load, validateSnapshot, acquire, validateTransition, checkConflicts, overlaps, pathPrefix } from '../../../tools/alpha/governance.mjs';

const seeded = load();
const sha = '1'.repeat(40), newer = '2'.repeat(40);
function accepted() {
  const s = structuredClone(seeded);
  s.plan.bootstrap.state = 'ACCEPTED';
  s.plan.bootstrap.evidence = 'docs/evidence/alpha/G0/independent-ci.json';
  for (const p of s.plan.phases) p.status = p.round === 1 ? 'READY' : 'LOCKED';
  for (const r of s.plan.rounds) r.status = r.round === 1 ? 'READY' : 'LOCKED';
  return s;
}
function claim(s, phaseId, agentId, expectedEpoch = 0) { return acquire(s, { phaseId, agentId, expectedEpoch, baseMainSha: sha }); }
function token(s, phaseId = 'P101') {
  const c = s.registry.claims.find(c => c.phaseId === phaseId && c.state === 'ACTIVE');
  return { schemaVersion: 1, kind: 'PHASE', phaseId, agentId: c.agentId, claimEpoch: c.claimEpoch, baseMainSha: c.baseMainSha, branch: c.branch };
}
function transition(main, head, context, files, mainSha = sha) { return validateTransition(main, head, context, { mainSha, headBranch: context.branch, files }); }

test('G0 is serialized: all phase acquisition is rejected before acceptance', () => {
  const before = accepted(); before.plan.bootstrap.state = 'IN_PROGRESS';
  for (const p of before.plan.phases) p.status = 'LOCKED';
  for (const r of before.plan.rounds) r.status = 'LOCKED';
  assert.equal(validateSnapshot(before).activeClaims, 0);
  assert.throws(() => claim(before, 'P101', 'one'), /unavailable/);
  const tampered = structuredClone(before); tampered.plan.phases[0].status = 'READY';
  assert.throws(() => validateSnapshot(tampered), /Unmet dependency/);
});
test('five R1 claims are possible, disjoint and independently owned after G0', () => {
  let s = accepted();
  for (let i = 1; i <= 5; i++) s = claim(s, `P10${i}`, `agent-${i}`);
  assert.equal(validateSnapshot(s).activeClaims, 5);
  assert.deepEqual(Object.values(s.registry.epochs).filter(x => x > 0), [1, 1, 1, 1, 1]);
  assert.equal(s.plan.phases.filter(p => p.round > 1).every(p => p.status === 'LOCKED'), true);
});
test('unassigned, unknown, later-round and unmet dependency acquisitions fail', () => {
  for (const id of ['P000', 'P106', 'P201', 'P601']) assert.throws(() => claim(accepted(), id, 'agent-one'), /unavailable/);
});
test('one agent cannot acquire two phases; one phase cannot have two owners', () => {
  const s = claim(accepted(), 'P101', 'one');
  assert.throws(() => claim(s, 'P102', 'one'), /already has an active claim/);
  assert.throws(() => claim(s, 'P101', 'two', 1), /already claimed/);
});
test('reassignment increments the epoch and fences resumed old tokens', () => {
  const old = claim(accepted(), 'P101', 'one');
  const latest = acquire(old, { phaseId: 'P101', agentId: 'two', expectedEpoch: 1, baseMainSha: newer, action: 'reassign' });
  assert.equal(latest.registry.epochs.P101, 2);
  assert.equal(latest.registry.claims[0].state, 'REASSIGNED');
  assert.throws(() => transition(latest, latest, token(old), ['tests/alpha/browser-baseline/old.test.mjs'], newer), /Stale epoch/);
  const stale = structuredClone(latest); stale.registry.claims[1].claimEpoch = 1;
  assert.throws(() => validateSnapshot(stale), /claim ID|Stale active/);
});
test('exact current main serializes acquisition and prevents lost concurrent claims', () => {
  const base = accepted(), head = claim(base, 'P101', 'one');
  const context = { ...token(head), kind: 'CLAIM', action: 'acquire', expectedEpoch: 0 };
  assert.equal(transition(base, head, context, ['docs/implementation/alpha/claims.json']).phaseId, 'P101');
  assert.throws(() => transition(base, head, context, [], newer), /exact current main/);
  const competing = claim(base, 'P102', 'two');
  assert.throws(() => transition(competing, head, context, []), /differs from serialized acquisition/);
});
test('claim acquisition PRs cannot include product code', () => {
  const base = accepted(), head = claim(base, 'P101', 'one');
  const context = { ...token(head), kind: 'CLAIM', action: 'acquire', expectedEpoch: 0 };
  assert.throws(() => transition(base, head, context, ['extension/alpha/core/start.js']), /outside ownership/);
});
test('a phase must retain current-main registry and cannot widen its own scope', () => {
  const main = claim(accepted(), 'P101', 'one'), context = token(main);
  assert.equal(transition(main, main, context, ['tests/alpha/browser-baseline/smoke.mjs']).phaseId, 'P101');
  for (const path of ['package.json', 'AGENTS.md', 'extension/alpha/storage/db.js', 'docs/evidence/alpha/P102/proof.json', 'docs/implementation/alpha/plan.json']) assert.throws(() => transition(main, main, context, [path]), /outside ownership/);
  const widened = structuredClone(main); widened.registry.claims[0].writePaths.push('extension/**');
  assert.throws(() => transition(main, widened, context, ['extension/background.js']), /widens/);
  assert.throws(() => transition(main, main, { ...context, agentId: 'two' }, []), /wrong owner/);
});
test('branch identity, acquisition epochs and contract assumptions are fenced', () => {
  const main = claim(accepted(), 'P101', 'one'), context = token(main);
  assert.throws(() => validateTransition(main, main, context, { mainSha: sha, headBranch: 'agent/two/p101', files: [] }), /branch/);
  assert.throws(() => claim(main, 'P101', 'two', 0), /Stale acquisition/);
  const stale = structuredClone(main); stale.registry.claims[0].contractReads['alpha.contracts.v1'] = '0'.repeat(64);
  assert.throws(() => validateSnapshot(stale), /Stale contract read/);
  const changed = structuredClone(main); changed.lock.contracts['alpha.contracts.v1'] = '0'.repeat(64); changed.registry.claims[0].contractReads['alpha.contracts.v1'] = '0'.repeat(64);
  assert.throws(() => transition(main, changed, context, []), /Frozen shared contracts/);
});
test('unsafe paths, globs, traversal and ancestor overlap fail closed', () => {
  for (const p of ['/tmp/x', '../x', 'a/../b', 'a\\b', 'a/*/b', 'a/**/b', 'C:x', 'a//b', 'a/ b', 'a/']) assert.throws(() => pathPrefix(p), /Unsafe/);
  assert.equal(overlaps('extension/alpha/storage/**', 'extension/alpha/storage/db.js'), true);
  assert.equal(overlaps('tests/alpha/providers/github/**', 'tests/alpha/providers/perchance/**'), false);
  assert.equal(overlaps('a', 'a/b'), true);
});
test('overlap, contract writers, exclusive resources and migration slots conflict', () => {
  let s = claim(claim(accepted(), 'P101', 'one'), 'P102', 'two');
  const [a, b] = s.registry.claims;
  assert.throws(() => checkConflicts(a, { ...b, writePaths: ['tests/alpha/browser-baseline/**'] }), /overlap/);
  assert.throws(() => checkConflicts({ ...a, contractWrites: ['alpha.contracts.v1'] }, b), /Contract write\/read/);
  assert.throws(() => checkConflicts({ ...a, exclusiveResources: ['db'] }, { ...b, exclusiveResources: ['db'] }), /resource conflict/);
  assert.throws(() => checkConflicts({ ...a, migrationSlots: ['one'] }, { ...b, migrationSlots: ['one'] }), /Migration slot/);
});
test('malformed authority and dependency cycles cannot unlock a round', () => {
  const cases = [s => s.plan.designOnly = true, s => s.registry.epochs.P101 = -1, s => s.plan.rounds[1].status = 'READY', s => s.plan.phases.push(s.plan.phases[0]), s => s.plan.phases[10].dependsOn = ['P301']];
  for (const change of cases) { const s = accepted(); change(s); assert.throws(() => validateSnapshot(s)); }
});
test('initial bootstrap cannot self-accept or acquire any phase', () => {
  const head = structuredClone(seeded);
  head.plan.bootstrap.state = 'IN_PROGRESS';
  for (const p of head.plan.phases) p.status = 'LOCKED';
  for (const r of head.plan.rounds) r.status = 'LOCKED';
  const context = { schemaVersion: 1, kind: 'BOOTSTRAP', phaseId: 'G0', ...head.plan.bootstrap };
  assert.equal(transition(null, head, context, [], context.baseMainSha).phaseId, 'G0');
  head.plan.bootstrap.state = 'ACCEPTED';
  assert.throws(() => transition(null, head, context, [], context.baseMainSha), /pre-accept/);
});
test('a gate accepts only its own five phases and unlocks only the next round', () => {
  let main = accepted();
  for (let i = 1; i <= 5; i++) main = claim(main, `P10${i}`, `agent-${i}`);
  const head = structuredClone(main);
  for (const p of head.plan.phases) if (p.round === 1) p.status = 'ACCEPTED'; else if (p.round === 2) p.status = 'READY';
  for (const c of head.registry.claims) c.state = 'ACCEPTED';
  head.plan.rounds[0].status = 'ACCEPTED'; head.plan.rounds[1].status = 'READY';
  const context = { schemaVersion: 1, kind: 'GATE', phaseId: 'GATE-R1', agentId: 'checker', branch: 'agent/checker/gate-r1', baseMainSha: sha, claimEpoch: 1 };
  assert.equal(transition(main, head, context, ['docs/evidence/alpha/GATE-R1/independent-ci.json']).phaseId, 'GATE-R1');
  assert.throws(() => transition(main, head, context, ['extension/alpha/core/background.js']), /outside ownership/);
  const tooFar = structuredClone(head); tooFar.plan.rounds[2].status = 'READY';
  assert.throws(() => transition(main, tooFar, context, []), /Previous round|immediate successor/);
});
