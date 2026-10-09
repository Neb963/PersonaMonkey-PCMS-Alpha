// P035: packaged-XPI acceptance in exact pinned Firefox Developer Edition.
// No DevTools MCP, mocked browser APIs or provider access.
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileText, loadBrowserPin, sha256File, writeJson } from "../../../tools/firefox/lib.mjs";
import { PackagedFirefox, waitFor } from "../../../tools/firefox/packaged-harness.mjs";

const PRODUCT="persona-route-manager@local";
const root=resolve(process.env.FIREFOX_P035_ROOT||join(tmpdir(),"pcms-fde-p035"));
const reportPath=resolve(process.env.FIREFOX_P035_REPORT||join(root,"p035-report.json"));
const pin=await loadBrowserPin();
const manifest=JSON.parse(await readFile("extension/manifest.json","utf8"));
const xpi=resolve("dist/persona-route-manager-v"+manifest.version+".xpi");
const report={
  schemaVersion:1,phase:"P035",
  commitSha:process.env.GITHUB_SHA||(await execFileText("git",["rev-parse","HEAD"])).stdout.trim(),
  workflowRun:process.env.GITHUB_RUN_ID||null,
  browserVersion:pin.version,archiveSha256:pin.archive.sha256,
  xpiSha256:await sha256File(xpi),checks:{}
};
let h;
async function page(body,args=[]){
  const code='const done=arguments[arguments.length-1]; (async()=>{const api=window.wrappedJSObject.browser;'+body+'})().then(v=>done({ok:true,value:JSON.parse(JSON.stringify(v??null))}),e=>done({ok:false,error:String(e?.stack||e)}));';
  const result=await h.pageScript(code,args,{async:true});
  if(!result.ok)throw Error(result.error);
  return result.value;
}
const windows=async()=>{const r=await h.client.command("WebDriver:GetWindowHandles");return r.value??r;};
async function createManagedTab(){
  const before=await windows();
  const persona=await page('return api.runtime.sendMessage({type:"CREATE_PERSONA",input:{name:"P035 Firefox acceptance",routeId:"__block__"}});');
  const profile=persona?.profile??persona?.result?.profile;
  assert.match(profile?.personaUid||"",/^[0-9a-f-]{36}$/i,"PersonaMonkey generated the stable personaUid");
  assert.match(profile?.containerId||"",/^firefox-container-/,"PersonaMonkey created the managed container");
  const result=await page('return api.tabs.create({url:api.runtime.getURL("pcms/app/index.html"),cookieStoreId:arguments[0],active:true});',[profile.containerId]);
  assert.equal(result.cookieStoreId,profile.containerId);
  await waitFor(async()=> (await windows()).length > before.length,"managed tab added",20000);
  const handles=await windows();
  const next=handles.find(x=>!before.includes(x));
  assert.ok(next);
  await h.client.command("WebDriver:SwitchToWindow",{handle:next});
  await waitFor(()=>h.pageScript('return document.readyState==="complete" && !!document.getElementById("coreStatusPill");'),"managed dashboard loaded",20000);
  const ctx=await page('return api.runtime.sendMessage({type:"GET_ACTIVE_CONTEXT"});');
  assert.equal(ctx.profile.personaUid,profile.personaUid);
  assert.equal(ctx.profile.containerId,profile.containerId);
  report.checks.managedPersonaContext=true;
  return {profile,handle:next};
}
async function addAccount(personaUid){
  const list=await page('return api.runtime.sendMessage({type:"PCMS_UI_REQUEST",version:1,requestId:"p035-list",kind:"query",name:"accounts.listAccounts",params:{args:[]}});');
  assert.equal(list.ok,true,JSON.stringify(list.error));
  const accountId="p035-acceptance";
  const command=await page('return api.runtime.sendMessage({type:"PCMS_UI_REQUEST",version:1,requestId:"p035-create",kind:"command",name:"accounts.createAccount",idempotencyKey:"p035-account-create-001",params:{args:[{accountId:"p035-acceptance",displayName:"Firefox popup account",personaUid:arguments[0]},{expectedRevision:arguments[1]}]}});',[personaUid,list.result.revision]);
  assert.equal(command.ok,true,JSON.stringify(command.error));
  await waitFor(async()=>{
    const s=await page('return (await api.storage.session.get("pcms.status.v1"))["pcms.status.v1"];');
    return s?.personaAccounts?.some(x=>x.personaUid===personaUid && x.accounts?.some(y=>y.accountId===accountId));
  },"Core publishes Persona-account mapping",20000);
  report.checks.coreAccountStatusProjection=true;
  return accountId;
}
try {
  if(process.env.CI)assert.notEqual(process.env.MOZ_DISABLE_CONTENT_SANDBOX,"1","OS sandbox must remain enabled");
  await mkdir(root,{recursive:true});
  h=await PackagedFirefox.create({root:join(root,"profiles")});
  await h.start();
  assert.equal(await h.install(xpi),PRODUCT);
  await h.openPage(PRODUCT,"pcms/app/index.html");
  await waitFor(()=>h.pageScript('return document.getElementById("brokerLiveStatus")?.dataset.state==="connected";'),"initial PCMS dashboard",30000);
  const {profile}=await createManagedTab();
  const accountId=await addAccount(profile.personaUid);
  // Real popup document in a same-extension iframe of a managed Persona tab.
  // Native popup geometry is not asserted; this measures its intrinsic layout.
  await page('const frame=document.createElement("iframe");frame.id="p035-frame";frame.src=api.runtime.getURL("popup/popup.html");frame.style.cssText="width:370px;height:560px;border:0";document.body.append(frame);return true;');
  await waitFor(()=>h.pageScript('return document.getElementById("p035-frame")?.contentDocument?.getElementById("pcmsAccount")?.textContent==="Account: Firefox popup account";'),"popup displays linked account",20000);
  const snapshot=await h.pageScript('const d=document.getElementById("p035-frame").contentDocument; const block=d.getElementById("pcmsBlock"); return {state:d.getElementById("pcmsState").textContent,account:d.getElementById("pcmsAccount").textContent,linkHidden:d.getElementById("pcmsOpenAccount").hidden,attention:d.getElementById("pcmsAttention").textContent,bodyWidth:d.body.getBoundingClientRect().width,bodyPreferredWidth:getComputedStyle(d.body).width,documentScrollWidth:d.documentElement.scrollWidth,mainHeight:d.querySelector("main").getBoundingClientRect().height,mainMaxHeight:getComputedStyle(d.querySelector("main")).maxHeight,blockWidth:block.getBoundingClientRect().width,role:d.getElementById("pcmsState").getAttribute("role")};');
  assert.equal(snapshot.state,"Running");
  assert.equal(snapshot.account,"Account: Firefox popup account");
  assert.equal(snapshot.linkHidden,false);
  assert.equal(snapshot.bodyWidth,370);
  assert.equal(snapshot.bodyPreferredWidth,"370px");
  assert.equal(snapshot.mainMaxHeight,"560px");
  assert.ok(snapshot.mainHeight<=560,"popup height stays within budget");
  assert.ok(snapshot.documentScrollWidth<=370,"no horizontal overflow");
  assert.equal(snapshot.role,"status");
  report.checks.pinnedFirefoxIntrinsicPopupSizing=true;
  report.checks.pinnedFirefoxStatusAndAccountLink=true;
  report.facts={bodyWidth:snapshot.bodyWidth,mainHeight:snapshot.mainHeight,status:snapshot.state};
  const before=await windows();
  await h.pageScript('document.getElementById("p035-frame").contentDocument.getElementById("pcmsOpenAccount").click();');
  await waitFor(async()=>{
    const tabs=await page('return api.tabs.query({});');
    return tabs.some(tab=>tab.url?.endsWith("#/accounts/p035-acceptance"));
  },"popup navigates an existing dashboard to account",20000);
  assert.equal((await windows()).length,before.length,"reuses a PCMS tab without opening another");
  report.checks.pinnedFirefoxAccountDeepLinkReusesTab=true;
  report.facts.accountRoute="#/accounts/"+accountId;
  report.passed=true;
} catch(e){
  report.passed=false;
  report.failure=String(e?.stack||e);
  throw e;
} finally {
  await h?.stop();
  await writeJson(reportPath,report);
  if(h)await rm(h.profilePath,{recursive:true,force:true});
}
console.log(JSON.stringify(report));
