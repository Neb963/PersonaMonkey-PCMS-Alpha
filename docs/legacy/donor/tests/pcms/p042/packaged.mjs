// A042-02/A042-03: exact pinned FDE; the shipped live-mutation wiring dispatches a repository
// release unattended through the real PersonaMonkey broker as an execution artifact under a
// control lease, woken only by its durable timer alarm with zero extension pages open, and
// post-apply verification reads the loopback fixture editor back. Real Perchance stays gated.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {appendFile,mkdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {execFileText,loadBrowserPin,sha256File,writeJson} from "../../../tools/firefox/lib.mjs";
import {PackagedFirefox,waitFor} from "../../../tools/firefox/packaged-harness.mjs";
import {P042_FIXTURE_ID,P042_FIXTURE_PAGE,P042_ALARM_DELIVERY_DELAY_MS,buildP042FixtureExtension} from "./fixture-extension.mjs";
const PRODUCT="persona-route-manager@local";
const root=resolve(process.env.FIREFOX_PACKAGED_DIR||join(tmpdir(),"pcms-firefox-p042"));
const reportPath=resolve(process.env.FIREFOX_P042_REPORT||join(root,"p042-report.json"));
const pin=await loadBrowserPin(),manifest=JSON.parse(await readFile("extension/manifest.json","utf8"));
const xpi=resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report={schemaVersion:1,phase:"P042",commitSha:process.env.GITHUB_SHA||(await execFileText("git",["rev-parse","HEAD"])).stdout.trim(),
  workflowRun:process.env.GITHUB_RUN_ID||null,version:pin.version,artifactSha256:pin.archive.sha256,
  productXpiSha256:await sha256File(xpi),checks:{},facts:{},sourceState:process.env.CI?"actions-checkout":"local-worktree",
  contentSandboxDisabled:process.env.MOZ_DISABLE_CONTENT_SANDBOX==="1",
  worktreeDirty:Boolean((await execFileText("git",["status","--porcelain"])).stdout.trim())};
let h,server,denyProxy,probe,productTab;
const requests=[],completions=[],saves=[];
const CODE="automatic fixture source\n  exact bytes 雪",HTML="<h1>deployed by PCMS</h1>";
// The loopback "provider": one editor page per generator and a save endpoint with receipts.
const editor=new Map([["alpha",{code:"old fixture source",html:"<p>old</p>",isPrivate:false,receipts:[]}]]);
const escape=s=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const EDITOR_SCRIPT=`const main=document.querySelector("main");
main.querySelector('[data-action="save"]').addEventListener("click",async()=>{
  const value=selector=>main.querySelector(selector);const op=value('[data-field="operation"]').value;
  const response=await fetch("/__save/"+main.dataset.generator,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({operationId:op,code:value('[data-panel="code"]').value,html:value('[data-panel="html"]').value,
      thumbnail:value('[data-panel="thumbnail"]').value||null,isPrivate:value('[data-setting="isPrivate"]').checked})});
  main.dataset.saveState=(response.ok?"saved:":"rejected:")+op;
});`;
function page(slug){
  const g=editor.get(slug);
  if(!g)return `<!doctype html><meta charset="utf-8"><main data-pcms-observe="v1" data-pcms-editor="v1" data-generator="${escape(slug)}" data-exists="false" data-challenge="false"></main>`;
  return `<!doctype html><meta charset="utf-8"><main data-pcms-observe="v1" data-pcms-editor="v1" data-generator="${escape(slug)}" data-exists="true"
 data-challenge="false" data-is-private="${g.isPrivate}" data-receipts="${escape(g.receipts.join(" "))}"><textarea data-panel="code">${escape(g.code)}</textarea><textarea data-panel="html">${escape(g.html)}</textarea><input type="hidden" data-panel="thumbnail" value=""><input type="checkbox" data-setting="isPrivate"${g.isPrivate?" checked":""}><input type="hidden" data-field="operation" value=""><button type="button" data-action="save">Save</button></main><script>${EDITOR_SCRIPT}</script>`;
}
async function body(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks).toString("utf8");}
async function call(code,args=[]){
  const result=await h.pageScript(`const done=arguments[arguments.length-1];
    (async()=>{const api=window.wrappedJSObject.browser;${code}})().then(value=>done({ok:true,value:JSON.parse(JSON.stringify(value??null))}),
    error=>done({ok:false,error:String(error)+" | "+String(error&&error.stack||"")}));`,args,{async:true});
  if(!result.ok)throw new Error(result.error);return result.value;
}
const status=()=>call('return api.runtime.sendMessage({type:"p042-status"});');
try{
  if(process.env.CI)assert.notEqual(process.env.MOZ_DISABLE_CONTENT_SANDBOX,"1");
  await mkdir(root,{recursive:true});
  server=createServer(async(req,res)=>{
    requests.push({method:req.method,path:req.url,at:new Date().toISOString()});
    if(req.method==="POST"&&req.url==="/__p042_pass_complete"){completions.push({at:new Date().toISOString()});res.writeHead(204);res.end();return;}
    if(req.method==="POST"&&req.url.startsWith("/__save/")){
      const slug=req.url.slice(8),g=editor.get(slug);let input=null;try{input=JSON.parse(await body(req));}catch{}
      if(!g||typeof input?.operationId!=="string"||!input.operationId){res.writeHead(409);res.end();return;}
      Object.assign(g,{code:input.code,html:input.html,isPrivate:input.isPrivate===true});g.receipts.push(input.operationId);
      saves.push({slug,operationId:input.operationId,at:new Date().toISOString(),thumbnail:input.thumbnail});
      res.writeHead(204);res.end();return;
    }
    res.writeHead(200,{"content-type":"text/html;charset=utf-8","cache-control":"no-store"});
    res.end(page(decodeURIComponent(req.url.slice(1))));
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
  await waitFor(()=>call('try{return (await api.runtime.sendMessage({type:"GET_INTEGRATION_POLICY"}))?.policy??null;}catch{return null;}'),"product background is ready for reviewed changes");
  // Grant only the disposable fixture profile. Use the product's exact preview /
  // authorization / commit protocol for external execution and direct loopback.
  const policy={enabled:true,trustedExtensionIds:[P042_FIXTURE_ID],allowDirect:true,allowExternalAutomation:true,allowExecutableInstall:true};
  await call(`const policy=arguments[0];const preview=await api.runtime.sendMessage({type:"PREVIEW_INTEGRATION_POLICY",policy});
    const approved=await api.runtime.sendMessage({type:"AUTHORIZE_SECURITY_PREVIEW",previewId:preview.previewId,approvedDelta:preview.delta});
    return api.runtime.sendMessage({type:"UPDATE_INTEGRATION_POLICY",policy,authorizationId:approved.authorizationId});`,[policy]);
  const personaUid=await call(`await api.runtime.sendMessage({type:"CREATE_PERSONA",input:{name:"P042 fixture"}});
    const state=(await api.runtime.sendMessage({type:"GET_SNAPSHOT"})).state;
    const profile=Object.values(state.profiles).find(p=>p.name==="P042 fixture");
    profile.routeId="__direct__";profile.blockLocalNetwork=false;
    const preview=await api.runtime.sendMessage({type:"PREVIEW_STATE_CHANGE",state});
    const approved=await api.runtime.sendMessage({type:"AUTHORIZE_SECURITY_PREVIEW",previewId:preview.previewId,approvedDelta:preview.delta});
    await api.runtime.sendMessage({type:"COMMIT_STATE_PREVIEW",authorizationId:approved.authorizationId});return profile.personaUid;`);
  const fixture=await buildP042FixtureExtension({productXpi:xpi,workDir:join(root,"fixture-build"),origin,personaUid,
    backgroundSource:await readFile("tests/pcms/p042/fixture-background.js","utf8")});
  report.facts.fixture={copiedProductFiles:fixture.copiedFiles,productTreeDigest:fixture.digest,fixtureXpiSha256:await sha256File(fixture.xpi),alarmDeliveryDelayMs:P042_ALARM_DELIVERY_DELAY_MS};
  const permission=await h.client.script(`const done=arguments[arguments.length-1];
    const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
    const extension=WebExtensionPolicy.getByID(arguments[0]).extension;
    ExtensionPermissions.add(extension.id,{permissions:["userScripts"],origins:[]},extension).then(()=>done(true),error=>done({error:String(error)}));`,[PRODUCT],{async:true});
  assert.equal(permission,true);
  await h.closePage(productTab);productTab=null;
  const reenabled=await h.client.script(`const done=arguments[arguments.length-1];
    const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    AddonManager.getAddonByID(arguments[0]).then(async addon=>{
      await addon.disable();await addon.enable();return true;
    }).then(done,error=>done({error:String(error)}));`,[PRODUCT],{async:true});
  assert.equal(reenabled,true);
  productTab=await h.openPage(PRODUCT,"options/options.html");
  await waitFor(()=>call('try{return (await api.runtime.sendMessage({type:"GET_INTEGRATION_POLICY"}))?.policy?.enabled??false;}catch{return false;}'),
    "reviewed execution policy survives add-on reinitialization");
  await h.closePage(productTab);productTab=null;
  // The fixture add-on (not the product) holds the only PCMS automation profile.
  assert.equal(await h.install(fixture.xpi),P042_FIXTURE_ID);
  probe=await h.openPage(P042_FIXTURE_ID,P042_FIXTURE_PAGE);
  const seeded=await waitFor(async()=>{const s=await status();if(s?.error)throw new Error(s.error);
    return s?.seed&&s.timers.some(t=>t.state==="SCHEDULED"&&t.serviceName==="core.deployer-automatic")?s:null;},
    "real broker probe meets every provider gate and Automatic is on",45000);
  // A042-02: through the real broker every provider gate holds; only the operator's choice was missing.
  assert.deepEqual(seeded.seed.unmetBefore,["operator"]);
  assert.equal(seeded.automatic.enabled,true);assert.equal(seeded.automatic.ready,true);
  assert.equal(seeded.dispatches.length,0);assert.equal(seeded.reads.length,0);assert.equal(saves.length,0);
  const dueAt=Date.parse(seeded.timers.find(t=>t.state==="SCHEDULED"&&t.serviceName==="core.deployer-automatic").dueAt);
  assert.ok(dueAt-Date.now()>12000,"first automatic step is deferred past the unload");
  report.checks.automaticGatesMetThroughRealBroker=true;
  report.facts.seeded={payloadHash:seeded.seed.payloadHash,dueAt:new Date(dueAt).toISOString()};
  await h.closePage(probe);probe=null;
  const unloadedAt=Date.now();report.facts.unload=await h.forceIdleUnload(P042_FIXTURE_ID);
  assert.equal(report.facts.unload.state,"stopped");
  await waitFor(async()=>completions.length&&(await h.extension(P042_FIXTURE_ID)).state==="running",
    "the zero-tab automatic pass dispatches and verifies the release",120000);
  const probeOpenedAt=Date.now();probe=await h.openPage(P042_FIXTURE_ID,P042_FIXTURE_PAGE);
  const after=await status();if(after?.error)throw new Error(after.error);
  report.facts.zeroTabInterval={unloadedAt:new Date(unloadedAt).toISOString(),probeOpenedAt:new Date(probeOpenedAt).toISOString(),completionReceiptAt:completions[0].at};
  report.facts.after={reads:after.reads,dispatches:after.dispatches,steps:after.steps,starts:after.starts,operations:after.operations,
    deployment:{operation:after.deployment.operation,policy:after.deployment.policy,baselineHash:after.deployment.confirmed.baselineHash},
    broker:after.broker.map(b=>b.command),saves:saves.map(s=>({operationId:s.operationId,at:s.at}))};
  const inZeroTab=at=>Date.parse(at)>unloadedAt&&Date.parse(at)<probeOpenedAt;
  // A042-01/A042-03: exactly one unattended save, by this operation, with byte-exact content.
  assert.equal(saves.length,1);assert.equal(saves[0].operationId,after.deployment.operation.operationId);
  assert.equal(editor.get("alpha").code,CODE);assert.equal(editor.get("alpha").html,HTML);
  assert.equal(editor.get("alpha").isPrivate,false);assert.equal(saves[0].thumbnail,null);
  assert.ok(inZeroTab(saves[0].at));
  assert.equal(after.deployment.operation.status,"SUCCEEDED");
  assert.equal(after.deployment.confirmed.payloadHash,seeded.seed.payloadHash);
  assert.equal(after.deployment.confirmed.baselineHash,seeded.seed.payloadHash,"post-apply read verified the deployed bytes");
  assert.equal(after.observation.observation.method,"PROVIDER_READ");assert.equal(after.observation.drift,false);
  assert.deepEqual(after.operations.map(o=>o.state),["SUCCEEDED"]);
  // Existence read, then the spaced dispatch, then post-apply verification, all with zero tabs.
  assert.deepEqual(after.reads.map(r=>r.slug),["alpha","alpha"]);assert.ok(after.reads.every(r=>inZeroTab(r.at)));
  assert.equal(after.dispatches.length,1);assert.ok(inZeroTab(after.dispatches[0].at));
  const existence=after.steps.find(s=>s.status==="EXISTENCE_READ"),dispatched=after.steps.find(s=>s.status==="DISPATCHED");
  assert.ok(existence&&dispatched);assert.equal(dispatched.outcome,"APPLIED");
  assert.ok(Date.parse(after.dispatches[0].at)-Date.parse(after.reads[0].at)>=20000,"dispatches are spaced at least 20 seconds");
  assert.ok(after.starts.some(s=>inZeroTab(s.at)),"the alarm started the event page with zero tabs");
  // Every browser action was a leased PersonaMonkey execution: two reads and one deployment.
  const commands=after.broker.map(b=>b.command);
  assert.equal(commands.filter(c=>c==="execution.start").length,3);
  assert.equal(commands.filter(c=>c==="persona.control.acquire").length,commands.filter(c=>c==="persona.control.release").length);
  assert.equal(commands.filter(c=>c==="execution.input.commit").length,1);
  assert.ok(after.broker.every(b=>b.ok));
  assert.deepEqual(after.attention,[]);assert.equal(after.storedContent,false);
  report.checks.zeroTabAutomaticDispatch=true;report.checks.executionArtifactUnderLease=true;
  report.checks.byteExactFixtureDeploy=true;report.checks.postApplyVerification=true;report.checks.hashOnlyDurableState=true;
  // Reconstructing the event page never replays the deployment.
  await h.closePage(probe);probe=null;await h.forceIdleUnload(P042_FIXTURE_ID);
  probe=await h.openPage(P042_FIXTURE_ID,P042_FIXTURE_PAGE);
  const restarted=await waitFor(async()=>{const s=await status();if(s?.error)throw new Error(s.error);return s;},"fixture restarts",20000);
  assert.equal(restarted.dispatches.length,1);assert.equal(saves.length,1);
  assert.deepEqual(restarted.operations.map(o=>o.state),["SUCCEEDED"]);
  report.checks.noReplayAfterUnload=true;report.passed=true;
}catch(error){
  report.passed=false;report.failure=String(error.stack||error);
  report.browserStderr=h?.stderr?.slice(-4000)??null;
  report.fixtureRequests=requests.map(r=>({method:r.method,path:r.path.startsWith("/__save/")?"/__save/*":r.path,at:r.at}));
  try{report.fixtureConsole=await h.client.script(`return Services.console.getMessageArray().filter(m=>/userscript|ReferenceError|SyntaxError|TypeError|automationSignal|Persona/i.test(m.message??m.errorMessage??""))
    .slice(-30).map(m=>String(m.message??m.errorMessage??""));`);}catch{}
  try{if(!probe)probe=await h.openPage(P042_FIXTURE_ID,P042_FIXTURE_PAGE);const s=await status();
    report.fixtureStatus={steps:s.steps,reads:s.reads,dispatches:s.dispatches,broker:s.broker,automatic:s.automatic,
      deployment:s.deployment,operations:s.operations,attention:s.attention?.map(t=>t.taskKind),timers:s.timers};}catch(diagnostic){report.statusError=String(diagnostic);}
  try{
    await h.openPage(PRODUCT,"options/options.html");
    report.fixtureTaskErrors=await call(`const data=await api.storage.local.get("automationJobs");
      return Object.values(data.automationJobs??{}).flatMap(job=>(job.tasks??[]).map(task=>({state:task.state,error:task.error})));`);
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
