import assert from 'node:assert/strict';
import test from 'node:test';
import { acquire, load, validateSnapshot, validateTransition } from '../../../tools/alpha/governance.mjs';

const MAIN = 'c'.repeat(40);

// Build synthetic governance states from the accepted plan and current contract,
// not from an arbitrary historical count of active claims on checkout HEAD.
function initial() {
  const state = structuredClone(load());
  state.registry = {
    schemaVersion: 1,
    epochs: Object.fromEntries(state.plan.phases.map(phase => [phase.id, 0])),
    claims: []
  };
  state.plan.bootstrap.state = 'ACCEPTED';
  state.plan.bootstrap.evidence = 'docs/evidence/alpha/G0/independent-ci.json';
  for (const phase of state.plan.phases) phase.status = phase.round === 1 ? 'READY' : 'LOCKED';
  for (const round of state.plan.rounds) round.status = round.round === 1 ? 'READY' : 'LOCKED';
  assert.equal(validateSnapshot(state).activeClaims, 0);
  return state;
}

test('all thirty legitimate phase acquisitions and six round gates remain valid', () => {
  let state = initial();
  const rounds = structuredClone(state.plan.rounds);
  for (const round of rounds) {
    for (const [slot, phaseId] of round.phaseIds.entries()) {
      const agentId = `lifecycle-agent-${slot + 1}`;
      const previous = state;
      const expectedEpoch = previous.registry.epochs[phaseId];
      const next = acquire(previous, { phaseId, agentId, expectedEpoch, baseMainSha: MAIN });
      const context = {
        schemaVersion: 1, kind: 'CLAIM', action: 'acquire', phaseId,
        agentId, branch: `agent/${agentId}/${phaseId.toLowerCase()}`,
        expectedEpoch, claimEpoch: expectedEpoch + 1, baseMainSha: MAIN
      };
      assert.equal(validateTransition(previous, next, context, {
        mainSha: MAIN, headBranch: context.branch,
        files: ['docs/implementation/alpha/claims.json']
      }).kind, 'CLAIM', phaseId);
      assert.throws(() => validateTransition(previous, next, context, {
        mainSha: 'd'.repeat(40), headBranch: context.branch,
        files: ['docs/implementation/alpha/claims.json']
      }), /exact current main/, `stale main: ${phaseId}`);
      state = next;
    }
    assert.equal(validateSnapshot(state).activeClaims, 5, round.id);

    const accepted = structuredClone(state);
    accepted.plan.rounds.find(r => r.id === round.id).status = 'ACCEPTED';
    for (const phaseId of round.phaseIds) {
      accepted.plan.phases.find(p => p.id === phaseId).status = 'ACCEPTED';
      accepted.registry.claims.find(c => c.phaseId === phaseId && c.state === 'ACTIVE').state = 'ACCEPTED';
    }
    const successor = accepted.plan.rounds.find(r => r.round === round.round + 1);
    if (successor) {
      successor.status = 'READY';
      for (const phaseId of successor.phaseIds)
        accepted.plan.phases.find(p => p.id === phaseId).status = 'READY';
    }
    const gateContext = {
      schemaVersion: 1, kind: 'GATE', phaseId: round.gateId,
      agentId: 'lifecycle-checker', claimEpoch: 1,
      baseMainSha: MAIN, branch: `agent/lifecycle-checker/${round.gateId.toLowerCase()}`
    };
    assert.equal(validateTransition(state, accepted, gateContext, {
      mainSha: MAIN, headBranch: gateContext.branch,
      files: [`docs/evidence/alpha/${round.gateId}/independent-ci.json`]
    }).kind, 'GATE', round.gateId);
    assert.equal(validateSnapshot(accepted).activeClaims, 0, round.gateId);
    assert.throws(() => validateTransition(state, accepted, gateContext, {
      mainSha: MAIN, headBranch: gateContext.branch,
      files: ['extension/alpha/providers/perchance/adapter.mjs']
    }), /outside ownership/, round.gateId);
    state = accepted;
  }
  assert.equal(state.plan.phases.filter(p => p.status === 'ACCEPTED').length, 30);
  assert.equal(state.plan.rounds.filter(r => r.status === 'ACCEPTED').length, 6);
  assert.equal(state.registry.claims.length, 30);
});
