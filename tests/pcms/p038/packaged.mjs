import assert from "node:assert/strict";
import {mkdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {execFileText,loadBrowserPin,sha256File,writeJson} from "../../../tools/firefox/lib.mjs";
import {PackagedFirefox,waitFor} from "../../../tools/firefox/packaged-harness.mjs";
import {REPOSITORY_SYNC_TIMERS} from "../../../pcms-modules/p015/repository-sync.js";

const PRODUCT="persona-route-manager@local";
const root=resolve(process.env.FIREFOX_PACKAGED_DIR||join(tmpdir(),"pcms-firefox-packaged-p038"));
const reportPath=resolve(process.env.FIREFOX_P038_REPORT||join(root,"report.json"));
const pin=await loadBrowserPin();
const manifest=JSON.parse(await readFile("extension/manifest.json","utf8"));
const xpi=resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report={schemaVersion:1,phase:"P038",
  commitSha:process.env.GITHUB_SHA||(await execFileText("git",["rev-parse","HEAD"])).stdout.trim(),
  workflowRun:process.env.GITHUB_RUN_ID||null,
  version:pin.version,artifactSha256:pin.archive.sha256,
  productXpiSha256:await sha256File(xpi),checks:{},facts:{}};
let h,probe;
async function page(code,args=[]){
  const result=await h.pageScript(`const done=arguments[arguments.length-1];
    (async()=>{const api=window.wrappedJSObject.browser;${code}})()
      .then(value=>done({ok:true,value:JSON.parse(JSON.stringify(value??null))}),
        error=>done({ok:false,error:String(error&&error.stack||error)}));`,args,{async:true});
  if(!result.ok)throw new Error(result.error);
  return result.value;
}
let seq=0;
async function request(name,args,kind="command"){
  return page(`
    const suffix=String(arguments[2])+"-"+Date.now();
    const response=await api.runtime.sendMessage({
      type:"PCMS_UI_REQUEST",version:1,requestId:"p038-"+suffix,
      kind:arguments[0],name:arguments[1].name,params:{args:arguments[1].args},
      ...(arguments[0]==="command"?{idempotencyKey:"p038-"+suffix}:{})
    });
    if(!response?.ok)throw new Error(String(response?.error?.code||"PCMS_UI_FAILED")+": "+String(response?.error?.message||"request failed"));
    return response.result;
  `,[kind,{name,args},++seq]);
}
async function backup(){
  const result=await request("backupRestore.createBackup",[{backupId:"p038-probe-"+(++seq)}]);
  const find=(namespace)=>result.records.find(row=>row.namespace===namespace&&row.key==="state")?.value??null;
  return {sync:find("module.deployer.repository.sync"),repo:find("module.deployer.repository"),
    timers:result.records.filter(row=>row.namespace==="core.timers"&&REPOSITORY_SYNC_TIMERS.includes(row.key))};
}
try{
  await mkdir(root,{recursive:true});
  h=await PackagedFirefox.create({root:join(root,"profiles")});
  await h.start();
  assert.equal(await h.install(xpi),PRODUCT);
  probe=await h.openPage(PRODUCT,"pcms/app/index.html");
  await waitFor(async()=>{
    const snapshot=await request("ui.snapshot",[],"query");
    return snapshot?.modules?.some?.(module=>module.moduleId==="deployer")||snapshot?.views?.some?.(module=>module.moduleId==="deployer");
  },"deployer built-in available",15000);
  await request("ui.invoke",["deployer","connect",null,
    {owner:"pcms-p038-offline",repo:"fixture",ref:"main",root:"",accessType:"public",listing:"unlisted"},{confirmed:true}]);
  const initial=await backup();
  assert.ok(initial.repo?.config,"configured repository must be persisted");
  // No network is ever contacted during the probe: the scan must fail closed.
  await h.client.script("Services.io.offline = true;");
  const wakeAt=await page(`const when=Date.now()+15000;
    await api.alarms.create("pcms.core.heartbeat",{when});return when;`);
  await h.closePage(probe);probe=null;
  const unloaded=await h.forceIdleUnload(PRODUCT);
  assert.equal(unloaded.state,"stopped");
  report.facts.initial={repositoryConfigured:true,background:unloaded,wakeAt};
  // Wait until AFTER the scheduled alarm while no PCMS tab is open. An
  // unrelated Firefox event may warm the background earlier than our alarm.
  await waitFor(async()=>Date.now()>=wakeAt+1000&&(await h.extension(PRODUCT)).state==="running",
    "repository sync must wake with zero PCMS tabs",30000);
  report.checks.zeroTabsBackgroundWake=true;
  // Keep the process offline until the durable scan result is observed; an
  // early reconnect races the background fetch and can turn UNAVAILABLE into 404.
  probe=await h.openPage(PRODUCT,"pcms/app/index.html");
  const completed=await waitFor(async()=>{
    const state=await backup();
    return state.repo?.lastFailure&&state.sync?.failureCount>0?state:null;
  },"offline repository check retained with backoff",15000);
  assert.equal(completed.repo.lastFailure.code,"REPO_UNAVAILABLE");
  assert.equal(completed.repo.snapshot,null);
  assert.equal(completed.sync.failureCount,1);
  assert.equal(completed.timers.filter(row=>row.value.state==="SCHEDULED").length,1);
  assert.ok(Date.parse(completed.sync.nextDueAt)>Date.parse(completed.repo.lastCheckedAt));
  report.facts.afterOffline={failureCode:completed.repo.lastFailure.code,
    nextDueAt:completed.sync.nextDueAt,scanSequence:completed.repo.scanSequence};
  report.checks.failedCheckPreservesStateAndSchedulesOneRetry=true;
  await h.client.script("Services.io.offline = false;");
  await h.closePage(probe);probe=null;
  await h.restart();
  assert.equal((await h.extension(PRODUCT)).id,PRODUCT);
  probe=await h.openPage(PRODUCT,"pcms/app/index.html");
  const restarted=await backup();
  assert.equal(restarted.sync.failureCount,1);
  assert.equal(restarted.repo.scanSequence,completed.repo.scanSequence);
  assert.equal(restarted.timers.filter(row=>row.value.state==="SCHEDULED").length,1);
  assert.equal(restarted.sync.nextDueAt,completed.sync.nextDueAt);
  report.facts.afterRestart={scanSequence:restarted.repo.scanSequence,nextDueAt:restarted.sync.nextDueAt};
  report.checks.restartPreservesBackoffWithoutDuplicateScan=true;
  report.passed=true;
}catch(error){
  report.passed=false;report.failure=String(error.stack||error);throw error;
}finally{
  try{await h?.client?.script("Services.io.offline = false;");}catch{}
  try{if(probe)await h.closePage(probe);}catch{}
  await h?.stop();
  await writeJson(reportPath,report);
  if(h)await rm(h.profilePath,{recursive:true,force:true});
}
console.log(JSON.stringify(report));
