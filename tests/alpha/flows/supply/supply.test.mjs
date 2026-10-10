import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecord, assertRecordUpdate, recordKey } from '../../../../extension/alpha/domain/records.js';
import { createSupplyFlow, createSupplyImportJournal } from '../../../../extension/alpha/flows/supply/service.mjs';
import { parsePastedSlugs } from '../../../../extension/alpha/features/reservation/service.mjs';

const NOW='2026-10-10T12:00:00.000Z',SHA='b'.repeat(40),HASH='a'.repeat(64);
const clone=x=>structuredClone(x);
function store() {
  const maps=new Map(['account','generator','operation','release'].map(x=>[x,new Map()]));
  let revision=0;
  return {
    async read(kind,key) {
      const row=maps.get(kind).get(key);
      return {revision,item:row?clone(row):null};
    },
    async list(kind) {
      return {revision,items:[...maps.get(kind).values()].map(clone)};
    },
    async commit({expectedRevision,writes}) {
      assert.equal(expectedRevision,revision,'global optimistic CAS');
      const future=new Map([...maps].map(([kind,map])=>[kind,new Map(map)]));
      for (const w of writes) {
        const next=normalizeRecord(w.kind,w.record),key=recordKey(w.kind,next);
        const old=future.get(w.kind).get(key);
        assert.equal(w.expectedRevision,old?.revision??0,'per-record optimistic CAS');
        assertRecordUpdate(w.kind,old?.record,next);
        if (w.kind==='account'||w.kind==='generator') next.revision=w.expectedRevision+1;
        future.get(w.kind).set(key,{record:clone(next),revision:w.expectedRevision+1});
      }
      for (const [kind,map] of future) maps.set(kind,map);
      revision++;
      return {revision,items:[]};
    }
  };
}
async function seedAccount(storage,n) {
  const row=await storage.list('account');
  await storage.commit({expectedRevision:row.revision,writes:[{
    kind:'account',expectedRevision:0,record:{
      accountId:'account-'+n,personaUid:'persona-'+n,epoch:1,
      name:'Account '+n,sessionState:'VERIFIED',revision:0,asOf:NOW
    }
  }]});
}
const ctx=account=>({accountId:account.accountId,personaUid:account.personaUid,
  epoch:account.epoch,routeRevision:2,capabilityRevision:3});
function sourceFor(key,folder=key) {
  return {repository:'Neb963/per-gens',ref:'main',root:'generators/'+folder,
    folder,slug:key,commitSha:SHA,
    blobs:{['generators/'+folder+'/DEPLOYMENT.md']:'c'.repeat(40)},
    status:'READY',releaseId:HASH};
}
function receipt(value,revision=0) {return {ok:true,result:value,revision};}
function failed(code) {return {ok:false,error:{code,message:'synthetic',retryable:false},revision:0};}
async function harness({accounts=2,lostReservation=false,lostImport=false,sourceKey='ready_slug',folder='my-folder'}={}) {
  const storage=store(),remote=new Map();
  for (let i=1;i<=accounts;i++) {
    await seedAccount(storage,i);remote.set('account-'+i,new Map());
  }
  const createCalls=[],reconcileCalls=[],importCalls=[];
  const binding=sourceFor(sourceKey,folder);
  const sources={
    async get({key}) {return key===sourceKey?receipt(binding):failed('NOT_APPLIED');},
    async resolveRelease({key}) {
      return key===sourceKey?receipt({releaseId:HASH,source:binding,files:{
        pjs:'a',html:'b',thumbnail:new Uint8Array([1])
      }}):failed('NOT_APPLIED');
    }
  };
  const perchance={
    async listGenerators({context,cursor}) {
      assert.equal(cursor,undefined);
      const rows=[...remote.get(context.accountId).entries()].map(([key,readback])=>({
        key,readback
      }));
      return receipt({items:rows,cursor:null,asOf:NOW});
    }
  };
  const reservation={
    async preview({key}) {return receipt(parsePastedSlugs(key));},
    async reserve({key,opId,expectedRevision,accountBindingEpoch}) {
      createCalls.push({key,opId});
      const row=await storage.read('operation',opId);
      assert.equal(row.revision,expectedRevision);
      const op={opId,kind:'create',targetKey:key,sourceRevision:'none',
        accountBindingEpoch,phase:'PREPARED',startedAt:NOW,
        remoteEvidence:{intent:{reservation:'P301',accountId:'account-1',
          personaUid:'persona-1',folder:key}}};
      await storage.commit({expectedRevision,writes:[{
        kind:'operation',expectedRevision:0,record:op
      }]});
      let r=await storage.read('operation',opId);
      await storage.commit({expectedRevision:r.revision,writes:[{
        kind:'operation',expectedRevision:r.item.revision,record:{...r.item.record,phase:'DISPATCHING'}
      }]});
      r=await storage.read('operation',opId);
      await storage.commit({expectedRevision:r.revision,writes:[{
        kind:'operation',expectedRevision:r.item.revision,record:{
          ...r.item.record,phase:'APPLIED',remoteEvidence:{
            ...r.item.record.remoteEvidence,observation:{owned:true}
          }
        }
      }]});
      if (lostReservation) {lostReservation=false;return failed('UNCERTAIN');}
      return receipt({kind:'reservation.github',targetKey:key,phase:'APPLIED'});
    },
    async reconcile({key,opId,accountBindingEpoch,expectedRevision}) {
      reconcileCalls.push({key,opId});
      const row=await storage.read('operation',opId);
      assert.equal(row.revision,expectedRevision);
      assert.equal(row.item.record.accountBindingEpoch,accountBindingEpoch);
      return receipt({kind:'reservation.github',targetKey:key,phase:'APPLIED'});
    }
  };
  const journal=createSupplyImportJournal(storage);
  const importPerchance={
    async probe() {return receipt(['generator.create','generator.list'],7);},
    async create({context,targetKey,opId,expectedSourceRevision}) {
      importCalls.push(opId);
      assert.equal(expectedSourceRevision,null);
      assert.equal((await journal.read(opId)).phase,'PREPARED');
      await journal.dispatch(opId);
      remote.get(context.accountId).set(targetKey,{
        ownership:'CONFIRMED',listing:'UNLISTED',sourceRevision:'version-1',asOf:NOW
      });
      if (lostImport) {lostImport=false;return failed('UNCERTAIN');}
      await journal.complete(opId,{phase:'APPLIED',remoteEvidence:{
        ownership:'CONFIRMED',listing:'UNLISTED',sourceRevision:'version-1'
      }});
      return receipt(remote.get(context.accountId).get(targetKey));
    }
  };
  const flow=createSupplyFlow({storage,reservation,sources,perchance,importPerchance,
    contextForAccount:ctx,now:()=>NOW});
  return {storage,remote,flow,createCalls,reconcileCalls,importCalls,binding};
}
const ok=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.result;};
const bad=(result,code)=>{assert.equal(result.ok,false,JSON.stringify(result));
  assert.equal(result.error.code,code);};

test('AP401-01/AP401-02: pasted 200 and 1000 candidates use at most 16 serial tasks per pass',async()=>{
  const h=await harness();
  const input=Array.from({length:1000},(_,i)=>'bulk_'+String(i).padStart(4,'0')).join('\n');
  assert.equal(ok(await h.flow.preview({text:input})).length,1000);
  const first=ok(await h.flow.processBatch({text:input,batchId:'scale',limit:16}));
  assert.equal(first.total,1000);
  assert.equal(first.items.length,16);assert.equal(first.nextOffset,16);
  assert.equal(first.maxConcurrentMutations,1);assert.equal(first.cursor,16);
  assert.equal(h.createCalls.length,16);
  const second=ok(await h.flow.processBatch({text:input,batchId:'scale',offset:16,limit:16}));
  assert.equal(second.items.length,16);assert.equal(second.nextOffset,32);
  assert.equal(h.createCalls.length,32);
  const list200=Array.from({length:200},(_,i)=>'cand_'+i).join(',');
  assert.equal(ok(await h.flow.preview({text:list200})).length,200);
  bad(await h.flow.processBatch({text:input,batchId:'scale',limit:17}),'INVALID_REQUEST');
  assert.equal(h.createCalls.length,32);
});

test('AP401-03: lost GitHub receipt resumes durable P301 operation without a second create',async()=>{
  const h=await harness({lostReservation:true});
  const text='resume_slug\nnew_slug';
  const a=ok(await h.flow.processBatch({text,batchId:'resume'}));
  assert.equal(a.halted,true);assert.equal(a.nextOffset,0);
  assert.equal(a.items[0].error.code,'UNCERTAIN');
  assert.equal(h.createCalls.length,1);
  const b=ok(await h.flow.processBatch({text,batchId:'resume'}));
  assert.equal(b.halted,false);assert.equal(b.nextOffset,2);
  assert.equal(h.createCalls.length,2,'second create is only for second slug');
  assert.equal(h.reconcileCalls.length,1);
  assert.equal(h.reconcileCalls[0].opId,'sup.resume.0');
  const again=ok(await h.flow.processBatch({text,batchId:'resume',limit:1}));
  assert.equal(again.items[0].ok,true);
  assert.equal(h.createCalls.length,2);
});

test('AP401-01/AP401-02: GitHub-first READY existing ownership binds without overwriting source',async()=>{
  const h=await harness();
  h.remote.get('account-2').set('ready_slug',{
    ownership:'CONFIRMED',listing:'UNLISTED',sourceRevision:'owned-1',asOf:NOW
  });
  const value=ok(await h.flow.processBatch({text:'ready_slug',batchId:'mapped',
    imports:[{key:'ready_slug',folder:'my-folder'}]}));
  assert.equal(value.items[0].ok,true);
  assert.equal(value.items[0].result.mode,'GITHUB_FIRST');
  const row=(await h.storage.read('generator','ready_slug')).item.record;
  assert.equal(row.accountId,'account-2');
  assert.equal(row.fleetIntent,'EXCLUDED');assert.equal(row.refreshState,'INELIGIBLE');
  assert.equal(row.sourceBinding.status,'READY');
  assert.equal(row.sourceBinding.folder,'my-folder');
  assert.equal(h.importCalls.length,0,'remote already exists');
  assert.equal(h.createCalls.length,0,'P301 must not replace READY with BLOCKED');
  bad(await h.flow.importReady({key:'ready_slug',folder:'wrong-folder',opId:'other'}),
    'CONFLICT');
});

test('AP401-03: create GitHub-first only after durable journal, resume lost response from inventory',async()=>{
  const h=await harness({lostImport:true});
  const args={key:'ready_slug',folder:'my-folder',opId:'import-job'};
  bad(await h.flow.importReady(args),'UNCERTAIN');
  assert.equal(h.importCalls.length,1);
  const before=(await h.storage.read('operation','import-job')).item.record;
  assert.equal(before.phase,'DISPATCHING');
  assert.equal(before.remoteEvidence.intent.releaseId,HASH);
  const done=ok(await h.flow.importReady(args));
  assert.equal(done.phase,'APPLIED');assert.equal(h.importCalls.length,1);
  assert.equal((await h.storage.read('operation','import-job')).item.record.phase,'APPLIED');
  assert.equal((await h.storage.read('generator','ready_slug')).item.record.sourceBinding.status,'READY');
  ok(await h.flow.importReady(args));
  assert.equal(h.importCalls.length,1);
});

test('AP401-03: confirmed absent uncertain import closes NOT_APPLIED and never dispatches again',async()=>{
  const h=await harness({lostImport:true});
  const args={key:'ready_slug',folder:'my-folder',opId:'missing-job'};
  bad(await h.flow.importReady(args),'UNCERTAIN');
  h.remote.get('account-1').delete('ready_slug');
  bad(await h.flow.importReady(args),'NOT_APPLIED');
  assert.equal((await h.storage.read('operation','missing-job')).item.record.phase,'NOT_APPLIED');
  bad(await h.flow.importReady(args),'NOT_APPLIED');
  assert.equal(h.importCalls.length,1);
});

test('AP401-02: invalid input never dispatches remote mutations',async()=>{
  const h=await harness();
  bad(await h.flow.processBatch({text:'bad key',batchId:'bad',
    imports:[{key:'bad',folder:'a'},{key:'bad',folder:'b'}]}),'INVALID_REQUEST');
  bad(await h.flow.processBatch({text:'abc',batchId:'a'}),'INVALID_REQUEST');
  bad(await h.flow.processBatch({text:'ready_slug',batchId:'ok',
    imports:[{key:'absent',folder:'any'}]}),'INVALID_REQUEST');
  assert.equal(h.createCalls.length,0);
  assert.equal(h.importCalls.length,0);
});
