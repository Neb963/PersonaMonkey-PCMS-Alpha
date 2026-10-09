import test from "node:test";
import assert from "node:assert/strict";

import {
  createLiveBrokerClient,
  createLiveOperationContext,
  createPcmsLiveMutationIntegration
} from "../../../extension/pcms/integration/live-mutations.js";
import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../../extension/pcms/remoteops/provider-gate.js";
import { REMOTE_OP_ERROR_CODES } from "../../../extension/pcms/remoteops/errors.js";
import {
  generatorSourceFingerprint,
  sha256Hex
} from "../../../extension/pcms/providers/perchance/contract.js";
import { makeStorage } from "../p010-harness.mjs";

const UID="11111111-1111-4111-8111-111111111111";

function brokerHarness(){
  const requests=[];
  let revision=10;
  return {
    requests,
    broker:Object.freeze({
      async request(request){
        requests.push(structuredClone(request));
        if(request.command==="system.status"){
          revision+=1;
          return Object.freeze({
            ok:true,
            result:Object.freeze({ready:true}),
            bootId:"boot-p026",
            revision
          });
        }
        if(request.command==="persona.open"){
          revision+=1;
          return Object.freeze({
            ok:true,
            result:Object.freeze({tabId:revision,personaUid:request.params.personaUid}),
            bootId:"boot-p026",
            revision
          });
        }
        if(request.command==="persona.control.get"){
          return Object.freeze({
            ok:true,
            result:Object.freeze({controlled:false,owner:null,leaseId:null}),
            bootId:"boot-p026",
            revision
          });
        }
        throw new Error("Unexpected broker command: "+request.command);
      }
    })
  };
}

test("A026-01 live Broker client refreshes the mutation precondition immediately before side effects",async()=>{
  const h=brokerHarness();
  const client=createLiveBrokerClient({broker:h.broker});
  await client.sync();
  await client.request("persona.open",{
    personaUid:UID,
    url:"https://perchance.org/example",
    active:true,
    allowDirect:true
  },{operationId:"p026-open-1"});

  assert.deepEqual(h.requests.map((request)=>request.command),[
    "system.status",
    "system.status",
    "persona.open"
  ]);
  const open=h.requests.at(-1);
  assert.equal(open.operationId,"p026-open-1");
  assert.deepEqual(open.precondition,{bootId:"boot-p026",revision:12});
  assert.equal(open.params.allowDirect,true);
});

test("A026-01 live operation context is durable and exact-identity fenced",async()=>{
  const storage=makeStorage();
  const context=createLiveOperationContext({storageBroker:storage});
  const operation={
    operationId:"deploy:demo:1:1",
    providerId:"perchance",
    action:"generator.update",
    targetRef:{kind:"generator",id:"demo"},
    intentFingerprint:"perchance:generator-source:v1:"+"a".repeat(64)
  };
  const first=await context.bind({operation,accountId:"acct-1",personaUid:UID});
  const replay=await context.bind({operation,accountId:"acct-1",personaUid:UID});
  assert.equal(first.revision,1);
  assert.equal(replay.revision,1);
  assert.equal((await context.get(operation.operationId)).personaUid,UID);
  await assert.rejects(
    context.bind({operation,accountId:"acct-2",personaUid:UID}),
    /context conflict/
  );
});

test("A026-01 ambiguous live Perchance update cannot replay and reconciles explicitly",async()=>{
  const storage=makeStorage();
  const remoteOps=createRemoteOps({
    storageBroker:storage,
    clock:()=>"2026-10-06T16:00:00.000Z"
  });
  const recoveryHold=createRecoveryHoldController({
    storageBroker:storage,
    remoteOps,
    clock:()=>"2026-10-06T16:00:01.000Z"
  });
  const h=brokerHarness();
  let mode="THROW";
  let operatorCalls=0;
  const operator=Object.freeze({
    async choose(){
      operatorCalls+=1;
      if(mode==="THROW") throw new Error("operator left outcome uncertain");
      return mode;
    }
  });
  const live=createPcmsLiveMutationIntegration({
    storageBroker:storage,
    personaBroker:h.broker,
    operator
  });
  const gate=createProviderGate({
    remoteOps,
    recoveryHold,
    providers:live.providers
  });

  const source="p026 representative source";
  const sourceHash=await sha256Hex(source);
  const operation={
    operationId:"deploy:p026:1:1",
    providerId:"perchance",
    action:"generator.update",
    targetRef:{kind:"generator",id:"p026-generator"},
    intentFingerprint:generatorSourceFingerprint(sourceHash)
  };
  await live.operationContext.bind({
    operation,
    accountId:"acct-p026",
    personaUid:UID
  });

  await assert.rejects(
    gate.mutate({operation,dispatchInput:{sourceHash,source}}),
    (error)=>error?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL
  );
  assert.equal(operatorCalls,1);
  assert.equal((await remoteOps.get(operation.operationId)).value.state,"UNCERTAIN");

  await assert.rejects(
    gate.mutate({operation,dispatchInput:{sourceHash,source}}),
    (error)=>error?.code===REMOTE_OP_ERROR_CODES.RECONCILE_REQUIRED
  );
  assert.equal(operatorCalls,1,"uncertain mutation must not call the provider again");

  mode="UNKNOWN";
  let reconciled=await gate.reconcile(operation.operationId);
  assert.equal(reconciled.value.state,"UNCERTAIN");
  assert.equal(reconciled.value.resolution,"RECONCILED_UNKNOWN");
  assert.equal(operatorCalls,2);

  mode="APPLIED";
  reconciled=await gate.reconcile(operation.operationId);
  assert.equal(reconciled.value.state,"SUCCEEDED");
  assert.equal(operatorCalls,3);

  const repeated=await gate.mutate({operation,dispatchInput:{sourceHash,source}});
  assert.equal(repeated.status,"ALREADY_APPLIED");
  assert.equal(operatorCalls,3);

  const opened=h.requests.filter((request)=>request.command==="persona.open");
  assert.equal(opened.length,3);
  assert.ok(opened.every((request)=>request.params.personaUid===UID));
  assert.ok(opened.every((request)=>request.params.allowDirect===true));
  assert.ok(opened.every((request)=>request.params.url==="https://perchance.org/p026-generator"));
});

test("A026-01 representative account provisioning remains an explicit operator mutation",async()=>{
  const storage=makeStorage();
  const remoteOps=createRemoteOps({storageBroker:storage});
  const recoveryHold=createRecoveryHoldController({storageBroker:storage,remoteOps});
  const h=brokerHarness();
  let operatorCalls=0;
  const live=createPcmsLiveMutationIntegration({
    storageBroker:storage,
    personaBroker:h.broker,
    operator:Object.freeze({
      async choose(){
        operatorCalls+=1;
        return "APPLIED";
      }
    })
  });
  const gate=createProviderGate({remoteOps,recoveryHold,providers:live.providers});
  const operation={
    operationId:"p019:attempt-p026:op:1",
    providerId:"perchance",
    action:"account.provision",
    targetRef:{kind:"account",id:"acct-p026"},
    intentFingerprint:"p019:account-provision:v1:attempt-p026:1"
  };
  await live.operationContext.bind({
    operation,
    accountId:"acct-p026",
    personaUid:UID
  });

  const result=await gate.mutate({operation,dispatchInput:{}});
  assert.equal(result.status,"APPLIED");
  assert.equal(result.operation.value.state,"SUCCEEDED");
  assert.equal(operatorCalls,1);
  const opened=h.requests.find((request)=>request.command==="persona.open");
  assert.equal(opened.params.url,"https://perchance.org/");
  assert.equal(opened.params.allowDirect,true);
});
