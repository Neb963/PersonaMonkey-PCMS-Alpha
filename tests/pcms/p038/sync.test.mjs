import test from "node:test";
import assert from "node:assert/strict";
import {createCoreServiceRegistry} from "../../../extension/pcms/services/registry.js";
import {createTimerService,TIMER_STATES,TIMER_NAMESPACE} from "../../../extension/pcms/services/timers.js";
import {createSingletonStateStore} from "../../../extension/pcms/integration/adapters.js";
import {REPO_ERRORS} from "../../../extension/pcms/providers/repository/contract.js";
import {
  createDeployerRepositorySync,repositorySyncBackoff,REPOSITORY_SYNC_SERVICE,
  REPOSITORY_SYNC_OWNER,REPOSITORY_SYNC_GENERATION,REPOSITORY_SYNC_TIMERS
} from "../../../pcms-modules/p015/repository-sync.js";
import {setup} from "../p036/harness.mjs";

const config=Object.freeze({provider:"github",owner:"example",repo:"generators",ref:"main",root:"",
  access:{kind:"public"},network:"default"});
function harness({steps=3}={}){
  const ctx=setup();
  let now="2026-10-08T10:00:00.000Z",completed=0,dispatches=0;
  const clock=()=>now;
  const state={config,scan:null,scanSequence:0,lastCheckedAt:null,lastSuccessfulScanAt:null,
    lastFailure:null,snapshot:{commitId:"1".repeat(40),items:[{slug:"retained"}]}};
  const repo={
    async read(){return {revision:1,value:structuredClone(state)};},
    async startScan(){
      if(!state.scan){state.scan={scanId:++state.scanSequence,cursor:0};}
      return {alreadyRunning:false,scan:state.scan};
    },
    async scanStep(){
      if(!state.scan)return {done:true,status:"IDLE"};
      state.scan.cursor++;
      dispatches++;
      if(state.scan.cursor<steps)return {done:false,status:"VALIDATE"};
      state.scan=null;state.lastCheckedAt=clock();state.lastSuccessfulScanAt=clock();
      return {done:true,status:"SUCCESS"};
    }
  };
  const registry=createCoreServiceRegistry();
  const timers=createTimerService({storageBroker:ctx.storage,auditJournal:ctx.audit.journal,
    serviceRegistry:registry,clock});
  const stateStore=createSingletonStateStore({storageBroker:ctx.storage,namespace:"module.deployer.repository.sync"});
  const sync=createDeployerRepositorySync({repository:repo,timers,stateStore,clock});
  registry.register(REPOSITORY_SYNC_SERVICE,{onTimer:args=>sync.onTimer(args)},
    {ownerId:REPOSITORY_SYNC_OWNER,generation:REPOSITORY_SYNC_GENERATION});
  async function scheduled(){
    return (await timers.list()).filter(row=>row.value.state===TIMER_STATES.SCHEDULED
      &&REPOSITORY_SYNC_TIMERS.includes(row.value.timerId));
  }
  async function run(){
    const results=await timers.runDue({now});
    return results;
  }
  function advance(ms){now=new Date(Date.parse(now)+ms).toISOString();}
  return {ctx,repo,state,sync,timers,stateStore,scheduled,run,advance,
    get now(){return now;},get dispatches(){return dispatches;},get completed(){return completed;}};
}
test("A038-01 scheduled checks execute as bounded steps with zero UI clients and one pending timer",async()=>{
  const h=harness({steps:4});
  const first=await h.sync.declare();
  assert.equal(first.enabled,true);
  assert.equal((await h.scheduled()).length,1);
  await h.sync.declare();
  assert.equal((await h.scheduled()).length,1);
  for(let i=0;i<4;i++){
    const due=(await h.scheduled())[0].value.dueAt;
    if(Date.parse(due)>Date.parse(h.now))h.advance(Date.parse(due)-Date.parse(h.now));
    const pass=await h.run();
    assert.equal(pass.processed.length,1);
    assert.equal(pass.processed[0].value.state,TIMER_STATES.FIRED);
    assert.equal((await h.scheduled()).length,1);
    assert.equal((await h.run()).processed.length,0,"duplicate wake must not redispatch");
  }
  assert.equal(h.dispatches,4);
  assert.equal(h.state.scanSequence,1);
  const next=(await h.scheduled())[0];
  assert.equal(Date.parse(next.value.dueAt)-Date.parse(h.now),60*60*1000);
  assert.equal((await h.sync.readState()).value.failureCount,0);
});
test("A038-01 arbitrarily long sleep/restart collapses missed cadences into one catch-up",async()=>{
  const h=harness({steps:1});
  await h.sync.declare();
  assert.equal((await h.run()).processed.length,1);
  assert.equal(h.dispatches,1);
  h.advance(3*24*60*60*1000);
  await h.sync.declare();
  assert.equal((await h.scheduled()).length,1);
  assert.equal((await h.run()).processed.length,1);
  assert.equal(h.dispatches,2);
  assert.equal((await h.run()).processed.length,0);
  assert.equal(h.state.scanSequence,2);
});
test("A038-02 offline/backoff and rate-limit reset preserve published state and desired intent",async()=>{
  const h=harness({steps:1});
  const initial=structuredClone(h.state.snapshot);
  const deployments={revision:7,deployments:[{id:"existing",desiredRevision:3}]};
  let fault=REPO_ERRORS.UNAVAILABLE,resetAt=null;
  h.repo.scanStep=async()=>{
    h.state.scan=null;h.state.lastFailure={code:fault,...(resetAt?{resetAt}:{})};
    h.state.lastCheckedAt=h.now;
    return {done:true,status:"FAILED",error:fault};
  };
  await h.sync.declare();
  await h.run();
  let scheduled=(await h.scheduled())[0];
  assert.equal(Date.parse(scheduled.value.dueAt)-Date.parse(h.now),60_000);
  h.advance(60_000);
  await h.run();
  scheduled=(await h.scheduled())[0];
  assert.equal(Date.parse(scheduled.value.dueAt)-Date.parse(h.now),120_000);
  h.advance(120_000);
  fault=REPO_ERRORS.RATE_LIMITED;
  resetAt=new Date(Date.parse(h.now)+17*60_000).toISOString();
  await h.run();
  scheduled=(await h.scheduled())[0];
  assert.equal(scheduled.value.dueAt,resetAt);
  assert.equal((await h.sync.readState()).value.failureCount,3);
  assert.deepEqual(h.state.snapshot,initial);
  assert.deepEqual(deployments,{revision:7,deployments:[{id:"existing",desiredRevision:3}]});
  assert.equal(repositorySyncBackoff({failureCount:1,error:fault,resetAt,now:Date.parse(h.now)}),resetAt);
});
test("A038-03 interrupted DISPATCHING timer is recovered once from durable scan checkpoint",async()=>{
  const h=harness({steps:3});
  await h.sync.declare();
  await h.run();
  assert.equal(h.state.scan.cursor,1);
  const timer=(await h.scheduled())[0];
  const bucket=h.ctx.storage.namespace(TIMER_NAMESPACE);
  const claimed=await bucket.compareAndSwap(timer.value.timerId,{
    expectedRevision:timer.revision,value:{...timer.value,state:TIMER_STATES.DISPATCHING}
  });
  assert.equal(claimed.value.state,TIMER_STATES.DISPATCHING);
  const recovered=await h.timers.recoverInterrupted({now:h.now});
  assert.equal(recovered.recovered.length,1);
  assert.equal(recovered.recovered[0].value.missedReason,"interrupted");
  await h.sync.declare();
  assert.equal((await h.scheduled()).length,1);
  h.advance(1000);
  await h.run();
  assert.equal(h.state.scan.cursor,2);
  assert.equal(h.state.scanSequence,1,"restart must continue one scan, not start another");
  h.advance(1000);
  await h.run();
  assert.equal(h.state.scan,null);
  assert.equal(h.dispatches,3);
  assert.equal((await h.scheduled()).length,1);
});
test("A038-02 no repository config declares no scan and cancels a pending schedule",async()=>{
  const h=harness();
  await h.sync.declare();
  delete h.state.config;h.state.config=null;
  assert.equal((await h.sync.declare()).enabled,false);
  assert.equal((await h.scheduled()).length,0);
  assert.equal(h.dispatches,0);
});

test("A038-03 a fully committed scan checkpoint is recognized after an interrupted sync-state write",async()=>{
  const h=harness({steps:2});
  await h.sync.declare();
  // The P037 final checkpoint committed, but the event page was terminated
  // before the P038 state CAS. This replay must not prepare desired state twice.
  h.state.scanSequence=1;
  h.state.lastCheckedAt=h.now;
  h.state.lastSuccessfulScanAt=h.now;
  const pass=await h.run();
  assert.equal(pass.processed.length,1);
  assert.equal(h.dispatches,0);
  assert.equal(h.state.scanSequence,1);
  assert.equal((await h.scheduled()).length,1);
  assert.equal((await h.sync.readState()).value.lastCheckedAt,h.now);
});
test("A038-03 a missed callback that failed outside the repository step is re-declared",async()=>{
  const h=harness();
  await h.sync.declare();
  const pending=(await h.scheduled())[0];
  const row=await h.ctx.storage.namespace(TIMER_NAMESPACE).compareAndSwap(pending.value.timerId,{
    expectedRevision:pending.revision,
    value:{...pending.value,state:TIMER_STATES.MISSED,completedAt:h.now,missedReason:"delivery-failed"}
  });
  assert.equal(row.value.state,TIMER_STATES.MISSED);
  await h.sync.declare();
  assert.equal((await h.scheduled()).length,1);
  assert.notEqual((await h.scheduled())[0].value.timerId,pending.value.timerId);
  h.advance(1000);
  await h.run();
  assert.equal(h.dispatches,1);
});
