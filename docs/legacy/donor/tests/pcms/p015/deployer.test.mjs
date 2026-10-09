import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../../extension/pcms/remoteops/provider-gate.js";
import { createPerchanceProviderAdapter } from "../../../extension/pcms/providers/perchance/adapter.js";
import {
  PERCHANCE_DRIVER_CONTRACT_ID,
  PERCHANCE_DRIVER_CONTRACT_VERSION,
  PERCHANCE_GENERATOR_UPDATE_ACTION,
  PERCHANCE_PROVIDER_ID,
  sha256Hex
} from "../../../extension/pcms/providers/perchance/contract.js";
import { createPerchanceEmulator } from "../../../extension/pcms/providers/perchance/emulator.js";
import { createDeployerService, DEPLOYMENT_OPERATION_STATUS } from "../../../pcms-modules/p015/deployer.js";
import { DEPLOYER_ERROR_CODES } from "../../../pcms-modules/p015/errors.js";
import { DEPLOYER_PROVIDER_ID } from "../../../pcms-modules/p015/schema.js";
import { makeStorage } from "../p010-harness.mjs";
import { account, makeAccounts, makeGateResolver, makeStateStore } from "./harness.mjs";

const SOURCE_A="new source";
const SOURCE_B="old source";
const HASH_A="eb326958738d171e78bdff8117386308557c0f4d19783441bca3dea03314d2bc";
const HASH_B="470f5e33c65605ccb235dfaab0f3bc914bb2c23ea7a408bf3ad81218feae39a2";

function setup({driver=null}={}) {
  const remoteStorage=makeStorage();
  const remoteOps=createRemoteOps({storageBroker:remoteStorage});
  const recoveryHold=createRecoveryHoldController({storageBroker:remoteStorage,remoteOps});
  const emulator=driver ? null : createPerchanceEmulator();
  const adapter=createPerchanceProviderAdapter({driver:driver || emulator.driver});
  const gate=createProviderGate({
    remoteOps,
    recoveryHold,
    providers:{perchance:adapter.providerDescriptor}
  });
  const state=makeStateStore();
  const accounts=makeAccounts({"acct-1":account("acct-1"),"acct-2":account("acct-2")});
  const gates=makeGateResolver(gate);
  let tick=0;
  const service=createDeployerService({
    stateStore:state.store,
    accountsService:accounts.service,
    providerGateResolver:gates.resolver,
    remoteOperationReader:remoteOps,
    clock:()=>new Date(Date.UTC(2026,9,5,5,0,tick++)).toISOString()
  });
  return {remoteStorage,remoteOps,recoveryHold,emulator,adapter,gate,state,accounts,gates,service};
}

async function create(h,{deploymentId="dep-1",accountId="acct-1",generatorId="gen-123",sourceHash=HASH_A,expectedRevision=0}={}) {
  return h.service.createDeployment({deploymentId,accountId,generatorId,sourceHash},{expectedRevision});
}

test("A015-01 desired/observed model stores hashes and stable ownership but never source bytes",async()=>{
  const h=setup();
  const result=await create(h);
  assert.equal(result.revision,1);
  assert.equal(result.deployment.providerId,DEPLOYER_PROVIDER_ID);
  assert.deepEqual(result.deployment.targetRef,{kind:"generator",id:"gen-123"});
  // P036: v1 inputs create a pcms.deployer.state/v2 "v1-source" record with the same meaning.
  assert.deepEqual(result.deployment.desired,{revision:1,payloadKind:"v1-source",payloadHash:HASH_A,thumbnailHash:null,listing:null,origin:{kind:"MANUAL"}});
  assert.deepEqual(result.deployment.confirmed,{payloadHash:null,thumbnailHash:null,listing:null,confirmedAt:null,operationId:null,baselineHash:null});
  assert.equal(result.deployment.operation.status,DEPLOYMENT_OPERATION_STATUS.PENDING);
  const serialized=JSON.stringify(h.state.shared.row.value);
  assert.equal(serialized.includes(SOURCE_A),false);
  assert.equal(serialized.includes("personaUid"),false);
  assert.equal(serialized.includes("cookieStoreId"),false);
});

test("A015-01 provider identity matches the accepted Perchance provider contract",()=>{
  assert.equal(DEPLOYER_PROVIDER_ID,PERCHANCE_PROVIDER_ID);
});

test("A015-01 target ownership and state revision are fenced",async()=>{
  const h=setup();
  await create(h);
  await assert.rejects(
    create(h,{deploymentId:"dep-2",accountId:"acct-2",generatorId:"gen-123",sourceHash:HASH_B,expectedRevision:1}),
    error=>error?.code===DEPLOYER_ERROR_CODES.TARGET_CONFLICT
  );
  await assert.rejects(
    create(h,{deploymentId:"dep-2",accountId:"acct-2",generatorId:"gen-456",sourceHash:HASH_B,expectedRevision:0}),
    error=>error?.code===DEPLOYER_ERROR_CODES.REVISION_CONFLICT && error.currentRevision===1
  );
});

test("A015-01 desired revisions are monotonic and idempotent for the same hash",async()=>{
  const h=setup();
  await create(h);
  const same=await h.service.setDesired("dep-1",{expectedRevision:1,expectedDesiredRevision:1,sourceHash:HASH_A});
  assert.equal(same.changed,false);
  assert.equal(same.revision,1);
  const changed=await h.service.setDesired("dep-1",{expectedRevision:1,expectedDesiredRevision:1,sourceHash:HASH_B});
  assert.equal(changed.changed,true);
  assert.equal(changed.deployment.desired.revision,2);
  assert.equal(changed.deployment.operation.operationId,"deploy:dep-1:2:1");
  assert.equal(changed.deployment.confirmed.payloadHash,null);
});

test("A015-02 stable-target mutation dispatches through ProviderGate and confirms observed state",async()=>{
  const h=setup();
  h.emulator.seedGenerator({generatorId:"gen-123",sourceHash:HASH_B,source:SOURCE_B});
  await create(h);
  const result=await h.service.deploy("dep-1",{expectedRevision:1,source:SOURCE_A});
  assert.equal(result.status,"APPLIED");
  assert.equal(result.deployment.operation.status,DEPLOYMENT_OPERATION_STATUS.SUCCEEDED);
  assert.equal(result.deployment.confirmed.payloadHash,HASH_A);
  assert.deepEqual(h.emulator.getGenerator("gen-123"),{generatorId:"gen-123",sourceHash:HASH_A,source:SOURCE_A});
  const remote=await h.remoteOps.get("deploy:dep-1:1:1");
  assert.equal(remote.value.targetRef.id,"gen-123");
  assert.equal(remote.value.state,"SUCCEEDED");
});

test("A015-02 source mismatch fails before RemoteOperation creation or provider dispatch",async()=>{
  const h=setup();
  await create(h);
  await assert.rejects(
    h.service.deploy("dep-1",{expectedRevision:1,source:SOURCE_B}),
    error=>error?.code===DEPLOYER_ERROR_CODES.SOURCE_MISMATCH
  );
  assert.equal(await h.remoteOps.get("deploy:dep-1:1:1"),null);
  assert.equal(h.emulator.getGenerator("gen-123"),null);
  assert.equal((await h.service.getDeployment("dep-1")).operation.status,DEPLOYMENT_OPERATION_STATUS.PENDING);
});

test("A015-02 direct NOT_APPLIED requires a new durable operation identity before retry",async()=>{
  const driver={
    probe:async()=>({
      contractId:PERCHANCE_DRIVER_CONTRACT_ID,
      contractVersion:PERCHANCE_DRIVER_CONTRACT_VERSION,
      providerId:PERCHANCE_PROVIDER_ID,
      operations:[PERCHANCE_GENERATOR_UPDATE_ACTION]
    }),
    updateGenerator:async()=>({status:"NOT_APPLIED"}),
    reconcileGeneratorUpdate:async()=>({status:"UNKNOWN"})
  };
  const h=setup({driver});
  await create(h);
  const failed=await h.service.deploy("dep-1",{expectedRevision:1,source:SOURCE_A});
  assert.equal(failed.status,"NOT_APPLIED");
  assert.equal(failed.deployment.operation.status,DEPLOYMENT_OPERATION_STATUS.FAILED);
  const retried=await h.service.prepareRetry("dep-1",{expectedRevision:3});
  assert.equal(retried.deployment.operation.operationId,"deploy:dep-1:1:2");
  assert.equal(retried.deployment.operation.status,DEPLOYMENT_OPERATION_STATUS.PENDING);
});

test("A015-02 account or account-scoped provider loss fails closed without dispatch",async()=>{
  const h=setup();
  await create(h);
  h.accounts.remove("acct-1");
  await assert.rejects(
    h.service.deploy("dep-1",{expectedRevision:1,source:SOURCE_A}),
    error=>error?.code===DEPLOYER_ERROR_CODES.ACCOUNT_UNAVAILABLE
  );
  assert.equal(await h.remoteOps.get("deploy:dep-1:1:1"),null);

  h.accounts.set("acct-1",account("acct-1"));
  h.gates.setAvailable(false);
  await assert.rejects(
    h.service.deploy("dep-1",{expectedRevision:1,source:SOURCE_A}),
    error=>error?.code===DEPLOYER_ERROR_CODES.PROVIDER_UNAVAILABLE
  );
  assert.equal(await h.remoteOps.get("deploy:dep-1:1:1"),null);
  assert.equal((await h.service.getDeployment("dep-1")).operation.status,DEPLOYMENT_OPERATION_STATUS.PENDING);
});

test("A015-03 post-apply ambiguity reconciles to IN_SYNC without replay",async()=>{
  const h=setup();
  await create(h);
  h.emulator.failNext("after-apply");
  await assert.rejects(h.service.deploy("dep-1",{expectedRevision:1,source:SOURCE_A}));
  const deployment=await h.service.getDeployment("dep-1");
  assert.equal(deployment.operation.status,DEPLOYMENT_OPERATION_STATUS.RECONCILE);
  assert.equal(h.emulator.getGenerator("gen-123").sourceHash,HASH_A);
  const reconciled=await h.service.reconcileDeployment("dep-1",{expectedRevision:3});
  assert.equal(reconciled.deployment.operation.status,DEPLOYMENT_OPERATION_STATUS.SUCCEEDED);
  assert.equal(reconciled.deployment.confirmed.payloadHash,HASH_A);
  const view=(await h.service.listDeploymentViews()).deployments[0];
  assert.equal(view.syncState,"IN_SYNC");
  assert.equal(view.actions.canDeploy,false);
});

test("A015-03 pre-apply ambiguity must reconcile NOT_APPLIED before same operation retry",async()=>{
  const h=setup();
  await create(h);
  h.emulator.failNext("before-apply");
  await assert.rejects(h.service.deploy("dep-1",{expectedRevision:1,source:SOURCE_A}));
  const deployment=await h.service.getDeployment("dep-1");
  assert.equal(deployment.operation.status,DEPLOYMENT_OPERATION_STATUS.RECONCILE);
  const reconciled=await h.service.reconcileDeployment("dep-1",{expectedRevision:3});
  assert.equal(reconciled.deployment.operation.status,DEPLOYMENT_OPERATION_STATUS.RETRYABLE);
  const retried=await h.service.deploy("dep-1",{expectedRevision:4,source:SOURCE_A});
  assert.equal(retried.status,"APPLIED");
  assert.equal(retried.deployment.operation.operationId,"deploy:dep-1:1:1");
  assert.equal(retried.deployment.confirmed.payloadHash,HASH_A);
});

test("A015-03 restart-style ACTIVE recovery with no RemoteOperation safely returns to PENDING",async()=>{
  const h=setup();
  await create(h);
  const row=structuredClone(h.state.shared.row);
  row.revision=2;
  row.value.deployments[0].operation.status=DEPLOYMENT_OPERATION_STATUS.ACTIVE;
  row.value.deployments[0].updatedAt="2026-10-05T05:00:10.000Z";
  h.state.shared.row=row;
  const recovered=await h.service.reconcileDeployment("dep-1",{expectedRevision:2});
  assert.equal(recovered.deployment.operation.status,DEPLOYMENT_OPERATION_STATUS.PENDING);
  assert.equal(recovered.deployment.confirmed.payloadHash,null);
});

test("A015-03 UI projection distinguishes pending and out-of-sync actions",async()=>{
  const h=setup();
  await create(h);
  let view=(await h.service.listDeploymentViews()).deployments[0];
  assert.equal(view.syncState,"PENDING");
  assert.equal(view.actions.canDeploy,true);
  const applied=await h.service.deploy("dep-1",{expectedRevision:1,source:SOURCE_A});
  const changed=await h.service.setDesired("dep-1",{expectedRevision:applied.revision,expectedDesiredRevision:1,sourceHash:HASH_B});
  view=(await h.service.listDeploymentViews()).deployments[0];
  assert.equal(changed.deployment.confirmed.payloadHash,HASH_A);
  assert.equal(view.syncState,"OUT_OF_SYNC");
  assert.equal(view.actions.canUpdateDesired,true);
});

test("A015-03 desired state cannot change while mutation outcome requires reconciliation",async()=>{
  const h=setup();
  await create(h);
  h.emulator.failNext("after-apply");
  await assert.rejects(h.service.deploy("dep-1",{expectedRevision:1,source:SOURCE_A}));
  const current=await h.service.listDeployments();
  await assert.rejects(
    h.service.setDesired("dep-1",{expectedRevision:current.revision,expectedDesiredRevision:1,sourceHash:HASH_B}),
    error=>error?.code===DEPLOYER_ERROR_CODES.OPERATION_BUSY
  );
});

test("fixture hashes remain the accepted SHA-256 values",async()=>{
  assert.equal(await sha256Hex(SOURCE_A),HASH_A);
  assert.equal(await sha256Hex(SOURCE_B),HASH_B);
});
