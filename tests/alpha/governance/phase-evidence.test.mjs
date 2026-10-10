import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPhaseEvidence, validatePublishedPhaseEvidence } from '../../../tools/alpha/governance.mjs';

const mainSha = 'a'.repeat(40), implementationSha = 'b'.repeat(40);
const required = ['alpha-governance', 'firefox-developer-edition'];
const phase = { id: 'P301', acceptanceIds: ['AP301-01', 'AP301-02', 'AP301-03'] };
const claim = { claimId: 'CLM-P301-001', agentId: 'agent-one', claimEpoch: 1 };
const proof = (name, id) => ({ name, id, sha: mainSha, event: 'push', conclusion: 'success' });
const valid = () => ({
  phaseId: 'P301', state: 'MERGED', claimId: claim.claimId,
  agentId: claim.agentId, claimEpoch: 1, providerLive: false,
  commitSha: implementationSha, mergedMainSha: mainSha,
  acceptanceIds: [...phase.acceptanceIds],
  ciRuns: [proof(required[0], 11), proof(required[1], 12)]
});
const validate = (record, ancestor = () => true) =>
  validatePublishedPhaseEvidence(record, phase, claim, required, ancestor);

test('published phase evidence uses exactly one shared gate schema', () => {
  assert.equal(validate(valid()), true);
  for (const edit of [
    r => { delete r.commitSha; },
    r => { r.claimEpoch = 0; },
    r => { r.claimId = 'CLM-P301-002'; },
    r => { r.agentId = 'other'; },
    r => { r.state = 'CI_VERIFIED'; },
    r => { r.providerLive = true; },
    r => { r.acceptanceIds.pop(); },
    r => { r.acceptanceIds.push('AP301-04'); },
    r => { r.ciRuns.push(proof('alpha-firefox', 13)); },
    r => { r.ciRuns.push(proof(required[0], 14)); },
    r => { r.ciRuns = [r.ciRuns[0]]; },
    r => { r.ciRuns[0].sha = 'c'.repeat(40); },
    r => { r.ciRuns[0].id = 0; },
    r => { r.ciRuns[0].event = 'pull_request'; },
    r => { r.ciRuns[0].conclusion = 'failure'; },
    r => { r.mergedMainSha = 'not-a-sha'; }
  ]) {
    const r = valid();
    edit(r);
    assert.throws(() => validate(r), 'Invalid phase evidence must fail before the gate');
  }
  assert.throws(() => validate(valid(), sha => sha !== implementationSha),
    /not ancestors/);
  assert.throws(() => validate(valid(), sha => sha !== mainSha),
    /not ancestors/);
});

const repo = 'Neb963/PersonaMonkey-PCMS-Alpha';
const runs = () => required.map((name, i) => ({
  id: i + 100, name, head_sha: mainSha, event: 'push',
  status: 'completed', conclusion: 'success',
  repository: { full_name: repo }, html_url: 'https://github.com/example/run/' + i
}));
const fetchWith = (workflow_runs, ok = true) => async url => ({
  ok, async json() { return { workflow_runs }; },
  url
});
const args = (workflow_runs, verified = []) => ({
  phaseId: 'P301', commitSha: implementationSha, mergedMainSha: mainSha,
  requiredWorkflows: required, fetchImpl: fetchWith(workflow_runs),
  token: null, verify: async proof => { verified.push(proof); }
});

test('automatic evidence derives both exact push runs and independently verifies them', async () => {
  const observed = [];
  const record = await collectPhaseEvidence(args(runs(), observed));
  assert.deepEqual(record.ciRuns.map(p => p.id), [100, 101]);
  assert.deepEqual(observed, record.ciRuns);
  assert.equal(record.providerLive, false);
  assert.equal(record.commitSha, implementationSha);
  assert.equal(validate({ ...valid(), ...record, state: 'MERGED' }), true);
});

test('automatic evidence fails closed for missing, stale, failed or forged CI', async () => {
  const variations = [
    r => { r.pop(); },
    r => { r[0].head_sha = 'c'.repeat(40); },
    r => { r[0].event = 'pull_request'; },
    r => { r[0].conclusion = 'failure'; },
    r => { r[0].status = 'in_progress'; },
    r => { r[0].repository.full_name = 'attacker/repo'; },
    r => { r[0].id = 0; },
    r => { r.unshift({ ...r[0], conclusion: 'failure', id: 999 }); }
  ];
  for (const mutate of variations) {
    const r = runs();
    mutate(r);
    await assert.rejects(collectPhaseEvidence(args(r)), /Missing latest successful/);
  }
  await assert.rejects(collectPhaseEvidence({ ...args(runs()), fetchImpl: fetchWith(runs(), false) }),
    /Cannot list/);
  await assert.rejects(collectPhaseEvidence({
    ...args(runs()), verify: async () => { throw new Error('independent run rejected'); }
  }), /independent run rejected/);
  await assert.rejects(collectPhaseEvidence({ ...args(runs()), repository: 'attacker/repo' }),
    /Invalid phase proof request/);
  await assert.rejects(collectPhaseEvidence({ ...args(runs()), commitSha: 'invalid' }),
    /Invalid phase proof request/);
});
