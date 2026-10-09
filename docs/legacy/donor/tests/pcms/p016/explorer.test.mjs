import assert from "node:assert/strict";
import test from "node:test";

import { createExplorerService, EXPLORER_CLAIM_STATUS } from "../../../pcms-modules/p016/explorer.js";
import { createAccountsService } from "../../../pcms-modules/p014/accounts.js";
import { EXPLORER_ERROR_CODES } from "../../../pcms-modules/p016/errors.js";
import {
  EXPLORER_PROVIDER_ID,
  EXPLORER_TARGET_KIND,
  candidateIdFor
} from "../../../pcms-modules/p016/schema.js";
import { PERCHANCE_GENERATOR_TARGET_KIND, PERCHANCE_PROVIDER_ID } from "../../../extension/pcms/providers/perchance/contract.js";
import { account, makeAccounts, makeStateStore } from "./harness.mjs";
import { makePersonaResolver, makeStateStore as makeAccountsStateStore, persona, UID_A } from "../p014/harness.mjs";

const HASH_A="eb326958738d171e78bdff8117386308557c0f4d19783441bca3dea03314d2bc";
const HASH_B="470f5e33c65605ccb235dfaab0f3bc914bb2c23ea7a408bf3ad81218feae39a2";

function setup(){
  const state=makeStateStore();
  const accounts=makeAccounts({"acct-1":account("acct-1"),"acct-2":account("acct-2")});
  let tick=0;
  const service=createExplorerService({
    stateStore:state.store,
    accountsService:accounts.service,
    clock:()=>new Date(Date.UTC(2026,9,5,6,0,tick++)).toISOString()
  });
  return {state,accounts,service};
}
async function discover(h,{accountId="acct-1",discoveryId="scan-1",candidates=[{generatorId:"gen-1",observedSourceHash:HASH_A}],expectedRevision=0}={}){
  return h.service.recordDiscovery({accountId,discoveryId,candidates},{expectedRevision});
}

test("A016-01 discovery stores bounded generator candidates and no Persona or source bytes",async()=>{
  const h=setup();
  const result=await discover(h);
  assert.equal(result.revision,1);
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].candidateId,candidateIdFor("acct-1","gen-1"));
  assert.equal(result.candidates[0].freshness,"CURRENT");
  assert.equal(result.candidates[0].observedSourceHash,HASH_A);
  const serialized=JSON.stringify(h.state.shared.row.value);
  assert.equal(serialized.includes("personaUid"),false);
  assert.equal(serialized.includes("cookieStoreId"),false);
  assert.equal(serialized.includes("generator source text"),false);
});

test("A016-01 Explorer integrates with the accepted P014 Accounts service by durable AccountId",async()=>{
  const accountState=makeAccountsStateStore();
  const personas=makePersonaResolver({[UID_A]:persona(UID_A,"firefox-container-10")});
  const accounts=createAccountsService({
    stateStore:accountState.store,
    personaResolver:personas.resolver,
    clock:()=>"2026-10-05T05:55:00Z"
  });
  await accounts.createAccount({accountId:"acct-real",displayName:"Real",personaUid:UID_A},{expectedRevision:0});
  const explorerState=makeStateStore();
  const explorer=createExplorerService({
    stateStore:explorerState.store,
    accountsService:accounts,
    clock:()=>"2026-10-05T06:00:00Z"
  });
  const result=await explorer.recordDiscovery({
    accountId:"acct-real",
    discoveryId:"scan-real",
    candidates:[{generatorId:"gen-real",observedSourceHash:HASH_A}]
  },{expectedRevision:0});
  assert.equal(result.candidates[0].accountId,"acct-real");
  assert.equal(JSON.stringify(explorerState.shared.row.value).includes(UID_A),false);
});

test("A016-01 provider and target identity stay aligned with accepted P013 constants",()=>{
  assert.equal(EXPLORER_PROVIDER_ID,PERCHANCE_PROVIDER_ID);
  assert.equal(EXPLORER_TARGET_KIND,PERCHANCE_GENERATOR_TARGET_KIND);
});

test("A016-01 discovery identity is idempotent only for identical normalized content",async()=>{
  const h=setup();
  await discover(h);
  const replay=await discover(h,{expectedRevision:1});
  assert.equal(replay.changed,false);
  assert.equal(replay.revision,1);
  await assert.rejects(
    discover(h,{expectedRevision:1,candidates:[{generatorId:"gen-1",observedSourceHash:HASH_B}]}),
    error=>error?.code===EXPLORER_ERROR_CODES.DISCOVERY_CONFLICT
  );
});

test("A016-01 discovery is account-scoped, revision fenced, and fails closed for unavailable accounts",async()=>{
  const h=setup();
  await discover(h);
  await assert.rejects(
    discover(h,{accountId:"acct-2",discoveryId:"scan-2",expectedRevision:0}),
    error=>error?.code===EXPLORER_ERROR_CODES.REVISION_CONFLICT && error.currentRevision===1
  );
  h.accounts.remove("acct-2");
  await assert.rejects(
    discover(h,{accountId:"acct-2",discoveryId:"scan-2",expectedRevision:1}),
    error=>error?.code===EXPLORER_ERROR_CODES.ACCOUNT_UNAVAILABLE
  );
  assert.equal(h.state.shared.row.revision,1);
});

test("A016-01 account projection rejects accessors without invoking them",async()=>{
  const state=makeStateStore();
  let invoked=0;
  const exotic={accountId:"acct-1",providerId:"perchance"};
  Object.defineProperty(exotic,"personaUid",{enumerable:true,get(){invoked+=1;return "bad";}});
  const service=createExplorerService({
    stateStore:state.store,
    accountsService:{async getAccount(){return exotic;}},
    clock:()=>"2026-10-05T06:00:00Z"
  });
  await assert.rejects(
    service.recordDiscovery({accountId:"acct-1",discoveryId:"scan-1",candidates:[]},{expectedRevision:0}),
    error=>error?.code===EXPLORER_ERROR_CODES.ACCOUNT_UNAVAILABLE
  );
  assert.equal(invoked,0);
});

test("A016-02 claim creates a durable deployment reservation and exact replay is idempotent",async()=>{
  const h=setup();
  await discover(h);
  const candidateId=candidateIdFor("acct-1","gen-1");
  const claimed=await h.service.claimCandidate(candidateId,{claimId:"claim-1",deploymentId:"dep-1"},{expectedRevision:1});
  assert.equal(claimed.revision,2);
  assert.equal(claimed.reservation.ready,true);
  assert.deepEqual(claimed.reservation.targetRef,{kind:"generator",id:"gen-1"});
  const replay=await h.service.claimCandidate(candidateId,{claimId:"claim-1",deploymentId:"dep-1"},{expectedRevision:2});
  assert.equal(replay.changed,false);
  assert.equal(replay.revision,2);
  assert.equal(JSON.stringify(h.state.shared.row.value).includes("personaUid"),false);
});

test("A016-02 active target and deployment reservations are unique across accounts",async()=>{
  const h=setup();
  await discover(h);
  await discover(h,{accountId:"acct-2",discoveryId:"scan-2",candidates:[{generatorId:"gen-1",observedSourceHash:HASH_B}],expectedRevision:1});
  await h.service.claimCandidate(candidateIdFor("acct-1","gen-1"),{claimId:"claim-1",deploymentId:"dep-1"},{expectedRevision:2});
  await assert.rejects(
    h.service.claimCandidate(candidateIdFor("acct-2","gen-1"),{claimId:"claim-2",deploymentId:"dep-2"},{expectedRevision:3}),
    error=>error?.code===EXPLORER_ERROR_CODES.CLAIM_CONFLICT
  );
  await discover(h,{accountId:"acct-2",discoveryId:"scan-3",candidates:[{generatorId:"gen-2",observedSourceHash:HASH_B}],expectedRevision:3});
  await assert.rejects(
    h.service.claimCandidate(candidateIdFor("acct-2","gen-2"),{claimId:"claim-3",deploymentId:"dep-1"},{expectedRevision:4}),
    error=>error?.code===EXPLORER_ERROR_CODES.CLAIM_CONFLICT
  );
});

test("A016-02 claimed candidates survive disappearance, reconcile fail closed, and recover without losing identity",async()=>{
  const h=setup();
  await discover(h);
  const candidateId=candidateIdFor("acct-1","gen-1");
  await h.service.claimCandidate(candidateId,{claimId:"claim-1",deploymentId:"dep-1"},{expectedRevision:1});
  const missing=await discover(h,{discoveryId:"scan-2",candidates:[],expectedRevision:2});
  assert.equal(missing.candidates.length,1);
  assert.equal(missing.candidates[0].freshness,"STALE");
  assert.equal(missing.candidates[0].claimStatus,EXPLORER_CLAIM_STATUS.TARGET_MISSING);
  assert.equal((await h.service.getDeploymentReservation("claim-1")).ready,false);

  h.accounts.remove("acct-1");
  let reconciled=await h.service.reconcileClaims({expectedRevision:3});
  assert.equal(reconciled.claims[0].status,EXPLORER_CLAIM_STATUS.ACCOUNT_UNAVAILABLE);
  h.accounts.fail("acct-1");
  reconciled=await h.service.reconcileClaims({expectedRevision:4});
  assert.equal(reconciled.claims[0].status,EXPLORER_CLAIM_STATUS.UNKNOWN);

  h.accounts.set("acct-1",account("acct-1"));
  reconciled=await h.service.reconcileClaims({expectedRevision:5});
  assert.equal(reconciled.claims[0].status,EXPLORER_CLAIM_STATUS.TARGET_MISSING);
  await discover(h,{discoveryId:"scan-3",candidates:[{generatorId:"gen-1",observedSourceHash:HASH_B}],expectedRevision:6});
  const reservation=await h.service.getDeploymentReservation("claim-1");
  assert.equal(reservation.ready,true);
  assert.equal(reservation.status,EXPLORER_CLAIM_STATUS.READY);
  assert.equal(reservation.observedSourceHash,HASH_B);
  assert.equal(reservation.deploymentId,"dep-1");
});

test("A016-02 stale unclaimed candidates are pruned while stale release removes the retained candidate",async()=>{
  const h=setup();
  await discover(h,{candidates:[
    {generatorId:"gen-1",observedSourceHash:HASH_A},
    {generatorId:"gen-2",observedSourceHash:HASH_B}
  ]});
  await h.service.claimCandidate(candidateIdFor("acct-1","gen-1"),{claimId:"claim-1",deploymentId:"dep-1"},{expectedRevision:1});
  let result=await discover(h,{discoveryId:"scan-2",candidates:[],expectedRevision:2});
  assert.deepEqual(result.candidates.map(x=>x.generatorId),["gen-1"]);
  const released=await h.service.releaseClaim("claim-1",{expectedRevision:3});
  assert.equal(released.claim.status,EXPLORER_CLAIM_STATUS.RELEASED);
  assert.equal((await h.service.listCandidates("acct-1")).candidates.length,0);
});

test("A016-03 candidate and reservation projections expose only safe deterministic actions",async()=>{
  const h=setup();
  await discover(h);
  let view=(await h.service.listCandidates("acct-1")).candidates[0];
  assert.deepEqual(view.actions,{canClaim:true,canRelease:false,needsReconcile:false});
  await h.service.claimCandidate(view.candidateId,{claimId:"claim-1",deploymentId:"dep-1"},{expectedRevision:1});
  view=(await h.service.listCandidates("acct-1")).candidates[0];
  assert.deepEqual(view.actions,{canClaim:false,canRelease:true,needsReconcile:false});
  let reservation=await h.service.getDeploymentReservation("claim-1");
  assert.deepEqual(reservation.actions,{canCreateDeployment:true,canRelease:true,needsReconcile:false});
  await discover(h,{discoveryId:"scan-2",candidates:[],expectedRevision:2});
  reservation=await h.service.getDeploymentReservation("claim-1");
  assert.deepEqual(reservation.actions,{canCreateDeployment:false,canRelease:true,needsReconcile:true});
  await h.service.releaseClaim("claim-1",{expectedRevision:3});
  reservation=await h.service.getDeploymentReservation("claim-1");
  assert.deepEqual(reservation.actions,{canCreateDeployment:false,canRelease:false,needsReconcile:false});
});
