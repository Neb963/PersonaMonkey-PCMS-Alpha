import test from 'node:test';
import assert from 'node:assert/strict';
import {createAttentionService,createDesktopAttentionNotifier} from '../../../extension/alpha/features/attention/service.mjs';
import {validateAttentionLedger} from '../../../extension/alpha/features/attention/store.mjs';

const now=()=> '2026-10-10T20:00:00.000Z';
function memoryStore(){
  let state={schemaVersion:1,revision:0,items:[]},tail=Promise.resolve();
  return {
    async read(){return structuredClone(validateAttentionLedger(state));},
    change(expected,fn){const work=tail.then(()=>{
      if(state.revision!==expected)throw Object.assign(new Error('STALE_REVISION'),{code:'STALE_REVISION'});
      const copy=structuredClone(state);const returned=fn(copy);
      assert.equal(returned?.then,undefined);
      copy.revision++;validateAttentionLedger(copy);state=copy;return structuredClone(copy);
    });tail=work.catch(()=>{});return work;}
  };
}
function harness({notifierFailure=false}={}){
  const shown=[],opened=[];
  const store=memoryStore();let id=0;
  const tasks=[{id:'ai-review-1',accountId:'acct-1',key:'alpha',bindingEpoch:1,
    state:'COMPLETED',reviewPending:true,approvalRevision:null}];
  const service=createAttentionService({store,aiTasks:{async read(){return {tasks:structuredClone(tasks)};}},
    tabs:{async openPendingReview(value){opened.push(value);return {phase:'ACTIVE',tabId:42};}},
    notifier:{async show(value){shown.push(value);if(notifierFailure)throw Error('notification unavailable');}},
    readRevision:async()=>7,now,makeId:()=>String(++id)});
  const raise=(occurrence='op-1',kind='SYSTEM_WARNING')=>service.raise({accountId:'acct-1',
    accountBindingEpoch:1,opId:occurrence,key:'alpha',options:{kind,occurrence,
      ...(kind==='AI_REVIEW'?{taskId:'ai-review-1'}:{})}});
  return {shown,opened,tasks,store,service,raise};
}
test('AP404-02 retry storm yields exactly one desktop warning and one open inbox row',async()=>{
  const h=harness();
  const replies=await Promise.all(Array.from({length:30},()=>h.raise()));
  assert.equal(replies.every(x=>x.ok),true);
  assert.equal(new Set(replies.map(x=>x.result.id)).size,1);
  assert.equal(h.shown.length,1);
  assert.deepEqual(h.shown[0],{id:`pcms-alpha:${replies[0].result.id}`,
    title:'PCMS needs attention',message:'Review the action-required inbox.'});
  const list=await h.service.list();assert.equal(list.result.items.length,1);
  const row=list.result.items[0];assert.equal(row.notice,'SHOWN');
  const ack=await h.service.acknowledge({accountId:'acct-1',accountBindingEpoch:1,
    opId:'ack-1',options:{attentionId:row.id,expectedItemRevision:row.revision}});
  assert.equal(ack.ok,true);assert.equal(ack.result.state,'ACKNOWLEDGED');
  assert.equal((await h.service.list()).result.items.length,0);
  assert.equal((await h.raise()).result.id,row.id); // same occurrence never resends or reopens
  assert.equal(h.shown.length,1);
  assert.equal((await h.raise('op-2')).ok,true);assert.equal(h.shown.length,2);
});
test('AP404-02 notification API failure cannot suppress inbox or cause duplicate dispatch',async()=>{
  const h=harness({notifierFailure:true});
  assert.equal((await h.raise()).ok,true);
  assert.equal((await h.raise()).ok,true);
  assert.equal(h.shown.length,1);
  const rows=(await h.service.list()).result.items;
  assert.equal(rows.length,1);assert.equal(rows[0].notice,'UNCERTAIN');
  const stale=await h.service.acknowledge({accountId:'acct-1',accountBindingEpoch:1,
    opId:'ack-1',options:{attentionId:rows[0].id,expectedItemRevision:1}});
  assert.equal(stale.ok,false);assert.equal(stale.error.code,'STALE_REVISION');
});
test('AP404-03 pending AI review opens correct task on demand, not on raising',async()=>{
  const h=harness();
  const raised=await h.raise('ai-review-1','AI_REVIEW');assert.equal(raised.ok,true);
  assert.equal(h.opened.length,0);
  const item=raised.result;
  assert.equal(item.action,'OPEN_EDITOR');
  const bad=await h.service.acknowledge({accountId:'acct-1',accountBindingEpoch:2,
    opId:'editor-bad',options:{attentionId:item.id,expectedItemRevision:item.revision,action:'OPEN_EDITOR'}});
  assert.equal(bad.error.code,'STALE_BINDING');
  const open=await h.service.acknowledge({accountId:'acct-1',accountBindingEpoch:1,
    opId:'editor-open-1',options:{attentionId:item.id,expectedItemRevision:item.revision,action:'OPEN_EDITOR'}});
  assert.equal(open.ok,true);assert.equal(open.result.editor.tabId,42);
  assert.deepEqual(h.opened,[{taskId:'ai-review-1',opId:'editor-open-1'}]);
  assert.equal((await h.service.list()).result.items.length,1); // opening is not approval
  h.tasks[0].reviewPending=false;
  const blocked=await h.service.acknowledge({accountId:'acct-1',accountBindingEpoch:1,
    opId:'editor-open-2',options:{attentionId:item.id,expectedItemRevision:item.revision,action:'OPEN_EDITOR'}});
  assert.equal(blocked.error.code,'WAITING_HUMAN');assert.equal(h.opened.length,1);
});
test('AP404-02 ledger rejects secrets, invalid states and duplicate fingerprints',()=>{
  const t={id:'attention:1',kind:'SYSTEM_WARNING',accountId:'acct-1',key:null,bindingEpoch:1,
    occurrence:'op-1',taskId:null,state:'OPEN',notice:'UNSENT',revision:1,createdAt:now(),updatedAt:now()};
  assert.throws(()=>validateAttentionLedger({schemaVersion:1,revision:0,items:[{...t,token:'secret'}]}),e=>e.code==='RECOVERY_HOLD');
  assert.throws(()=>validateAttentionLedger({schemaVersion:1,revision:0,items:[t,{...t,id:'attention:2'}]}),e=>e.code==='RECOVERY_HOLD');
});
test('AP404-02 desktop adapter emits fixed wording with no arbitrary notification content',async()=>{
  const calls=[],notifier=createDesktopAttentionNotifier({notifications:{async create(...args){calls.push(args);}}});
  await notifier.show({id:'pcms-alpha:attention:1',title:'AI review ready',message:'A generator needs your approval.'});
  assert.equal(calls.length,1);
  await assert.rejects(notifier.show({id:'other',title:'token',message:'secret'}),e=>e.code==='INVALID_REQUEST');
});
