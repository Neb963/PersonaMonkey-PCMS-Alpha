import assert from "node:assert/strict";
import test from "node:test";

import { startPcmsRuntimeWithRetry } from "../../../extension/pcms/app/startup-retry.js";

test("A026-03 startup retry survives transient PersonaMonkey Integration unavailability",async()=>{
  let attempts=0;
  const sleeps=[];
  const result=await startPcmsRuntimeWithRetry({
    delays:[0,10,20],
    setTimeoutRef:(resolve,ms)=>{sleeps.push(ms);resolve();return 1;},
    startRuntime:async()=>{
      attempts+=1;
      if(attempts<3)throw new Error("Integration v1 not ready");
      return {brokerRevision:7};
    }
  });
  assert.equal(attempts,3);
  assert.deepEqual(sleeps,[10,20]);
  assert.equal(result.brokerRevision,7);
});

test("A026-03 startup retry is bounded and preserves the final failure",async()=>{
  let attempts=0;
  const terminal=new Error("still unavailable");
  await assert.rejects(
    startPcmsRuntimeWithRetry({
      delays:[0,1,1],
      setTimeoutRef:(resolve)=>{resolve();return 1;},
      startRuntime:async()=>{attempts+=1;throw terminal;}
    }),
    error=>error===terminal
  );
  assert.equal(attempts,3);
});
