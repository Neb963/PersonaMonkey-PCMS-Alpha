import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,META} from '../../core/helpers.mjs';
import {createAttentionService} from '../../../../extension/alpha/features/attention/service.mjs';
import {validateAttentionLedger} from '../../../../extension/alpha/features/attention/store.mjs';

function inbox(){
  let data={schemaVersion:1,revision:0,items:[]},pending=Promise.resolve();
  return {
    async read(){return structuredClone(validateAttentionLedger(data));},
    change(rev,mutator){
      const next=pending.then(()=>{
        if(rev!==data.revision)throw Object.assign(new Error('STALE_REVISION'),{code:'STALE_REVISION'});
        const value=structuredClone(data);mutator(value);value.revision++;
        data=validateAttentionLedger(value);return structuredClone(data);
      });
      pending=next.catch(()=>{});return next;
    }
  };
}
test('R4-ISSUE100 concurrent jobs share one Core tab ceiling while P404 notifications deduplicate',async()=>{
  const f=await fixture(),sent=[],store=inbox();
  const revision=(await f.core.readStatus()).revision;
  const attention=createAttentionService({store,
    aiTasks:{read:async()=>({tasks:[]})},
    tabs:{openPendingReview:async()=>{throw Error('No operator click');}},
    notifier:{show:async payload=>{sent.push(payload);}},
    readRevision:async()=>revision,now:()=> '2026-10-11T12:00:00.000Z',
    makeId:()=> 'notice-r4-001'});
  const req={accountId:META.accountId,accountBindingEpoch:1,
    expectedRevision:revision,opId:'alert-r4',key:'demo',
    options:{kind:'SYSTEM_WARNING',occurrence:'r4-conflict'}};
  const replies=await Promise.all(Array.from({length:24},()=>attention.raise(req)));
  assert(replies.every(x=>x.ok===true),JSON.stringify(replies.filter(x=>!x.ok).map(x=>x.error?.code)));
  assert.equal(new Set(replies.map(x=>x.result.id)).size,1);
  assert.equal(sent.length,1);
  assert.equal((await attention.list()).result.items.length,1);
  const reservations=await Promise.allSettled(Array.from({length:5},(_,i)=>
    f.core.tabs.reserve({binding:META,opId:'r4-tab-'+i,targetKey:META.accountId})));
  assert.equal(reservations.filter(x=>x.status==='fulfilled').length,4);
  const fifth=reservations.find(x=>x.status==='rejected');
  assert.equal(fifth.reason.code,'RATE_LIMIT');
  assert.equal((await f.core.readStatus()).budgets.tabs,4);
  for(const row of reservations)if(row.status==='fulfilled')
    await f.core.tabs.release({permit:row.value});
  assert.equal((await f.core.readStatus()).budgets.tabs,0);
  assert.equal(sent.length,1);
  f.core.close();
});
