import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteOps } from "../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../extension/pcms/remoteops/provider-gate.js";
import { REMOTE_OP_ERROR_CODES } from "../../extension/pcms/remoteops/errors.js";
import { makeStorage, op } from "./p010-harness.mjs";

function setup({dispatch,reconcile=async()=>({status:"UNKNOWN"})}={}){
 const storage=makeStorage();const ops=createRemoteOps({storageBroker:storage});const recovery=createRecoveryHoldController({storageBroker:storage,remoteOps:ops});
 const gate=createProviderGate({remoteOps:ops,recoveryHold:recovery,providers:{perchance:{operations:{"generator.update":{dispatch:dispatch|| (async()=>({status:"APPLIED"})),reconcile}}}}});
 return{storage,ops,recovery,gate};
}

test("A010-02 ProviderGate persists DISPATCHING before external dispatch",async()=>{
 let observed=null;let h;
 h=setup({dispatch:async()=>{observed=await h.ops.get("op-1");return{status:"APPLIED"};}});
 const result=await h.gate.mutate({operation:op(),dispatchInput:{payload:"transient"}});
 assert.equal(observed.value.state,"DISPATCHING");assert.equal(observed.value.attempt,1);
 assert.equal(result.operation.value.state,"SUCCEEDED");
});

test("A010-02 provider exceptions become UNCERTAIN and require reconciliation before retry",async()=>{
 let dispatches=0;let reconciliation="UNKNOWN";
 const h=setup({dispatch:async()=>{dispatches+=1;if(dispatches===1)throw new Error("network");return{status:"APPLIED"};},reconcile:async()=>({status:reconciliation})});
 await assert.rejects(h.gate.mutate({operation:op(),dispatchInput:{}}),e=>e?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL);
 assert.equal((await h.ops.get("op-1")).value.state,"UNCERTAIN");
 await assert.rejects(h.gate.mutate({operation:op(),dispatchInput:{}}),e=>e?.code===REMOTE_OP_ERROR_CODES.RECONCILE_REQUIRED);
 assert.equal(dispatches,1);
 let row=await h.gate.reconcile("op-1");assert.equal(row.value.state,"UNCERTAIN");
 reconciliation="NOT_APPLIED";row=await h.gate.reconcile("op-1");assert.equal(row.value.state,"RETRYABLE");
 const done=await h.gate.mutate({operation:op(),dispatchInput:{}});assert.equal(done.operation.value.state,"SUCCEEDED");assert.equal(dispatches,2);
});

test("A010-02 unknown provider/action behavior fails closed without dispatch",async()=>{
 const h=setup();
 await assert.rejects(h.gate.mutate({operation:op({providerId:"unknown"}),dispatchInput:{}}),e=>e?.code===REMOTE_OP_ERROR_CODES.PROVIDER_UNKNOWN);
 await assert.rejects(h.gate.mutate({operation:op({operationId:"op-2",action:"unknown.action"}),dispatchInput:{}}),e=>e?.code===REMOTE_OP_ERROR_CODES.ACTION_UNKNOWN);
 assert.equal(await h.ops.get("op-1"),null);
 assert.equal(await h.ops.get("op-2"),null);
});

test("A010-02 transient dispatch input, including secret material, is never persisted",async()=>{
 const h=setup();const secret="super-secret-value";
 await h.gate.mutate({operation:op(),dispatchInput:{secret}});
 const serialized=JSON.stringify([...h.storage.shared.rows.values()]);assert.equal(serialized.includes(secret),false);assert.equal(serialized.includes("dispatchInput"),false);
});

test("A010-02 malformed provider success shape is treated as ambiguous",async()=>{
 const h=setup({dispatch:async()=>({status:"APPLIED",extra:true})});
 await assert.rejects(h.gate.mutate({operation:op(),dispatchInput:{}}),e=>e?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL);
 assert.equal((await h.ops.get("op-1")).value.state,"UNCERTAIN");
});
