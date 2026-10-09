import test from "node:test";
import assert from "node:assert/strict";

import { createPcmsUiProjectionService } from "../../../extension/pcms/app/projections.js";
import { PCMS_UI_ERROR_CODES } from "../../../extension/pcms/app/errors.js";
import { account, makeSources, task, UID_B } from "./harness.mjs";

test("A021-01 navigation and Attention projection are deterministic read-only views",async()=>{
  const sources=makeSources({
    accounts:[
      account({accountId:"b-account",displayName:"Beta",personaUid:UID_B}),
      account({accountId:"a-account",displayName:"Alpha"})
    ],
    attention:[
      task({taskId:"task-low",title:"Low task",priority:"LOW",createdAt:"2026-10-05T10:00:00.000Z"}),
      task({taskId:"task-critical",title:"Critical task",priority:"CRITICAL",createdAt:"2026-10-05T11:00:00.000Z"}),
      task({taskId:"task-high",title:"High task",priority:"HIGH",createdAt:"2026-10-05T09:00:00.000Z"})
    ]
  });
  const ui=createPcmsUiProjectionService({humanTasks:sources.humanTasks,accounts:sources.accounts});
  const snapshot=await ui.snapshot();

  assert.deepEqual(snapshot.navigation.map(x=>[x.id,x.badge]),[
    ["overview",null],["attention",3],["accounts",2],["search",null]
  ]);
  assert.deepEqual(snapshot.notifications.items.map(x=>x.taskId),["task-critical","task-high","task-low"]);
  assert.equal(snapshot.notifications.criticalCount,1);
  assert.deepEqual(snapshot.accounts.accounts.map(x=>x.accountId),["a-account","b-account"]);
  assert.equal(sources.calls.attention,1);
  assert.equal(sources.calls.accounts,1);
});

test("A021-02 search ranks account and Attention projections without indexing instructions or secret-like fields",async()=>{
  const sources=makeSources({
    accounts:[
      account({accountId:"acct-primary",displayName:"Primary Account"}),
      account({accountId:"acct-secondary",displayName:"Secondary"})
    ],
    attention:[
      task({taskId:"review-primary",title:"Review Primary",taskKind:"operator.review",instructions:"needle-only-in-instructions"}),
      task({taskId:"captcha",title:"Complete provider CAPTCHA",taskKind:"operator.captcha",subjectRef:null})
    ]
  });
  const ui=createPcmsUiProjectionService({humanTasks:sources.humanTasks,accounts:sources.accounts});

  let snapshot=await ui.snapshot({query:"Primary"});
  assert.deepEqual(snapshot.search.results.map(x=>[x.kind,x.id]),[
    ["account","acct-primary"],["attention","review-primary"]
  ]);
  assert.equal(JSON.stringify(snapshot).includes("needle-only-in-instructions"),false);

  snapshot=await ui.snapshot({query:"needle-only-in-instructions"});
  assert.deepEqual(snapshot.search.results,[]);

  snapshot=await ui.snapshot({query:"captcha"});
  assert.deepEqual(snapshot.search.results.map(x=>x.id),["captcha"]);
});

test("A021-02 search is bounded and stable",async()=>{
  const accounts=Array.from({length:80},(_,index)=>account({
    accountId:"acct-"+String(index).padStart(3,"0"),
    displayName:"Searchable "+String(index).padStart(3,"0"),
    personaUid:`11111111-1111-4111-8${String(index).padStart(3,"0")}-${String(index).padStart(12,"0")}`
  }));
  const sources=makeSources({accounts,attention:[]});
  const ui=createPcmsUiProjectionService({humanTasks:sources.humanTasks,accounts:sources.accounts,maxSearchResults:25});
  const snapshot=await ui.snapshot({query:"Searchable"});
  assert.equal(snapshot.search.results.length,25);
  assert.deepEqual(snapshot.search.results.slice(0,3).map(x=>x.id),["acct-000","acct-001","acct-002"]);
});

test("A021 projection fails closed on malformed/accessor source data without invoking getters",async()=>{
  let getterCalled=false;
  const badAccount={};
  Object.defineProperty(badAccount,"accountId",{enumerable:true,get(){getterCalled=true;throw new Error("getter");}});
  for(const [name,value] of Object.entries({
    displayName:"Bad",providerId:"perchance",personaUid:"11111111-1111-4111-8111-111111111111",bindingEpoch:1
  })) Object.defineProperty(badAccount,name,{enumerable:true,value});

  const ui=createPcmsUiProjectionService({
    humanTasks:Object.freeze({async listAttention(){return [];}}),
    accounts:Object.freeze({async listAccounts(){return {revision:1,accounts:[badAccount]};}})
  });
  await assert.rejects(()=>ui.snapshot(),e=>e?.code===PCMS_UI_ERROR_CODES.PROJECTION_PROTOCOL);
  assert.equal(getterCalled,false);
});

test("A021 projection maps source exceptions to fixed protocol errors",async()=>{
  const ui=createPcmsUiProjectionService({
    humanTasks:Object.freeze({async listAttention(){throw new Error("private source failure");}}),
    accounts:Object.freeze({async listAccounts(){return {revision:0,accounts:[]};}})
  });
  await assert.rejects(()=>ui.snapshot(),e=>e?.code===PCMS_UI_ERROR_CODES.PROJECTION_PROTOCOL&&!e.message.includes("private source failure"));
});
