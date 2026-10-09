import assert from "node:assert/strict";
import test from "node:test";

import { CORE_SERVICE_ERROR_CODES } from "../../extension/pcms/services/errors.js";
import { createCoreServiceRegistry } from "../../extension/pcms/services/registry.js";
import {
  HUMAN_TASK_NAMESPACE,
  HUMAN_TASK_STATES,
  createHumanTaskService
} from "../../extension/pcms/services/human-tasks.js";
import {
  TIMER_NAMESPACE,
  TIMER_STATES,
  createTimerService
} from "../../extension/pcms/services/timers.js";
import { makeP012Harness } from "./p012-harness.mjs";

test("A012-01 HumanTask state is durable, audited, revision-fenced, and Attention is deterministic", async () => {
  const h=makeP012Harness();
  const tasks=createHumanTaskService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,clock:h.clock});
  const normal=await tasks.open({taskId:"task-normal",taskKind:"operator.review",title:"Review account",priority:"NORMAL",subjectRef:{kind:"account",id:"acct-1"}});
  h.setNow("2026-10-05T03:00:01Z");
  const critical=await tasks.open({taskId:"task-critical",taskKind:"operator.captcha",title:"Complete CAPTCHA",instructions:"Use the active guarded session only",priority:"CRITICAL"});
  h.setNow("2026-10-05T03:00:02Z");
  const high=await tasks.open({taskId:"task-high",taskKind:"operator.confirm",title:"Confirm provider state",priority:"HIGH"});

  assert.equal(normal.revision,1);
  assert.equal(h.shared.events[0].type,"human-task.opened");
  assert.equal(Object.hasOwn(normal.value,"result"),false,"HumanTask must not persist arbitrary operator input");
  assert.deepEqual((await tasks.listAttention()).map(row=>row.value.taskId),["task-critical","task-high","task-normal"]);

  h.setNow("2026-10-05T03:00:03Z");
  const resolved=await tasks.resolve("task-critical",{expectedRevision:critical.revision,resolutionCode:"completed"});
  assert.equal(resolved.value.state,HUMAN_TASK_STATES.RESOLVED);
  assert.equal(resolved.value.completedAt,"2026-10-05T03:00:03.000Z");
  assert.deepEqual((await tasks.listAttention()).map(row=>row.value.taskId),["task-high","task-normal"]);
  await assert.rejects(tasks.cancel("task-critical",{expectedRevision:critical.revision}),error=>error?.code===CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT);
  await assert.rejects(tasks.resolve("task-critical",{expectedRevision:resolved.revision}),error=>error?.code===CORE_SERVICE_ERROR_CODES.INVALID_TRANSITION);

  const persisted=h.row(HUMAN_TASK_NAMESPACE,"task-critical");
  assert.equal(persisted.value.state,HUMAN_TASK_STATES.RESOLVED);
  assert.equal(h.shared.events.at(-1).type,"human-task.resolved");
  assert.equal(high.value.state,HUMAN_TASK_STATES.OPEN);
});

test("A012-01 HumanTask identity is stable and duplicate creation fails closed", async () => {
  const h=makeP012Harness();
  const tasks=createHumanTaskService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,clock:h.clock});
  const first=await tasks.open({taskId:"task-1",taskKind:"operator.review",title:"Review"});
  await assert.rejects(tasks.open({taskId:"task-1",taskKind:"operator.review",title:"Different"}),error=>error?.code===CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT&&error.currentRevision===first.revision);
  assert.equal(h.shared.events.length,1);
});

test("A012-03 service registry fences owner/generation and exposes only declared methods", async () => {
  let tokens=0;const registry=createCoreServiceRegistry({tokenFactory:()=>"token-"+(++tokens)});
  const calls=[];
  const first=registry.register("core.example",{ping:async args=>{calls.push(args);return "pong";}},{ownerId:"module-a",generation:1});
  assert.deepEqual(registry.describe("core.example"),{name:"core.example",ownerId:"module-a",generation:1,methods:["ping"]});
  assert.equal(await registry.call("core.example","ping",{n:1},{ownerId:"module-a",generation:1}),"pong");
  assert.deepEqual(calls,[{n:1}]);
  await assert.rejects(registry.call("core.example","ping",null,{ownerId:"module-a",generation:0}),error=>error?.code===CORE_SERVICE_ERROR_CODES.STALE_SERVICE);
  assert.throws(()=>registry.register("core.example",{ping(){return null;}},{ownerId:"module-b",generation:2}),error=>error?.code===CORE_SERVICE_ERROR_CODES.SERVICE_CONFLICT);
  assert.throws(()=>registry.register("core.example",{ping(){return null;}},{ownerId:"module-a",generation:1}),error=>error?.code===CORE_SERVICE_ERROR_CODES.STALE_SERVICE);
  const second=registry.register("core.example",{ping(){return "v2";}},{ownerId:"module-a",generation:2});
  assert.throws(()=>registry.unregister("core.example",{token:first.token}),error=>error?.code===CORE_SERVICE_ERROR_CODES.STALE_SERVICE);
  assert.equal(registry.unregister("core.example",{token:second.token}),true);
  await assert.rejects(registry.call("core.example","ping"),error=>error?.code===CORE_SERVICE_ERROR_CODES.SERVICE_UNAVAILABLE);
});

test("A012-03 service registration tokens are single-use fencing values", () => {
  const registry=createCoreServiceRegistry({tokenFactory:()=>"fixed-token"});
  registry.register("core.one",{ping(){return null;}},{ownerId:"core",generation:0});
  assert.throws(()=>registry.register("core.two",{ping(){return null;}},{ownerId:"core",generation:0}),error=>error?.code===CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  assert.throws(()=>registry.register("core.bad",{constructor(){return null;}},{ownerId:"core",generation:0}),error=>error?.code===CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
  const hidden={ping(){return null;}}; hidden[Symbol("hidden")]=()=>null;
  assert.throws(()=>registry.register("core.hidden",hidden,{ownerId:"core",generation:0}),error=>error?.code===CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
});

test("A012-02 timer delivery is one-shot, durable, generation-fenced, and audited", async () => {
  const h=makeP012Harness();const registry=createCoreServiceRegistry();const delivered=[];
  registry.register("core.timer-target",{onTimer:async event=>{delivered.push(event);}},{ownerId:"module-a",generation:4});
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock,maxOverdueMs:60_000});
  const scheduled=await timers.schedule({timerId:"timer-1",serviceName:"core.timer-target",ownerId:"module-a",generation:4,dueAt:"2026-10-05T03:00:10Z"});
  assert.equal(scheduled.value.state,TIMER_STATES.SCHEDULED);
  assert.equal((await timers.runDue()).processed.length,0);
  h.setNow("2026-10-05T03:00:10Z");
  const run=await timers.runDue();
  assert.equal(run.processed.length,1);assert.equal(run.remainingDue,0);
  assert.equal(run.processed[0].value.state,TIMER_STATES.FIRED);
  assert.deepEqual(delivered,[{timerId:"timer-1",dueAt:"2026-10-05T03:00:10.000Z"}]);
  assert.deepEqual(h.shared.events.map(e=>e.type),["timer.scheduled","timer.dispatching","timer.fired"]);
  assert.equal((await timers.runDue()).processed.length,0,"fired timer must not replay");
  assert.equal(h.row(TIMER_NAMESPACE,"timer-1").value.state,TIMER_STATES.FIRED);
});

test("A012-02 due work is bounded and old backlog is marked missed instead of replayed", async () => {
  const h=makeP012Harness();const registry=createCoreServiceRegistry();let delivered=0;
  registry.register("core.timer-target",{onTimer:async()=>{delivered+=1;}},{ownerId:"core",generation:0});
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock,maxDuePerRun:2,maxOverdueMs:5000});
  for(let i=1;i<=3;i++)await timers.schedule({timerId:"timer-"+i,serviceName:"core.timer-target",ownerId:"core",generation:0,dueAt:"2026-10-05T02:59:58Z"});
  const first=await timers.runDue({limit:2});
  assert.equal(first.processed.length,2);assert.equal(first.remainingDue,1);assert.equal(delivered,2);
  h.setNow("2026-10-05T03:00:10Z");
  const second=await timers.runDue({limit:2});
  assert.equal(second.processed.length,1);assert.equal(second.processed[0].value.state,TIMER_STATES.MISSED);assert.equal(delivered,2);
});

test("A012-03 restart does not blindly replay due or interrupted timers", async () => {
  const shared={rows:new Map(),events:[],now:"2026-10-05T03:00:00.000Z"};
  const h1=makeP012Harness(shared);const registry1=createCoreServiceRegistry();let oldCalls=0;
  registry1.register("core.timer-target",{onTimer:async()=>{oldCalls+=1;}},{ownerId:"module-a",generation:7});
  const timers1=createTimerService({storageBroker:h1.storageBroker,auditJournal:h1.auditJournal,serviceRegistry:registry1,clock:h1.clock});
  await timers1.schedule({timerId:"restart-due",serviceName:"core.timer-target",ownerId:"module-a",generation:7,dueAt:"2026-10-05T03:00:00Z"});

  const h2=makeP012Harness(shared);const registry2=createCoreServiceRegistry();const timers2=createTimerService({storageBroker:h2.storageBroker,auditJournal:h2.auditJournal,serviceRegistry:registry2,clock:h2.clock});
  const beforeRegister=await timers2.runDue();
  assert.equal(beforeRegister.processed.length,0);assert.equal(beforeRegister.remainingDue,1);assert.equal(oldCalls,0);
  let newCalls=0;registry2.register("core.timer-target",{onTimer:async()=>{newCalls+=1;}},{ownerId:"module-a",generation:7});
  assert.equal((await timers2.runDue()).processed[0].value.state,TIMER_STATES.FIRED);assert.equal(newCalls,1);

  await timers2.schedule({timerId:"interrupted",serviceName:"core.timer-target",ownerId:"module-a",generation:7,dueAt:"2026-10-05T03:00:00Z"});
  const row=h2.row(TIMER_NAMESPACE,"interrupted");row.revision+=1;row.value.state=TIMER_STATES.DISPATCHING;h2.put(TIMER_NAMESPACE,"interrupted",row);
  const h3=makeP012Harness(shared);const registry3=createCoreServiceRegistry();registry3.register("core.timer-target",{onTimer:async()=>{throw new Error("must not run");}},{ownerId:"module-a",generation:7});
  const timers3=createTimerService({storageBroker:h3.storageBroker,auditJournal:h3.auditJournal,serviceRegistry:registry3,clock:h3.clock});
  const recovered=await timers3.recoverInterrupted();
  assert.equal(recovered.recovered.length,1);assert.equal(recovered.recovered[0].value.state,TIMER_STATES.MISSED);
});


test("A012-02 stale service generation reconciles due timers to MISSED without dispatch", async () => {
  const h=makeP012Harness();const registry=createCoreServiceRegistry();let delivered=0;
  registry.register("core.timer-target",{onTimer:async()=>{delivered+=1;}},{ownerId:"module-a",generation:1});
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock});
  await timers.schedule({timerId:"old-generation",serviceName:"core.timer-target",ownerId:"module-a",generation:1,dueAt:"2026-10-05T03:00:00Z"});
  registry.register("core.timer-target",{onTimer:async()=>{delivered+=1;}},{ownerId:"module-a",generation:2});
  const result=await timers.runDue();
  assert.equal(result.processed.length,1);
  assert.equal(result.processed[0].value.state,TIMER_STATES.MISSED);
  assert.equal(result.remainingDue,0);
  assert.equal(delivered,0);
  assert.equal(h.shared.events.at(-1).type,"timer.missed");
  assert.deepEqual(h.shared.events.at(-1).data,{reason:"stale-service"});
});

test("A012-02 timer scheduling rejects stale service generations", async () => {
  const h=makeP012Harness();const registry=createCoreServiceRegistry();registry.register("core.timer-target",{onTimer(){return null;}},{ownerId:"module-a",generation:9});
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock});
  await assert.rejects(timers.schedule({timerId:"stale",serviceName:"core.timer-target",ownerId:"module-a",generation:8,dueAt:"2026-10-05T03:01:00Z"}),error=>error?.code===CORE_SERVICE_ERROR_CODES.STALE_SERVICE&&error.currentGeneration===9);
});
