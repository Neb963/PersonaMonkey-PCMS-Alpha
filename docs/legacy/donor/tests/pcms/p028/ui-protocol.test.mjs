import test from "node:test";
import assert from "node:assert/strict";

import {
  PCMS_UI_ERROR_CODES,
  PCMS_UI_OPERATIONS,
  isPcmsUiSender,
  validatePcmsUiRequest
} from "../../../extension/pcms/integration/ui-client-contract.js";
import { PCMS_UI_RECEIPT_NAMESPACE, createPcmsUiDispatcher } from "../../../extension/pcms/background/ui-dispatcher.js";
import { createPcmsUiClient } from "../../../extension/pcms/app/ui-client.js";
import { BASE_URL, PCMS_SENDER, RUNTIME_ID, makeDurable } from "./harness.mjs";

function request(overrides={}){
  return {type:"PCMS_UI_REQUEST",version:1,requestId:"req-1",kind:"query",name:"accounts.listAccounts",params:{args:[]},...overrides};
}
const command=(overrides={})=>request({kind:"command",name:"accounts.createAccount",idempotencyKey:"ui-key-0001",
  params:{args:[{accountId:"a"},{expectedRevision:0}]},...overrides});

test("A028-03 UI requests are exact-key and schema validated",()=>{
  assert.equal(validatePcmsUiRequest(request()).name,"accounts.listAccounts");
  assert.equal(validatePcmsUiRequest(command()).idempotencyKey,"ui-key-0001");
  const invalid=[
    null,[],"x",
    request({type:"PCMS_REQUEST"}),
    request({version:2}),
    request({requestId:""}),
    request({requestId:"x".repeat(200)}),
    request({extra:true}),
    request({kind:"command"}),
    request({params:{args:[],more:1}}),
    request({params:{args:"no"}}),
    request({params:{}}),
    request({name:"accounts.getAccount",params:{args:["a","b"]}}),
    request({idempotencyKey:"ui-key-0001"}),
    command({idempotencyKey:undefined}),
    command({idempotencyKey:"short"}),
    request({name:"accounts.getAccount",params:{args:[{fn(){}}]}}),
    request({name:"accounts.getAccount",params:{args:[Number.NaN]}}),
    request({name:"accounts.getAccount",params:{args:[new Date()]}}),
    request({name:"accounts.getAccount",params:{args:[JSON.parse('{"__proto__":{"x":1}}')]}}),
    request({name:"broker.request",params:{args:[{requestId:"b",command:"persona.open",params:{}}]}}),
    request({name:"broker.request",params:{args:[{requestId:"b",command:"system.status",params:{},operationId:"op"}]}})
  ];
  for(const message of invalid){
    assert.throws(()=>validatePcmsUiRequest(message),(error)=>error.code===PCMS_UI_ERROR_CODES.INVALID_REQUEST,JSON.stringify(message));
  }
  for(const name of ["storageBroker.namespace","remoteOps.beginDispatch","providerGate.mutate","moduleRuntime.recoverAll","toString","__proto__.x"]) {
    assert.throws(()=>validatePcmsUiRequest(request({name})),(error)=>error.code===PCMS_UI_ERROR_CODES.UNKNOWN_OPERATION,name);
  }
  // Mutating service methods are commands, never queries.
  for(const [name,operation] of Object.entries(PCMS_UI_OPERATIONS)) {
    if(/\.(create|rebind|record|claim|set|prepare|deploy|reconcile|dispatch|acquire|advance|resolve|answer|apply)/.test(name)) {
      assert.equal(operation.kind,"command",name);
    }
  }
});

test("A028-03 only PCMS extension pages of this extension may send UI requests",()=>{
  const options={runtimeId:RUNTIME_ID,extensionBaseUrl:BASE_URL};
  assert.equal(isPcmsUiSender(PCMS_SENDER,options),true);
  assert.equal(isPcmsUiSender({id:RUNTIME_ID,url:BASE_URL+"pcms/index.html"},options),true);
  for(const sender of [
    null,{},
    {id:"other@ext",url:BASE_URL+"pcms/app/index.html"},
    {id:RUNTIME_ID,url:"https://perchance.org/pcms/app/index.html"},
    {id:RUNTIME_ID,url:BASE_URL+"popup/popup.html"},
    {id:RUNTIME_ID,url:BASE_URL+"options/options.html"},
    {id:RUNTIME_ID,url:"moz-extension://other-uuid/pcms/app/index.html"}
  ]) assert.equal(isPcmsUiSender(sender,options),false,JSON.stringify(sender));
});

function dispatcherHarness(){
  const durable=makeDurable();
  let calls=0;
  let block=null;
  const topics=[];
  const core={
    storageBroker:durable.storageBroker,
    accounts:{
      async listAccounts(){return {revision:0,accounts:[]};},
      async createAccount(input,{expectedRevision}={}){
        calls+=1;
        if(block) await block;
        if(expectedRevision!==0){const error=new Error("Changed elsewhere");error.code="PCMS_ACCOUNTS_REVISION_CONFLICT";error.currentRevision=3;throw error;}
        return {revision:1,account:{accountId:input.accountId}};
      }
    },
    backupRestore:{async createBackup({backupId}){calls+=1;return {backupId,records:[]};}}
  };
  const dispatcher=createPcmsUiDispatcher({
    ensureCore:async()=>core,
    readStatus:async()=>({state:"RUNNING"}),
    onCommitted:async(list)=>{topics.push(list);},
    runtimeId:RUNTIME_ID,
    extensionBaseUrl:BASE_URL,
    clock:durable.clock
  });
  return {durable,dispatcher,topics,get calls(){return calls;},setBlock(value){block=value;}};
}

test("A028-03 sender and schema are checked before any Core work",async()=>{
  const h=dispatcherHarness();
  const rejected=await h.dispatcher.handle(command(),{id:RUNTIME_ID,url:"https://evil.test/"});
  assert.equal(rejected.ok,false);
  assert.equal(rejected.error.code,PCMS_UI_ERROR_CODES.SENDER_REJECTED);
  const invalid=await h.dispatcher.handle(command({params:{args:[1,2,3]}}),PCMS_SENDER);
  assert.equal(invalid.error.code,PCMS_UI_ERROR_CODES.INVALID_REQUEST);
  assert.equal(h.calls,0);
});

test("A028-03 commands are idempotent per key: replay returns the durable receipt without re-running",async()=>{
  const h=dispatcherHarness();
  const first=await h.dispatcher.handle(command(),PCMS_SENDER);
  assert.equal(first.ok,true);
  assert.deepEqual(first.receipt,{receiptId:"ui-key-0001",subject:"accounts.createAccount",status:"COMPLETED"});
  const replay=await h.dispatcher.handle(command({requestId:"req-2"}),PCMS_SENDER);
  assert.equal(replay.ok,true);
  assert.equal(replay.receipt.replayed,true);
  assert.deepEqual(JSON.parse(JSON.stringify(replay.result)),JSON.parse(JSON.stringify(first.result)));
  assert.equal(h.calls,1);
  const conflict=await h.dispatcher.handle(command({requestId:"req-3",params:{args:[{accountId:"b"},{expectedRevision:0}]}}),PCMS_SENDER);
  assert.equal(conflict.error.code,PCMS_UI_ERROR_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(h.calls,1);
  assert.deepEqual(h.topics,[["accounts","attention"]]);

  // Domain failures are receipted and replayed too, carrying the revision conflict.
  const failed=await h.dispatcher.handle(command({idempotencyKey:"ui-key-0002",params:{args:[{accountId:"c"},{expectedRevision:9}]}}),PCMS_SENDER);
  assert.equal(failed.ok,false);
  assert.equal(failed.receipt.status,"FAILED");
  assert.equal(failed.error.currentRevision,3);
  const failedAgain=await h.dispatcher.handle(command({idempotencyKey:"ui-key-0002",params:{args:[{accountId:"c"},{expectedRevision:9}]}}),PCMS_SENDER);
  assert.equal(failedAgain.error.code,"PCMS_ACCOUNTS_REVISION_CONFLICT");
  assert.equal(h.calls,2);
});

test("A028-03 concurrent duplicates from two tabs share one execution",async()=>{
  const h=dispatcherHarness();
  let release;
  h.setBlock(new Promise((resolve)=>{release=resolve;}));
  const a=h.dispatcher.handle(command({requestId:"tab-a"}),PCMS_SENDER);
  const b=h.dispatcher.handle(command({requestId:"tab-b"}),PCMS_SENDER);
  await new Promise((resolve)=>setImmediate(resolve));
  release();
  const [ra,rb]=await Promise.all([a,b]);
  assert.equal(ra.ok,true);
  assert.equal(rb.ok,true);
  assert.equal(ra.requestId,"tab-a");
  assert.equal(rb.requestId,"tab-b");
  assert.equal(h.calls,1);
});

test("A028-03 FAULT: a command interrupted by unload is reported unknown and never re-run",async()=>{
  const h=dispatcherHarness();
  // The previous context recorded the receipt and was unloaded before completing.
  const store=h.durable.storageBroker.namespace(PCMS_UI_RECEIPT_NAMESPACE);
  const hash=await globalThis.crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify({name:"accounts.createAccount",args:[{accountId:"a"},{expectedRevision:0}]})));
  const requestHash=[...new Uint8Array(hash)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
  await store.compareAndSwap("ui-key-0001",{expectedRevision:0,value:{schemaVersion:1,kind:"ui-command-receipt",receiptId:"ui-key-0001",
    subject:"accounts.createAccount",requestHash,status:"PENDING",recordedAt:"2026-10-07T12:00:00.000Z",completedAt:null,resultRetained:false,result:null,error:null}});
  const replay=await h.dispatcher.handle(command(),PCMS_SENDER);
  assert.equal(replay.ok,false);
  assert.equal(replay.error.code,PCMS_UI_ERROR_CODES.OUTCOME_UNKNOWN);
  assert.equal(h.calls,0);
});

test("A028-03 large results are not retained in receipts; old receipts are pruned",async()=>{
  const h=dispatcherHarness();
  const created=await h.dispatcher.handle(command({name:"backupRestore.createBackup",idempotencyKey:"ui-backup-01",params:{args:[{backupId:"b1"}]}}),PCMS_SENDER);
  assert.equal(created.ok,true);
  assert.equal(created.result.backupId,"b1");
  const store=h.durable.storageBroker.namespace(PCMS_UI_RECEIPT_NAMESPACE);
  const receipt=await store.get("ui-backup-01");
  assert.equal(receipt.value.resultRetained,false);
  assert.equal(receipt.value.result,null);
  const replay=await h.dispatcher.handle(command({name:"backupRestore.createBackup",idempotencyKey:"ui-backup-01",params:{args:[{backupId:"b1"}]}}),PCMS_SENDER);
  assert.equal(replay.error.code,PCMS_UI_ERROR_CODES.RESULT_NOT_RETAINED);
  assert.equal(h.calls,1);
  const removed=await h.dispatcher.pruneReceipts({storageBroker:h.durable.storageBroker},{now:Date.parse("2026-10-20T00:00:00.000Z")});
  assert.equal(removed,1);
  assert.equal(await store.get("ui-backup-01"),null);
});

test("A028-03 UI client facade mirrors service methods, keeps keys per command and retries transport loss with the same key",async()=>{
  const sent=[];
  let failNext=true;
  const client=createPcmsUiClient({
    transport:{
      async send(message){
        sent.push(message);
        if(message.kind==="command"&&failNext){failNext=false;throw new Error("Receiving end does not exist");}
        if(message.name==="accounts.getAccount") return {ok:false,error:{code:"PCMS_ACCOUNTS_NOT_FOUND",message:"missing",currentRevision:4}};
        return {ok:true,result:{echo:message.params.args}};
      },
      subscribeRevision(){return ()=>{};}
    },
    newIdempotencyKey:(()=>{let n=0;return ()=>"ui-test-key-"+(++n);})()
  });
  assert.deepEqual(await client.runtime.accounts.listAccounts(),{echo:[]});
  assert.deepEqual(await client.runtime.accounts.createAccount({accountId:"x"},{expectedRevision:0}),{echo:[{accountId:"x"},{expectedRevision:0}]});
  const commands=sent.filter((message)=>message.kind==="command");
  assert.equal(commands.length,2);
  assert.equal(commands[0].idempotencyKey,commands[1].idempotencyKey,"retry keeps the idempotency key");
  await client.runtime.accounts.createAccount({accountId:"y"},{expectedRevision:1});
  assert.notEqual(sent.at(-1).idempotencyKey,commands[0].idempotencyKey,"each submission is a new command");
  const error=await client.runtime.accounts.getAccount("missing").catch((caught)=>caught);
  assert.equal(error.code,"PCMS_ACCOUNTS_NOT_FOUND");
  assert.equal(error.currentRevision,4);
  await client.runtime.deployer.deploy("d",{expectedRevision:1,source:"s",ignored:undefined});
  assert.deepEqual(sent.at(-1).params.args,["d",{expectedRevision:1,source:"s"}]);
  assert.equal(typeof client.runtime.storageBroker,"undefined");
  assert.equal(typeof client.runtime.providerGate,"undefined");
  for(const message of sent) validatePcmsUiRequest(message);
});
