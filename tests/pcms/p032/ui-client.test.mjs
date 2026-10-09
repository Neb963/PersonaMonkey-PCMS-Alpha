import test from "node:test";
import assert from "node:assert/strict";

import { createPcmsUiClient } from "../../../extension/pcms/app/ui-client.js";
import { readPcmsCachedStatus } from "../../../extension/pcms/app/live-runtime.js";

function transportHarness(){
  const revisions=new Set();
  return {
    receipts:[],
    transport:{
      async send(message){
        if(message.name==="core.status") return {ok:true,requestId:message.requestId,result:{state:"RUNNING"}};
        return {
          ok:true,
          requestId:message.requestId,
          receipt:{receiptId:message.idempotencyKey,subject:message.name,status:"COMPLETED"},
          result:{accepted:true}
        };
      },
      async readSession(key){return {state:"RUNNING",asOf:"2026-10-07T21:00:00.000Z",key};},
      subscribeRevision(listener){revisions.add(listener);return ()=>revisions.delete(listener);}
    }
  };
}

test("A032-02 dashboard client exposes bounded receipt projections without changing command results",async()=>{
  const h=transportHarness();
  const client=createPcmsUiClient({transport:h.transport,newIdempotencyKey:()=>"ui-p032-receipt-1"});
  const seen=[];
  const off=client.subscribeReceipt((receipt)=>seen.push(receipt));
  assert.deepEqual(await client.runtime.accounts.createAccount({accountId:"a"},{expectedRevision:0}),{accepted:true});
  assert.deepEqual(seen,[{
    receiptId:"ui-p032-receipt-1",
    subject:"accounts.createAccount",
    status:"COMPLETED",
    replayed:false,
    requestId:seen[0].requestId,
    ok:true
  }]);
  assert.match(seen[0].requestId,/^ui-/);
  off();
  client.close();
});

test("A032-03 cached Core status reads only the accepted non-secret session summary",async()=>{
  const h=transportHarness();
  const status=await readPcmsCachedStatus({transport:h.transport});
  assert.equal(status.state,"RUNNING");
  assert.equal(status.key,"pcms.status.v1");
});
