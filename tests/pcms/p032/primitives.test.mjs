import test from "node:test";
import assert from "node:assert/strict";

import {
  PCMS_STATUS_TOKENS,
  pcmsStatusToken,
  presentPcmsCoreStatus,
  presentPcmsHumanTask,
  presentPcmsModule,
  presentPcmsReceipt
} from "../../../extension/pcms/app/primitives.js";

test("A032-01 shell status tokens use one closed vocabulary",()=>{
  assert.deepEqual(Object.keys(PCMS_STATUS_TOKENS),[
    "OK","INFO","ACTIVE","WAITING_HUMAN","WARNING","ERROR","UNCERTAIN","HELD","UNAVAILABLE"
  ]);
  assert.equal(pcmsStatusToken("NOT_A_TOKEN"),PCMS_STATUS_TOKENS.INFO);
  assert.deepEqual(presentPcmsModule({available:true}),{token:"OK",label:"Available"});
  assert.deepEqual(presentPcmsModule({available:false}),{token:"UNAVAILABLE",label:"Unavailable"});
});

test("A032-03 Core presentation distinguishes live running, cached idle, starting and unavailable",()=>{
  const cached={state:"RUNNING",asOf:"2026-10-07T20:00:00.000Z"};
  assert.deepEqual(presentPcmsCoreStatus(cached,{live:false}),{
    state:"IDLE",token:"INFO",label:"Idle",asOf:cached.asOf
  });
  assert.deepEqual(presentPcmsCoreStatus(cached,{live:true}),{
    state:"RUNNING",token:"OK",label:"Running",asOf:cached.asOf
  });
  assert.equal(presentPcmsCoreStatus(null,{pending:true}).state,"STARTING");
  assert.equal(presentPcmsCoreStatus({state:"UNAVAILABLE"}).state,"UNAVAILABLE");
});

test("A032-02 durable receipt and HumanTask states map to subject-level presentation",()=>{
  assert.deepEqual(presentPcmsReceipt({status:"COMPLETED"}),{token:"OK",label:"Done"});
  assert.deepEqual(presentPcmsReceipt({status:"PENDING"}),{token:"ACTIVE",label:"Running"});
  assert.deepEqual(presentPcmsReceipt({status:"FAILED"}),{token:"ERROR",label:"Failed"});
  assert.equal(presentPcmsReceipt({status:"UNKNOWN"}).token,"UNCERTAIN");
  assert.equal(presentPcmsHumanTask({priority:"CRITICAL",taskKind:"operator.review"}).token,"WARNING");
  assert.equal(presentPcmsHumanTask({priority:"HIGH",taskKind:"provider.reconcile"}).token,"UNCERTAIN");
  assert.equal(presentPcmsHumanTask({priority:"NORMAL",taskKind:"operator.captcha"}).token,"WAITING_HUMAN");
});
