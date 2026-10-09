import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PCMS_CORE_HEARTBEAT_ALARM, PCMS_TIMER_ALARM_NEXT } from "../../../extension/pcms/background/alarms/coordinator.js";
import { PCMS_CONTINUITY_FIXTURE_TIMER_ID } from "../../../extension/pcms/background/alarms/continuity-fixture.js";
import { TIMER_STATES } from "../../../extension/pcms/services/timers.js";
import { execFileText, loadBrowserPin, sha256File, writeJson } from "../../../tools/firefox/lib.mjs";
import { PackagedFirefox, waitFor } from "../../../tools/firefox/packaged-harness.mjs";

const PRODUCT="persona-route-manager@local";
const root=resolve(process.env.FIREFOX_PACKAGED_DIR||join(tmpdir(),"pcms-firefox-packaged-p029"));
const reportPath=resolve(process.env.FIREFOX_P029_REPORT||join(root,"report.json"));
const pin=await loadBrowserPin();
const manifest=JSON.parse(await readFile("extension/manifest.json","utf8"));
const xpi=resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report={
  schemaVersion:1,
  phase:"P029",
  commitSha:process.env.GITHUB_SHA||(await execFileText("git",["rev-parse","HEAD"])).stdout.trim(),
  workflowRun:process.env.GITHUB_RUN_ID||null,
  version:pin.version,
  artifactSha256:pin.archive.sha256,
  productXpiSha256:await sha256File(xpi),
  checks:{},
  facts:{}
};

let h;
async function page(code,args=[]){
  const result=await h.pageScript(`const done=arguments[arguments.length-1];
    (async()=>{const api=window.wrappedJSObject.browser;${code}})()
      .then(value=>done({ok:true,value:JSON.parse(JSON.stringify(value??null))}),
        error=>done({ok:false,error:String(error&&error.stack||error)}));`,args,{async:true});
  if(!result.ok)throw new Error(result.error);
  return result.value;
}
let timerProbeSequence=0;
async function timerRow(){
  const sequence=++timerProbeSequence;
  return page(`
    const suffix=String(arguments[1])+"-"+Date.now();
    const response=await api.runtime.sendMessage({
      type:"PCMS_UI_REQUEST",
      version:1,
      requestId:"p029-probe-"+suffix,
      kind:"command",
      name:"backupRestore.createBackup",
      params:{args:[{backupId:"p029-probe-"+suffix}]},
      idempotencyKey:"p029-probe-"+suffix
    });
    if(!response?.ok)throw new Error((response?.error?.code||"PCMS_UI_FAILED")+": "+(response?.error?.message||"backup probe failed"));
    return response.result.records.find((record)=>record.namespace==="core.timers"&&record.key===arguments[0])||null;
  `,[PCMS_CONTINUITY_FIXTURE_TIMER_ID,sequence]);
}
async function alarms(){return page("return api.alarms.getAll();");}
async function openProbe(){return h.openPage(PRODUCT,"pcms/app/index.html");}
async function waitScheduled(label,priorRevision=0){
  return waitFor(async()=>{
    const row=await timerRow();
    return row?.revision>priorRevision&&row.value?.state===TIMER_STATES.SCHEDULED?row:null;
  },label,30000);
}
async function waitAlarmWake(dueAt,label){
  const delay=Math.max(0,Date.parse(dueAt)-Date.now());
  if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay+100));
  return waitFor(async()=>(await h.extension(PRODUCT)).state==="running",label,15000);
}

try{
  await mkdir(root,{recursive:true});
  h=await PackagedFirefox.create({root:join(root,"profiles")});
  await h.start();
  assert.equal(await h.install(xpi),PRODUCT);

  let probe=await openProbe();
  const first=await waitScheduled("initial P029 continuity timer");
  const firstAlarms=await alarms();
  assert.equal(firstAlarms.filter(item=>item.name===PCMS_TIMER_ALARM_NEXT).length,1);
  assert.equal(firstAlarms.filter(item=>item.name===PCMS_CORE_HEARTBEAT_ALARM).length,1);
  assert.equal(firstAlarms.find(item=>item.name===PCMS_TIMER_ALARM_NEXT).scheduledTime,Date.parse(first.value.dueAt));
  report.facts.initial={revision:first.revision,dueAt:first.value.dueAt,alarms:firstAlarms.map(item=>({name:item.name,scheduledTime:item.scheduledTime,periodInMinutes:item.periodInMinutes??null}))};
  await h.closePage(probe);

  report.firstUnload=await h.forceIdleUnload(PRODUCT);
  assert.equal(report.firstUnload.state,"stopped","Firefox test hook must confirm suspension");
  await waitAlarmWake(first.value.dueAt,"P029 next-due alarm wakes unloaded background");
  probe=await openProbe();
  const fired=await waitFor(async()=>{
    const row=await timerRow();
    return row?.value?.state===TIMER_STATES.FIRED?row:null;
  },"P029 continuity timer fires with zero PCMS tabs",15000);
  assert.ok(fired.revision>first.revision);
  report.facts.afterUnload={revision:fired.revision,state:fired.value.state,completedAt:fired.value.completedAt};
  report.checks.zeroPcmsTabsAlarmWakeAndRun=true;
  await h.closePage(probe);

  await h.restart();
  assert.equal((await h.extension(PRODUCT)).id,PRODUCT);
  probe=await openProbe();
  const restarted=await waitScheduled("cold restart re-declares P029 continuity timer",fired.revision);
  assert.notEqual(restarted.value.dueAt,first.value.dueAt);
  const restartAlarms=await alarms();
  assert.equal(restartAlarms.filter(item=>item.name===PCMS_TIMER_ALARM_NEXT).length,1);
  assert.equal(restartAlarms.filter(item=>item.name===PCMS_CORE_HEARTBEAT_ALARM).length,1);
  assert.equal(restartAlarms.find(item=>item.name===PCMS_TIMER_ALARM_NEXT).scheduledTime,Date.parse(restarted.value.dueAt));
  report.facts.restart={revision:restarted.revision,dueAt:restarted.value.dueAt,alarms:restartAlarms.map(item=>({name:item.name,scheduledTime:item.scheduledTime,periodInMinutes:item.periodInMinutes??null}))};
  report.checks.coldRestartRecreatesAlarmsFromDurableTimer=true;
  await h.closePage(probe);

  report.restartUnload=await h.forceIdleUnload(PRODUCT);
  assert.equal(report.restartUnload.state,"stopped","Firefox test hook must confirm suspension after restart");
  await waitAlarmWake(restarted.value.dueAt,"P029 recreated alarm wakes after profile restart");
  probe=await openProbe();
  const firedAgain=await waitFor(async()=>{
    const row=await timerRow();
    return row?.revision>restarted.revision&&row.value?.state===TIMER_STATES.FIRED?row:null;
  },"P029 restarted continuity timer fires",15000);
  report.facts.afterRestartUnload={revision:firedAgain.revision,state:firedAgain.value.state,completedAt:firedAgain.value.completedAt};
  report.checks.profileRestartThenZeroTabsUnloadAndRun=true;
  await h.closePage(probe);
  report.passed=true;
}catch(error){
  report.passed=false;report.failure=String(error.stack||error);throw error;
}finally{
  await h?.stop();
  await writeJson(reportPath,report);
  if(h)await rm(h.profilePath,{recursive:true,force:true});
}
console.log(JSON.stringify(report));
