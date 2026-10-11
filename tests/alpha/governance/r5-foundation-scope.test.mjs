import test from 'node:test';
import assert from 'node:assert/strict';
import {load,validateTransition,R5_FOUNDATION} from '../../../tools/alpha/governance.mjs';

const main = load('.'), sha = 'a'.repeat(40);
function candidate() {
  const head = structuredClone(main), nextHash = 'b'.repeat(64);
  head.lock.contractRevision = R5_FOUNDATION.nextRevision;
  head.lock.contracts['alpha.contracts.v1'] = nextHash;
  for (const c of head.registry.claims) if (['ACTIVE','PR_OPEN'].includes(c.state))
    c.contractReads['alpha.contracts.v1'] = nextHash;
  const context = {
    schemaVersion:1,kind:'R5_FOUNDATION',foundationId:R5_FOUNDATION.id,
    phaseId:R5_FOUNDATION.id,agentId:R5_FOUNDATION.agentId,
    branch:R5_FOUNDATION.branch,claimEpoch:0,
    authorization:R5_FOUNDATION.authorization,baseMainSha:sha,
    previousHash:main.lock.contracts['alpha.contracts.v1'],nextHash,
    contractRevision:R5_FOUNDATION.nextRevision,
    claimEpochs:structuredClone(main.registry.epochs)
  };
  const files=[
    R5_FOUNDATION.contextPath,
    'docs/implementation/alpha/contracts.lock.json',
    'docs/implementation/alpha/CONTRACTS.md',
    'extension/alpha/contracts/index.d.ts',
    'extension/alpha/contracts/surface.json'
  ];
  return {head,context,files};
}
const check=(head,context,files,mainState=main)=>validateTransition(
  mainState,head,context,{mainSha:sha,headBranch:context.branch,files});
test('R5 foundation is a fixed, single-use, contract-versioned scope',()=>{
  const {head,context,files}=candidate();
  assert.equal(check(head,context,files).kind,'R5_FOUNDATION');
  for (const field of [
    {authorization:'self'},{claimEpoch:1},{contractRevision:4},
    {previousHash:'f'.repeat(64)},{nextHash:'f'.repeat(64)},
    {baseMainSha:'c'.repeat(40)},{claimEpochs:{...context.claimEpochs,P502:9}}
  ]) assert.throws(()=>check(head,{...context,...field},files));
});
test('R5 foundation cannot modify phase state, ownership, policy or unrelated product',()=>{
  const {head,context,files}=candidate();
  for (const path of [
    'extension/alpha/flows/supply/service.mjs',
    'extension/alpha/features/accounts/service.mjs',
    'docs/implementation/alpha/plan.json',
    'extension/alpha/providers/perchance/adapter.mjs'
  ]) assert.throws(()=>check(head,context,[...files,path]),/outside ownership/);
  for(const change of [
    h=>h.plan.phases.find(p=>p.id==='P501').status='CLAIMED',
    h=>h.registry.epochs.P502++,
    h=>h.policies.claims.serialized=false
  ]) {
    const tampered=structuredClone(head);change(tampered);
    assert.throws(()=>check(tampered,context,files));
  }
});
test('R5 foundation cannot start after a concurrent R5 claim is published',()=>{
  const {head,context,files}=candidate();
  const acquired=structuredClone(main);
  const phase=acquired.plan.phases.find(p=>p.id==='P502');
  phase.status='CLAIMED';acquired.plan.rounds.find(r=>r.id==='R5').status='IN_PROGRESS';
  const c={
    schemaVersion:1,claimId:'CLM-P502-001',phaseId:'P502',
    agentId:'slot-two-r5',claimEpoch:1,state:'ACTIVE',baseMainSha:sha,
    branch:'agent/slot-two-r5/p502',writePaths:[
      ...phase.ownership.writePaths,'docs/evidence/alpha/P502/**'],
    contractReads:{'alpha.contracts.v1':main.lock.contracts['alpha.contracts.v1']},
    contractWrites:[],exclusiveResources:[],migrationSlots:[],
    acceptanceIds:phase.acceptanceIds
  };
  acquired.registry.epochs.P502=1;acquired.registry.claims.push(c);
  assert.throws(()=>check(head,context,files,acquired),
    /R5 foundation requires accepted R4, unclaimed R5/);
});
