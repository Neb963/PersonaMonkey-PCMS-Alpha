import test from "node:test";
import assert from "node:assert/strict";

import { PCMS_UI_MAX_RECEIPT_LIST } from "../../../extension/pcms/integration/ui-client-contract.js";
import { createPcmsUiDispatcher, PCMS_UI_RECEIPT_NAMESPACE, PCMS_UI_RECEIPT_RETENTION_MS } from "../../../extension/pcms/background/ui-dispatcher.js";
import { createPcmsUiClient } from "../../../extension/pcms/app/ui-client.js";
import { BASE_URL, PCMS_SENDER, RUNTIME_ID, makeDurable } from "../p028/harness.mjs";

function fixture(shared){
  const durable=makeDurable(shared);
  const listeners=new Set();
  let executed=0;
  let sequence=0;
  const core={
    storageBroker:durable.storageBroker,
    accounts:{
      async createAccount(input){
        executed++;
        if(input.fail){
          const error=new Error("private-error-message-should-never-be-exposed");
          error.code="PCMS_ACCOUNT_TEST_FAILURE";
          throw error;
        }
        return {revision:1,secretResult:"private-command-result-should-never-be-exposed"};
      }
    }
  };
  const dispatcher=createPcmsUiDispatcher({
    ensureCore:async()=>core,
    readStatus:async()=>({state:"RUNNING"}),
    onCommitted:async()=>{
      const revision={seq:++sequence,topics:["accounts"]};
      for(const listener of listeners) listener(revision);
    },
    runtimeId:RUNTIME_ID,extensionBaseUrl:BASE_URL,clock:durable.clock
  });
  function client(idempotencyKey="ui-p032-command-0001"){
    return createPcmsUiClient({
      transport:{
        send:(message)=>dispatcher.handle(message,PCMS_SENDER),
        subscribeRevision(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
      },
      newIdempotencyKey:()=>idempotencyKey
    });
  }
  return {durable,dispatcher,client,get executed(){return executed;},get subscribers(){return listeners.size;}};
}

function request(requestId="read-1"){
  return {type:"PCMS_UI_REQUEST",version:1,requestId,
    kind:"query",name:"uiReceipts.list",params:{args:[]}};
}

test("A032-02 two tabs see the same Core receipts via revision signals, without replay",async()=>{
  const h=fixture();
  const tabA=h.client("ui-p032-command-shared");
  const tabB=h.client("ui-p032-command-other");
  const remoteSeen=new Promise((resolve)=>{
    tabB.subscribe(()=>{void tabB.runtime.uiReceipts.list().then(resolve);});
  });
  const result=await tabA.runtime.accounts.createAccount({accountId:"acct-1",privateInput:"do-not-expose"},{expectedRevision:0});
  assert.equal(result.revision,1);
  const visible=await remoteSeen;
  assert.equal(visible.receipts.length,1);
  assert.deepEqual(Object.keys(visible.receipts[0]),["receiptId","subject","status","recordedAt","completedAt"]);
  assert.equal(visible.receipts[0].receiptId,"ui-p032-command-shared");
  assert.equal(visible.receipts[0].status,"COMPLETED");
  assert.equal(h.executed,1);
  assert.equal(h.subscribers,1);
  tabA.close();
  tabB.close();
  assert.equal(h.subscribers,0);
});

test("A032-02 closing all tabs and reopening a new background context preserves list visibility",async()=>{
  const h=fixture();
  const a=h.client("ui-p032-close-reopen");
  await a.runtime.accounts.createAccount({accountId:"a"},{expectedRevision:0});
  a.close();
  const restarted=fixture(h.durable.shared);
  const c=restarted.client("ui-p032-never-replay");
  const result=await c.runtime.uiReceipts.list();
  assert.deepEqual(result.receipts.map((x)=>x.receiptId),["ui-p032-close-reopen"]);
  assert.equal(restarted.executed,0,"read-only list must not replay prior commands");
  c.close();
});

test("A032-02 read projection never exposes stored inputs, hashes, result payloads or error bodies",async()=>{
  const h=fixture();
  const ok=h.client("ui-p032-success-secret");
  await ok.runtime.accounts.createAccount({accountId:"private-input"},{expectedRevision:0});
  const failed=h.client("ui-p032-failed-secret");
  await assert.rejects(failed.runtime.accounts.createAccount({fail:true},{expectedRevision:0}),
    (error)=>error.code==="PCMS_ACCOUNT_TEST_FAILURE");
  const persisted=await h.durable.storageBroker.namespace(PCMS_UI_RECEIPT_NAMESPACE).list();
  assert.equal(persisted.length,2);
  assert.ok(persisted.some((row)=>row.value.result?.secretResult));
  assert.ok(persisted.some((row)=>row.value.error?.message?.includes("private-error")));
  const response=await h.dispatcher.handle(request(),PCMS_SENDER);
  assert.equal(response.ok,true);
  assert.equal(response.result.receipts.length,2);
  assert.equal(response.result.receipts[0].status,"FAILED","failures remain ahead of successes");
  const serialized=JSON.stringify(response);
  for(const secret of ["private-input","private-command-result","private-error-message","requestHash","resultRetained","result","error"]) {
    if(secret==="result")continue; // response.result is the safe envelope, never a stored command result
    assert.equal(serialized.includes(secret),false,"leaked "+secret);
  }
  ok.close();failed.close();
});

test("A032-02 list is bounded, prioritizes unresolved outcomes and rejects stale or malformed receipts",async()=>{
  const h=fixture();
  const store=h.durable.storageBroker.namespace(PCMS_UI_RECEIPT_NAMESPACE);
  async function insert(id,status,recordedAt=h.durable.clock()){
    await store.compareAndSwap(id,{expectedRevision:0,value:{
      schemaVersion:1,kind:"ui-command-receipt",receiptId:id,subject:"accounts.createAccount",
      requestHash:"private-hash",status,recordedAt,completedAt:null,
      resultRetained:false,result:null,error:null
    }});
  }
  for(let n=0;n<PCMS_UI_MAX_RECEIPT_LIST+8;n++){
    const id="ui-p032-bound-"+String(n).padStart(3,"0");
    await insert(id,n===0?"PENDING":n===1?"FAILED":"COMPLETED");
  }
  await insert("ui-p032-stale","FAILED",new Date(Date.parse(h.durable.clock())-PCMS_UI_RECEIPT_RETENTION_MS-1000).toISOString());
  await insert("ui-p032-future","FAILED","2099-01-01T00:00:00.000Z");
  await insert("ui-p032-malformed","WRONG");
  const listed=await h.client().runtime.uiReceipts.list();
  assert.equal(listed.receipts.length,PCMS_UI_MAX_RECEIPT_LIST);
  assert.deepEqual(listed.receipts.slice(0,2).map((x)=>x.status),["UNKNOWN","FAILED"],
    "orphaned pending writes require reconciliation, not a false Running label");
  assert.equal(listed.receipts.some((x)=>/stale|future|malformed/.test(x.receiptId)),false);
  assert.equal(h.executed,0);
});

test("A032-02 read-only endpoint is exact-key, sender guarded and never accepts commands",async()=>{
  const h=fixture();
  const badSender=await h.dispatcher.handle(request(),{id:RUNTIME_ID,url:"https://evil.test/"});
  assert.equal(badSender.error.code,"PCMS_UI_SENDER_REJECTED");
  const badArgs=await h.dispatcher.handle({...request("invalid-args"),params:{args:[1]}},PCMS_SENDER);
  assert.equal(badArgs.error.code,"PCMS_UI_INVALID_REQUEST");
  const badKey=await h.dispatcher.handle({...request("invalid-key"),idempotencyKey:"ui-invalid-00001"},PCMS_SENDER);
  assert.equal(badKey.error.code,"PCMS_UI_INVALID_REQUEST");
  const badKind=await h.dispatcher.handle({...request("invalid-kind"),kind:"command",idempotencyKey:"ui-invalid-00001"},PCMS_SENDER);
  assert.equal(badKind.error.code,"PCMS_UI_INVALID_REQUEST");
  const direct=await h.dispatcher.handle(request("valid"),PCMS_SENDER);
  assert.equal(direct.ok,true);
  assert.deepEqual(direct.result.receipts,[]);
  assert.equal(h.executed,0);
});


test("A032-02 completed receipts use completion time for retention and recency",async()=>{
  const h=fixture();
  const store=h.durable.storageBroker.namespace(PCMS_UI_RECEIPT_NAMESPACE);
  const now=Date.parse(h.durable.clock());
  const oldStart=new Date(now-8*24*60*60*1000).toISOString();
  const recentEnd=new Date(now-60*60*1000).toISOString();
  const tooOldEnd=new Date(now-PCMS_UI_RECEIPT_RETENTION_MS-1000).toISOString();
  for(const [key,completedAt] of [["ui-p032-recent-finish",recentEnd],["ui-p032-expired-finish",tooOldEnd]]){
    await store.compareAndSwap(key,{expectedRevision:0,value:{
      schemaVersion:1,kind:"ui-command-receipt",receiptId:key,subject:"accounts.createAccount",
      requestHash:"private-hash",status:"COMPLETED",recordedAt:oldStart,
      completedAt,resultRetained:false,result:null,error:null
    }});
  }
  const listed=await h.client().runtime.uiReceipts.list();
  assert.deepEqual(listed.receipts.map((row)=>row.receiptId),["ui-p032-recent-finish"]);
  assert.equal(listed.receipts[0].completedAt,recentEnd);
  assert.equal(h.executed,0);
});
