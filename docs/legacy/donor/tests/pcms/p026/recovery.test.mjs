import test from "node:test";
import assert from "node:assert/strict";

import { recoverPcmsLiveStartup } from "../../../extension/pcms/integration/live-core.js";
import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../../extension/pcms/remoteops/provider-gate.js";
import { REMOTE_OP_ERROR_CODES } from "../../../extension/pcms/remoteops/errors.js";
import { makeStorage, op } from "../p010-harness.mjs";

const checks={moduleGenerations:true,personaBindings:true,providerCapabilities:true};

test("A026-02 restart enters RECOVERY_HOLD before recovering an interrupted live dispatch",async()=>{
  const storage=makeStorage();
  const remoteOps=createRemoteOps({
    storageBroker:storage,
    clock:()=>"2026-10-06T16:30:00.000Z"
  });
  const recoveryHold=createRecoveryHoldController({
    storageBroker:storage,
    remoteOps,
    clock:()=>"2026-10-06T16:30:01.000Z"
  });

  let row=await remoteOps.prepare(op({operationId:"p026-interrupted"}));
  row=await remoteOps.beginDispatch("p026-interrupted",{expectedRevision:row.revision});

  const events=[];
  const moduleRuntime=Object.freeze({
    async recoverAll(){
      events.push((await recoveryHold.getStatus()).value.state);
      return Object.freeze(["demo.module"]);
    }
  });

  const result=await recoverPcmsLiveStartup({remoteOps,recoveryHold,moduleRuntime});
  assert.equal(result.recoveryState,"RECOVERY_HOLD");
  assert.deepEqual(result.interruptedOperationIds,["p026-interrupted"]);
  assert.deepEqual(result.recoveredModuleIds,["demo.module"]);
  assert.deepEqual(events,["RECOVERY_HOLD"],"module recovery must observe the durable hold");
  assert.equal((await remoteOps.get("p026-interrupted")).value.state,"UNCERTAIN");
});

test("A026-02 RECOVERY_HOLD blocks new dispatch and reconciliation never replays the interrupted mutation",async()=>{
  const storage=makeStorage();
  const remoteOps=createRemoteOps({storageBroker:storage});
  const recoveryHold=createRecoveryHoldController({storageBroker:storage,remoteOps});
  let dispatches=0;
  let reconciles=0;
  const gate=createProviderGate({
    remoteOps,
    recoveryHold,
    providers:{
      perchance:{
        operations:{
          "generator.update":{
            async dispatch(){dispatches+=1;return {status:"APPLIED"};},
            async reconcile(){reconciles+=1;return {status:"NOT_APPLIED"};}
          }
        }
      }
    }
  });

  let row=await remoteOps.prepare(op({operationId:"p026-recover"}));
  row=await remoteOps.beginDispatch("p026-recover",{expectedRevision:row.revision});
  await recoverPcmsLiveStartup({
    remoteOps,
    recoveryHold,
    moduleRuntime:Object.freeze({async recoverAll(){return Object.freeze([]);}})
  });

  await assert.rejects(
    gate.mutate({operation:op({operationId:"p026-new"}),dispatchInput:{}}),
    (error)=>error?.code===REMOTE_OP_ERROR_CODES.RECOVERY_HOLD
  );
  assert.equal(dispatches,0);

  const reconciled=await gate.reconcile("p026-recover");
  assert.equal(reconciled.value.state,"RETRYABLE");
  assert.equal(reconciles,1);
  assert.equal(dispatches,0);

  const cancelled=await remoteOps.cancel("p026-recover",{expectedRevision:reconciled.revision});
  assert.equal(cancelled.value.state,"CANCELLED");
  const held=await recoveryHold.getStatus();
  const released=await recoveryHold.releaseRecoveryHold({
    expectedRevision:held.revision,
    checks
  });
  assert.equal(released.value.state,"NORMAL");
  assert.equal(dispatches,0,"recovery must never redispatch a possibly successful mutation");
});

test("A026-02 clean restart remains NORMAL and still advances module generation recovery",async()=>{
  const storage=makeStorage();
  const remoteOps=createRemoteOps({storageBroker:storage});
  const recoveryHold=createRecoveryHoldController({storageBroker:storage,remoteOps});
  let recoverCalls=0;
  const result=await recoverPcmsLiveStartup({
    remoteOps,
    recoveryHold,
    moduleRuntime:Object.freeze({
      async recoverAll(){recoverCalls+=1;return Object.freeze(["module-a"]); }
    })
  });
  assert.equal(result.recoveryState,"NORMAL");
  assert.deepEqual(result.interruptedOperationIds,[]);
  assert.deepEqual(result.recoveredModuleIds,["module-a"]);
  assert.equal(recoverCalls,1);
});
