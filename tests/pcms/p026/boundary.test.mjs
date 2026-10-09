import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// P040 (A040-03) removed the P026 legacy operator forms. Every assertion that pointed at a
// legacy form or at live-controls.js now points at the surface that replaced it, with the same
// intent: the workflow still exists, still goes through the accepted module service, and still
// carries no raw provider authority.
const LIVE_MUTATIONS="extension/pcms/integration/live-mutations.js";
const LIVE_CONTROLS="extension/pcms/app/live-controls.js";
const ACCOUNTS_VIEW="extension/pcms/app/views/accounts/accounts-view.js";
const GENERATORS_VIEW="extension/pcms/app/views/generators/generators-view.js";
const SETTINGS_VIEW="extension/pcms/app/views/settings/settings-view.js";
const EXPLORER_UI="pcms-modules/p016/ui.js";
const REFRESHER_UI="pcms-modules/p017/ui.js";
const REFRESHER="pcms-modules/p017/refresher.js";
const PROVISIONING_UI="pcms-modules/p019/ui.js";
const LEGACY_FORM_IDS=[
  "accountCreateForm","accountRebindForm","explorerLiveForm","deployerLiveForm","refresherLiveForm",
  "provisioningLiveForm","backupCreateForm","restoreApplyForm","recoveryReleaseForm",
  "accountCreatePersonaUid","accountRebindPersonaUid","backupPayload","recoveryStatus"
];

test("A026-01 live provider effects stay behind Persona Broker and explicit operator confirmation",async()=>{
  const source=await readFile(LIVE_MUTATIONS,"utf8");
  assert.match(source,/createPerchanceProviderAdapter/);
  assert.match(source,/client\.request\("persona\.open"/);
  assert.match(source,/operator\.choose/);
  assert.match(source,/allowDirect:true/);
  assert.doesNotMatch(source,/\bbrowser\s*\./);
  assert.doesNotMatch(source,/\bchrome\s*\./);
  assert.doesNotMatch(source,/nativeMessaging|sendNativeMessage|XMLHttpRequest|querySelector\s*\(|fetch\s*\(/);
});

test("A026-01 (superseded by A040-03) production controls exercise accepted PCMS modules instead of raw provider authority",async()=>{
  const owners=[
    [ACCOUNTS_VIEW,["runtime.accounts.createAccount","runtime.accounts.rebindPersona"]],
    [EXPLORER_UI,["explorer.recordDiscovery","explorer.claimCandidate"]],
    [GENERATORS_VIEW,["runtime.deployer.deploy","runtime.deployer.reconcileDeployment"]],
    [REFRESHER,["dispatchRefresh"]],
    [REFRESHER_UI,["refresher.refreshNow","refresher.reconcileRefresh"]],
    [PROVISIONING_UI,["provisioning.createAttempt","provisioning.advance"]],
    [SETTINGS_VIEW,["runtime.backupRestore.applyStagedRestore","runtime.backupRestore.reconcileAndRelease"]]
  ];
  for(const [path,calls] of owners){
    const source=await readFile(path,"utf8");
    for(const expected of calls) assert.match(source,new RegExp(expected.replaceAll(".","\\.")),path+" → "+expected);
    assert.doesNotMatch(source,/\bbrowser\s*\.|sendNativeMessage|XMLHttpRequest|fetch\s*\(/,path);
  }
  const controls=await readFile(LIVE_CONTROLS,"utf8");
  assert.doesNotMatch(controls,/\bbrowser\s*\.|sendNativeMessage|XMLHttpRequest|fetch\s*\(/);
  assert.doesNotMatch(controls,/LiveForm|createAccount|recordDiscovery|dispatchRefresh|createAttempt|applyStagedRestore/);
});

test("A026-02 (superseded by A040-03) recovery controls expose backup, previewed restore hold, and explicit release",async()=>{
  const html=await readFile("extension/pcms/app/index.html","utf8");
  const settings=await readFile(SETTINGS_VIEW,"utf8");
  assert.match(html,/id="settingsBackup"/);
  assert.match(settings,/createBackup/);
  assert.match(settings,/stageRestore/);
  assert.match(settings,/applyStagedRestore/);
  assert.match(settings,/reconcileAndRelease/);
  for(const id of LEGACY_FORM_IDS) assert.equal(html.includes('id="'+id+'"'),false,id);
});

test("A026-01 (superseded by A040-01/A040-03) account binding UI exposes live Personas and visible action feedback",async()=>{
  const [html,css,accounts,input,runtime]=await Promise.all([
    readFile("extension/pcms/app/index.html","utf8"),
    readFile("extension/pcms/app/app.css","utf8"),
    readFile(ACCOUNTS_VIEW,"utf8"),
    readFile("extension/pcms/app/action-input.js","utf8"),
    readFile("extension/pcms/app/live-runtime.js","utf8")
  ]);
  const statusIndex=html.indexOf('id="liveActionStatus"');
  const mainIndex=html.indexOf('<main class="content">');
  assert.ok(statusIndex>0&&statusIndex<mainIndex,"live action feedback must stay visible outside route-specific views");
  assert.equal((html.match(/id="accountsV2"/g)||[]).length,1);
  // Accounts lists live Personas through the read-only Broker proxy; module actions pick a
  // Persona from the same directory instead of typing a personaUid.
  assert.match(accounts,/command:"persona\.list"/);
  assert.match(runtime,/command:"persona\.list"/);
  assert.match(runtime,/page:Object\.freeze\(\{size:100/);
  assert.match(input,/runtime\.personaDirectory\.list\(\)/);
  assert.match(css,/\.live-form input, \.live-form textarea, \.live-form select/);
});


test("A026-03 PCMS app uses bounded startup retry instead of a one-shot live connection",async()=>{
  const app=await readFile("extension/pcms/app/app.js","utf8");
  const retry=await readFile("extension/pcms/app/startup-retry.js","utf8");
  assert.match(app,/startPcmsRuntimeWithRetry\(\{startRuntime:startPcmsLiveRuntime\}\)/);
  assert.match(retry,/PCMS_STARTUP_RETRY_DELAYS_MS/);
  assert.match(retry,/delays\.length>16/);
  assert.match(retry,/throw lastError/);
});
