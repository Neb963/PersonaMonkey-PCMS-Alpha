import test from 'node:test';
import assert from 'node:assert/strict';
import {load,validateSnapshot,validateTransition,R4_REPAIRS} from '../../../tools/alpha/governance.mjs';
import {historicalRoundSnapshot} from './historical-fixtures.mjs';

const published = load('.');
const earlier = historicalRoundSnapshot(published, 4);
const sha = 'a'.repeat(40);
function repairContext(snapshot) {
  const repairId='R4-ISSUE99';
  return {
    schemaVersion:1,kind:'R4_REPAIR',repairId,phaseId:repairId,
    issueNumber:R4_REPAIRS[repairId].issue,agentId:'r4-repair',
    branch:R4_REPAIRS[repairId].branch,claimEpoch:0,
    authorization:'MAINT-R4-REPAIR-SCOPE-009',
    baseMainSha:sha,contractHash:snapshot.lock.contracts['alpha.contracts.v1'],
    claimEpochs:structuredClone(snapshot.registry.epochs)
  };
}
test('historical R4 snapshot discards later epochs and claims without mutating checkout',()=>{
  assert.notStrictEqual(earlier,published);
  assert.equal(validateSnapshot(earlier).activeClaims,5);
  for(const p of published.plan.phases.filter(p=>p.round>4)){
    assert.equal(earlier.registry.epochs[p.id],0);
    assert.equal(earlier.plan.phases.find(x=>x.id===p.id).status,'LOCKED');
    assert.equal(earlier.registry.claims.some(c=>c.phaseId===p.id),false);
  }
  assert.equal(earlier.plan.rounds.find(r=>r.id==='R4').status,'IN_PROGRESS');
  assert.equal(earlier.plan.rounds.find(r=>r.id==='R5').status,'LOCKED');
});
test('R5/R6 future claims cannot break historical R4 repair assertions',()=>{
  const changed=structuredClone(published);
  for (const id of ['P501','P502','P505','P601','P605']) {
    const phase=changed.plan.phases.find(p=>p.id===id);
    changed.registry.epochs[id]=13;
    changed.registry.claims.push({
      schemaVersion:1,claimId:'CLM-'+id+'-013',phaseId:id,
      agentId:'fixture-'+id,claimEpoch:13,state:'ACTIVE',
      baseMainSha:sha,branch:'agent/fixture-'+id.toLowerCase()+'/'+id.toLowerCase(),
      writePaths:[...phase.ownership.writePaths,'docs/evidence/alpha/'+id+'/**'],
      contractReads:{'alpha.contracts.v1':changed.lock.contracts['alpha.contracts.v1']},
      contractWrites:[],exclusiveResources:[],migrationSlots:[],
      acceptanceIds:phase.acceptanceIds
    });
    phase.status='CLAIMED';
  }
  changed.plan.rounds.find(r=>r.id==='R5').status='IN_PROGRESS';
  const reconstructed=historicalRoundSnapshot(changed,4);
  assert.deepEqual(reconstructed,earlier);
  const context=repairContext(reconstructed);
  const evidence='docs/evidence/alpha/R4-ISSUE99/context.json';
  assert.equal(validateTransition(reconstructed,reconstructed,context,{
    mainSha:sha,headBranch:context.branch,files:[evidence]
  }).kind,'R4_REPAIR');
  const invalid={...context,claimEpochs:{...context.claimEpochs,P502:1}};
  assert.throws(()=>validateTransition(reconstructed,reconstructed,invalid,{
    mainSha:sha,headBranch:context.branch,files:[evidence]
  }),/R4 repair requires fixed/);
});
test('fixture projection requires explicit round and never supplies real write authority',()=>{
  for(const value of [0,7,1.5,'4',null]) {
    assert.throws(()=>historicalRoundSnapshot(published,value),TypeError);
  }
  const reconstructed=historicalRoundSnapshot(published,4);
  const context=repairContext(reconstructed);
  const path='docs/evidence/alpha/R4-ISSUE99/context.json';
  assert.throws(()=>validateTransition(published,published,context,{
    mainSha:sha,headBranch:context.branch,files:[path]
  }),/R4 issue repair needs active R4 and exact current main/);
});
