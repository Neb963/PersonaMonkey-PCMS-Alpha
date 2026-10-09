import assert from "node:assert/strict";
import test from "node:test";

import { createCoreServiceRegistry } from "../../../extension/pcms/services/registry.js";
import { TIMER_NAMESPACE, TIMER_STATES, createTimerService } from "../../../extension/pcms/services/timers.js";
import {
  PCMS_CORE_HEARTBEAT_ALARM,
  PCMS_CORE_HEARTBEAT_MINUTES,
  PCMS_TIMER_ALARM_NEXT,
  PCMS_TIMER_CONTINUATION_DELAY_MS,
  createPcmsAlarmCoordinator
} from "../../../extension/pcms/background/alarms/coordinator.js";
import { makeP012Harness } from "../p012-harness.mjs";

function fakeAlarms(){
  const values=new Map();const calls=[];
  return Object.freeze({
    values,calls,
    async create(name,info){values.set(name,Object.freeze({name,...structuredClone(info)}));calls.push(["create",name,structuredClone(info)]);},
    async get(name){return values.get(name)??null;},
    async clear(name){const existed=values.delete(name);calls.push(["clear",name]);return existed;}
  });
}
function target(registry,calls){
  registry.register("core.p029-target",Object.freeze({async onTimer(event){calls.push(event);}}),{ownerId:"core",generation:1});
}
function input(id,dueAt){return {name:id,serviceName:"core.p029-target",ownerId:"core",generation:1,dueAt};}

test("A029-01 cold start recreates heartbeat and maps the earliest durable due timer to one named alarm",async()=>{
  const h=makeP012Harness();const registry=createCoreServiceRegistry();const calls=[];target(registry,calls);
  const alarms=fakeAlarms();let coordinator;
  const timers=createTimerService({
    storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock,
    onChanged:async()=>coordinator?.armNext()
  });
  coordinator=createPcmsAlarmCoordinator({alarms,timers,clock:h.clock});
  await timers.ensure(input("later","2026-10-05T03:01:00Z"));
  await timers.ensure(input("earlier","2026-10-05T03:00:30Z"));
  alarms.values.clear();
  const pass=await coordinator.start({wake:"COLD"});
  assert.equal(pass.due.processed.length,0);
  assert.equal(alarms.values.get(PCMS_CORE_HEARTBEAT_ALARM).periodInMinutes,PCMS_CORE_HEARTBEAT_MINUTES);
  assert.equal(alarms.values.get(PCMS_TIMER_ALARM_NEXT).when,Date.parse("2026-10-05T03:00:30Z"));
  assert.equal(pass.next.nextTimerId,"earlier");
});

test("A029-01 duplicate and spurious alarm wakes are harmless and one due occurrence fires once",async()=>{
  const h=makeP012Harness();const registry=createCoreServiceRegistry();const delivered=[];target(registry,delivered);
  const alarms=fakeAlarms();let coordinator;
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock,onChanged:async()=>coordinator?.armNext()});
  coordinator=createPcmsAlarmCoordinator({alarms,timers,clock:h.clock});
  await timers.ensure(input("once","2026-10-05T03:00:05Z"));
  await coordinator.start({wake:"COLD"});
  assert.deepEqual(await coordinator.handleAlarm("pcms.not-owned"),{ignored:true});
  assert.equal(delivered.length,0);
  h.setNow("2026-10-05T03:00:05Z");
  await Promise.all([
    coordinator.handleAlarm(PCMS_TIMER_ALARM_NEXT),
    coordinator.handleAlarm(PCMS_TIMER_ALARM_NEXT),
    coordinator.handleAlarm(PCMS_CORE_HEARTBEAT_ALARM)
  ]);
  assert.equal(delivered.length,1);
  assert.equal((await timers.get("once")).value.state,TIMER_STATES.FIRED);
  assert.equal(alarms.values.has(PCMS_TIMER_ALARM_NEXT),false);
  assert.equal(alarms.values.has(PCMS_CORE_HEARTBEAT_ALARM),true);
});

test("A029-02 interrupted work is recovered, re-declared once and then dispatched exactly once",async()=>{
  const h=makeP012Harness();const registry=createCoreServiceRegistry();const delivered=[];target(registry,delivered);
  const alarms=fakeAlarms();let coordinator;
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock,onChanged:async()=>coordinator?.armNext()});
  await timers.ensure(input("recover-me","2026-10-05T03:00:00Z"));
  const row=h.row(TIMER_NAMESPACE,"recover-me");row.revision+=1;row.value.state=TIMER_STATES.DISPATCHING;h.put(TIMER_NAMESPACE,"recover-me",row);
  let declarations=0;
  coordinator=createPcmsAlarmCoordinator({
    alarms,timers,clock:h.clock,
    declareSchedules:async({recovered})=>{
      const interrupted=recovered.find(item=>item.value.timerId==="recover-me");
      if(interrupted){declarations+=1;await timers.ensure(input("recover-me",interrupted.value.dueAt));}
    }
  });
  const first=await coordinator.start({wake:"WARM"});
  assert.equal(first.recovered.recovered.length,1);
  assert.equal(declarations,1);
  assert.equal(delivered.length,1);
  assert.equal((await timers.get("recover-me")).value.state,TIMER_STATES.FIRED);
  await coordinator.handleAlarm(PCMS_CORE_HEARTBEAT_ALARM);
  assert.equal(delivered.length,1);
  assert.equal(declarations,1);
});

test("A029-02 bounded due passes schedule a continuation instead of replaying an unbounded backlog",async()=>{
  const shared={rows:new Map(),events:[],now:"2026-10-05T03:00:00.000Z"};
  const h=makeP012Harness(shared);const registry=createCoreServiceRegistry();const delivered=[];target(registry,delivered);
  const alarms=fakeAlarms();let coordinator;
  const timers=createTimerService({storageBroker:h.storageBroker,auditJournal:h.auditJournal,serviceRegistry:registry,clock:h.clock,maxDuePerRun:2,onChanged:async()=>coordinator?.armNext()});
  for(const id of ["a","b","c"])await timers.ensure(input(id,"2026-10-05T03:00:00Z"));
  coordinator=createPcmsAlarmCoordinator({alarms,timers,clock:h.clock,limit:2});
  const first=await coordinator.start({wake:"WARM"});
  assert.equal(first.due.processed.length,2);
  assert.equal(first.due.remainingDue,1);
  assert.equal(delivered.length,2);
  assert.equal(alarms.values.get(PCMS_TIMER_ALARM_NEXT).when,Date.parse(h.clock())+PCMS_TIMER_CONTINUATION_DELAY_MS);
  h.setNow("2026-10-05T03:00:01Z");
  const second=await coordinator.handleAlarm(PCMS_TIMER_ALARM_NEXT);
  assert.equal(second.due.processed.length,1);
  assert.equal(second.due.remainingDue,0);
  assert.equal(delivered.length,3);
  assert.equal(alarms.values.has(PCMS_TIMER_ALARM_NEXT),false);
});
