import test from 'node:test';
import assert from 'node:assert/strict';
import { load, validateTransition, P303_REPAIR } from '../../../tools/alpha/governance.mjs';

// The repair leaves accepted R3 and the active R4 agents completely unchanged.
// Ownership is deliberately more restrictive than the original P303 claim.
const main = load('.');
const mainSha = 'a'.repeat(40);
const context = {
  schemaVersion: 1, kind: 'REPAIR', phaseId: 'P303', repairId: 'P303-ISSUE85',
  issueNumber: 85, agentId: 'p303-repair', branch: P303_REPAIR.branch,
  claimEpoch: 1, baseMainSha: mainSha,
  contractHash: main.lock.contracts['alpha.contracts.v1'],
  authorization: P303_REPAIR.maintenanceId
};
const paths = [P303_REPAIR.contextPath, ...P303_REPAIR.codePaths];
const validate = (c = context, h = main, files = paths, base = mainSha) =>
  validateTransition(main, h, c, { mainSha: base, headBranch: P303_REPAIR.branch, files });

test('issue-85 repair is accepted only as a one-time bounded R3 correction', () => {
  assert.equal(main.plan.phases.find(p => p.id === 'P303').status, 'ACCEPTED');
  assert.equal(main.plan.rounds.find(r => r.id === 'R3').status, 'ACCEPTED');
  assert.equal(validate().kind, 'REPAIR');
  assert.equal(main.registry.epochs.P303, 1);
  assert.deepEqual(P303_REPAIR.codePaths, [
    'extension/alpha/features/ai/controller.mjs',
    'tests/alpha/ai/controller.test.mjs'
  ]);
});

test('repair cannot change plan/claims/contracts/policies or steal active R4 paths', () => {
  for (const mutate of [
    s => {s.plan.phases.find(p => p.id === 'P303').status = 'CLAIMED';},
    s => {s.registry.epochs.P303 += 1;},
    s => {s.registry.claims.find(c => c.phaseId === 'P403').state = 'RELEASED';},
    s => {s.lock.contracts['alpha.contracts.v1'] = 'b'.repeat(64);},
    s => {s.policies.claims.epochFencing = false;}
  ]) { const altered = structuredClone(main); mutate(altered); assert.throws(() => validate(context, altered)); }
  for (const path of [
    'extension/alpha/features/deployer/service.mjs',
    'extension/alpha/flows/release/main.mjs',
    'extension/alpha/features/attention/inbox.mjs',
    'docs/evidence/alpha/P303/acceptance.json',
    'docs/implementation/alpha/claims.json',
    'tools/alpha/governance.mjs'
  ]) assert.throws(() => validate(context, main, [...paths, path]), /outside ownership/);
  assert.throws(() => validate(context, main, P303_REPAIR.codePaths), /own context/);
});

test('repair authority is specific to issue, accepted epoch, branch and exact current main', () => {
  for (const change of [
    {kind:'PHASE'}, {repairId:'P303-OTHER'}, {issueNumber:86},
    {agentId:'slot-three-r4'}, {claimEpoch:2}, {branch:'repair/other'},
    {authorization:'unapproved'}, {contractHash:'b'.repeat(64)}
  ]) assert.throws(() => validate({...context,...change}));
  assert.throws(() => validate(context,main,paths,'b'.repeat(40)), /exact current main/);
  assert.throws(() => validateTransition(main, main, context, {
    mainSha, headBranch: 'agent/foreign/p303', files: paths
  }), /branch/);
});
