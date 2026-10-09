// A039-01/02/03: exact pinned FDE, real product broker/execution; loopback provider.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {appendFile,mkdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {execFileText,loadBrowserPin,sha256File,writeJson} from "../../../tools/firefox/lib.mjs";
import {PackagedFirefox,waitFor} from "../../../tools/firefox/packaged-harness.mjs";
import {P039_FIXTURE_ID,P039_FIXTURE_PAGE,P039_ALARM_DELIVERY_DELAY_MS,buildP039FixtureExtension} from "./fixture-extension.mjs";
const PRODUCT="persona-route-manager@local";
const root=resolve(process.env.FIREFOX_PACKAGED_DIR||join(tmpdir(),"pcms-firefox-p039"));
const reportPath=resolve(process.env.FIREFOX_P039_REPORT||join(root,"p039-report.json"));
const pin=await loadBrowserPin(),manifest=JSON.parse(await readFile("extension/manifest.json","utf8"));
const xpi=resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report={schemaVersion:1,phase:"P039",commitSha:process.env.GITHUB_SHA||(await execFileText("git",["rev-parse","HEAD"])).stdout.trim(),
  workflowRun:process.env.GITHUB_RUN_ID||null,version:pin.version,artifactSha256:pin.archive.sha256,
  productXpiSha256:await sha256File(xpi),checks:{},facts:{},sourceState:process.env.CI?"actions-checkout":"local-worktree",
  contentSandboxDisabled:process.env.MOZ_DISABLE_CONTENT_SANDBOX==="1",
  worktreeDirty:Boolean((await execFileText("git",["status","--porcelain"])).stdout.trim())};
let h,server,denyProxy,probe,productTab,changed=false;
const requests=[],completions=[];
const escape=s=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
async function page(code,args=[]){
  const result=await h.pageScript(`const done=arguments[arguments.length-1];
    (async()=>{const api=window.wrappedJSObject.browser;${code}})().then(value=>done({ok:true,value:JSON.parse(JSON.stringify(value??null))}),
    error=>done({ok:false,error:String(error)+" | "+String(error&&error.stack||"")}));`,args,{async:true});
  if(!result.ok)throw new Error(result.error);return result.value;
}
const status=()=>page('return api.runtime.sendMessage({type:"p039-status"});');
try{
  if(process.env.CI)assert.notEqual(process.env.MOZ_DISABLE_CONTENT_SANDBOX,"1");
  await mkdir(root,{recursive:true});
  server=createServer((req,res)=>{
    requests.push({path:req.url,at:new Date().toISOString()});
    if(req.method==="POST"&&req.url==="/__p039_sweep_complete"){
      completions.push({at:new Date().toISOString()});res.writeHead(204);res.end();return;
    }
    const slug=req.url.slice(1),challenge=changed&&slug==="gamma";
    const code=changed&&slug==="beta"?"provider changed":"fixture source\n  exact bytes";
    res.writeHead(200,{"content-type":"text/html;charset=utf-8","cache-control":"no-store"});
    res.end(`<main data-pcms-observe="v1" data-generator="${escape(slug)}" data-is-private="false" data-challenge="${challenge}"><pre data-panel="code">${escape(code)}</pre><pre data-panel="html">&lt;h1&gt;fixture&lt;/h1&gt;</pre></main>`);
  });
  await new Promise(done=>server.listen(0,"127.0.0.1",done));
  const origin="http://127.0.0.1:"+server.address().port;
  // Fail-closed local proxy applies before Firefox starts, so even built-in
  // startup requests cannot contact an external service before Marionette's
  // parent observer is installed. Only loopback bypasses this rejecting proxy.
  denyProxy=createServer((_req,res)=>{res.writeHead(403,{"connection":"close"});res.end();});
  denyProxy.on("connect",(_req,socket)=>socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  await new Promise(done=>denyProxy.listen(0,"127.0.0.1",done));
  const proxyPort=denyProxy.address().port;
  h=await PackagedFirefox.create({root:join(root,"profiles")});
  await appendFile(join(h.profilePath,"user.js"),[
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.http", "127.0.0.1");',
    `user_pref("network.proxy.http_port", ${proxyPort});`,
    'user_pref("network.proxy.ssl", "127.0.0.1");',
    `user_pref("network.proxy.ssl_port", ${proxyPort});`,
    'user_pref("network.proxy.no_proxies_on", "127.0.0.1,localhost,[::1]");',
    'user_pref("network.proxy.failover_direct", false);',
    'user_pref("network.dns.disablePrefetch", true);',
    'user_pref("network.trr.mode", 5);'
  ].join("\n")+"\n");
  await h.start();
  // CI-only parent HTTP observer: all product and fixture requests are confined
  // to the exact loopback origin, including PersonaMonkey's catalog refreshes.
  await h.client.script(`const origin=arguments[0];
    Services.obs.addObserver({observe(subject){
      const channel=subject.QueryInterface(Components.interfaces.nsIHttpChannel);
      if(channel.URI.prePath!==origin)channel.cancel(Components.results.NS_ERROR_ABORT);
    }},"http-on-modify-request");`,[origin]);
  report.facts.networkIsolation={mode:"startup-rejecting-proxy-and-parent-http-observer",allowedOrigin:origin};
  assert.equal(await h.install(xpi),PRODUCT);
  productTab=await h.openPage(PRODUCT,"options/options.html");
  await waitFor(()=>h.pageScript('return !!document.getElementById("integrationEnabled")'),"PersonaMonkey security settings load");
  await waitFor(()=>page('try{return (await api.runtime.sendMessage({type:"GET_INTEGRATION_POLICY"}))?.policy??null;}catch{return null;}'),"product background is ready for reviewed changes");
  // Grant only the disposable fixture profile. Use the product's exact preview /
  // authorization / commit protocol for external execution and direct loopback.
  const policy={enabled:true,trustedExtensionIds:[P039_FIXTURE_ID],allowDirect:true,allowExternalAutomation:true,allowExecutableInstall:true};
  await page(`const policy=arguments[0];const preview=await api.runtime.sendMessage({type:"PREVIEW_INTEGRATION_POLICY",policy});
    const approved=await api.runtime.sendMessage({type:"AUTHORIZE_SECURITY_PREVIEW",previewId:preview.previewId,approvedDelta:preview.delta});
    return api.runtime.sendMessage({type:"UPDATE_INTEGRATION_POLICY",policy,authorizationId:approved.authorizationId});`,[policy]);
  const personaUid=await page(`await api.runtime.sendMessage({type:"CREATE_PERSONA",input:{name:"P039 fixture"}});
    const state=(await api.runtime.sendMessage({type:"GET_SNAPSHOT"})).state;
    const profile=Object.values(state.profiles).find(p=>p.name==="P039 fixture");
    profile.routeId="__direct__";profile.blockLocalNetwork=false;
    const preview=await api.runtime.sendMessage({type:"PREVIEW_STATE_CHANGE",state});
    const approved=await api.runtime.sendMessage({type:"AUTHORIZE_SECURITY_PREVIEW",previewId:preview.previewId,approvedDelta:preview.delta});
    await api.runtime.sendMessage({type:"COMMIT_STATE_PREVIEW",authorizationId:approved.authorizationId});return profile.personaUid;`);
  const fixture=await buildP039FixtureExtension({productXpi:xpi,workDir:join(root,"fixture-build"),origin,personaUid,
    backgroundSource:await readFile("tests/pcms/p039/fixture-background.js","utf8")});
  report.facts.fixture={copiedProductFiles:fixture.copiedFiles,productTreeDigest:fixture.digest,fixtureXpiSha256:await sha256File(fixture.xpi),alarmDeliveryDelayMs:P039_ALARM_DELIVERY_DELAY_MS};
  const permission=await h.client.script(`const done=arguments[arguments.length-1];
    const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
    const extension=WebExtensionPolicy.getByID(arguments[0]).extension;
    ExtensionPermissions.add(extension.id,{permissions:["userScripts"],origins:[]},extension).then(()=>done(true),error=>done({error:String(error)}));`,[PRODUCT],{async:true});
  assert.equal(permission,true);
  await h.closePage(productTab);productTab=null;
  // Reinitialize with the permission present without losing the HTTP isolation
  // observer. Normal disable/enable preserves the reviewed policy and profile.
  const reenabled=await h.client.script(`const done=arguments[arguments.length-1];
    const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    AddonManager.getAddonByID(arguments[0]).then(async addon=>{
      await addon.disable();await addon.enable();return true;
    }).then(done,error=>done({error:String(error)}));`,[PRODUCT],{async:true});
  assert.equal(reenabled,true);
  productTab=await h.openPage(PRODUCT,"options/options.html");
  await waitFor(()=>page('try{return (await api.runtime.sendMessage({type:"GET_INTEGRATION_POLICY"}))?.policy?.enabled??false;}catch{return false;}'),
    "reviewed execution policy survives add-on reinitialization");
  await h.closePage(productTab);productTab=null;
  assert.equal(await h.install(fixture.xpi),P039_FIXTURE_ID);
  probe=await h.openPage(P039_FIXTURE_ID,P039_FIXTURE_PAGE);
  const seeded=await waitFor(async()=>{const s=await status();if(s?.error)throw new Error(s.error);return s?.seed&&s.timers.some(t=>t.state==="SCHEDULED")?s:null;},"real broker verifies fixture and schedules bounded sweep",45000);
  assert.equal(seeded.reads.length,1);assert.equal(seeded.reads[0].slug,"alpha");
  assert.equal(seeded.deployments.find(d=>d.slug==="alpha").status.observation.payloadHash,seeded.seed.baselineHash);
  assert.deepEqual(seeded.control.queue,["gen:beta","gen:gamma"]);assert.equal(seeded.storedContent,false);
  const dueAt=Date.parse(seeded.timers.find(t=>t.state==="SCHEDULED").dueAt);assert.ok(dueAt-Date.now()>15000);
  report.checks.realExecutionArtifactVerifiedExactPanels=true;
  report.facts.seeded={baselineHash:seeded.seed.baselineHash,queue:seeded.control.queue,dueAt:new Date(dueAt).toISOString()};
  changed=true;await h.closePage(probe);probe=null;
  const unloadedAt=Date.now();report.facts.unload=await h.forceIdleUnload(P039_FIXTURE_ID);
  assert.equal(report.facts.unload.state,"stopped");
  // Two spaced reads complete with no extension page open; opening the probe
  // afterward is read-only inspection, not the source of the alarm wake.
  await waitFor(async()=>completions.length&&(await h.extension(P039_FIXTURE_ID)).state==="running",
    "the zero-tab alarm completes the delayed sweep and durable challenge transition",90000);
  const probeOpenedAt=Date.now();probe=await h.openPage(P039_FIXTURE_ID,P039_FIXTURE_PAGE);
  const after=await waitFor(async()=>{const s=await status();if(s?.error)throw new Error(s.error);return s.attention?.length?s:null;},"challenge task is durable",20000);
  const beta=after.deployments.find(d=>d.slug==="beta");
  report.facts.zeroTabInterval={unloadedAt:new Date(unloadedAt).toISOString(),probeOpenedAt:new Date(probeOpenedAt).toISOString(),completionReceiptAt:completions[0].at};
  report.facts.after={reads:after.reads,starts:after.starts,queue:after.control.queue,paused:beta.policy,taskCount:after.attention.length};
  assert.deepEqual(after.reads.map(r=>r.slug),["alpha","beta","gamma"]);
  assert.ok(Date.parse(after.reads[2].at)-Date.parse(after.reads[1].at)>=10000);
  assert.ok(after.reads.slice(1).every(r=>Date.parse(r.at)>unloadedAt&&Date.parse(r.at)<probeOpenedAt));
  assert.ok(after.starts.some(s=>Date.parse(s.at)>unloadedAt&&Date.parse(s.at)<probeOpenedAt));
  assert.ok(Date.parse(completions[0].at)>unloadedAt&&Date.parse(completions[0].at)<=probeOpenedAt);
  assert.equal(beta.status.drift,true);assert.equal(beta.policy.pauseReason,"DRIFT");
  assert.equal(after.attention.length,1);assert.equal(after.attention[0].taskKind,"provider.observation-challenge");
  assert.ok(!after.timers.some(t=>t.state==="SCHEDULED"));assert.deepEqual(after.control.queue,["gen:gamma"]);
  assert.equal(after.operations.length,3);assert.ok(after.operations.every(op=>op.state==="SUCCEEDED"));assert.equal(after.storedContent,false);
  report.checks.zeroTabAlarmWake=true;report.checks.oldestFirstLimitAndDurableSpacing=true;
  report.checks.realFixtureDriftPausedWithoutOverwrite=true;report.checks.oneChallengeTaskStopsSweep=true;report.checks.hashOnlyDurableState=true;
  // Reconstructing the event page cannot create a duplicate challenge or read.
  await h.closePage(probe);probe=null;await h.forceIdleUnload(P039_FIXTURE_ID);
  probe=await h.openPage(P039_FIXTURE_ID,P039_FIXTURE_PAGE);const restarted=await status();
  assert.equal(restarted.attention.length,1);assert.equal(restarted.reads.length,3);
  report.checks.challengeSurvivesUnloadWithoutDuplicate=true;report.passed=true;
}catch(error){
  report.passed=false;report.failure=String(error.stack||error);
  report.browserStderr=h?.stderr?.slice(-4000)??null;
  report.fixtureRequests=requests;
  try{report.fixtureConsole=await h.client.script(`return Services.console.getMessageArray().filter(m=>/userscript|ReferenceError|SyntaxError|automationSignal/i.test(m.message??m.errorMessage??""))
    .slice(-20).map(m=>String(m.message??m.errorMessage??""));`);}catch{}
  try{report.currentUrl=await h.pageScript("return location.href;");}catch{}
  try{
    await h.openPage(PRODUCT,"options/options.html");
    report.fixtureTaskErrors=await page(`const data=await api.storage.local.get("automationJobs");
      return Object.values(data.automationJobs??{}).flatMap(job=>(job.tasks??[]).map(task=>({state:task.state,error:task.error})));`);
    report.fixtureMetadata=await page(`const {state}=await api.storage.local.get("state");return {
      profiles:Object.values(state?.profiles??{}).filter(p=>p.name==="P039 fixture").map(p=>({id:p.containerId,managed:p.managed,routeId:p.routeId,blockLocalNetwork:p.blockLocalNetwork})),
      scripts:Object.values(state?.scripts??{}).map(s=>({id:s.id,name:s.name,enabled:s.enabled,runAt:s.runAt,matches:s.matches,profileIds:s.profileIds,autoRun:s.autoRun}))};`);
  }catch(diagnostic){report.diagnosticError=String(diagnostic);}
  throw error;
}
finally{
  await h?.stop();await new Promise(done=>server?server.close(done):done());
  denyProxy?.closeAllConnections();await new Promise(done=>denyProxy?denyProxy.close(done):done());
  await writeJson(reportPath,report);
  if(h)await rm(h.profilePath,{recursive:true,force:true});
}
console.log(JSON.stringify(report));
