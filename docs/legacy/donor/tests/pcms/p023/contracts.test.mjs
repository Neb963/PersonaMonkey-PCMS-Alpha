import test from "node:test";
import assert from "node:assert/strict";

import {
  createKeyedStateStore,
  createPersonaResolverFromBroker,
  createSingletonStateStore
} from "../../../extension/pcms/integration/adapters.js";
import { createExplorerDeployerBridge } from "../../../extension/pcms/integration/explorer-deployer.js";
import { INTEGRATION_ERROR_CODES } from "../../../extension/pcms/integration/errors.js";
import { makeMemoryBackend } from "./harness.mjs";
import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";

test("A023-01 storage adapters preserve module-facing CAS contracts over shared PCMS namespaces",async()=>{
  const storageBroker=createPcmsStorageBroker({
    backend:makeMemoryBackend(),
    clock:()=>"2026-10-05T12:00:00.000Z"
  });
  const singleton=createSingletonStateStore({storageBroker,namespace:"module.test"});
  assert.equal(await singleton.read(),null);
  let write=await singleton.compareAndSwap({expectedRevision:0,value:{hello:"world"}});
  assert.deepEqual(write,{ok:true,revision:1,value:{hello:"world"}});
  const conflict=await singleton.compareAndSwap({expectedRevision:0,value:{hello:"stale"}});
  assert.deepEqual(conflict,{ok:false,currentRevision:1});
  assert.deepEqual(await singleton.read(),{revision:1,value:{hello:"world"}});

  const keyed=createKeyedStateStore({storageBroker,namespace:"module.keyed",keyPrefix:"attempt:"});
  write=await keyed.compareAndSwap({attemptId:"attempt-1",expectedRevision:0,value:{attemptId:"attempt-1"}});
  assert.equal(write.ok,true);
  assert.deepEqual(await keyed.get("attempt-1"),{revision:1,value:{attemptId:"attempt-1"}});
  assert.equal((await keyed.list()).length,1);
});

test("A023-01 Persona resolver uses only persona.get and maps not-found to null",async()=>{
  const calls=[];
  const resolver=createPersonaResolverFromBroker({
    broker:{
      async request(request){
        calls.push(request);
        if(request.params.personaUid.endsWith("1111"))return {ok:true,result:{personaUid:request.params.personaUid,cookieStoreId:"container-a"}};
        return {ok:false,error:{code:"PERSONA_NOT_FOUND"}};
      }
    },
    requestIdFactory:()=>"req-persona"
  });
  const uid="11111111-1111-4111-8111-111111111111";
  assert.equal((await resolver.get(uid)).personaUid,uid);
  assert.equal(await resolver.get("22222222-2222-4222-8222-222222222222"),null);
  assert.deepEqual(calls.map(x=>x.command),["persona.get","persona.get"]);
  assert.equal(Object.hasOwn(calls[0],"operationId"),false);
});

test("A023-01 Explorer->Deployer bridge fails closed on conflicting materialization",async()=>{
  const reservation={
    ready:true,
    actions:{canCreateDeployment:true},
    deploymentId:"dep-1",
    accountId:"acct-1",
    providerId:"perchance",
    targetRef:{kind:"generator",id:"gen-1"},
    observedSourceHash:"eb326958738d171e78bdff8117386308557c0f4d19783441bca3dea03314d2bc"
  };
  const bridge=createExplorerDeployerBridge({
    explorer:{async getDeploymentReservation(){return reservation;}},
    deployer:{
      async getDeployment(){return {
        deploymentId:"dep-1",
        accountId:"acct-1",
        providerId:"perchance",
        targetRef:{kind:"generator",id:"different"},
        desired:{sourceHash:reservation.observedSourceHash}
      };},
      async createDeployment(){throw new Error("must not run");}
    }
  });
  await assert.rejects(
    ()=>bridge.createDeploymentFromClaim("claim-1",{expectedDeployerRevision:1}),
    e=>e?.code===INTEGRATION_ERROR_CODES.CROSS_MODULE_CONFLICT
  );
});
