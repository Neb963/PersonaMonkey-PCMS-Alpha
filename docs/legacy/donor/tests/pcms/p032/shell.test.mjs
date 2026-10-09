import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("A032-01 v2 shell rehosts legacy views and moves diagnostics out of Overview",async()=>{
  const [html,app,css]=await Promise.all([
    readFile("extension/pcms/app/index.html","utf8"),
    readFile("extension/pcms/app/app.js","utf8"),
    readFile("extension/pcms/app/app.css","utf8")
  ]);
  assert.match(html,/id="viewDiagnostics"/);
  assert.match(html,/Settings → Diagnostics/);
  const overview=html.slice(html.indexOf('id="viewOverview"'),html.indexOf('id="viewModules"'));
  assert.doesNotMatch(overview,/id="namespaceVersion"|id="brokerVersion"|id="coreHostStatus"/);
  assert.match(app,/resolvePcmsRouteV2/);
  assert.match(app,/PCMS_V2_BUILTIN_MODULE_IDS/);
  assert.match(css,/grid-template-columns:220px minmax\(0,1fr\)/);
  assert.match(css,/\.primary-nav[\s\S]*flex-direction:column/);
});

test("A032-01 dashboard source constructs no Core or privileged service",async()=>{
  const files=["app.js","live-runtime.js","ui-client.js","live-controls.js"];
  const sources=await Promise.all(files.map((name)=>readFile("extension/pcms/app/"+name,"utf8")));
  const joined=sources.join("\n");
  assert.doesNotMatch(joined,/createPcmsCoreHost|createBackgroundPcmsCore|createPcmsLiveCore|new\s+StorageBroker|indexedDB\s*\.|browser\s*\.(tabs|contextualIdentities|proxy)|sendNativeMessage/);
  assert.match(joined,/pcms\.ui-client\/v1|createPcmsUiClient/);
});

test("A032-02 no global Working state remains and P026 workflows survive rehost on their P034/P040/P041 surfaces",async()=>{
  const [html,controls]=await Promise.all([
    readFile("extension/pcms/app/index.html","utf8"),
    readFile("extension/pcms/app/live-controls.js","utf8")
  ]);
  assert.doesNotMatch(controls,/["'`]Working…["'`]|["'`]Working\.\.\.["'`]/);
  const statusIndex=html.indexOf('id="liveActionStatus"');
  const mainIndex=html.indexOf('<main class="content">');
  assert.ok(statusIndex>0&&statusIndex<mainIndex);
  // P040 (A040-03): the rehosted P026 control IDs are superseded. Each workflow keeps exactly
  // one mount point: Accounts (P034), Settings → Backup & restore (P041) and the module page /
  // input dialog that serves the Provisioning page (P040).
  for(const id of ["accountsV2","settingsBackup","viewModulePage","moduleInputDialog"])
    assert.equal((html.match(new RegExp('id="'+id+'"',"g"))||[]).length,1,id);
  for(const id of [
    "accountCreatePersonaUid","accountRebindPersonaUid","provisioningLiveForm",
    "backupCreateForm","restoreApplyForm","recoveryReleaseForm"
  ]) assert.equal(html.includes('id="'+id+'"'),false,id);
  assert.match(html,/id="actionTrayDurableList"/);
  assert.match(html,/id="actionTrayReceiptList"/);
  assert.match(html,/id="actionTrayLocalList"/);
  const app=await readFile("extension/pcms/app/app.js","utf8");
  assert.match(app,/runtime\.uiReceipts\.list\(\)/);
  assert.match(app,/renderActionTray\(snapshot,receiptState\)/);
});

test("A032-03 shell refresh is revision-driven and does not drive operations with UI timers",async()=>{
  const app=await readFile("extension/pcms/app/app.js","utf8");
  assert.match(app,/runtime\.subscribe\(\(revision\)=>/);
  assert.match(app,/document\.body\.dataset\.pcmsRevision/);
  assert.match(app,/readPcmsCachedStatus/);
  assert.match(app,/presentPcmsCoreStatus/);
  assert.doesNotMatch(app,/setInterval\s*\(/);
});

test("A032-03 dashboard bootstrap is single-instance and unavailable Core retains Diagnostics navigation",async()=>{
  const app=await readFile("extension/pcms/app/app.js","utf8");
  assert.equal((app.match(/void bootPcmsApp\(\);/g)||[]).length,1,
    "duplicate boot registers multiple UI clients and listeners");
  assert.match(app,/mountUnavailablePcmsShell/);
  assert.match(app,/const unavailable=mountUnavailablePcmsShell\(\)/);
  assert.match(app,/viewDiagnostics/);
  assert.match(app,/control\.disabled=true/);
});
