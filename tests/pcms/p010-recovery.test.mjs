import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteOps } from "../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../extension/pcms/remoteops/provider-gate.js";
import { REMOTE_OP_ERROR_CODES } from "../../extension/pcms/remoteops/errors.js";
import { makeStorage, op } from "./p010-harness.mjs";

const checks={moduleGenerations:true,personaBindings:true,providerCapabilities:true};

test("A010-03 recovery hold is durable, recovers interrupted dispatch, and blocks mutation",async()=>{
 const shared={rows:new Map()};const storage=makeStorage(shared);const ops=createRemoteOps({storageBroker:storage});
 let row=await ops.prepare(op());await ops.beginDispatch("op-1",{expectedRevision:row.revision});
 const recovery=createRecoveryHoldController({storageBroker:storage,remoteOps:ops});const entered=await recovery.enterRecoveryHold({reason:"restore"});
 assert.deepEqual(entered.recoveredOperationIds,["op-1"]);assert.equal(entered.hold.value.state,"RECOVERY_HOLD");
 const restartedOps=createRemoteOps({storageBroker:makeStorage(shared)});const restartedRecovery=createRecoveryHoldController({storageBroker:makeStorage(shared),remoteOps:restartedOps});
 assert.equal((await restartedRecovery.getStatus()).value.state,"RECOVERY_HOLD");
 const gate=createProviderGate({remoteOps:restartedOps,recoveryHold:restartedRecovery,providers:{perchance:{operations:{"generator.update":{dispatch:async()=>({status:"APPLIED"}),reconcile:async()=>({status:"APPLIED"})}}}}});
 await assert.rejects(gate.mutate({operation:op({operationId:"op-2"}),dispatchInput:{}}),e=>e?.code===REMOTE_OP_ERROR_CODES.RECOVERY_HOLD);
});

test("A010-03 recovery release requires all checks and zero unresolved RemoteOps",async()=>{
 const storage=makeStorage();const ops=createRemoteOps({storageBroker:storage});const recovery=createRecoveryHoldController({storageBroker:storage,remoteOps:ops});
 await ops.prepare(op());const entered=await recovery.enterRecoveryHold();
 await assert.rejects(recovery.releaseRecoveryHold({expectedRevision:entered.hold.revision,checks:{...checks,providerCapabilities:false}}),e=>e?.code===REMOTE_OP_ERROR_CODES.RECOVERY_INCOMPLETE);
 await assert.rejects(recovery.releaseRecoveryHold({expectedRevision:entered.hold.revision,checks}),e=>e?.code===REMOTE_OP_ERROR_CODES.RECOVERY_INCOMPLETE);
 let row=await ops.get("op-1");await ops.cancel("op-1",{expectedRevision:row.revision});
 const released=await recovery.releaseRecoveryHold({expectedRevision:entered.hold.revision,checks});assert.equal(released.value.state,"NORMAL");
});

test("A010-03 UNCERTAIN reconciliation is allowed while recovery hold blocks dispatch",async()=>{
 const storage=makeStorage();const ops=createRemoteOps({storageBroker:storage});const recovery=createRecoveryHoldController({storageBroker:storage,remoteOps:ops});
 let row=await ops.prepare(op());row=await ops.beginDispatch("op-1",{expectedRevision:row.revision});row=await ops.markUncertain("op-1",{expectedRevision:row.revision});
 const entered=await recovery.enterRecoveryHold();let reconciles=0;
 const gate=createProviderGate({
  remoteOps:ops,
  recoveryHold:recovery,
  providers:{perchance:{operations:{"generator.update":{
    dispatch:async()=>({status:"APPLIED"}),
    reconcile:async()=>{reconciles+=1;return{status:"APPLIED"};}
  }}}}
 });
 const resolved=await gate.reconcile("op-1");assert.equal(resolved.value.state,"SUCCEEDED");assert.equal(reconciles,1);
 const released=await recovery.releaseRecoveryHold({expectedRevision:entered.hold.revision,checks});assert.equal(released.value.state,"NORMAL");
});
