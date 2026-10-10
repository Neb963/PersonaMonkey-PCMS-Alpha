import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVisibilityService,classifyRetry} from '../../../extension/alpha/features/visibility/service.mjs';
const DAY=86_400_000,MIN=60_000,BASE=Date.parse('2026-10-10T00:00:00.000Z');
const key=i=>'gen-'+String(i).padStart(4,'0');
const record=(name,values={})=>({key:name,fleetIntent:'MANAGED',listingObserved:'PUBLIC',refreshState:'ACTIVE',...values});
function inventory(rows) {
  const byKey=new Map(rows.map(r=>[r.key,r]));
  return {
    async list({cursor,limit=100}={}) {const pos=cursor?Number(cursor):0;return {ok:true,result:{items:rows.slice(pos,pos+limit),cursor:pos+limit<rows.length?String(pos+limit):null,asOf:new Date(BASE).toISOString()},revision:1};},
    async get({key}) {return byKey.has(key)?{ok:true,result:byKey.get(key),revision:1}:{ok:false,error:{code:'NOT_APPLIED'}};}
  };
}
function ledger() {
  let state=null;
  return {async read(){return structuredClone(state);},async update(fn){state=fn(structuredClone(state));return structuredClone(state);},snapshot(){return structuredClone(state);}};
}
function fixture({rows=[record('alpha-one')],now=BASE,feedKeys=['alpha-one'],renderedKeys=feedKeys,
  pinnedKeys=[],filteredKeys=[],statsCount=()=>100,stored=ledger()}={}) {
  let clock=now,feeds=0,views=0,failFeed=false;
  const feedSource={async observe(){feeds++;if(failFeed)throw new Error('Synthetic fetch failure');return {
    source:'TRUSTED_RENDERED_RECENT',feedKeys,renderedKeys,pinnedKeys,filteredKeys,
    asOf:new Date(clock).toISOString(),evidenceRefs:['fixture.recent']
  };}};
  const statsSource={async readViews({key}){views++;return {source:'TRUSTED_GENERATOR_VIEWS',
    views:statsCount(key,clock),asOf:new Date(clock).toISOString()};}};
  const service=createVisibilityService({inventory:inventory(rows),feedSource,statsSource,
    ledger:stored,clock:()=>clock});
  return {service,ledger:stored,advance:ms=>{clock+=ms;},time:()=>clock,feedCalls:()=>feeds,
    statsCalls:()=>views,breakFeed:()=>{failFeed=true;}};
}
test('AP305-01/02: feed order is not rendered order; pinned, filtered and absent remain distinct',async()=>{
  const rows=['alpha-one','beta-two','charlie-three','delta-four','pin-five'].map(name=>record(name));
  const f=fixture({rows,feedKeys:['alpha-one','beta-two','charlie-three','delta-four'],
    renderedKeys:['pin-five','alpha-one','charlie-three','delta-four'],
    pinnedKeys:['pin-five'],filteredKeys:['beta-two']});
  const data=await f.service.observeRecent({limit:5});assert.equal(data.ok,true);
  const all=Object.fromEntries(data.result.items.map(x=>[x.key,x]));
  assert.deepEqual([all['pin-five'].feedPosition,all['pin-five'].renderedPosition,all['pin-five'].status],[null,1,'VISIBLE']);
  assert.deepEqual([all['alpha-one'].feedPosition,all['alpha-one'].renderedPosition],[1,2]);
  assert.deepEqual([all['beta-two'].feedPosition,all['beta-two'].renderedPosition,all['beta-two'].status],[2,null,'LIKELY_FILTERED']);
  assert.equal(all['delta-four'].status,'VISIBLE');
  assert.equal((await f.service.getPosition({key:'not-here'})).error.code,'NOT_APPLIED');
  assert.equal(f.feedCalls(),1);
  const missing=fixture({rows:[record('absent-six')],feedKeys:['other-seven'],renderedKeys:['other-seven']});
  assert.equal((await missing.service.getPosition({key:'absent-six'})).result.status,'NOT_VISIBLE');
});
test('AP305-01: global 10-minute poll is shared, coalesced and survives service recreation',async()=>{
  const l=ledger(),f=fixture({stored:l});
  await Promise.all(Array.from({length:15},()=>f.service.observeRecent({limit:5})));
  assert.equal(f.feedCalls(),1);
  f.advance(9*MIN);assert.equal((await f.service.getPosition({key:'alpha-one'})).ok,true);
  assert.equal(f.feedCalls(),1);
  const rebuilt=fixture({stored:l,now:f.time()});
  assert.equal((await rebuilt.service.getPosition({key:'alpha-one'})).ok,true);
  assert.equal(rebuilt.feedCalls(),0);
  f.advance(MIN);assert.equal((await f.service.observeRecent()).ok,true);
  assert.equal(f.feedCalls(),2);
  const cursor=await f.service.observeRecent({limit:1});assert.equal(cursor.result.cursor,null);
});
test('AP305-02: fixed 1k fleet, global feed and adaptive stats stay within 1000 remote requests/day',async()=>{
  const rows=Array.from({length:1000},(_,i)=>record(key(i),{refreshState:i<60?'ACTIVE':'SLEEPING',
    fleetIntent:i>=800?'EXCLUDED':'MANAGED'}));
  const f=fixture({rows,feedKeys:[key(0)],renderedKeys:[key(0)]});
  for(let tick=0;tick<144;tick++) {
    assert.equal((await f.service.observeRecent({limit:250})).ok,true);
    if(tick===0) {
      // 1000 generator stat checks must not lead to 1000 extra feed fetches.
      for(const row of rows) await f.service.collectStats({key:row.key});
    }
    if(tick<143)f.advance(10*MIN);
  }
  const budget=await f.service.budget();assert.equal(budget.ok,true);
  assert.equal(f.feedCalls(),144);assert.ok(f.statsCalls()<=856);
  assert.ok(f.feedCalls()+f.statsCalls()<=1000);
  assert.equal(budget.result.used,f.feedCalls()+f.statsCalls());
});
test('AP305-03: day/week deltas require baselines; staleness and counter resets are explicit',async()=>{
  const samples=new Map([[BASE,100],[BASE+DAY,140],[BASE+6*DAY,160],[BASE+7*DAY,240]]);
  const f=fixture({statsCount:(_,when)=>samples.get(when)??100});
  let first=await f.service.collectStats({key:'alpha-one'});
  assert.equal(first.ok,true);assert.equal(first.result.dailyViews,null);assert.equal(first.result.weeklyViews,null);
  for(const days of [1,5,1]) {f.advance(days*DAY);await f.service.collectStats({key:'alpha-one'});}
  const week=await f.service.collectStats({key:'alpha-one'});
  assert.equal(week.result.dailyViews,80);assert.equal(week.result.weeklyViews,140);
  assert.equal(week.result.isStale,0);assert.equal(week.result.lastObservedAtMs,BASE+7*DAY);
  // An excluded generator stays on a 72-hour cadence: its 30-hour old sample
  // must report stale rather than silently guessing recent daily/weekly values.
  const low=fixture({rows:[record('alpha-one',{fleetIntent:'EXCLUDED'})]});
  await low.service.collectStats({key:'alpha-one'});low.advance(30*60*MIN);
  const stale=await low.service.collectStats({key:'alpha-one'});
  assert.equal(stale.ok,true);assert.equal(stale.result.isStale,1);
  assert.equal(stale.result.staleAgeMs,30*60*MIN);
  // Provider error: no synthetic fresh view is invented.
  const reset=fixture({statsCount:()=>1});
  assert.equal((await reset.service.collectStats({key:'alpha-one'})).result.dailyViews,null);
  reset.advance(DAY);assert.equal((await reset.service.collectStats({key:'alpha-one'})).result.dailyViews,0);
});
test('AP305-02/03: outage and malformed readback never prove a ban or advance view history',async()=>{
  const f=fixture();await f.service.observeRecent();f.advance(10*MIN);f.breakFeed();
  assert.equal((await f.service.observeRecent()).error.code,'UNAVAILABLE');
  assert.equal(f.feedCalls(),2);
  f.advance(11*MIN);
  assert.equal((await f.service.getPosition({key:'alpha-one'})).error.code,'UNAVAILABLE');
  const last=f.ledger.snapshot().feed;
  assert.equal(last.asOf,new Date(BASE).toISOString());
  const invalid=createVisibilityService({inventory:inventory([record('alpha-one')]),
    feedSource:{observe:async()=>({source:'ACCOUNT_INVENTORY',feedKeys:[],renderedKeys:[],asOf:new Date(BASE).toISOString(),evidenceRefs:[]})},
    statsSource:{readViews:async()=>({views:999})},ledger:ledger(),clock:()=>BASE});
  assert.equal((await invalid.observeRecent()).error.code,'UNAVAILABLE');
  assert.equal((await invalid.collectStats({key:'alpha-one'})).error.code,'UNSUPPORTED_CAPABILITY');
});
test('AP305-01: bounded retry advice does not mutate provider or assert prohibited classification',()=>{
  const nowMs=BASE,base={activeCount:10,margin:.1,failedAttempts:0,nowMs};
  assert.deepEqual(classifyRetry({...base,observation:{status:'VISIBLE',renderedPosition:11}}),
    {action:'ON_TARGET',target:11,delayMs:null});
  assert.equal(classifyRetry({...base,observation:{status:'VISIBLE',renderedPosition:13}}).reason,'BELOW_TARGET');
  const filtered=classifyRetry({...base,observation:{status:'LIKELY_FILTERED',renderedPosition:null}});
  assert.equal(filtered.reason,'FILTERED');assert.equal(filtered.delayMs,3_600_000);
  assert.equal(classifyRetry({...base,failedAttempts:3,observation:{status:'NOT_VISIBLE'}}).action,'SUSPEND');
  assert.equal(classifyRetry({...base,observation:{status:'UNKNOWN'}}).action,'WAIT_FOR_OBSERVATION');
  assert.equal(classifyRetry({...base,lastAttemptAtMs:BASE-1000,observation:{status:'NOT_VISIBLE'}}).action,'BACKOFF');
});
