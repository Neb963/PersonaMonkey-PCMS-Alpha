import assert from "node:assert/strict";
import test from "node:test";

import { createRefresherService, REFRESH_OPERATION_STATUS } from "../../../pcms-modules/p017/refresher.js";
import { REFRESHER_ERROR_CODES } from "../../../pcms-modules/p017/errors.js";
import { sha256Hex } from "../../../extension/pcms/providers/perchance/contract.js";
import { account, makeAccounts, makeProvider, makeStateStore } from "./harness.mjs";

const SOURCE_A="new source";
const SOURCE_B="old source";
const HASH_A="eb326958738d171e78bdff8117386308557c0f4d19783441bca3dea03314d2bc";
const HASH_B="470f5e33c65605ccb235dfaab0f3bc914bb2c23ea7a408bf3ad81218feae39a2";

function setup(){
  const state=makeStateStore();
  const accounts=makeAccounts({"acct-1":account("acct-1")});
  const provider=makeProvider();
  let now="2026-10-05T06:30:00.000Z";
  const service=createRefresherService({
    stateStore:state.store,accountsService:accounts.service,
    providerGateResolver:provider.resolver,remoteOperationReader:provider.remoteReader,
    clock:()=>now
  });
  const input={
    cohortId:"cohort-1",accountId:"acct-1",enabled:true,
    policy:{mode:"AUTO_RECENT",dailyBudget:2,dayOffsetMinutes:0,activeHours:24,sleepDays:0,anchorAt:"2026-10-05T00:00:00Z"},
    members:[{generatorId:"gen-1",sourceHash:HASH_A},{generatorId:"gen-2",sourceHash:HASH_B}]
  };
  return {state,accounts,provider,service,input,setNow:value=>{now=new Date(value).toISOString();}};
}
async function prepared(h,generatorId="gen-1"){
  await h.service.createCohort(h.input,{expectedRevision:0});
  return h.service.prepareRefresh("cohort-1",generatorId,{expectedRevision:1});
}

test("A017-03 confirmed provider effect increments accounting only after SUCCEEDED",async()=>{
  const h=setup();await prepared(h);
  const before=await h.service.getCohort("cohort-1");
  assert.equal(before.members[0].confirmedCount,0);
  const result=await h.service.dispatchRefresh("cohort-1","gen-1",{expectedRevision:2,source:SOURCE_A});
  assert.equal(result.status,"APPLIED");
  assert.equal(result.member.operation.status,REFRESH_OPERATION_STATUS.SUCCEEDED);
  assert.equal(result.member.confirmedCount,1);
  assert.equal(result.member.lastConfirmedAt,"2026-10-05T06:30:00.000Z");
  assert.equal(h.provider.mutations.length,1);
  assert.equal(h.provider.mutations[0].operation.action,"generator.update");
  assert.equal(h.provider.mutations[0].dispatchInput.source, SOURCE_A);
  assert.equal(JSON.stringify(h.state.shared.row.value).includes(SOURCE_A),false);
});

test("A017-03 source mismatch fails before provider dispatch",async()=>{
  const h=setup();await prepared(h);
  await assert.rejects(
    h.service.dispatchRefresh("cohort-1","gen-1",{expectedRevision:2,source:SOURCE_B}),
    error=>error?.code===REFRESHER_ERROR_CODES.SOURCE_MISMATCH
  );
  assert.equal(h.provider.mutations.length,0);
  assert.equal((await h.service.getCohort("cohort-1")).members[0].operation.status,REFRESH_OPERATION_STATUS.PENDING);
});

test("A017-03 account or ProviderGate loss fails closed before dispatch",async()=>{
  const h=setup();await prepared(h);
  h.accounts.remove("acct-1");
  await assert.rejects(
    h.service.dispatchRefresh("cohort-1","gen-1",{expectedRevision:2,source:SOURCE_A}),
    error=>error?.code===REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE
  );
  assert.equal(h.provider.mutations.length,0);

  h.accounts.set("acct-1",account("acct-1"));
  h.provider.setAvailable(false);
  await assert.rejects(
    h.service.dispatchRefresh("cohort-1","gen-1",{expectedRevision:2,source:SOURCE_A}),
    error=>error?.code===REFRESHER_ERROR_CODES.PROVIDER_UNAVAILABLE
  );
  assert.equal(h.provider.mutations.length,0);
});

test("A017-03 direct NOT_APPLIED releases budget and next prepare creates new operation identity",async()=>{
  const h=setup();await prepared(h);
  h.provider.setResult("NOT_APPLIED");
  const failed=await h.service.dispatchRefresh("cohort-1","gen-1",{expectedRevision:2,source:SOURCE_A});
  assert.equal(failed.member.operation.status,REFRESH_OPERATION_STATUS.FAILED);
  assert.equal(failed.member.confirmedCount,0);
  let plan=await h.service.planRefreshes("cohort-1");
  assert.equal(plan.budget.used,0);
  const retry=await h.service.prepareRefresh("cohort-1","gen-1",{expectedRevision:4});
  assert.equal(retry.member.operation.operationId,"refresh:cohort-1:1:2");
});

test("A017-03 post-apply ambiguity reconciles to one confirmed effect without replay",async()=>{
  const h=setup();await prepared(h);
  h.provider.failAfter("SUCCEEDED");
  await assert.rejects(h.service.dispatchRefresh("cohort-1","gen-1",{expectedRevision:2,source:SOURCE_A}));
  let cohort=await h.service.getCohort("cohort-1");
  assert.equal(cohort.members[0].operation.status,REFRESH_OPERATION_STATUS.RECONCILE);
  assert.equal(cohort.members[0].confirmedCount,0);
  const reconciled=await h.service.reconcileRefresh("cohort-1","gen-1",{expectedRevision:4});
  assert.equal(reconciled.member.operation.status,REFRESH_OPERATION_STATUS.SUCCEEDED);
  assert.equal(reconciled.member.confirmedCount,1);
  assert.equal(h.provider.mutations.length,1);
});

test("A017-03 pre-apply ambiguity reconciles before retrying the same durable operation",async()=>{
  const h=setup();await prepared(h);
  h.provider.failBefore("RETRYABLE");
  await assert.rejects(h.service.dispatchRefresh("cohort-1","gen-1",{expectedRevision:2,source:SOURCE_A}));
  const reconciled=await h.service.reconcileRefresh("cohort-1","gen-1",{expectedRevision:4});
  assert.equal(reconciled.member.operation.status,REFRESH_OPERATION_STATUS.RETRYABLE);
  const operationId=reconciled.member.operation.operationId;
  h.provider.setResult("APPLIED");
  const retried=await h.service.dispatchRefresh("cohort-1","gen-1",{expectedRevision:5,source:SOURCE_A});
  assert.equal(retried.member.operation.operationId,operationId);
  assert.equal(retried.member.confirmedCount,1);
});

test("A017-03 restart-style ACTIVE state with no RemoteOperation returns safely to PENDING",async()=>{
  const h=setup();await prepared(h);
  const row=structuredClone(h.state.shared.row);
  row.revision=3;
  row.value.cohorts[0].members[0].operation.status=REFRESH_OPERATION_STATUS.ACTIVE;
  row.value.cohorts[0].members[0].updatedAt="2026-10-05T06:31:00.000Z";
  h.state.shared.row=row;
  const recovered=await h.service.reconcileRefresh("cohort-1","gen-1",{expectedRevision:3});
  assert.equal(recovered.member.operation.status,REFRESH_OPERATION_STATUS.PENDING);
  assert.equal(recovered.member.confirmedCount,0);
});

test("A017-03 policy and source changes are fenced while an operation is unresolved",async()=>{
  const h=setup();await prepared(h);
  await assert.rejects(
    h.service.updatePolicy("cohort-1",{expectedRevision:2,enabled:true,policy:h.input.policy}),
    error=>error?.code===REFRESHER_ERROR_CODES.OPERATION_BUSY
  );
  await assert.rejects(
    h.service.setMemberSourceHash("cohort-1","gen-1",{expectedRevision:2,sourceHash:HASH_B}),
    error=>error?.code===REFRESHER_ERROR_CODES.OPERATION_BUSY
  );
});

test("fixture hashes match accepted SHA-256 behavior",async()=>{
  assert.equal(await sha256Hex(SOURCE_A),HASH_A);
  assert.equal(await sha256Hex(SOURCE_B),HASH_B);
});
