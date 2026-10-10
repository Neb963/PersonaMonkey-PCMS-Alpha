import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefresherService } from '../../../extension/alpha/features/refresher/service.mjs';
import { initialState, capacity, DEFAULT_CONFIG, HOUR, JITTER } from '../../../extension/alpha/features/refresher/model.mjs';
const start = Date.parse('2026-10-10T00:00:00Z');
const fixed = 'a'.repeat(64);
function generator(n) {return { key: 'gen'+String(n).padStart(4,'0'), accountId:'account-one', personaUid:'persona-one',
  accountBindingEpoch:1, fleetIntent:'MANAGED', listingObserved:'PUBLIC', deployState:'DEPLOYED',
  refreshState:'ELIGIBLE', releaseId: fixed, sourceBinding:{status:'READY'}, attentionRefs:[],
  revision:1, asOf:new Date(start).toISOString() };}
function harness(count=12, opts={}) {
  let now=start, inventoryRevision=1, data=Array.from({length:count},(_,i)=>generator(i));
  let state=initialState();
  const ledger = { async read() { return structuredClone(state); },
    async transact(expectedRevision, mutate) { if(expectedRevision!==null && state.revision!==expectedRevision)
      throw Object.assign(new Error('STALE_REVISION'),{code:'STALE_REVISION'});
      const next=structuredClone(state),result=mutate(next);next.revision++;state=next;
      return {revision:next.revision,value:structuredClone(state),result:structuredClone(result)}; } };
  const storage = {async list() {return {revision:inventoryRevision,items:data.map(r=>({record:structuredClone(r)}))};},
    async read(k,key) { const record=data.find(x=>x.key===key);return {revision:1,item:record?{record:structuredClone(record)}:null};}};
  const make = () => createRefresherService({storage,ledger,clock:()=>now,random:opts.random??(()=>.5),maxHealthyGapMs:24*HOUR});
  const service=make();
  const move = hours => {now += hours*HOUR;};
  const setTime = value => {now=value;};
  const health = (state,runId='run-one',evidenceRefs=state==='OUTAGE'?['outage.readback']:[])=>service.checkpoint({state,runId,at:now,evidenceRefs});
  const config = async options=>{const rev=(await service.inspect()).revision;let r=await service.configure({expectedRevision:rev,options}); assert.equal(r.ok,true,JSON.stringify(r));return r;};
  const manual = async(key,action)=>{const rev=(await service.inspect()).revision;
    return service.setEligibility({key,accountId:'account-one',personaUid:'persona-one',accountBindingEpoch:1,expectedRevision:rev,options:{action}});};
  return {service, ledger,storage,move,setTime,health,config,manual,make, get data(){return data;},setData:items=>{data=items; inventoryRevision++;}};
}
test('AP304-01: 24/72 ratio, observed capacity, margin, manual target and 1k bounded pool', async()=>{
  const p={...DEFAULT_CONFIG,observedCapacity:200};
  assert.equal(capacity(p,96).cap,24);
  assert.equal(capacity(p,72).cap,18);
  assert.equal(capacity({...p,observedCapacity:20},72).cap,18);
  assert.equal(capacity({...p,manualCap:5},72).cap,5);
  assert.equal(capacity({...p,observedCapacity:null},72).cap,0);
  const h=harness(1000);
  await h.config({observedCapacity:200});await h.health('HEALTHY');
  const planned=await h.service.planPass();assert.equal(planned.ok,true);
  assert.equal(planned.result.length,200 / 1.1 | 0); // capacity floor = 181
  assert.equal(new Set(planned.result).size,planned.result.length);
  const cap = await h.service.inspect();assert.equal(Object.values(cap.schedules).filter(x=>x.phase==='ACTIVE').length,181);
  await h.config({manualCap:5}); await h.service.planPass();
  assert.equal(Object.values((await h.service.inspect()).schedules).filter(x=>x.phase==='ACTIVE').length,5);
  const rejected=await h.service.configure({expectedRevision:(await h.service.inspect()).revision,options:{manualCap:200}});
  assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'INVALID_REQUEST');
});
test('AP304-02: shutdown and outage pause; warm idle unload counts; cold run does not', async()=>{
 const h=harness(1);await h.config({observedCapacity:10});await h.health('HEALTHY');
 assert.deepEqual((await h.service.planPass()).result,['gen0000']);
 h.move(1/6);assert.equal((await h.health('HEALTHY')).result.creditedMs,10*60_000);
 h.move(1);assert.equal((await h.health('OUTAGE')).result.creditedMs,0);
 h.move(2);assert.equal((await h.health('HEALTHY')).result.creditedMs,0);
 h.move(1/6);assert.equal((await h.health('HEALTHY')).result.creditedMs,10*60_000);
 h.move(1);assert.equal((await h.health('SHUTDOWN')).result.creditedMs,0);
 h.move(24);assert.equal((await h.health('HEALTHY','run-two')).result.creditedMs,0);
 h.move(1/6);assert.equal((await h.health('HEALTHY','run-two')).result.creditedMs,10*60_000);
 const check=(await h.service.inspect()).schedules.gen0000;assert.equal(check.activeHealthyMs,30*60_000);
 const restarted=h.make();assert.equal((await restarted.inspect()).schedules.gen0000.activeHealthyMs,30*60_000);
});
test('AP304-03: independently jittered active/sleep, minimum sleep, longest waiting and manual hold',async()=>{
 const h=harness(3,{random:()=>0});await h.config({activeHours:1,sleepHours:2,observedCapacity:1,margin:0});
 await h.health('HEALTHY');assert.deepEqual((await h.service.planPass()).result,['gen0000']);
 let s=(await h.service.inspect()).schedules;
 assert.equal(s.gen0000.activeTargetMs, HOUR-JITTER);
 h.move(1/2);await h.health('HEALTHY');assert.deepEqual((await h.service.planPass()).result,['gen0001']);
 s=(await h.service.inspect()).schedules;
 assert.equal(s.gen0000.phase,'SLEEPING');assert.ok(s.gen0000.sleepUntil>=start+2.5*HOUR);
 assert.equal((await h.manual('gen0001','PULL_OUT')).ok,true);
 assert.equal((await h.manual('gen0001','PULL_IN')).ok,true);
 assert.equal((await h.service.planPass()).result.length,1); // gen0002 is available
 s=(await h.service.inspect()).schedules;assert.equal(s.gen0001.phase,'SLEEPING');
 await h.manual('gen0001','PULL_OUT');
 h.move(3);await h.health('HEALTHY'); await h.service.planPass();
 s=(await h.service.inspect()).schedules;assert.equal(s.gen0001.manualOut,true);
 assert.notEqual(s.gen0001.phase,'ACTIVE');
 await h.manual('gen0001','PULL_IN');
 // Pulling in does not bypass occupied cap or modify another generator's active time.
 assert.equal((await h.service.planPass()).result.length,0);
});
test('fail closed for stale revision, Persona rebind, unknown capacity and outage without evidence',async()=>{
 const h=harness(1);await h.health('HEALTHY');assert.deepEqual((await h.service.planPass()).result,[]);
 assert.equal((await h.service.configure({expectedRevision:0,options:{observedCapacity:50}})).error.code,'STALE_REVISION');
 assert.equal((await h.health('OUTAGE','run-one',[])).error.code,'INVALID_REQUEST');
 const invalid=await h.service.setEligibility({key:'gen0000',accountId:'account-one',personaUid:'old',accountBindingEpoch:1,
  expectedRevision:(await h.service.inspect()).revision,options:{action:'PULL_OUT'}});
 assert.equal(invalid.error.code,'STALE_BINDING');
});

test('status cursor is revision-fenced and configured response stays numeric',async()=>{
 const h=harness(3); const configured=await h.config({observedCapacity:20});
 assert.equal(Object.values(configured.result).every(x=>typeof x==='number'),true);
 let first=await h.service.status({limit:1});
 assert.equal(first.ok,true);assert.equal(first.result.items.length,1);
 assert.equal((await h.service.status({cursor:first.result.cursor,limit:1})).ok,true);
 await h.config({manualCap:2});
 assert.equal((await h.service.status({cursor:first.result.cursor,limit:1})).error.code,'STALE_REVISION');
});

test('inventory cursor fences independent P102 inventory changes',async()=>{
 const h=harness(3); const first=await h.service.status({limit:1});
 assert.equal(first.ok,true);
 h.setData([...h.data, generator(3)]);
 const second=await h.service.status({cursor:first.result.cursor,limit:1});
 assert.equal(second.ok,false); assert.equal(second.error.code,'STALE_REVISION');
});
test('positive jitter does not shorten sleep; idle timeout has bounded replay',async()=>{
 const h=harness(1,{random:()=>1});await h.config({activeHours:1,sleepHours:72,observedCapacity:10});
 await h.health('HEALTHY');assert.deepEqual((await h.service.planPass()).result,['gen0000']);
 h.move(1.5);await h.health('HEALTHY'); await h.service.planPass();
 const row=(await h.service.inspect()).schedules.gen0000;
 assert.equal(row.phase,'SLEEPING');
 assert.equal(row.sleepUntil,row.sleepStartedAt + 72*HOUR + JITTER);
 const h2=harness(1);await h2.config({observedCapacity:5});
 await h2.service.checkpoint({at:start,state:'HEALTHY',runId:'run-one'});
 await h2.service.planPass();
 h2.move(4);
 const fresh=createRefresherService({storage:h2.storage,ledger:h2.ledger,clock:()=>start+4*HOUR,random:()=>0.5});
 assert.equal((await fresh.checkpoint({at:start+4*HOUR,state:'HEALTHY',runId:'run-one'})).result.creditedMs,15*60_000);
});
