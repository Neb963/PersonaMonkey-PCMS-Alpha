// A032-02: actual packaged Firefox Developer Edition, not mocked Node UI state.
// Core and two dashboard tabs share the same extension context. A command in tab A
// must appear in tab B's action tray; after both tabs close and Core unloads, a
// newly opened dashboard must recover the same non-secret Core receipt.
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileText, loadBrowserPin, sha256File, writeJson } from "../../../tools/firefox/lib.mjs";
import { PackagedFirefox, waitFor } from "../../../tools/firefox/packaged-harness.mjs";

const PRODUCT="persona-route-manager@local";
const root=resolve(process.env.FIREFOX_PACKAGED_DIR||join(tmpdir(),"pcms-fde-p032"));
const reportPath=resolve(process.env.FIREFOX_P032_REPORT||join(root,"p032-report.json"));
const pin=await loadBrowserPin();
const manifest=JSON.parse(await readFile("extension/manifest.json","utf8"));
const xpi=resolve("dist/persona-route-manager-v"+manifest.version+".xpi");
const report={
  schemaVersion:1,phase:"P032",
  commitSha:process.env.GITHUB_SHA||(await execFileText("git",["rev-parse","HEAD"])).stdout.trim(),
  workflowRun:process.env.GITHUB_RUN_ID||null,
  version:pin.version,artifactSha256:pin.archive.sha256,
  productXpiSha256:await sha256File(xpi),checks:{},facts:{}
};
let h;
async function page(code,args=[]){
  const wrapper='const done=arguments[arguments.length-1]; (async()=>{const api=window.wrappedJSObject.browser;'+code+'})().then(value=>done({ok:true,value:JSON.parse(JSON.stringify(value??null))}),error=>done({ok:false,error:String(error&&error.stack||error)}));';
  const result=await h.pageScript(wrapper,args,{async:true});
  if(!result.ok)throw new Error(result.error);
  return result.value;
}
const switchTo=(handle)=>h.client.command("WebDriver:SwitchToWindow",{handle});
async function dashboard(){
  const handle=await h.openPage(PRODUCT,"pcms/app/index.html");
  await waitFor(()=>h.pageScript('return document.getElementById("brokerLiveStatus")?.dataset.state==="connected";'),
    "packaged P032 dashboard connects",30000);
  return handle;
}
async function receipts(){
  const response=await page('return api.runtime.sendMessage({type:"PCMS_UI_REQUEST",version:1,requestId:"p032-read-"+Date.now(),kind:"query",name:"uiReceipts.list",params:{args:[]}});');
  assert.equal(response.ok,true,"Core receipt read must succeed");
  assert.ok(Array.isArray(response.result?.receipts));
  return response.result.receipts;
}
async function trayIds(){
  return h.pageScript('return [...document.querySelectorAll("#actionTrayReceiptList [data-receipt-id]")].map(el=>el.dataset.receiptId);');
}
async function sendReceiptCommand(id){
  return page('const id=arguments[0];const result=await api.runtime.sendMessage({type:"PCMS_UI_REQUEST",version:1,requestId:"p032-command-"+id,kind:"command",name:"backupRestore.createBackup",idempotencyKey:id,params:{args:[{backupId:id}]}});return {ok:result.ok,receipt:result.receipt,error:result.error};',[id]);
}
async function expectTray(id,description){
  await waitFor(async()=>(await trayIds()).includes(id),description,30000);
  assert.equal((await trayIds()).filter(x=>x===id).length,1,"one visible row per receipt ID");
}

try{
  await mkdir(root,{recursive:true});
  h=await PackagedFirefox.create({root:join(root,"profiles-p032")});
  await h.start();
  assert.equal(await h.install(xpi),PRODUCT);
  const a=await dashboard();
  const b=await dashboard();
  const id="p032-fde-receipt-"+Date.now();

  await switchTo(a);
  const command=await sendReceiptCommand(id);
  assert.equal(command.ok,true,command.error?.code||"backup command failed");
  assert.equal(command.receipt?.receiptId,id);
  assert.equal(command.receipt?.status,"COMPLETED");
  await expectTray(id,"tab A re-queries its own Core receipt");
  report.checks.localTrayUsesDurableRead=true;

  await switchTo(b);
  await expectTray(id,"tab B receives revision and re-queries Core receipts");
  const remote=await receipts();
  assert.equal(remote.filter(x=>x.receiptId===id).length,1);
  const row=remote.find(x=>x.receiptId===id);
  assert.deepEqual(Object.keys(row),["receiptId","subject","status","recordedAt","completedAt"]);
  assert.equal(row.subject,"backupRestore.createBackup");
  assert.equal(row.status,"COMPLETED");
  report.checks.secondTabReceiptAndRedaction=true;

  await h.closePage(b);
  await h.closePage(a);
  report.unload=await h.forceIdleUnload(PRODUCT);
  assert.equal(report.unload.state,"stopped");
  report.checks.zeroDashboardTabsCoreUnload=true;

  const reopened=await dashboard();
  await expectTray(id,"reopened dashboard recovers durable receipt without replay");
  const persisted=await receipts();
  assert.equal(persisted.filter(x=>x.receiptId===id).length,1);
  report.checks.reopenedTrayHasSameDurableReceipt=true;
  await h.closePage(reopened);

  report.facts.receipt={receiptId:id,subject:row.subject,status:row.status};
  report.passed=true;
}catch(error){
  report.passed=false;
  report.failure=String(error&&error.stack||error);
  throw error;
}finally{
  await h?.stop();
  await writeJson(reportPath,report);
  if(h)await rm(h.profilePath,{recursive:true,force:true});
}
console.log(JSON.stringify(report));
