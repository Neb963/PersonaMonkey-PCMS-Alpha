import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountsService } from '../../../extension/alpha/features/accounts/service.mjs';
import { normalizeRecord, recordKey, assertRecordUpdate } from '../../../extension/alpha/domain/records.js';

const WHEN='2026-10-09T00:00:00.000Z';
const clone=value=>structuredClone(value);
function memoryStore(){
  let version=0;
  const data=new Map(['account','generator','operation','release'].map(kind=>[kind,new Map()]));
  const record=(kind,key)=>data.get(kind).get(key);
  return {
    async read(kind,key){const row=record(kind,key);return {revision:version,item:row?clone(row):null};},
    async list(kind){return {revision:version,items:[...data.get(kind).values()].map(clone)};},
    async commit({expectedRevision,writes}){
      if(version!==expectedRevision)throw Object.assign(new Error('stale'),{code:'STALE_REVISION'});
      if(!Array.isArray(writes)||!writes.length||writes.length>64)throw Object.assign(new Error('batch'),{code:'INVALID_REQUEST'});
      const next=new Map([...data].map(([kind,map])=>[kind,new Map(map)]));
      const seen=new Set();
      for(const w of writes){
        const raw=normalizeRecord(w.kind,w.record),key=recordKey(w.kind,raw),tag=w.kind+'/'+key;
        assert(!seen.has(tag));seen.add(tag);
        const prior=next.get(w.kind).get(key);
        if((prior?.revision||0)!==w.expectedRevision)throw Object.assign(new Error('stale record'),{code:'STALE_REVISION'});
        assertRecordUpdate(w.kind,prior?.record,raw);
        const stored={...raw,...(['account','generator'].includes(w.kind)?{revision:w.expectedRevision+1}:{})};
        next.get(w.kind).set(key,{revision:w.expectedRevision+1,record:stored});
      }
      const uid=new Set();
      for(const x of next.get('account').values()){
        if(uid.has(x.record.personaUid))throw Object.assign(new Error('uid collision'),{code:'CONFLICT'});
        uid.add(x.record.personaUid);
      }
      for(const x of next.get('generator').values()){
        const a=next.get('account').get(x.record.accountId)?.record;
        if(!a||a.personaUid!==x.record.personaUid||a.epoch!==x.record.accountBindingEpoch)
          throw Object.assign(new Error('binding mismatch'),{code:'STALE_BINDING'});
      }
      version++;
      for(const [kind,map] of next)data.set(kind,map);
      return {revision:version,items:writes.map(w=>clone(data.get(w.kind).get(recordKey(w.kind,w.record))))};
    }
  };
}
function harness({inventory=[],probeError=null,routeHealthy=true}={}){
  const storage=memoryStore(),personas=new Map(),events=[];
  let n=0,brokerRev=7,nextTab=1;
  const broker={
    events,personas,routeHealthy,
    async request(request){
      events.push(clone(request));
      const response=(result,ok=true)=>({
        version:1,requestId:request.requestId, ...(request.operationId?{operationId:request.operationId}:{}),
        bootId:'boot-1',revision:brokerRev,ok,...(ok?{result}:{error:{code:'UNAVAILABLE',message:'Unverified',retryable:false}})
      });
      if(request.command==='system.describe')return response({commands:['persona.open','persona.create','route.assign']});
      if(request.command==='persona.get'){
        const p=personas.get(request.params.personaUid);
        return p?response(clone(p)):response(null,false);
      }
      const write=['persona.create','persona.open','route.assign','route.test'].includes(request.command);
      assert(write);
      assert.equal(request.precondition.bootId,'boot-1');
      assert.equal(request.precondition.revision,brokerRev);
      assert.equal(request.params.allowDirect,false,'never enable Direct for retry/open/create');
      assert.equal(typeof request.operationId,'string');
      const operation=await storage.read('operation',request.operationId);
      assert.equal(operation.item?.record.phase,'DISPATCHING','operation durable before external effect');
      brokerRev++;
      switch(request.command){
        case 'persona.create':{
          const p={personaUid:request.params.personaUid,cookieStoreId:'firefox-container-11',name:request.params.name};
          personas.set(p.personaUid,p);return response({persona:clone(p),reused:false});
        }
        case 'persona.open':
          if(broker.failOpen)throw new Error('synthetic lost response');
          return response({personaUid:request.params.personaUid,tabId:nextTab++,cookieStoreId:personas.get(request.params.personaUid)?.cookieStoreId});
        case 'route.assign':
          return response({persona:clone(personas.get(request.params.personaUid)),route:{id:request.params.routeId}});
        case 'route.test':return response({ok:broker.routeHealthy});
      }
    }
  };
  const pageSize=7;
  const perchance={
    async probe(){return probeError?{ok:false,error:{code:probeError,retryable:false,message:'Manual login'},revision:0}:
      {ok:true,result:['generator.list'],revision:1};},
    async listGenerators({cursor}){
      const offset=cursor?Number(cursor):0,next=offset+pageSize;
      return {ok:true,revision:0,result:{items:inventory.slice(offset,next),
        cursor:next<inventory.length?String(next):null,asOf:WHEN}};
    }
  };
  const service=createAccountsService({
    storage,broker,perchance,
    contextForAccount:account=>({accountId:account.accountId,personaUid:account.personaUid,
      epoch:account.epoch,routeRevision:4,capabilityRevision:3}),
    now:()=>WHEN,randomId:()=> '00000000-0000-4000-8000-' + String(++n).padStart(12,'0')
  });
  const revision=async()=> (await storage.list('account')).revision;
  const begin=async(opId='begin-1')=>service.enroll({accountId:'acc-1',opId,expectedRevision:await revision(),
    accountBindingEpoch:1,options:{name:'Synthetic account'}});
  const guard=async(opId,options,epoch=1)=>({accountId:'acc-1',opId,expectedRevision:await revision(),
    accountBindingEpoch:epoch,options});
  return {storage,broker,perchance,service,personas,events,begin,guard,revision};
}
function row(key,listing='PUBLIC'){
  return {key,readback:{ownership:'CONFIRMED',listing,sourceRevision:'r1',asOf:WHEN}};
}
const assertOk=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.result;};
const assertErr=(r,code)=>{assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.error.code,code);};

test('AP202-01: manual enrollment creates dedicated Persona and durable operation before browser dispatch',async()=>{
  const h=harness(),account=assertOk(await h.begin());
  assert.equal(account.personaUid,'00000000-0000-4000-8000-000000000001');
  assert.match(account.personaUid,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(account.epoch,1);
  assert.equal(account.sessionState,'WAITING_HUMAN');
  const operations=(await h.storage.list('operation')).items.map(x=>x.record);
  assert.deepEqual(operations.map(x=>[x.kind,x.phase]),[['persona.create','APPLIED'],['persona.open','APPLIED']]);
  assert.equal(h.events.filter(x=>x.command==='persona.open').length,1);
  assert.equal(h.events.filter(x=>x.command==='persona.create').length,1);
  const reopened=assertOk(await h.service.get({accountId:'acc-1'}));
  assert.deepEqual(reopened,account);
  assertErr(await h.begin(),'CONFLICT');
  assert.equal(h.events.filter(x=>x.command==='persona.create').length,1,'never blind-replay create');
});

test('AP202-01: cookie container rotation preserves personaUid and binding epoch',async()=>{
  const h=harness(),initial=assertOk(await h.begin());
  const p=h.personas.get(initial.personaUid);
  p.cookieStoreId='firefox-container-12';
  const opened=assertOk(await h.service.enroll(await h.guard('open-2',{action:'OPEN'})));
  assert.equal(opened.personaUid,initial.personaUid);
  assert.equal(opened.epoch,1);
  assert.equal(h.events.at(-2)?.command,'persona.open');
});

test('AP202-01: atomic rebind previews impact, raises epoch, retains EXCLUDED intent and forces new login',async()=>{
  const h=harness({inventory:[row('owned-one'),row('owned-two','UNLISTED')]});
  assertOk(await h.begin());
  assertOk(await h.service.verifySession(await h.guard('verify-1',{manualDone:true})));
  h.personas.set('00000000-0000-4000-8000-000000000101',{personaUid:'00000000-0000-4000-8000-000000000101',cookieStoreId:'firefox-container-31'});
  const preview=assertOk(await h.service.previewRebind({accountId:'acc-1'}));
  assert(preview.some(x=>x.includes('Affected generators: 2')));
  assert(preview.some(x=>x.includes('owned-one')));
  const updated=assertOk(await h.service.rebind(await h.guard('rebind-1',{personaUid:'00000000-0000-4000-8000-000000000101',confirm:true})));
  assert.equal(updated.epoch,2);
  assert.equal(updated.personaUid,'00000000-0000-4000-8000-000000000101');
  assert.equal(updated.sessionState,'WAITING_HUMAN');
  const generators=(await h.storage.list('generator')).items.map(x=>x.record);
  assert.equal(generators.length,2);
  assert(generators.every(x=>x.personaUid==='00000000-0000-4000-8000-000000000101'&&x.accountBindingEpoch===2&&x.fleetIntent==='EXCLUDED'));
  assertErr(await h.service.verifySession(await h.guard('stale',{manualDone:true},1)),'STALE_BINDING');
  assert.equal(h.events.filter(x=>x.command==='route.assign').length,0,'rebind is local; no route transfer');
});

test('AP202-02: challenge cannot set VERIFIED; explicit route retry uses typed broker without Direct bypass',async()=>{
  const h=harness({probeError:'WAITING_HUMAN'});
  const initial=assertOk(await h.begin());
  assertErr(await h.service.verifySession(await h.guard('verify-1',{manualDone:true})),'WAITING_HUMAN');
  assert.equal((await h.service.get({accountId:'acc-1'})).result.sessionState,'WAITING_HUMAN');
  h.broker.routeHealthy=false;
  const tabsBefore=h.events.filter(x=>x.command==='persona.open').length;
  assertErr(await h.service.enroll(await h.guard('retry-fail',{action:'RETRY_ROUTE',routeId:'mullvad-one'})),'WAITING_HUMAN');
  assert.equal(h.events.filter(x=>x.command==='persona.open').length,tabsBefore,'unhealthy route does not open');
  h.broker.routeHealthy=true;
  const after=assertOk(await h.service.enroll(await h.guard('retry-pass',{action:'RETRY_ROUTE',routeId:'mullvad-two'})));
  assert.equal(after.personaUid,initial.personaUid);
  assert.equal(after.sessionState,'WAITING_HUMAN','a route test is not login proof');
  assert.equal(h.events.filter(x=>x.command==='persona.open').length,tabsBefore+1);
  assert(h.events.filter(x=>x.command==='route.assign').every(x=>x.params.allowDirect===false));
});

test('AP202-02: ambiguous tab dispatch is journalled UNCERTAIN; same opId cannot retry',async()=>{
  const h=harness();assertOk(await h.begin());
  h.broker.failOpen=true;
  const attempt=await h.guard('open-uncertain',{action:'OPEN'});
  assertErr(await h.service.enroll(attempt),'UNCERTAIN');
  assert.equal((await h.storage.read('operation','open-uncertain')).item.record.phase,'UNCERTAIN');
  h.broker.failOpen=false;
  assertErr(await h.service.enroll({...attempt,expectedRevision:await h.revision()}),'RECOVERY_HOLD');
  assert.equal(h.events.filter(x=>x.command==='persona.open'&&x.operationId==='open-uncertain').length,1);
  h.personas.set('00000000-0000-4000-8000-000000000102',{personaUid:'00000000-0000-4000-8000-000000000102'});
  assertErr(await h.service.rebind(await h.guard('rebind-blocked',{personaUid:'00000000-0000-4000-8000-000000000102',confirm:true})),'RECOVERY_HOLD');
});

test('AP202-03: imported account-owned generators default EXCLUDED; public is not managed',async()=>{
  const h=harness({inventory:[row('public-one'),row('hidden-one','UNLISTED')]});
  assertOk(await h.begin());
  const verified=assertOk(await h.service.verifySession(await h.guard('verify-1',{manualDone:true})));
  assert.equal(verified.sessionState,'VERIFIED');
  const generators=(await h.storage.list('generator')).items.map(x=>x.record);
  assert.deepEqual(generators.map(x=>[x.key,x.listingObserved,x.fleetIntent]),[
    ['public-one','PUBLIC','EXCLUDED'],['hidden-one','UNLISTED','EXCLUDED']]);
  assert(generators.every(x=>x.sourceBinding===null&&x.releaseId===null));
  assertOk(await h.service.verifySession(await h.guard('verify-2',{manualDone:true})));
  assert.equal((await h.storage.list('generator')).items.length,2,'rescan is idempotent');
});

test('AP202-03: incomplete or duplicate authenticated inventory fails closed without VERIFIED',async()=>{
  const h=harness({inventory:[row('duplicate-one'),row('duplicate-one')]});
  assertOk(await h.begin());
  const result=await h.service.verifySession(await h.guard('verify-duplicate',{manualDone:true}));
  assertErr(result,'CONFLICT');
  assert.equal((await h.storage.list('generator')).items.length,0);
  assert.equal((await h.service.get({accountId:'acc-1'})).result.sessionState,'WAITING_HUMAN');
});

test('AP202-03: imports 100 account-owned entries in <=64-write CAS batches',async()=>{
  const inventory=Array.from({length:100},(_,n)=>row('generator-'+String(n).padStart(3,'0')));
  const h=harness({inventory});assertOk(await h.begin());
  const result=assertOk(await h.service.verifySession(await h.guard('verify-large',{manualDone:true})));
  assert.equal(result.sessionState,'VERIFIED');
  const imported=(await h.storage.list('generator')).items;
  assert.equal(imported.length,100);
  assert(imported.every(x=>x.record.fleetIntent==='EXCLUDED'));
  h.personas.set('00000000-0000-4000-8000-000000000103',{personaUid:'00000000-0000-4000-8000-000000000103'});
  assertErr(await h.service.rebind(await h.guard('rebind-large',{personaUid:'00000000-0000-4000-8000-000000000103',confirm:true})),'RECOVERY_HOLD');
  assert.equal((await h.service.get({accountId:'acc-1'})).result.epoch,1,'no partial mass rebind');
});

test('AP202-01/02: stale revision, unsafe options, and unconfirmed Persona are rejected',async()=>{
  const h=harness();assertOk(await h.begin());
  assertErr(await h.service.enroll({accountId:'acc-1',opId:'attempt-1',accountBindingEpoch:1,
    expectedRevision:0,options:{action:'OPEN'}}),'STALE_REVISION');
  assertErr(await h.service.enroll(await h.guard('unsafe',{password:'not-allowed'})),'INVALID_REQUEST');
  assertErr(await h.service.rebind(await h.guard('non-uuid',{personaUid:'non-uuid',confirm:true})),'INVALID_REQUEST');
  assertErr(await h.service.rebind(await h.guard('bad-rebind',{personaUid:'00000000-0000-4000-8000-000000000999',confirm:true})),'UNAVAILABLE');
  assert.equal(h.events.filter(x=>x.command==='persona.open').length,1);
});

test('AP202: account list uses revision-bound cursor and no secrets',async()=>{
  const h=harness();assertOk(await h.begin());
  const page=assertOk(await h.service.list({limit:1}));
  assert.equal(page.items.length,1);
  assert.equal(page.items[0].name,'Synthetic account');
  assert.equal(page.cursor,null);
  assertErr(await h.service.list({cursor:'v1.0.1'}),'STALE_REVISION');
  assert.deepEqual(Object.keys(h.service).sort(),['enroll','get','list','previewRebind','rebind','verifySession']);
});
