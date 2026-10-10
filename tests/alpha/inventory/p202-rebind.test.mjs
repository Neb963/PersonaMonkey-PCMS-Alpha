import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountsService } from '../../../extension/alpha/features/accounts/service.mjs';
import { createInventoryService, readInventoryFact } from '../../../extension/alpha/features/inventory/service.mjs';
import { normalizeInventoryFact, validInventoryFactTransition } from '../../../extension/alpha/features/inventory/facts.mjs';

// Genuine P202 service, P204 service, P103 account adapter and shared P102-style
// CAS fixture. No provider, browser, or native mutations occur.
const AT='2026-10-10T00:00:00.000Z';
const newUid='00000000-0000-4000-8000-000000000045';
const clone=v=>structuredClone(v);

test('issue #45 cross-phase: P202 rebind + manual verification permits P204 fact migration',async()=>{
  let globalRevision=1;
  const data=new Map(['account','generator','operation','release'].map(k=>[k,new Map()]));
  data.get('account').set('account-a',{revision:1,record:{
    accountId:'account-a',personaUid:'persona-a',epoch:1,name:'Fixture',
    sessionState:'VERIFIED',revision:1,asOf:AT
  }});
  const recordKey=(kind,row)=>kind==='account'?row.accountId:
    kind==='generator'?row.key:kind==='operation'?row.opId:row.releaseId;
  const storage={
    async read(kind,key){
      const row=data.get(kind).get(key);
      return {revision:globalRevision,item:row?clone(row):null};
    },
    async list(kind){
      return {revision:globalRevision,items:[...data.get(kind).values()].map(clone)};
    },
    async commit({expectedRevision,writes}){
      assert.equal(expectedRevision,globalRevision);
      assert(writes.length>=1&&writes.length<=64);
      const updated=new Map([...data].map(([kind,map])=>[kind,new Map(map)]));
      for(const w of writes){
        const k=recordKey(w.kind,w.record),before=updated.get(w.kind).get(k);
        assert.equal(w.expectedRevision,before?.revision??0);
        updated.get(w.kind).set(k,{revision:w.expectedRevision+1,
          record:clone({...w.record,revision:w.expectedRevision+1})});
      }
      for(const [kind,map] of updated)data.set(kind,map);
      globalRevision++;
      return {revision:globalRevision};
    }
  };
  const rows=new Map();
  const facts={
    async get(key){return clone(rows.get(key)??null);},
    async list(){return clone([...rows.values()]);},
    async putMany(input){
      for(const row of input){
        assert(validInventoryFactTransition(rows.get(row.key),row),'durable CAS');
      }
      for(const row of input)rows.set(row.key,normalizeInventoryFact(row));
    },
    async compareAndPut(row,expectedRevision){
      assert.equal(rows.get(row.key)?.observationRevision,expectedRevision);
      rows.set(row.key,normalizeInventoryFact(row));
    }
  };
  const provider={
    async probe(){return {ok:true,result:{},revision:1};},
    async listGenerators(){return {ok:true,revision:1,result:{
      items:[{key:'g0001',readback:{ownership:'CONFIRMED',listing:'UNLISTED',
        sourceRevision:'r1',asOf:AT}}],cursor:null,asOf:AT
    }};},
    async observe(){return {ok:true,result:{ownership:'CONFIRMED',
      listing:'UNLISTED',sourceRevision:'r1',asOf:AT},revision:1};}
  };
  const contextForAccount=a=>({accountId:a.accountId,personaUid:a.personaUid,epoch:a.epoch,
    routeRevision:1,capabilityRevision:1});
  const broker={async request(request){
    assert.equal(request.command,'persona.get');
    return {version:1,requestId:request.requestId,bootId:'boot-1',revision:7,ok:true,
      result:{personaUid:request.params.personaUid}};
  }};
  const accounts=createAccountsService({storage,broker,perchance:provider,contextForAccount,
    now:()=>AT,randomId:()=> '00000000-0000-4000-8000-000000000001'});
  const inventory=createInventoryService({storage,provider,facts,clock:()=>AT});
  const initial={accountId:'account-a',accountBindingEpoch:1,expectedRevision:1,
    opId:'scan-old',options:{context:contextForAccount((await storage.read('account','account-a')).item.record)}};
  assert.equal((await inventory.observe(initial)).ok,true);
  const old=await readInventoryFact(facts,'g0001');
  assert.equal(old.accountBindingEpoch,1);
  const rebound=await accounts.rebind({accountId:'account-a',accountBindingEpoch:1,
    expectedRevision:globalRevision,opId:'p202-rebind',options:{personaUid:newUid,confirm:true}});
  assert.equal(rebound.ok,true,JSON.stringify(rebound));
  assert.equal(rebound.result.epoch,2);
  assert.equal(rebound.result.sessionState,'WAITING_HUMAN');
  const nextContext=contextForAccount(rebound.result);
  const next={accountId:'account-a',accountBindingEpoch:2,
    expectedRevision:rebound.result.revision,opId:'scan-new',options:{context:nextContext}};
  assert.equal((await inventory.observe(next)).error.code,'OWNERSHIP_UNKNOWN');
  assert.deepEqual(await readInventoryFact(facts,'g0001'),old);
  const verified=await accounts.verifySession({accountId:'account-a',accountBindingEpoch:2,
    expectedRevision:globalRevision,opId:'manual-done',options:{manualDone:true}});
  assert.equal(verified.ok,true,JSON.stringify(verified));
  assert.equal(verified.result.sessionState,'VERIFIED');
  next.expectedRevision=verified.result.revision;
  assert.equal((await inventory.observe(next)).ok,true);
  const fact=await readInventoryFact(facts,'g0001');
  assert.equal(fact.personaUid,newUid);
  assert.equal(fact.accountBindingEpoch,2);
  assert.equal(fact.observationRevision,old.observationRevision+1);
  assert.equal(fact.acceptedSourceRevision,old.acceptedSourceRevision);
});
