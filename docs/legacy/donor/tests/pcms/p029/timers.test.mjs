import assert from "node:assert/strict";
import test from "node:test";

import { CORE_SERVICE_ERROR_CODES } from "../../../extension/pcms/services/errors.js";
import { createCoreServiceRegistry } from "../../../extension/pcms/services/registry.js";
import {
  PCMS_TIMERS_ENSURE_CONTRACT,
  TIMER_NAMESPACE,
  TIMER_STATES,
  createTimerService
} from "../../../extension/pcms/services/timers.js";
import { makeP012Harness } from "../p012-harness.mjs";

function register(registry,calls,{generation=1}={}){
  registry.register("core.p029-target",Object.freeze({async onTimer(event){calls.push(event);}}),{ownerId:"core",generation});
}

test("A029-01 pcms.timers.ensure/v1 converges declarations and never postpones queued work",async()=>{
  assert.equal(PCMS_TIMERS_ENSURE_CONTRACT,"pcms.timers.ensure/v1");
  const h=makeP012Harness();const registry=createCoreServiceRegistry();const calls=[];register(registry,calls);
  const changes=[];
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock,maxOverdueMs:60_000,onChanged:async change=>changes.push(change.eventType)});
  const input={name:"declared",serviceName:"core.p029-target",ownerId:"core",generation:1,dueAt:"2026-10-05T03:00:10Z"};
  const first=await timers.ensure(input);
  const duplicate=await timers.ensure(input);
  const later=await timers.ensure({...input,dueAt:"2026-10-05T03:00:20Z"});
  assert.equal(duplicate.revision,first.revision);
  assert.equal(later.revision,first.revision);
  assert.equal(later.value.dueAt,"2026-10-05T03:00:10.000Z");
  const earlier=await timers.ensure({...input,dueAt:"2026-10-05T03:00:05Z"});
  assert.equal(earlier.value.dueAt,"2026-10-05T03:00:05.000Z");
  assert.deepEqual(changes,["timer.scheduled","timer.ensured"]);
  h.setNow("2026-10-05T03:00:05Z");
  assert.equal((await timers.runDue()).processed[0].value.state,TIMER_STATES.FIRED);
  assert.equal(calls.length,1);
  const satisfied=await timers.ensure({...input,dueAt:"2026-10-05T03:00:05Z"});
  assert.equal(satisfied.value.state,TIMER_STATES.FIRED);
  assert.equal((await timers.runDue()).processed.length,0);
  assert.equal(calls.length,1);
  const next=await timers.ensure({...input,dueAt:"2026-10-05T03:00:30Z"});
  assert.equal(next.value.state,TIMER_STATES.SCHEDULED);
  assert.equal(next.value.dueAt,"2026-10-05T03:00:30.000Z");
});

test("A029-02 overdue declared work is MISSED and identical re-declaration does not replay backlog",async()=>{
  const h=makeP012Harness();const registry=createCoreServiceRegistry();const calls=[];register(registry,calls);
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock,maxOverdueMs:1000});
  const input={name:"overdue",serviceName:"core.p029-target",ownerId:"core",generation:1,dueAt:"2026-10-05T02:59:00Z"};
  await timers.ensure(input);
  const pass=await timers.runDue();
  assert.equal(pass.processed[0].value.state,TIMER_STATES.MISSED);
  assert.equal(pass.processed[0].value.missedReason,"overdue");
  assert.equal(calls.length,0);
  const repeated=await timers.ensure(input);
  assert.equal(repeated.value.state,TIMER_STATES.MISSED);
  assert.equal(repeated.revision,pass.processed[0].revision);
  assert.equal((await timers.runDue()).processed.length,0);
});

test("A029-02 an interrupted occurrence receives exactly one declared catch-up",async()=>{
  const h=makeP012Harness();const registry=createCoreServiceRegistry();const calls=[];register(registry,calls);
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock});
  const input={name:"interrupted",serviceName:"core.p029-target",ownerId:"core",generation:1,dueAt:"2026-10-05T03:00:00Z"};
  await timers.ensure(input);
  const row=h.row(TIMER_NAMESPACE,"interrupted");row.revision+=1;row.value.state=TIMER_STATES.DISPATCHING;h.put(TIMER_NAMESPACE,"interrupted",row);
  const recovered=await timers.recoverInterrupted();
  assert.equal(recovered.recovered[0].value.missedReason,"interrupted");
  const catchup=await timers.ensure(input);
  assert.equal(catchup.value.state,TIMER_STATES.SCHEDULED);
  const fired=await timers.runDue();
  assert.equal(fired.processed[0].value.state,TIMER_STATES.FIRED);
  assert.equal(calls.length,1);
  const stable=await timers.ensure(input);
  assert.equal(stable.value.state,TIMER_STATES.FIRED);
  assert.equal((await timers.runDue()).processed.length,0);
  assert.equal(calls.length,1);
});

test("A029-02 a declaration cannot replace a live DISPATCHING occurrence",async()=>{
  const h=makeP012Harness();const registry=createCoreServiceRegistry();const calls=[];register(registry,calls);
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock});
  const input={name:"active",serviceName:"core.p029-target",ownerId:"core",generation:1,dueAt:"2026-10-05T03:00:00Z"};
  await timers.ensure(input);
  const row=h.row(TIMER_NAMESPACE,"active");row.revision+=1;row.value.state=TIMER_STATES.DISPATCHING;h.put(TIMER_NAMESPACE,"active",row);
  assert.equal((await timers.ensure(input)).value.state,TIMER_STATES.DISPATCHING);
  await assert.rejects(timers.ensure({...input,dueAt:"2026-10-05T03:00:01Z"}),error=>error?.code===CORE_SERVICE_ERROR_CODES.INVALID_TRANSITION);
});
