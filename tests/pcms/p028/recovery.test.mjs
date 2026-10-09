import test from "node:test";
import assert from "node:assert/strict";

import { recoverPcmsLiveStartup, recoverPcmsWarmWake } from "../../../extension/pcms/integration/live-core.js";
import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../../extension/pcms/remoteops/provider-gate.js";
import { REMOTE_OP_ERROR_CODES } from "../../../extension/pcms/remoteops/errors.js";
import { makeStorage, op } from "../p010-harness.mjs";

// A context is the set of service objects one event-page lifetime builds over durable storage.
function context(storage){
  const remoteOps=createRemoteOps({storageBroker:storage,clock:()=>"2026-10-07T12:00:00.000Z"});
  const recoveryHold=createRecoveryHoldController({storageBroker:storage,remoteOps,clock:()=>"2026-10-07T12:00:01.000Z"});
  const recovered=[];
  const moduleRuntime=Object.freeze({async recoverAll(){recovered.push((await recoveryHold.getStatus()).value.state);return Object.freeze(["demo.module"]);}});
  return {remoteOps,recoveryHold,moduleRuntime,recovered};
}

async function seed(remoteOps,states){
  for(const [id,state] of Object.entries(states)){
    let row=await remoteOps.prepare(op({operationId:id,targetRef:{kind:"generator",id:"gen-"+id}}));
    if(state==="PREPARED") continue;
    row=await remoteOps.beginDispatch(id,{expectedRevision:row.revision});
    if(state==="DISPATCHING") continue;
    row=await remoteOps.markUncertain(id,{expectedRevision:row.revision});
    if(state==="UNCERTAIN") continue;
    row=await remoteOps.reconcile(id,{expectedRevision:row.revision,outcome:"NOT_APPLIED"});
    assert.equal(row.value.state,"RETRYABLE");
  }
}

const table=[
  {name:"nothing unresolved",states:{},cold:"NORMAL",warm:"NORMAL"},
  {name:"PREPARED/RETRYABLE/UNCERTAIN only",states:{a:"PREPARED",b:"RETRYABLE",c:"UNCERTAIN"},cold:"RECOVERY_HOLD",warm:"NORMAL"},
  {name:"interrupted DISPATCHING",states:{d:"DISPATCHING"},cold:"RECOVERY_HOLD",warm:"RECOVERY_HOLD"},
  {name:"DISPATCHING with other unresolved",states:{a:"PREPARED",c:"UNCERTAIN",d:"DISPATCHING"},cold:"RECOVERY_HOLD",warm:"RECOVERY_HOLD"}
];

for(const row of table){
  test("A028-02 wake classification: "+row.name+" (cold "+row.cold+", warm "+row.warm+")",async()=>{
    for(const wake of ["cold","warm"]){
      const storage=makeStorage();
      const first=context(storage);
      await seed(first.remoteOps,row.states);
      const next=context(storage);
      const recover=wake==="cold"?recoverPcmsLiveStartup:recoverPcmsWarmWake;
      const result=await recover(next);
      assert.equal(result.recoveryState,row[wake],wake);
      assert.deepEqual(result.recoveredModuleIds,["demo.module"]);
      assert.deepEqual(next.recovered,[row[wake]],"module recovery observes the durable hold decision");
      const dispatching=Object.entries(row.states).filter(([,state])=>state==="DISPATCHING").map(([id])=>id);
      assert.deepEqual([...result.interruptedOperationIds].sort(),dispatching.sort());
      for(const [id,state] of Object.entries(row.states)){
        const expected=state==="DISPATCHING"?"UNCERTAIN":state;
        assert.equal((await next.remoteOps.get(id)).value.state,expected,wake+" "+id);
      }
    }
  });
}

test("A028-02 an existing hold survives a warm wake unchanged and is never released implicitly",async()=>{
  const storage=makeStorage();
  const first=context(storage);
  await first.recoveryHold.enterRecoveryHold({reason:"restore:backup-1"});
  const result=await recoverPcmsWarmWake(context(storage));
  assert.equal(result.recoveryState,"RECOVERY_HOLD");
  assert.equal((await context(storage).recoveryHold.getStatus()).value.reason,"restore:backup-1");
});

test("A028-02 FAULT: unload during provider dispatch → warm wake UNCERTAIN + hold, never replayed",async()=>{
  const storage=makeStorage();
  let dispatches=0;
  let reconciles=0;
  const providers=(hang)=>({
    perchance:{operations:{"generator.update":{
      async dispatch(){dispatches+=1;if(hang) return new Promise(()=>{});return {status:"APPLIED"};},
      async reconcile(){reconciles+=1;return {status:"APPLIED"};}
    }}}
  });
  // Context 1 dispatches and is unloaded at the dispatch step boundary.
  const first=context(storage);
  const gate1=createProviderGate({remoteOps:first.remoteOps,recoveryHold:first.recoveryHold,providers:providers(true)});
  void gate1.mutate({operation:op({operationId:"fault-1"}),dispatchInput:{}});
  for(let i=0;i<20&&dispatches===0;i+=1) await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(dispatches,1);
  assert.equal((await first.remoteOps.get("fault-1")).value.state,"DISPATCHING");

  // Context 2: warm wake in the same browser session.
  const second=context(storage);
  const result=await recoverPcmsWarmWake(second);
  assert.equal(result.recoveryState,"RECOVERY_HOLD");
  assert.deepEqual(result.interruptedOperationIds,["fault-1"]);
  assert.equal((await second.remoteOps.get("fault-1")).value.state,"UNCERTAIN");
  const gate2=createProviderGate({remoteOps:second.remoteOps,recoveryHold:second.recoveryHold,providers:providers(false)});
  await assert.rejects(gate2.mutate({operation:op({operationId:"fault-1"}),dispatchInput:{}}),
    (error)=>error.code===REMOTE_OP_ERROR_CODES.RECOVERY_HOLD);
  assert.equal(dispatches,1,"interrupted dispatch is never replayed");
  const reconciled=await gate2.reconcile("fault-1");
  assert.equal(reconciled.value.state,"SUCCEEDED");
  assert.equal(reconciles,1);
  assert.equal(dispatches,1);

  // A further warm wake with nothing interrupted keeps the existing hold but adds nothing.
  const third=await recoverPcmsWarmWake(context(storage));
  assert.deepEqual(third.interruptedOperationIds,[]);
});

test("A028-02 FAULT: unload at every RemoteOperation step boundary is recovered deterministically on warm wake",async()=>{
  const steps=["PREPARED","DISPATCHING","UNCERTAIN","RETRYABLE"];
  for(const step of steps){
    const storage=makeStorage();
    await seed(context(storage).remoteOps,{x:step});
    const woke=context(storage);
    const result=await recoverPcmsWarmWake(woke);
    const state=(await woke.remoteOps.get("x")).value.state;
    if(step==="DISPATCHING"){
      assert.equal(state,"UNCERTAIN");
      assert.equal(result.recoveryState,"RECOVERY_HOLD");
    } else {
      assert.equal(state,step,"non-dispatching state is left to its per-target fail-closed rules");
      assert.equal(result.recoveryState,"NORMAL");
    }
    // Recovery is idempotent across duplicate wakes.
    const again=await recoverPcmsWarmWake(context(storage));
    assert.equal(again.recoveryState,result.recoveryState);
    assert.equal((await context(storage).remoteOps.get("x")).value.state,state);
  }
});
