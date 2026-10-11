import assert from 'node:assert/strict';
import test from 'node:test';
import {load,validateTransition,R4_REPAIRS} from '../../../tools/alpha/governance.mjs';
const main=load('.'),sha='a'.repeat(40),hash=main.lock.contracts['alpha.contracts.v1'];
const ctx=id=>({schemaVersion:1,kind:'R4_REPAIR',repairId:id,phaseId:id,issueNumber:R4_REPAIRS[id].issue,agentId:'r4-repair',branch:R4_REPAIRS[id].branch,claimEpoch:0,authorization:'MAINT-R4-REPAIR-SCOPE-009',baseMainSha:sha,contractHash:hash,claimEpochs:structuredClone(main.registry.epochs)});
const validate=(id,paths=[],patch={})=>{const context={...ctx(id),...patch};return validateTransition(main,main,context,{mainSha:sha,headBranch:context.branch,files:[`docs/evidence/alpha/${id}/context.json`,...paths]});};
test('R4 repair confines owner paths to exact issue',()=>{
 assert.equal(validate('R4-ISSUE99',['extension/alpha/storage/store.js']).kind,'R4_REPAIR');
 assert.equal(validate('R4-ISSUE100',['tests/alpha/integration/r4/full.test.mjs']).kind,'R4_REPAIR');
 assert.throws(()=>validate('R4-ISSUE100',['extension/alpha/storage/store.js']),/outside ownership/);
 assert.throws(()=>validate('R4-ISSUE99',['extension/alpha/contracts/surface.json']),/outside ownership/);
});
test('R4 repair requires exact owner, epoch, branch and frozen contract',()=>{
 for(const fields of [{issueNumber:5},{agentId:'fake'},{claimEpoch:1},{authorization:'self'},
  {contractHash:'f'.repeat(64)},{claimEpochs:{...main.registry.epochs,P405:2}},
  {branch:'agent/r4-repair/r4-issue100'},{baseMainSha:'b'.repeat(40)},{kind:'PHASE'}])
  assert.throws(()=>validate('R4-ISSUE99',[],fields));
});
test('R4 issue repair cannot alter accepted or upcoming round state',()=>{
 for(const mutation of [s=>s.registry.epochs.P405++,s=>s.plan.rounds.find(r=>r.id==='R5').status='READY',s=>s.plan.phases.find(p=>p.id==='P405').status='ACCEPTED']){
  const altered=structuredClone(main);mutation(altered);const c=ctx('R4-ISSUE99');
  assert.throws(()=>validateTransition(main,altered,c,{mainSha:sha,headBranch:c.branch,files:['docs/evidence/alpha/R4-ISSUE99/context.json']}));
 }
});
