import test from "node:test";
import assert from "node:assert/strict";
import { createProvisioningProviderAdapter, PROVISIONING_DRIVER_CONTRACT_ID, PROVISIONING_DRIVER_CONTRACT_VERSION } from "../../../pcms-modules/p019/provider.js";
import { PROVISIONING_ERROR_CODES } from "../../../pcms-modules/p019/errors.js";
import { PROVISIONING_PROVIDER_ID, PROVISIONING_REMOTE_ACTION, provisioningIntentFingerprint } from "../../../pcms-modules/p019/schema.js";
import { SECRET_REF, UID_A } from "./harness.mjs";

function operation(state="DISPATCHING"){
  const now="2026-10-05T12:00:00.000Z";
  return {schemaVersion:1,kind:"remote-operation",operationId:"p019:attempt-1:op:1",providerId:PROVISIONING_PROVIDER_ID,action:PROVISIONING_REMOTE_ACTION,targetRef:{kind:"account",id:"account-1"},intentFingerprint:provisioningIntentFingerprint("attempt-1",1),state,attempt:1,createdAt:now,updatedAt:now,lastDispatchAt:now,resolvedAt:null,resolution:state==="UNCERTAIN"?"AMBIGUOUS":null};
}
function driver(){
  const calls=[]; let mutation={status:"APPLIED"}, reconciliation={status:"UNKNOWN"}, preflight={status:"READY",reason:null};
  return {
    api:Object.freeze({
      async probe(){ return {contractId:PROVISIONING_DRIVER_CONTRACT_ID,contractVersion:PROVISIONING_DRIVER_CONTRACT_VERSION,providerId:PROVISIONING_PROVIDER_ID,operations:[PROVISIONING_REMOTE_ACTION]}; },
      async preflight(input){ calls.push(["preflight",structuredClone(input)]); return structuredClone(preflight); },
      async provisionAccount(input){ calls.push(["provision",structuredClone(input)]); return structuredClone(mutation); },
      async reconcileAccountProvisioning(input){ calls.push(["reconcile",structuredClone(input)]); return structuredClone(reconciliation); }
    }),
    calls,
    setMutation(v){mutation=v;}, setReconciliation(v){reconciliation=v;}, setPreflight(v){preflight=v;}
  };
}
const input=()=>({attemptId:"attempt-1",accountId:"account-1",personaUid:UID_A,credentialRef:SECRET_REF,sessionHandle:{opaque:"session"}});

test("A019-02: provider preflight exposes only explicit READY/HUMAN_REQUIRED gates", async()=>{
  const d=driver(); const adapter=createProvisioningProviderAdapter({driver:d.api});
  assert.equal((await adapter.probeCompatibility()).providerId,"perchance");
  assert.deepEqual(await adapter.preflight(input()),{status:"READY",reason:null});
  d.setPreflight({status:"HUMAN_REQUIRED",reason:"CAPTCHA"});
  assert.deepEqual(await adapter.preflight(input()),{status:"HUMAN_REQUIRED",reason:"CAPTCHA"});
  assert.equal(d.calls.filter(([kind])=>kind==="provision").length,0);
});

test("A019-01: dispatch passes opaque SecretRef/session handle but never resolves credentials", async()=>{
  const d=driver(); const adapter=createProvisioningProviderAdapter({driver:d.api});
  assert.deepEqual(await adapter.providerDescriptor.operations[PROVISIONING_REMOTE_ACTION].dispatch({operation:operation(),dispatchInput:input()}),{status:"APPLIED"});
  const sent=d.calls.find(([kind])=>kind==="provision")[1];
  assert.equal(sent.credentialRef,SECRET_REF);
  assert.deepEqual(sent.sessionHandle,{opaque:"session"});
  assert.equal(Object.hasOwn(sent,"password"),false);
  assert.equal(Object.hasOwn(sent,"secret"),false);
});

test("A019-03: reconciliation accepts UNKNOWN while dispatch rejects ambiguous/malformed outcomes", async()=>{
  const d=driver(); const adapter=createProvisioningProviderAdapter({driver:d.api});
  d.setMutation({status:"UNKNOWN"});
  await assert.rejects(()=>adapter.providerDescriptor.operations[PROVISIONING_REMOTE_ACTION].dispatch({operation:operation(),dispatchInput:input()}),(e)=>e.code===PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  d.setReconciliation({status:"UNKNOWN"});
  assert.deepEqual(await adapter.providerDescriptor.operations[PROVISIONING_REMOTE_ACTION].reconcile({operation:operation("UNCERTAIN")}),{status:"UNKNOWN"});
});

test("provider contract fails closed on incompatible or accessor-shaped compatibility data", async()=>{
  const bad={
    probe:async()=>({contractId:PROVISIONING_DRIVER_CONTRACT_ID,contractVersion:999,providerId:PROVISIONING_PROVIDER_ID,operations:[PROVISIONING_REMOTE_ACTION]}),
    preflight:async()=>({status:"READY",reason:null}),provisionAccount:async()=>({status:"APPLIED"}),reconcileAccountProvisioning:async()=>({status:"UNKNOWN"})
  };
  await assert.rejects(()=>createProvisioningProviderAdapter({driver:bad}).probeCompatibility(),(e)=>e.code===PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  let getterCalled=false;
  const accessDriver={
    probe:async()=>{ const out={contractId:PROVISIONING_DRIVER_CONTRACT_ID,contractVersion:1,providerId:PROVISIONING_PROVIDER_ID}; Object.defineProperty(out,"operations",{enumerable:true,get(){getterCalled=true;return [PROVISIONING_REMOTE_ACTION];}}); return out; },
    preflight:async()=>({status:"READY",reason:null}),provisionAccount:async()=>({status:"APPLIED"}),reconcileAccountProvisioning:async()=>({status:"UNKNOWN"})
  };
  await assert.rejects(()=>createProvisioningProviderAdapter({driver:accessDriver}).probeCompatibility(),(e)=>e.code===PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  assert.equal(getterCalled,false);
});

test("operation identity mismatch is rejected before provider mutation", async()=>{
  const d=driver(); const adapter=createProvisioningProviderAdapter({driver:d.api});
  const op=operation(); op.intentFingerprint="p019:account-provision:v1:other:1";
  await assert.rejects(()=>adapter.providerDescriptor.operations[PROVISIONING_REMOTE_ACTION].dispatch({operation:op,dispatchInput:input()}),(e)=>e.code===PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  assert.equal(d.calls.some(([kind])=>kind==="provision"),false);
});
