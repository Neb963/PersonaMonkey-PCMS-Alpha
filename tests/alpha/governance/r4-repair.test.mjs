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

test('supplementary #99 coverage repair is separately fenced to bundle and backup regressions',()=>{
  const c={...ctx('R4-ISSUE99-COVERAGE'),authorization:'MAINT-R4-COVERAGE-SCOPE-010'};
  const accepted=(paths)=>validateTransition(main,main,c,{
    mainSha:sha,headBranch:c.branch,files:['docs/evidence/alpha/R4-ISSUE99-COVERAGE/context.json',...paths]});
  assert.equal(accepted(['extension/alpha/backup/bundle.js','tests/alpha/backup/bundle.test.mjs']).kind,'R4_REPAIR');
  for(const p of ['extension/alpha/storage/store.js','extension/alpha/core/core.mjs','tools/alpha/governance.mjs'])
    assert.throws(()=>accepted([p]),/outside ownership/);
  for(const change of [{authorization:'MAINT-R4-REPAIR-SCOPE-009'},
    {branch:'agent/r4-repair/r4-issue99'},{issueNumber:100}])
    assert.throws(()=>validateTransition(main,main,{...c,...change},{
      mainSha:sha,headBranch:c.branch,files:['docs/evidence/alpha/R4-ISSUE99-COVERAGE/context.json']}));
});

test('follow-up R4 #99 and #100 have separate narrowly-scoped authority',()=>{
  for(const [id,path,other] of [
    ['R4-ISSUE99-RECONCILE','extension/alpha/backup/integration/authority.mjs','extension/alpha/providers/perchance/broker-executor.mjs'],
    ['R4-ISSUE100-WIRING','extension/alpha/providers/perchance/broker-executor.mjs','extension/alpha/backup/integration/authority.mjs']]){
    const data={...ctx(id),authorization:'MAINT-R4-FINAL-011'};
    const file='docs/evidence/alpha/'+id+'/context.json';
    assert.equal(validateTransition(main,main,data,{mainSha:sha,headBranch:data.branch,files:[file,path]}).kind,'R4_REPAIR');
    assert.throws(()=>validateTransition(main,main,data,{mainSha:sha,headBranch:data.branch,files:[file,other]}),/outside ownership/);
    assert.throws(()=>validateTransition(main,main,{...data,authorization:'MAINT-R4-REPAIR-SCOPE-009'},{mainSha:sha,headBranch:data.branch,files:[file,path]}));
  }
});

test('R4 P405 reconciliation evidence is one-use and cannot change product or governance',()=>{
  const c={...ctx('R4-P405-EVIDENCE'),authorization:'MAINT-R4-EVIDENCE-012'};
  const allowed=['docs/evidence/alpha/R4-P405-EVIDENCE/context.json',
    'docs/evidence/alpha/P405/acceptance.json'];
  assert.equal(validateTransition(main,main,c,{mainSha:sha,headBranch:c.branch,files:allowed}).kind,'R4_REPAIR');
  for(const path of ['extension/alpha/backup/integration/authority.mjs',
    'docs/implementation/alpha/plan.json','docs/evidence/alpha/P402/acceptance.json'])
    assert.throws(()=>validateTransition(main,main,c,{mainSha:sha,headBranch:c.branch,
      files:[...allowed,path]}),/outside ownership/);
});

test('one-use final issue100 connected typed-broker tests cannot edit product',()=>{
  const c={...ctx('R4-ISSUE100-FINAL'),authorization:'MAINT-R4-EVIDENCE-012'};
  const files=['docs/evidence/alpha/R4-ISSUE100-FINAL/context.json',
    'tests/alpha/integration/r4/connected.test.mjs'];
  assert.equal(validateTransition(main,main,c,{mainSha:sha,headBranch:c.branch,files}).kind,'R4_REPAIR');
  assert.throws(()=>validateTransition(main,main,c,{mainSha:sha,headBranch:c.branch,
    files:[...files,'extension/alpha/bootstrap/host.mjs']}),/outside ownership/);
});

test('R4 P403 premature recovery hold may only be repaired in owner flow',()=>{
 const c={...ctx('R4-ISSUE100-REFRESH'),authorization:'MAINT-R4-REFRESH-013'};
 const files=['docs/evidence/alpha/R4-ISSUE100-REFRESH/context.json',
   'extension/alpha/flows/refresh/service.mjs','tests/alpha/integration/r4/connected.test.mjs'];
 assert.equal(validateTransition(main,main,c,{mainSha:sha,headBranch:c.branch,files}).kind,'R4_REPAIR');
 assert.equal(validateTransition(main,main,c,{mainSha:sha,headBranch:c.branch,
   files:[...files,'extension/alpha/core/core.mjs','tests/alpha/core/core.test.mjs']}).kind,'R4_REPAIR');
 assert.throws(()=>validateTransition(main,main,c,{mainSha:sha,headBranch:c.branch,
   files:[...files,'extension/alpha/core/core.mjs']}),/outside ownership/);
});
