import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { load, acquire, validateTransition, validateSnapshot, MAINTENANCE } from '../../../tools/alpha/governance.mjs';
import { approvalBody, verifyMaintenanceApproval } from '../../../tools/alpha/maintenance-approval.mjs';

// This suite proves the historical maintenance authorization, not today's
// mutable claim registry. Never derive a past gate's inputs from checkout HEAD.
const context = JSON.parse(readFileSync('docs/evidence/alpha/MAINT-ALPHA-GOV-001/context.json', 'utf8'));
const sha = context.baseMainSha;
const main = load('.', sha);
const contextPath = `docs/evidence/alpha/${context.maintenanceId}/context.json`;
const changed = [contextPath, 'tests/alpha/governance/contract-amendment.test.mjs',
  'tools/alpha/governance.mjs', 'tools/alpha/ci.mjs'];
const check = (next = main, ctx = context, files = changed, base = sha, branch = context.branch) =>
  validateTransition(main, next, ctx, { mainSha: base, headBranch: branch, files });

test('maintenance transition is narrow, owner-attested, exact-main and preserves live state', () => {
  assert.equal(validateSnapshot(main).activeClaims, 4);
  assert.equal(main.plan.phases.find(p => p.id === 'P103').status, 'READY');
  assert.equal(check().kind, 'MAINTENANCE');
  assert.equal(MAINTENANCE.authority, 'OWNER_PR_COMMENT_V1');
  assert.equal(main.lock.contracts['alpha.contracts.v1'], context.contractHash);
  assert.deepEqual(main.registry.epochs, context.claimEpochs);
});
test('maintenance cannot be impersonated by a phase, alternate branch or unsigned context', () => {
  for (const fields of [
    { kind: 'PHASE', phaseId: 'P101', agentId: 'slot-one' },
    { agentId: 'slot-one' }, { phaseId: 'P101' },
    { branch: 'agent/slot-one/p101' }, { maintenanceId: 'MAINT-OTHER' },
    { authorization: 'self-approved' }, { claimEpoch: 1 },
    { pullRequest: 0 }, { pullRequest: '20' },
    { baseMainSha: 'a'.repeat(40) },
    { contractHash: 'b'.repeat(64) },
    { claimEpochs: { ...context.claimEpochs, P103: 1 } }
  ]) assert.throws(() => check(main, { ...context, ...fields }));
  assert.throws(() => check(main, context, changed, 'a'.repeat(40)), /exact current main/);
  assert.throws(() => check(main, context, changed, sha, 'agent/slot-one/p101'), /branch/);
});
test('maintenance cannot modify contracts, claims, plan status, policy or acceptance', () => {
  for (const mutation of [
    s => s.lock.contracts['alpha.contracts.v1'] = 'f'.repeat(64),
    s => s.registry.epochs.P103++,
    s => s.registry.claims[0].agentId = 'attacker',
    s => s.registry.claims[0].writePaths.push('extension/**'),
    s => s.registry.claims[0].contractReads['alpha.contracts.v1'] = 'f'.repeat(64),
    s => s.plan.phases.find(p => p.id === 'P103').status = 'CLAIMED',
    s => s.plan.phases.find(p => p.id === 'P101').status = 'ACCEPTED',
    s => s.plan.rounds[1].status = 'READY',
    s => s.policies.claims.epochFencing = false
  ]) {
    const after = structuredClone(main);
    mutation(after);
    assert.throws(() => check(after));
  }
});
test('maintenance rejects unrelated and phase-owned file paths', () => {
  for (const path of [
    'AGENTS.md', 'package.json', 'docs/implementation/alpha/claims.json',
    'docs/implementation/alpha/plan.json', 'docs/implementation/alpha/contracts.lock.json',
    'docs/implementation/alpha/policies.json', 'extension/alpha/providers/github/adapter.js',
    'extension/alpha/providers/perchance/adapter.js', 'extension/alpha/contracts/index.d.ts',
    'tests/alpha/providers/perchance/new.test.mjs', 'docs/evidence/alpha/P103/context.json',
    '.github/workflows/alpha-governance.yml', 'docs/evidence/alpha/MAINT-OTHER/context.json'
  ]) assert.throws(() => check(main, context, [...changed, path]), /outside ownership/);
  assert.throws(() => check(main, context, ['tools/alpha/ci.mjs']), /own new context/);
});
test('phase authorization cannot be used to change maintenance tests', () => {
  const c = main.registry.claims.find(c => c.phaseId === 'P101');
  const phase = { schemaVersion: 1, kind: 'PHASE', phaseId: 'P101',
    agentId: c.agentId, branch: c.branch, claimEpoch: c.claimEpoch, baseMainSha: c.baseMainSha };
  assert.throws(() => validateTransition(main, main, phase, {
    mainSha: sha, headBranch: phase.branch, files: ['tests/alpha/governance/maintenance.test.mjs']
  }), /outside ownership/);
});
test('GitHub owner approval is tied to exact PR head and main, never candidate-authored strings', async () => {
  const approvedHeadSha = 'c'.repeat(40);
  const body = approvalBody({ maintenanceId: context.maintenanceId, baseMainSha: sha, approvedHeadSha });
  const pr = { base: { ref: 'main' }, head: { ref: context.branch, sha: approvedHeadSha } };
  const comment = { user: { login: 'Neb963' }, author_association: 'OWNER', body };
  const fake = (record = pr, comments = [comment]) => async url => ({
    ok: true, status: 200, async json() { return url.includes('/pulls/') ? record : comments; }
  });
  const args = { repository: 'Neb963/PersonaMonkey-PCMS-Alpha', mainSha: sha, approvedHeadSha };
  assert.equal((await verifyMaintenanceApproval(context, { ...args, request: fake() })).approved, true);
  for (const c of [
    { ...comment, user: { login: 'attacker' } },
    { ...comment, author_association: 'CONTRIBUTOR' },
    { ...comment, body: body.replace(approvedHeadSha, 'd'.repeat(40)) },
    { ...comment, body: 'approved' }
  ]) await assert.rejects(verifyMaintenanceApproval(context, { ...args, request: fake(pr, [c]) }), /Missing exact/);
  await assert.rejects(verifyMaintenanceApproval(context, { ...args, request: fake({ ...pr,
    head: { ...pr.head, sha: 'd'.repeat(40) } }) }), /differs from exact candidate/);
  await assert.rejects(verifyMaintenanceApproval(context, { ...args, mainSha: 'd'.repeat(40),
    request: fake() }), /Invalid maintenance approval/);
  await assert.rejects(verifyMaintenanceApproval(context, { ...args,
    request: async () => ({ ok: false, status: 403 }) }), /Cannot independently verify/);
});

test('historical maintenance stays valid through new claims and later owner-attested maintenance', () => {
  // A normal fifth claim must not retroactively change a completed maintenance.
  const acquired = acquire(main, {
    phaseId: 'P103', agentId: 'slot-three-p103', expectedEpoch: 0,
    baseMainSha: 'a'.repeat(40)
  });
  assert.equal(validateSnapshot(acquired).activeClaims, 5);
  assert.equal(check().kind, 'MAINTENANCE');
  assert.throws(() => check(acquired), /Maintenance cannot change plans, claims/);

  // A new independently attested maintenance transaction is legal against
  // the then-current (five-claim) registry; the old context is not reusable.
  const maintenanceId = 'MAINT-FUTURE-CLAIMS-003';
  const futureSha = 'b'.repeat(40);
  const futureContext = {
    ...context, phaseId: maintenanceId, maintenanceId,
    branch: 'agent/alpha-maintenance/maint-future-claims-003',
    baseMainSha: futureSha, contractHash: acquired.lock.contracts['alpha.contracts.v1'],
    claimEpochs: structuredClone(acquired.registry.epochs), pullRequest: 12345
  };
  const futureFiles = [
    `docs/evidence/alpha/${maintenanceId}/context.json`,
    'tests/alpha/governance/maintenance.test.mjs'
  ];
  assert.equal(validateTransition(acquired, acquired, futureContext, {
    mainSha: futureSha, headBranch: futureContext.branch, files: futureFiles
  }).kind, 'MAINTENANCE');
  assert.throws(() => validateTransition(acquired, acquired, {
    ...futureContext, claimEpochs: context.claimEpochs
  }, {
    mainSha: futureSha, headBranch: futureContext.branch, files: futureFiles
  }), /Stale maintenance contracts or claim epochs/);
});
