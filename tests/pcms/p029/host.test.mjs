import assert from "node:assert/strict";
import test from "node:test";

import { createPcmsBackgroundEntry } from "../../../extension/pcms/background/entry.js";
import { createPcmsCoreHost } from "../../../extension/pcms/background/core-host.js";

function sessionStore(){
  const rows=new Map();
  return {rows,async get(key){return rows.get(key)??null;},async set(key,value){rows.set(key,structuredClone(value));}};
}
function fakeCore(events){
  return Object.freeze({
    async initialize({wake}){events.push(["initialize",wake]);return {recoveryState:"NORMAL"};},
    close(){events.push(["close"]);},
    bindTimerAlarmRearm(handler){events.push(["bind",handler===null?"clear":"set"]);},
    storageBroker:{namespace(){return {async list(){return [];}};}},
    recoveryHold:{async getStatus(){return {value:{state:"NORMAL"}};}},
    remoteOps:{async listUnresolved(){return [];}},
    humanTasks:{async listAttention(){return [];}},
    accounts:{async listAccounts(){return {accounts:[]};}}
  });
}

test("A029-01 first alarm wake lets Core startup run one due pass; later alarms run the existing coordinator",async()=>{
  const events=[];const session=sessionStore();
  const host=createPcmsCoreHost({
    personaMonkeyReady:async()=>{},
    createCore:()=>fakeCore(events),
    createAlarmCoordinator:()=>Object.freeze({
      async start({wake}){events.push(["alarm.start",wake]);},
      async handleAlarm(name,{wake}){events.push(["alarm.handle",name,wake]);},
      async armNext(){events.push(["alarm.rearm"]);}
    }),
    sessionStore:session,
    runtimeId:"pcms-test",
    extensionBaseUrl:"moz-extension://pcms-test/",
    newSessionId:()=>"0123456789abcdef0123456789abcdef"
  });
  await host.handleAlarm({name:"pcms.timers.next"});
  assert.deepEqual(events.slice(0,3),[["initialize","COLD"],["bind","set"],["alarm.start","COLD"]]);
  assert.equal(events.some(event=>event[0]==="alarm.handle"),false,"startup due pass owns the first wake");
  await host.handleAlarm({name:"pcms.core.heartbeat"});
  assert.deepEqual(events.at(-1),["alarm.handle","pcms.core.heartbeat","WARM"]);
});

test("A029-01 background entry routes only pcms.* alarms and preserves the alarm envelope",async()=>{
  const added=[];const seen=[];
  const event=name=>({addListener(listener){added.push([name,listener]);}});
  const entry=createPcmsBackgroundEntry({
    browserRef:{runtime:{onMessage:event("message"),onStartup:event("startup"),onInstalled:event("installed")},alarms:{onAlarm:event("alarm")}},
    loadHost:async()=>Object.freeze({
      async wake(){seen.push(["wake"]);return true;},
      async handleAlarm(alarm){seen.push(["alarm",alarm.name]);return true;},
      async handleUiMessage(){return {ok:true};}
    })
  });
  entry.install();
  entry.setPersonaMonkeyBootstrap(async()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  const listener=added.find(([name])=>name==="alarm")[1];
  listener({name:"persona-mullvad-idle"});
  listener({name:"pcms.timers.next"});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(seen.some(item=>item[0]==="alarm"&&item[1]==="persona-mullvad-idle"),false);
  assert.equal(seen.some(item=>item[0]==="alarm"&&item[1]==="pcms.timers.next"),true);
});
