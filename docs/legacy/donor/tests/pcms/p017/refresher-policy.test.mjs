import assert from "node:assert/strict";
import test from "node:test";

import { createRefresherService, REFRESHER_MODE } from "../../../pcms-modules/p017/refresher.js";
import { REFRESHER_ERROR_CODES } from "../../../pcms-modules/p017/errors.js";
import { REFRESHER_PROVIDER_ID, REFRESHER_TARGET_KIND } from "../../../pcms-modules/p017/schema.js";
import { PERCHANCE_PROVIDER_ID, PERCHANCE_GENERATOR_TARGET_KIND } from "../../../extension/pcms/providers/perchance/contract.js";
import { account, makeAccounts, makeProvider, makeStateStore } from "./harness.mjs";

const HASH_A="eb326958738d171e78bdff8117386308557c0f4d19783441bca3dea03314d2bc";
const HASH_B="470f5e33c65605ccb235dfaab0f3bc914bb2c23ea7a408bf3ad81218feae39a2";

function setup({mode=REFRESHER_MODE.AUTO_RECENT,dailyBudget=2,activeHours=2,sleepDays=1,dayOffsetMinutes=0,anchorAt="2026-10-05T06:00:00Z"}={}){
  const state=makeStateStore();
  const accounts=makeAccounts({"acct-1":account("acct-1"),"acct-2":account("acct-2")});
  const provider=makeProvider();
  let now="2026-10-05T06:30:00.000Z";
  const service=createRefresherService({
    stateStore:state.store,accountsService:accounts.service,
    providerGateResolver:provider.resolver,remoteOperationReader:provider.remoteReader,
    clock:()=>now
  });
  const input={
    cohortId:"cohort-1",accountId:"acct-1",enabled:true,
    policy:{mode,dailyBudget,dayOffsetMinutes,activeHours,sleepDays,anchorAt},
    members:[
      {generatorId:"gen-1",sourceHash:HASH_A},
      {generatorId:"gen-2",sourceHash:HASH_B},
      {generatorId:"gen-3",sourceHash:HASH_A}
    ]
  };
  return {state,accounts,provider,service,input,setNow:value=>{now=new Date(value).toISOString();}};
}
async function create(h){return h.service.createCohort(h.input,{expectedRevision:0});}

test("A017-01 cohort persists AccountId, targets and source hashes without Persona or source bytes",async()=>{
  const h=setup();const result=await create(h);
  assert.equal(result.revision,1);
  assert.equal(result.cohort.accountId,"acct-1");
  assert.deepEqual(result.cohort.members.map(x=>x.generatorId),["gen-1","gen-2","gen-3"]);
  const serialized=JSON.stringify(h.state.shared.row.value);
  assert.equal(serialized.includes("personaUid"),false);
  assert.equal(serialized.includes("cookieStoreId"),false);
  assert.equal(serialized.includes("new source"),false);
});

test("A017-01 provider and target identity match accepted P013 constants",()=>{
  assert.equal(REFRESHER_PROVIDER_ID,PERCHANCE_PROVIDER_ID);
  assert.equal(REFRESHER_TARGET_KIND,PERCHANCE_GENERATOR_TARGET_KIND);
});

test("A017-01 target ownership and revision are fenced",async()=>{
  const h=setup();await create(h);
  const second={...h.input,cohortId:"cohort-2",accountId:"acct-2",members:[{generatorId:"gen-1",sourceHash:HASH_A}]};
  await assert.rejects(
    h.service.createCohort(second,{expectedRevision:1}),
    error=>error?.code===REFRESHER_ERROR_CODES.TARGET_CONFLICT
  );
  await assert.rejects(
    h.service.updatePolicy("cohort-1",{expectedRevision:0,enabled:true,policy:h.input.policy}),
    error=>error?.code===REFRESHER_ERROR_CODES.REVISION_CONFLICT && error.currentRevision===1
  );
});

test("A017-02 AUTO_RECENT planning is deterministic and bounded by configurable daily budget",async()=>{
  const h=setup({dailyBudget:2});await create(h);
  const plan=await h.service.planRefreshes("cohort-1");
  assert.equal(plan.active,true);
  assert.deepEqual(plan.members.map(x=>x.generatorId),["gen-1","gen-2"]);
  assert.deepEqual(plan.budget,{limit:2,used:0,remaining:2});

  let prepared=await h.service.prepareRefresh("cohort-1","gen-1",{expectedRevision:1});
  assert.equal(prepared.member.operation.operationId,"refresh:cohort-1:1:1");
  prepared=await h.service.prepareRefresh("cohort-1","gen-2",{expectedRevision:2});
  assert.equal(prepared.member.operation.operationId,"refresh:cohort-1:2:1");
  await assert.rejects(
    h.service.prepareRefresh("cohort-1","gen-3",{expectedRevision:3}),
    error=>error?.code===REFRESHER_ERROR_CODES.BUDGET_EXHAUSTED
  );
  const after=await h.service.planRefreshes("cohort-1");
  assert.deepEqual(after.budget,{limit:2,used:2,remaining:0});
  assert.equal(after.members.length,0);
});

test("A017-02 offset day windows and active/sleep cycles are deterministic",async()=>{
  const h=setup({dailyBudget:3,dayOffsetMinutes:360,activeHours:2,sleepDays:1,anchorAt:"2026-10-05T06:00:00Z"});
  await create(h);
  h.setNow("2026-10-05T07:59:59Z");
  let plan=await h.service.planRefreshes("cohort-1");
  assert.equal(plan.active,true);
  assert.equal(plan.dayStart,"2026-10-05T06:00:00.000Z");
  h.setNow("2026-10-05T08:00:00Z");
  plan=await h.service.planRefreshes("cohort-1");
  assert.equal(plan.active,false);
  assert.equal(plan.members.length,0);
  h.setNow("2026-10-06T08:00:00Z");
  plan=await h.service.planRefreshes("cohort-1");
  assert.equal(plan.active,true);
  assert.equal(plan.dayStart,"2026-10-06T06:00:00.000Z");
});

test("A017-02 MANUAL mode does not auto-plan but allows explicit budget-fenced preparation",async()=>{
  const h=setup({mode:REFRESHER_MODE.MANUAL,dailyBudget:1,activeHours:1,sleepDays:365});
  await create(h);
  h.setNow("2026-10-05T20:00:00Z");
  const plan=await h.service.planRefreshes("cohort-1");
  assert.equal(plan.mode,REFRESHER_MODE.MANUAL);
  assert.equal(plan.members.length,0);
  const prepared=await h.service.prepareRefresh("cohort-1","gen-1",{expectedRevision:1});
  assert.equal(prepared.member.operation.status,"PENDING");
});

test("A017-02 account loss fails closed before cohort admission",async()=>{
  const h=setup();h.accounts.remove("acct-1");
  await assert.rejects(create(h),error=>error?.code===REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
  assert.equal(h.state.shared.row,null);
});
