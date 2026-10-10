import test from 'node:test';
import assert from 'node:assert/strict';
import {createAlphaTabAllocator} from '../../../extension/alpha/features/tabs/allocator.mjs';

const now=()=> '2026-10-10T20:00:00.000Z';
function fixture({uncertain=false}={}){
  const tasks=Array.from({length:8},(_,i)=>({id:`ai:${i}`,accountId:'acct-1',personaUid:'uid-1',
    key:`generator-${i}`,bindingEpoch:1,revision:5,state:'COMPLETED',reviewPending:true,
    approvalRevision:null,dispatchPhase:'APPLIED',savedSourceHash:'a'.repeat(64),savedSourceRevision:'sr-1'}));
  const ledger={async read(){return {tasks:structuredClone(tasks)};}};
  const slots=new Map(),opened=[],attached=[],closed=[];
  let operationRevision=0;
  const core={storage:{async list(){return {revision:operationRevision};}},
    tabs:{async reserve({binding,opId,targetKey}){
      if(slots.size>=4)throw Object.assign(new Error('RATE_LIMIT'),{code:'RATE_LIMIT'});
      const permit={id:`permit:${opId}`,...binding,opId,targetKey};slots.set(opId,{permit,phase:'RESERVED'});return permit;
    },async attach({permit,tabId}){
      const slot=slots.get(permit.opId);assert.ok(slot);assert.equal(slot.tabId,tabId);
      slot.phase='ACTIVE';attached.push(permit.opId);
    },async release({permit}){
      const slot=slots.get(permit.opId);
      if(slot?.tabId||slot?.phase==='DISPATCHING')throw Object.assign(new Error('RECOVERY_HOLD'),{code:'RECOVERY_HOLD'});
      slots.delete(permit.opId);
    },async reconcile({permit}){return {phase:slots.get(permit.opId)?.phase??'RELEASED'};}},
    operations:{async execute({operation,binding,dispatch,readback}){
      assert.equal(operation.kind,'persona.open');assert.equal(binding.owner,'attention');
      const result=await dispatch({mutate:async(command,params)=>{
        assert.equal(command,'persona.open');assert.equal(params.allowDirect,false);
        assert.equal(params.personaUid,'uid-1');assert.equal(params.url,
          `https://perchance.org/${operation.targetKey}#edit`);
        opened.push(params);slots.get(operation.opId).phase='DISPATCHING';if(uncertain)throw Object.assign(new Error('UNCERTAIN'),{code:'UNCERTAIN'});
        return {ok:true,result:{tabId:100+opened.length,personaUid:'uid-1'}};
      }});
      const observed=await readback({result});operationRevision++;
      slots.get(operation.opId).tabId=observed.evidence.tabId;
      return {remoteEvidence:{observation:observed.evidence}};
    }} };
  const allocator=createAlphaTabAllocator({core,aiTasks:ledger,now,
    verifyBinding:async({accountId,key,accountBindingEpoch})=>({accountId,key,epoch:accountBindingEpoch,personaUid:'uid-1'})});
  return {tasks,slots,opened,attached,closed,allocator};
}
test('AP404-01 multiple simultaneous jobs respect global Core tab ceiling of four',async()=>{
  const h=fixture();
  const results=await Promise.allSettled(h.tasks.map((t,i)=>h.allocator.openPendingReview({taskId:t.id,opId:`open:${i}`})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,4);
  assert.equal(results.filter(x=>x.reason?.code==='RATE_LIMIT').length,4);
  assert.equal(h.slots.size,4);assert.equal(h.opened.length,4);assert.equal(h.attached.length,4);
  assert.equal(h.closed.length,0);
});
test('AP404-01 uncertain editor-open retains slot and never closes a foreign tab',async()=>{
  const h=fixture({uncertain:true});
  await assert.rejects(h.allocator.openPendingReview({taskId:'ai:0',opId:'open:0'}),e=>e.code==='UNCERTAIN');
  assert.equal(h.slots.size,1); // Core's permit remains until reconciliation
  assert.equal(h.closed.length,0);assert.equal(h.opened.length,1);
});
test('AP404-03 stale or approved review never opens editor or reserves tab',async()=>{
  const h=fixture();h.tasks[0].reviewPending=false;
  await assert.rejects(h.allocator.openPendingReview({taskId:'ai:0',opId:'open:0'}),e=>e.code==='WAITING_HUMAN');
  assert.equal(h.opened.length,0);assert.equal(h.slots.size,0);
  const original=h.tasks[1];h.tasks[1]={...original,bindingEpoch:2};
  const strict=createAlphaTabAllocator({core:{storage:{},operations:{},tabs:{}},aiTasks:{read:async()=>({tasks:[h.tasks[1]]})},
    verifyBinding:async()=>({accountId:'acct-1',key:original.key,epoch:2,personaUid:'other'})});
  await assert.rejects(strict.openPendingReview({taskId:'ai:1',opId:'open:1'}),e=>e.code==='STALE_BINDING');
});
