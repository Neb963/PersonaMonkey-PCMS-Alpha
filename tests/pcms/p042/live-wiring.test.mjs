import assert from "node:assert/strict";
import test from "node:test";
import { createPcmsLiveMutationIntegration } from "../../../extension/pcms/integration/live-mutations.js";
import { PERCHANCE_UNATTENDED_COMMANDS } from "../../../extension/pcms/providers/perchance/execution-update-driver.js";
import { generatorPayloadHash, generatorReleaseFingerprint } from "../../../extension/pcms/providers/perchance/contract.js";
import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../../extension/pcms/remoteops/provider-gate.js";
import { makeStorage } from "../p010-harness.mjs";

const UID="11111111-1111-4111-8111-111111111111",ORIGIN="http://127.0.0.1:4321";
const READ=["userscript.artifact.install","userscript.artifact.assign","persona.control.acquire","persona.control.release",
  "execution.start","execution.result.get","execution.result.ack","execution.cancel"];

// Persona Broker envelope stand-in: records every command and answers like PersonaMonkey.
function fakeBroker({verify="APPLIED"}={}){
  const commands=[];let staged=null;const chunks=[];
  return {commands,broker:{async request(envelope){
    commands.push(envelope.command);
    const ok=result=>({ok:true,result,bootId:"boot-1",revision:1});
    switch(envelope.command){
      case "system.status":return ok({});
      case "system.describe":return ok({commands:[...new Set([...READ,...PERCHANCE_UNATTENDED_COMMANDS])].map(command=>({command,authorized:true,available:true})),
        externalAutomation:{executionAvailable:true}});
      case "persona.control.acquire":return ok({leaseId:"lease-1"});
      case "execution.input.begin":chunks.length=0;return ok({inputRef:"input-1"});
      case "execution.input.append":chunks.push(Buffer.from(envelope.params.chunkBase64,"base64"));return ok({});
      case "execution.input.commit":staged=JSON.parse(Buffer.concat(chunks).toString("utf8"));return ok({});
      case "execution.start":return ok({executionId:"exec-1"});
      case "execution.result.get":return ok({state:"completed",truncated:false,acknowledged:false,tasks:[{result:{s:{operationId:staged.operationId,
        generatorId:staged.generatorId,status:staged.mode==="verify"?verify:"APPLIED",challenge:false}}}]});
      default:return ok({});
    }
  }}};
}
const operator=calls=>({async choose(input){calls.push(input.phase);return input.phase==="dispatch"?null:"UNKNOWN";}});

async function wiring({automationProfile=null,verify}={}){
  const storageBroker=makeStorage(),{broker,commands}=fakeBroker({verify}),choices=[];
  const live=createPcmsLiveMutationIntegration({storageBroker,personaBroker:broker,operator:operator(choices),automationProfile});
  const remoteOps=createRemoteOps({storageBroker}),recoveryHold=createRecoveryHoldController({storageBroker,remoteOps});
  const gate=createProviderGate({remoteOps,recoveryHold,providers:live.providers});
  const code="code",html="<p>x</p>",payloadHash=await generatorPayloadHash(code,html);
  const operation={operationId:"deploy:gen:alpha:1:1",providerId:"perchance",action:"generator.update",
    targetRef:{kind:"generator",id:"alpha"},intentFingerprint:await generatorReleaseFingerprint({payloadHash,thumbnailHash:null,listing:"UNLISTED"})};
  await live.operationContext.bind({operation,accountId:"acct-1",personaUid:UID});
  const dispatchInput={payloadHash,thumbnailHash:null,listing:"UNLISTED",code,html,thumbnail:null};
  return {live,gate,remoteOps,operation,dispatchInput,commands,choices,storageBroker};
}

test("A042-01 production composes no automation profile: unattended stays off and dispatch stays an assisted handoff",async()=>{
  const w=await wiring();
  const probe=await w.live.providerProbes[0].probeCompatibility();
  assert.equal(probe.capabilities.unattended,false);assert.equal(probe.capabilities.create,false);
  await assert.rejects(w.gate.mutate({operation:w.operation,dispatchInput:w.dispatchInput}));
  assert.equal((await w.remoteOps.get(w.operation.operationId)).value.state,"UNCERTAIN");
  assert.deepEqual(w.choices,["dispatch"]);
  assert.ok(!w.commands.includes("execution.start"));assert.ok(!w.commands.includes("userscript.artifact.install"));
});

test("A042-01 with the reviewed fixture profile dispatch runs as a leased execution artifact after the durable RemoteOperation",async()=>{
  const w=await wiring({automationProfile:{kind:"fixture",origin:ORIGIN}});
  const probe=await w.live.providerProbes[0].probeCompatibility();
  assert.equal(probe.capabilities.unattended,true);assert.equal(probe.capabilities.listing,true);assert.equal(probe.capabilities.create,false);
  const result=await w.gate.mutate({operation:w.operation,dispatchInput:w.dispatchInput});
  assert.equal(result.status,"APPLIED");assert.equal(result.operation.value.state,"SUCCEEDED");
  assert.deepEqual(w.choices,[]);
  const start=w.commands.indexOf("execution.start");
  assert.ok(w.commands.indexOf("persona.control.acquire")<start&&w.commands.indexOf("execution.input.commit")<start);
  assert.ok(w.commands.lastIndexOf("persona.control.release")>start);
  const mode=[...w.storageBroker.shared.rows.entries()].find(([k])=>k.startsWith("integration.live-provider-dispatch-mode"));
  assert.equal(mode[1].value.mode,"UNATTENDED");
  // Release content never enters ordinary PCMS rows.
  assert.ok(!JSON.stringify([...w.storageBroker.shared.rows.values()]).includes("<p>x</p>"));
});

test("A042-01 an uncertain unattended operation is reconciled by the provider's answer, then by the operator, never replayed",async()=>{
  const w=await wiring({automationProfile:{kind:"fixture",origin:ORIGIN},verify:"APPLIED"});
  const prepared=await w.remoteOps.prepare(w.operation);
  const dispatching=await w.remoteOps.beginDispatch(w.operation.operationId,{expectedRevision:prepared.revision});
  await w.storageBroker.namespace("integration.live-provider-dispatch-mode").compareAndSwap(w.operation.operationId,
    {expectedRevision:0,value:{schemaVersion:1,operationId:w.operation.operationId,mode:"UNATTENDED"}});
  await w.remoteOps.markUncertain(w.operation.operationId,{expectedRevision:dispatching.revision});
  const starts=w.commands.filter(c=>c==="execution.start").length;
  assert.equal((await w.gate.reconcile(w.operation.operationId)).value.state,"SUCCEEDED");
  assert.equal(w.commands.filter(c=>c==="execution.start").length,starts+1,"one verify execution, no deploy replay");
  assert.deepEqual(w.choices,[]);
  const unknown=await wiring({automationProfile:{kind:"fixture",origin:ORIGIN},verify:"BOGUS"});
  const p2=await unknown.remoteOps.prepare(unknown.operation);
  const d2=await unknown.remoteOps.beginDispatch(unknown.operation.operationId,{expectedRevision:p2.revision});
  await unknown.storageBroker.namespace("integration.live-provider-dispatch-mode").compareAndSwap(unknown.operation.operationId,
    {expectedRevision:0,value:{schemaVersion:1,operationId:unknown.operation.operationId,mode:"UNATTENDED"}});
  await unknown.remoteOps.markUncertain(unknown.operation.operationId,{expectedRevision:d2.revision});
  assert.equal((await unknown.gate.reconcile(unknown.operation.operationId)).value.state,"UNCERTAIN");
  assert.deepEqual(unknown.choices,["reconcile"],"falls back to an operator task");
});
