import test from "node:test";
import assert from "node:assert/strict";

import { createPcmsUiDispatcher, PCMS_UI_RECEIPT_NAMESPACE } from "../../../extension/pcms/background/ui-dispatcher.js";
import { createHumanTaskService } from "../../../extension/pcms/services/human-tasks.js";
import { BASE_URL, PCMS_SENDER, RUNTIME_ID, makeDurable } from "../p028/harness.mjs";
import { makeP012Harness } from "../p012-harness.mjs";

const command=(requestId)=>({
  type:"PCMS_UI_REQUEST",
  version:1,
  requestId,
  kind:"command",
  name:"accounts.createAccount",
  idempotencyKey:"ui-p032-shared-receipt",
  params:{args:[{accountId:"p032-account"},{expectedRevision:0}]}
});

function receiptHarness(durable){
  let calls=0;
  const core={
    storageBroker:durable.storageBroker,
    accounts:{
      async createAccount(input,{expectedRevision}={}){
        calls+=1;
        assert.equal(expectedRevision,0);
        return {revision:1,account:{accountId:input.accountId}};
      }
    }
  };
  const build=()=>createPcmsUiDispatcher({
    ensureCore:async()=>core,
    readStatus:async()=>({state:"RUNNING"}),
    onCommitted:async()=>{},
    runtimeId:RUNTIME_ID,
    extensionBaseUrl:BASE_URL,
    clock:durable.clock
  });
  return {build,get calls(){return calls;}};
}

test("A032-02 durable command receipt is consistent across clients and survives all dashboard clients closing",async()=>{
  const durable=makeDurable();
  const h=receiptHarness(durable);
  const tabA=h.build();
  const tabB=h.build();

  const first=await tabA.handle(command("tab-a"),PCMS_SENDER);
  const second=await tabB.handle(command("tab-b"),PCMS_SENDER);
  assert.equal(first.ok,true);
  assert.equal(second.ok,true);
  assert.equal(second.receipt.replayed,true);
  assert.equal(h.calls,1,"two clients must not execute one idempotent command twice");

  const store=durable.storageBroker.namespace(PCMS_UI_RECEIPT_NAMESPACE);
  const persisted=await store.get("ui-p032-shared-receipt");
  assert.equal(persisted.value.status,"COMPLETED");

  // Simulate every dashboard client disappearing. A newly constructed UI dispatcher
  // sees the same durable receipt and still does not replay the effect.
  const reopened=h.build();
  const afterClose=await reopened.handle(command("reopened-tab"),PCMS_SENDER);
  assert.equal(afterClose.ok,true);
  assert.equal(afterClose.receipt.replayed,true);
  assert.equal(h.calls,1);
});

test("A032-02 HumanTasks remain durable and consistent when a new dashboard client is constructed",async()=>{
  const shared={rows:new Map(),events:[],now:"2026-10-07T21:00:00.000Z"};
  const h1=makeP012Harness(shared);
  const first=createHumanTaskService({storageBroker:h1.storageBroker,auditJournal:h1.auditJournal,clock:h1.clock});
  await first.open({
    taskId:"p032-human-task",
    taskKind:"operator.review",
    title:"Review provider state",
    priority:"HIGH",
    subjectRef:{kind:"account",id:"acct-1"}
  });
  assert.deepEqual((await first.listAttention()).map((row)=>row.value.taskId),["p032-human-task"]);

  // A second/new client gets a fresh service object but the same durable records.
  const h2=makeP012Harness(shared);
  const reopened=createHumanTaskService({storageBroker:h2.storageBroker,auditJournal:h2.auditJournal,clock:h2.clock});
  const attention=await reopened.listAttention();
  assert.deepEqual(attention.map((row)=>row.value.taskId),["p032-human-task"]);
  assert.equal(attention[0].value.title,"Review provider state");
});


// Cross-tab and reopen receipt-list acceptance is exercised by receipt-read.test.mjs.
