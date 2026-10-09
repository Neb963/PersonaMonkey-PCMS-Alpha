import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { captureBrowserScreenshot } from "./capture-browser-screenshot.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(repoRoot, "extension");
const tempRoot = mkdtempSync(join(tmpdir(), "persona-options-smoke-"));
cpSync(sourceRoot, tempRoot, { recursive: true });

const optionsPath = join(tempRoot, "options/options.html");
let html = readFileSync(optionsPath, "utf8");

const browserStub = `
<script>
(() => {
  window.__smokeErrors=[];
  window.addEventListener('error',(event)=>window.__smokeErrors.push('error: '+(event.error?.stack||event.message||'unknown')));
  window.addEventListener('unhandledrejection',(event)=>window.__smokeErrors.push('rejection: '+(event.reason?.stack||event.reason||'unknown')));
  const security={ready:true,privacySafe:true,networkPredictionSafe:true,webRTCSafe:true,proxyControl:'controlled_by_this_extension',lastProxyError:{at:new Date().toISOString(),message:'smoke proxy error'},lastBlock:{at:new Date().toISOString(),reason:'smoke-block',tabId:7,cookieStoreId:'missing-persona',url:'https://example.com/'}};
  let containers=[];
  const storageChangeListeners=[];
  let state={
    schemaVersion:2,
    global:{profileTargetCount:30,profileNamePrefix:'Persona',unmanagedPolicy:'direct',blockSpeculative:true,strictProxyVerification:true,enforcePrivacyControls:true,disableNetworkPrediction:true,webRTCMode:'proxy_only',autoReloadOnRouteChange:true,userscripts:{dependencyFetch:'direct',autoAssignImportedToAllProfiles:true,defaultInjectInto:'auto'},automation:{maxTabsTotal:40,maxTabsPerStep:20,maxJobRuntimeMinutes:60,historyLimit:100},mullvadNative:{enabled:true,autoStart:true,autoStopMinutes:15,requireReady:true}},
    profiles:{},routes:{},scripts:{},wireguardImports:[],
    workflows:{draft:{id:'draft',name:'No persona draft',enabled:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),steps:[{id:'step-1',profileId:'',urls:['https://example.com/'],concurrency:1,scriptIds:[],completion:{mode:'load',value:'',timeoutMs:60000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]}}
  };
  let integrationPolicy={enabled:false,trustedExtensionIds:[],allowDestructive:false,allowDirect:false,allowExternalAutomation:false,allowExecutableInstall:false};
  let integrationPolicyReadAttempts=0;
  let integrationLeaseReadAttempts=0;
  window.__smokeIntegrationPolicy=()=>structuredClone(integrationPolicy);
  window.__smokeIntegrationReadAttempts=()=>({policy:integrationPolicyReadAttempts,leases:integrationLeaseReadAttempts});
  let jobs=[{id:'job-smoke',workflowId:'draft',workflowName:'No persona draft',state:'running',createdAt:new Date(Date.now()-4000).toISOString(),startedAt:new Date(Date.now()-3500).toISOString(),finishedAt:null,currentStep:0,totalSteps:1,error:null,stepProgress:[{index:0,state:'running',profileId:'firefox-container-1',personaName:'Smoke Persona',route:{mode:'direct',id:null,name:'DIRECT',provider:'direct'},completion:{mode:'load',value:'',timeoutMs:60000},total:2,completed:1,failed:0,stopped:0,retrying:1,active:0,startedAt:new Date(Date.now()-3500).toISOString(),finishedAt:null}],tasks:[{id:'1-1',stepIndex:0,url:'https://example.com/',profileId:'firefox-container-1',personaName:'Smoke Persona',route:{mode:'direct',id:null,name:'DIRECT',provider:'direct'},completion:{mode:'load',value:'',timeoutMs:60000},retryPolicy:{maxRetries:2,retryDelayMs:1000},state:'retrying',attempts:1,attemptHistory:[{attempt:1,state:'failed',startedAt:new Date(Date.now()-2500).toISOString(),finishedAt:new Date(Date.now()-1500).toISOString(),tabId:7,error:'smoke task failure'}],nextRetryAt:new Date(Date.now()+1000).toISOString(),tabId:7,startedAt:new Date(Date.now()-2500).toISOString(),finishedAt:null,result:null,error:'smoke task failure'}]}];
  const snapshot=()=>({state:structuredClone(state),containers:structuredClone(containers),security:{...security},userScriptsGranted:true,mullvadNative:{installed:false,ready:false,error:'browser-smoke'}});
  window.__smokeState=()=>structuredClone(state);
  window.__smokeGetJobs=()=>structuredClone(jobs);
  window.__smokeSetJobs=(next)=>{jobs=structuredClone(next);};
  window.__smokeInstallProfileAndScript=()=>{
    if(!containers.some((item)=>item.cookieStoreId==='firefox-container-1'))containers.push({cookieStoreId:'firefox-container-1',name:'Smoke Persona',color:'blue',icon:'fingerprint'});
    state.profiles['firefox-container-1']={containerId:'firefox-container-1',managed:true,name:'Smoke Persona',routeId:'__direct__',killSwitch:true,blockLocalNetwork:true,domainMode:'any',allowedDomains:[],blockedDomains:[],scriptIds:['sig'],notes:'',owned:false};
    state.scripts.sig={id:'sig',name:'Signal helper',namespace:'',version:'1',description:'',author:'',homepageURL:'',supportURL:'',updateURL:'',downloadURL:'',icon:'',code:'// ==UserScript==\\n// @name Signal helper\\n// @match https://example.com/*\\n// @grant Persona.signal\\n// @inject-into content\\n// ==/UserScript==\\nPersona.complete({ok:true});',enabled:true,autoRun:true,matches:['https://example.com/*'],excludeMatches:[],includes:[],excludes:[],runAt:'document_idle',allFrames:false,injectInto:'content',world:'USER_SCRIPT',grants:['Persona.signal'],requires:[],resources:{},connects:[],tags:[],unwrap:false,profileIds:['firefox-container-1'],sourceURL:'',compatibility:{compatible:true,supported:['Persona.signal'],unsupported:[]},metaBlock:'',updatedAt:new Date().toISOString()};
  };
  window.__smokeInstallManyProfiles=(count)=>{
    for(let i=2;i<=count;i+=1){
      const id='firefox-container-'+i;
      const suffix=String(i).padStart(3,'0');
      const name=i===count?'Long persona '+('非常に長い名前-'.repeat(7))+suffix:'Persona '+suffix;
      if(!containers.some((item)=>item.cookieStoreId===id))containers.push({cookieStoreId:id,name,color:i%2?'blue':'purple',icon:'fingerprint'});
      state.profiles[id]={containerId:id,managed:true,name,routeId:i%3===0?'__block__':'__direct__',killSwitch:true,blockLocalNetwork:true,domainMode:'any',allowedDomains:[],blockedDomains:[],scriptIds:[],notes:'',owned:i%4===0};
    }
  };
  window.__smokeEmitStateChange=()=>storageChangeListeners.forEach((listener)=>listener({state:{newValue:structuredClone(state)}},'local'));
  window.__smokeDownloads=[];
  const localStorageData={automationJobs:Object.fromEntries(jobs.map((job)=>[job.id,structuredClone(job)]))};
  const syncStorageData={};
  const makeStorageArea=(store)=>({
    async get(keys){
      if(keys==null)return structuredClone(store);
      if(typeof keys==='string')return {[keys]:structuredClone(store[keys])};
      if(Array.isArray(keys))return Object.fromEntries(keys.map((key)=>[key,structuredClone(store[key])]));
      if(keys&&typeof keys==='object'){
        return Object.fromEntries(Object.entries(keys).map(([key,fallback])=>[
          key,Object.prototype.hasOwnProperty.call(store,key)?structuredClone(store[key]):structuredClone(fallback)
        ]));
      }
      return {};
    },
    async set(values){for(const [key,value] of Object.entries(values||{}))store[key]=structuredClone(value);},
    async remove(keys){for(const key of(Array.isArray(keys)?keys:[keys]))delete store[key];},
    async clear(){for(const key of Object.keys(store))delete store[key];}
  });
  const localStorageArea=makeStorageArea(localStorageData);
  const syncStorageArea=makeStorageArea(syncStorageData);
  let nextContextualIdentity=1000;
  const nativeCreateObjectURL=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(blob)=>{window.__smokeDownloads.push(blob);return nativeCreateObjectURL(blob);};
  HTMLAnchorElement.prototype.click=function(){};
  window.browser={
    runtime:{
      getManifest:()=>({version:'0.6.0'}),
      sendMessage:async(m)=>{
        if(m.type==='GET_SNAPSHOT')return snapshot();
        if(m.type==='PREVIEW_STATE_CHANGE')return {previewId:'smoke-state-preview',delta:[]};
        if(m.type==='GET_INTEGRATION_POLICY'){
          integrationPolicyReadAttempts++;
          if(integrationPolicyReadAttempts<3)throw new Error('Could not establish connection. Receiving end does not exist.');
          return {policy:structuredClone(integrationPolicy)};
        }
        if(m.type==='GET_EXTERNAL_AUTOMATION_CONTROL_LEASES'){
          integrationLeaseReadAttempts++;
          if(integrationLeaseReadAttempts<3)throw new Error('Could not establish connection. Receiving end does not exist.');
          return {leases:[]};
        }
        if(m.type==='PREVIEW_INTEGRATION_POLICY')return {previewId:'smoke-integration-preview',delta:[]};
        if(m.type==='UPDATE_INTEGRATION_POLICY'){
          integrationPolicy=structuredClone(m.policy||{});
          return {policy:structuredClone(integrationPolicy),bootId:'smoke-boot',revision:1};
        }
        if(m.type==='LIST_PERSONAS')return {personas:containers.map((container)=>({id:container.cookieStoreId,name:container.name,color:container.color,icon:container.icon,protection:state.profiles[container.cookieStoreId]?.managed?'active':'relaxed',health:{status:state.profiles[container.cookieStoreId]?.routeId==='__direct__'?'direct':'blocked',routeName:state.profiles[container.cookieStoreId]?.routeId==='__direct__'?'Direct network':'Block'}}))};
        if(m.type==='REFRESH_SECURITY')return {security:{...security}};
        if(m.type==='MULLVAD_LIST_ENTRIES')return {entries:[],selected_entry:''};
        if(m.type==='FETCH_MULLVAD_RELAYS')return {relays:[{hostname:'smoke-se1',ipv4_address:'10.64.0.2',port:1080,country:'Sweden',city:'Stockholm'}]};
        if(m.type==='LIST_AUTOMATION_JOBS')return {jobs:structuredClone(jobs)};
        if(m.type==='SAVE_STATE'){state=structuredClone(m.state);return {state:structuredClone(state),containers:structuredClone(containers),security:{...security}};}
        if(m.type==='CLEAR_AUTOMATION_JOBS'){jobs=[];return {jobs:[]};}
        if(m.type==='RUN_WORKFLOW')return {job:{id:'job-run'}};
        if(m.type==='STOP_AUTOMATION_JOB'){const job=jobs.find(j=>j.id===m.jobId);if(job)job.state='stopping';return {job:structuredClone(job)};}
        throw new Error('Unexpected smoke-test message: '+m.type);
      }
    },
    storage:{
      local:localStorageArea,
      sync:syncStorageArea,
      onChanged:{addListener(listener){storageChangeListeners.push(listener);}}
    },
    contextualIdentities:{
      async query(){return structuredClone(containers);},
      async create(details={}){
        const item={
          cookieStoreId:'firefox-container-smoke-'+nextContextualIdentity++,
          name:String(details.name||'Imported persona'),
          color:details.color||'blue',
          icon:details.icon||'fingerprint'
        };
        containers.push(item);
        return structuredClone(item);
      },
      async remove(cookieStoreId){
        const index=containers.findIndex((item)=>item.cookieStoreId===cookieStoreId);
        if(index>=0)containers.splice(index,1);
      }
    },
    permissions:{contains:async()=>true,request:async()=>true}
  };
})();
</script>`;

const smoke=`
<div id="browser-smoke-result" hidden>RUNNING</div>
<script type="module">
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(fn,label)=>{for(let i=0;i<220;i++){const value=fn();if(value)return value;await sleep(20);}throw new Error('timeout waiting for '+label+'; toast: '+(document.getElementById('toast')?.textContent||'')+'; browser errors: '+JSON.stringify(window.__smokeErrors||[]));};
const result=document.getElementById('browser-smoke-result');
const setSmokeStage=(stage)=>{document.body.dataset.smokeStage=stage;};
setSmokeStage('bootstrap');
const settleSyntheticDialog=(dialog,value)=>{
  const button=dialog?.querySelector('button[value="'+value+'"]');
  if(!dialog||!button)throw new Error('synthetic confirmation control missing for '+value);
  button.click();
  // Chrome --dump-dom does not always deliver the native <dialog> close event
  // deterministically. Dispatching it explicitly makes the synthetic browser
  // action deterministic; confirm-dialog.js settle() is idempotent if Chrome
  // already delivered the native event.
  if(dialog.open){try{dialog.close(value);}catch{}}
  dialog.dispatchEvent(new Event('close'));
  if(dialog.isConnected)throw new Error('synthetic confirmation did not settle after '+value);
};
const escapeSyntheticDialog=(dialog)=>{
  if(!dialog)throw new Error('confirmation dialog missing for Escape test');
  dialog.dispatchEvent(new Event('cancel',{cancelable:true}));
  if(dialog.open){try{dialog.close('cancel');}catch{}}
  dialog.dispatchEvent(new Event('close'));
  if(dialog.isConnected)throw new Error('Escape did not settle the confirmation dialog');
};
try{
  await import('./options.js');
  await import('./automations.js');
  await import('./diagnostics.js');
  const confirmModule=await import('./confirm-dialog.js');
  setSmokeStage('initial-load');
  await waitFor(()=>!document.body.classList.contains('options-loading'),'initial options load');
  if(document.getElementById('optionsMain')?.getAttribute('aria-busy')!=='false')throw new Error('initial load did not clear aria-busy');
  setSmokeStage('userscript-import-review');
  document.querySelector('[data-tab="scripts"]').click();
  const userscriptReviewCases=[
    {name:'page injection',code:'// ==UserScript==\\n// @name Page injection review\\n// @inject-into page\\n// ==/UserScript==\\n',world:'MAIN',mode:'page'},
    {name:'grant none',code:'// ==UserScript==\\n// @name Grant none review\\n// @grant none\\n// @inject-into auto\\n// ==/UserScript==\\n',world:'MAIN',mode:'auto'},
    {name:'grant none content override',code:'// ==UserScript==\\n// @name Content override review\\n// @grant none\\n// @inject-into content\\n// ==/UserScript==\\n',world:'USER_SCRIPT',mode:'content'}
  ];
  for(const testCase of userscriptReviewCases){
    const input=document.getElementById('scriptFile');
    const file=new File([testCase.code],testCase.name.replaceAll(' ','-')+'.user.js',{type:'text/javascript'});
    Object.defineProperty(input,'files',{configurable:true,value:[file]});
    input.dispatchEvent(new Event('change',{bubbles:true}));
    const dialog=await waitFor(()=>document.querySelector('dialog.confirmation-dialog[open]'),testCase.name+' import review');
    const disclosure=dialog.querySelector('.confirmation-dialog-message')?.textContent||'';
    if(!disclosure.includes('Execution world: '+testCase.world+' (injection mode: '+testCase.mode+')'))throw new Error(testCase.name+' import review omitted execution world or injection mode: '+disclosure);
    if(!disclosure.includes('High-impact grants: none detected'))throw new Error(testCase.name+' import review lost its grant-risk summary');
    settleSyntheticDialog(dialog,'cancel');
    await waitFor(()=>!document.querySelector('dialog.confirmation-dialog[open]'),testCase.name+' review cancellation');
  }
  const viewportParams=new URL(location.href).searchParams;
  const expectedViewport=viewportParams.get('viewport');
  const expectedWidth=Number(viewportParams.get('width')||0);
  if(expectedViewport==='mobile'){
    // Headless Chrome clamps --window-size below ~500 CSS px on Linux. The
    // contract we need is the real mobile CSS regime, whose tight breakpoint
    // is 560px, not an exact 390px CLI viewport.
    if(window.innerWidth>560)throw new Error('mobile smoke did not run inside the <=560px breakpoint: '+window.innerWidth);
  }else if(expectedWidth&&Math.abs(window.innerWidth-expectedWidth)>24){
    throw new Error(expectedViewport+' smoke did not run near the requested width '+expectedWidth+': '+window.innerWidth);
  }
  if(window.innerWidth<=699){
    if(getComputedStyle(document.querySelector('.tabs')).display!=='none')throw new Error('mobile navigation still exposes the horizontal tab strip');
    if(getComputedStyle(document.querySelector('.mobile-section-picker')).display==='none')throw new Error('mobile settings section picker is hidden');
  }else if(getComputedStyle(document.querySelector('.tabs')).display==='none'){
    throw new Error('desktop/tablet navigation unexpectedly hidden at '+window.innerWidth);
  }
  if(window.innerWidth<=560&&parseFloat(getComputedStyle(document.getElementById('refreshProfiles')).minHeight)<44)throw new Error('mobile action target is below 44px');

  const fullSmoke=expectedViewport==='wide';
  if(!fullSmoke){
    setSmokeStage('responsive-policy');
    const responsiveTabs=[...document.querySelectorAll('.tabs button[data-tab]')];
    const responsiveTabIds=responsiveTabs.map((button)=>button.dataset.tab);
    if(responsiveTabIds.join('|')!=='profiles|routes|cookies|scripts|automations|activity|security|backup')throw new Error('responsive settings navigation order is unexpected: '+responsiveTabIds.join('|'));
    if(responsiveTabs.some((button)=>!button.textContent.trim()))throw new Error('responsive settings navigation contains an unlabeled tab');
    const responsiveActiveTab=document.querySelector('.tabs button.active[data-tab]');
    const responsiveSelectedTabs=responsiveTabs.filter((button)=>button.getAttribute('aria-selected')==='true');
    if(document.querySelector('.tabs').getAttribute('role')!=='tablist'||responsiveActiveTab?.getAttribute('role')!=='tab'||responsiveSelectedTabs.length!==1||responsiveSelectedTabs[0]!==responsiveActiveTab)throw new Error('responsive settings tabs lack accessible selected-state semantics');
    if(!document.getElementById('mobileSectionNav')?.querySelector('optgroup[label="Operate"]'))throw new Error('responsive mobile section navigation is missing task groups');
    if(document.getElementById('advancedPersonaPolicy')?.open)throw new Error('advanced persona policy should start collapsed');

    document.querySelector('[data-tab="profiles"]').click();
    await waitFor(()=>document.getElementById('tab-profiles').classList.contains('active'),'responsive Personas tab');
    document.getElementById('advancedPersonaPolicy').open=true;
    window.__smokeInstallProfileAndScript();
    window.__smokeInstallManyProfiles(100);
    window.__smokeEmitStateChange();
    await waitFor(()=>document.querySelectorAll('#profilesTable tr[data-id]').length===100,'responsive 100-persona policy rendering');
    await waitFor(()=>document.querySelector('#profilesTable .export-profile'),'responsive decorated profile actions');

    const responsivePolicyWrap=document.getElementById('profilesTable');
    if(responsivePolicyWrap.scrollWidth>responsivePolicyWrap.clientWidth+2)throw new Error('responsive persona policy controls overflow horizontally');
    if(window.innerWidth<1100){
      const managedLabel=getComputedStyle(document.querySelector('#profilesTable .policy-managed'),'::before').display;
      const personaLabel=getComputedStyle(document.querySelector('#profilesTable .policy-persona'),'::before').display;
      if(managedLabel!=='none'||personaLabel!=='none')throw new Error('responsive persona policy duplicates Managed/Persona labels');
      const actionLabel=getComputedStyle(document.querySelector('#profilesTable .policy-actions'),'::before').display;
      if(window.innerWidth>=700&&actionLabel!=='none')throw new Error('tablet persona policy shows redundant Actions label');
      if(window.innerWidth<700&&actionLabel==='none')throw new Error('mobile persona policy lost its Actions label');
    }
    const responsiveLongPersona=await waitFor(()=>document.querySelector('#profilesTable tr[data-id="firefox-container-100"] .persona-identity-copy strong'),'responsive long persona decoration');
    if(!responsiveLongPersona.title.includes('Long persona'))throw new Error('responsive long persona identity lost its full title');
    const responsivePolicyAction=document.querySelector('#profilesTable .export-profile');
    const responsiveWrapRect=responsivePolicyWrap.getBoundingClientRect();
    const responsiveActionRect=responsivePolicyAction.getBoundingClientRect();
    if(responsiveActionRect.right>responsiveWrapRect.right+2||responsiveActionRect.left<responsiveWrapRect.left-2)throw new Error('responsive persona policy action is outside the visible surface');
  }

  if(fullSmoke){
  setSmokeStage('confirmations');
  const firstConfirm=confirmModule.confirmAction('First pending action');
  const secondConfirm=confirmModule.confirmAction('Replacement action');
  if(await firstConfirm!==false)throw new Error('superseded confirmation did not cancel its original caller');
  const activeConfirmations=[...document.querySelectorAll('dialog.confirmation-dialog[open]')];
  if(activeConfirmations.length!==1)throw new Error('stacked confirmation dialogs remained open');
  if(!activeConfirmations[0].textContent.includes('Replacement action'))throw new Error('replacement confirmation did not own the visible dialog');
  settleSyntheticDialog(activeConfirmations[0],'confirm');
  if(await secondConfirm!==true)throw new Error('replacement confirmation did not resolve its own caller');
  await sleep(20);
  if(document.querySelector('dialog.confirmation-dialog'))throw new Error('settled confirmation dialog was not removed');

  const tabButtons=[...document.querySelectorAll('.tabs button[data-tab]')];
  const tabIds=tabButtons.map((button)=>button.dataset.tab);
  if(tabIds.join('|')!=='profiles|routes|cookies|scripts|automations|activity|security|backup')throw new Error('top-level settings navigation order is not grouped as expected: '+tabIds.join('|'));
  if(tabButtons.some((button)=>!button.textContent.trim()))throw new Error('top-level settings navigation contains an unlabeled tab');
  const activeTabButton=document.querySelector('.tabs button.active[data-tab]');
  const selectedTabButtons=tabButtons.filter((button)=>button.getAttribute('aria-selected')==='true');
  if(document.querySelector('.tabs').getAttribute('role')!=='tablist'||activeTabButton?.getAttribute('role')!=='tab'||selectedTabButtons.length!==1||selectedTabButtons[0]!==activeTabButton)throw new Error('settings tabs lack accessible selected-state semantics');
  const activeSettingsPanel=activeTabButton ? document.getElementById('tab-'+activeTabButton.dataset.tab) : null;
  const inactiveSettingsPanels=[...document.querySelectorAll('.tab')].filter((panel)=>panel!==activeSettingsPanel);
  if(activeSettingsPanel?.getAttribute('role')!=='tabpanel'||activeSettingsPanel.getAttribute('aria-hidden')!=='false'||inactiveSettingsPanels.some((panel)=>panel.getAttribute('aria-hidden')!=='true'))throw new Error('settings panels lack accessible active/inactive semantics');
  if(!document.getElementById('mobileSectionNav')?.querySelector('optgroup[label="Operate"]'))throw new Error('mobile section navigation is missing task groups');
  if(document.getElementById('advancedPersonaPolicy')?.open)throw new Error('advanced persona policy should not dominate the default dashboard');
  setSmokeStage('security-and-integration-policy');
  document.querySelector('[data-tab="security"]').click();
  await waitFor(()=>document.getElementById('securityDetails').innerText.includes('Controlled by PersonaMonkey'),'humanized security state');
  if(document.getElementById('securityDetails').innerText.includes('controlled_by_this_extension'))throw new Error('raw proxy control enum leaked into primary security UI');
  if(!document.getElementById('saveSecurity').disabled)throw new Error('security Apply should be disabled with no changes');
  document.getElementById('blockSpeculative').click();
  if(document.getElementById('saveSecurity').disabled||!document.getElementById('securitySaveState').textContent.includes('Unsaved'))throw new Error('security edits did not expose unapplied state');
  const editedSecurityValue=document.getElementById('blockSpeculative').checked;
  document.getElementById('refreshSecurity').click();
  await waitFor(()=>document.getElementById('toast').textContent.includes('unsaved security changes'),'security runtime refresh preserving edits');
  if(document.getElementById('blockSpeculative').checked!==editedSecurityValue)throw new Error('runtime refresh overwrote unsaved security controls');
  document.getElementById('saveSecurity').click();
  await waitFor(()=>document.getElementById('saveSecurity').disabled,'security apply completion');
  if(!document.getElementById('securityApplyNotice').textContent.includes('Settings applied'))throw new Error('security applied/runtime relationship not restored after save');

  await waitFor(()=>document.getElementById('integrationPolicyStatus').textContent.includes('Policy loaded'),'integration policy load');
  await waitFor(()=>document.getElementById('integrationControlLeaseStatus').textContent.includes('Control status is local'),'integration lease status load');
  const integrationReadAttempts=window.__smokeIntegrationReadAttempts();
  if(integrationReadAttempts.policy<3||integrationReadAttempts.leases<3)throw new Error('integration startup reads did not exercise retry after transient missing receiver');
  if(document.getElementById('integrationEnabled').checked)throw new Error('external integration should load disabled by default');
  document.getElementById('integrationEnabled').checked=true;
  document.getElementById('integrationTrustedIds').value='pcms@example.test';
  document.getElementById('integrationAllowDirect').checked=true;
  document.getElementById('saveIntegrationPolicy').click();
  await waitFor(()=>document.getElementById('integrationPolicyStatus').textContent.includes('Policy saved'),'integration policy save');
  const savedIntegrationPolicy=window.__smokeIntegrationPolicy();
  if(!savedIntegrationPolicy.enabled||savedIntegrationPolicy.trustedExtensionIds[0]!=='pcms@example.test'||savedIntegrationPolicy.allowDirect!==true)throw new Error('integration policy editor did not persist the configured authority');

  document.querySelector('[data-tab="routes"]').click();
  await waitFor(()=>document.querySelector('#mullvadRelay option[value^="smoke-se1|"]'),'automatic Mullvad relay load');
  const routeCreateOptions=[...document.querySelectorAll('.route-create-option')];
  if(routeCreateOptions.length!==2||!routeCreateOptions[0].open||routeCreateOptions[1].open)throw new Error('route creation sources are not progressively disclosed');
  routeCreateOptions[1].open=true;await sleep(20);
  if(routeCreateOptions[0].open||!routeCreateOptions[1].open)throw new Error('route creation disclosures can compete simultaneously');
  routeCreateOptions[0].open=true;await sleep(20);
  if(routeCreateOptions[1].open)throw new Error('generic route disclosure did not close Mullvad setup');
  document.getElementById('routeHost').value='';
  document.getElementById('routePort').value='1080';
  document.getElementById('addGenericRoute').click();
  await waitFor(()=>document.getElementById('routeFormError')&&!document.getElementById('routeFormError').hidden,'persistent route validation');
  if(!document.getElementById('routeFormError').textContent.includes('host'))throw new Error('route validation did not explain the missing host');
  if(!document.getElementById('routeHost').getAttribute('aria-describedby')?.includes('routeFormError')||!document.getElementById('routeHost').getAttribute('aria-describedby')?.includes('routeHostHelp'))throw new Error('route validation/help is not associated with the invalid field');
  const toastNode=document.getElementById('toast');
  const toastModule=await import('./toast.js');
  toastModule.toast('smoke failure',true,5000);
  if(toastNode.getAttribute('role')!=='alert'||toastNode.getAttribute('aria-live')!=='assertive'||toastNode.getAttribute('aria-atomic')!=='true')throw new Error('error toast is not assertive/atomic');
  if(getComputedStyle(toastNode).opacity!=='1'||getComputedStyle(toastNode).visibility!=='visible')throw new Error('fresh toast is not immediately visible');
  toastNode.click();
  if(toastNode.textContent)throw new Error('toast click did not dismiss feedback');

  document.querySelector('[data-tab="automations"]').click();
  await sleep(80);
  if(!document.getElementById('tab-automations').classList.contains('active'))throw new Error('Automations tab did not activate');
  const workflowLayout=document.querySelector('#tab-automations .scripts-layout');
  const packagePanel=document.getElementById('workflowPackagePanel');
  if(!packagePanel||packagePanel.open)throw new Error('workflow packages should be secondary and collapsed initially');
  if(packagePanel.compareDocumentPosition(workflowLayout)&Node.DOCUMENT_POSITION_FOLLOWING)throw new Error('workflow package panel appears before everyday workflow controls');
  const workflowFilter=document.getElementById('workflowFilter');
  if(!workflowFilter)throw new Error('workflow filter missing');
  workflowFilter.value='No persona';workflowFilter.dispatchEvent(new Event('input',{bubbles:true}));
  if(document.querySelectorAll('#workflowList [data-workflow-id]').length!==1)throw new Error('workflow filter did not narrow the list');
  workflowFilter.value='definitely-not-a-workflow';workflowFilter.dispatchEvent(new Event('input',{bubbles:true}));
  if(!document.getElementById('workflowList').innerText.includes('No workflows match'))throw new Error('workflow filtered empty state missing');
  workflowFilter.value='';workflowFilter.dispatchEvent(new Event('input',{bubbles:true}));
  const workflowButton=await waitFor(()=>document.querySelector('#workflowList [data-workflow-id="draft"]'),'workflow list');
  workflowButton.click();
  await waitFor(()=>document.querySelector('#workflowList [data-workflow-id="draft"][aria-pressed="true"]'),'selected workflow semantic state');
  await waitFor(()=>document.querySelector('#workflowSteps .workflow-step'),'selected workflow editor');
  if(!document.getElementById('workflowPersonaNotice'))throw new Error('no-persona notice missing');
  if(!document.getElementById('workflowValidation').innerText.includes('choose a persona'))throw new Error('validation did not explain missing persona');
  const personaIssue=document.querySelector('.workflow-validation-link');
  if(!personaIssue)throw new Error('workflow validation issue is not actionable');
  personaIssue.click();
  if(document.activeElement!==document.querySelector('.wfProfile')||document.querySelector('.wfProfile').getAttribute('aria-invalid')!=='true')throw new Error('workflow validation did not focus and mark offending field');

  const scriptAssignment=document.querySelector('.workflow-script-assignment');
  if(!scriptAssignment||scriptAssignment.open)throw new Error('workflow script assignment should be collapsed until needed');
  scriptAssignment.open=true;
  const completion=document.querySelector('.wfCompletion');
  const completionValue=document.querySelector('.wfCompletionValue');
  if(!completionValue.disabled)throw new Error('page-load completion value should be disabled');
  completion.value='delay';
  completion.dispatchEvent(new Event('change',{bubbles:true}));
  if(completionValue.disabled||completionValue.type!=='number')throw new Error('delay completion value was not enabled as numeric input');
  completionValue.value='5000';
  document.querySelector('.wfRetryDelay').value='2500';

  document.getElementById('addWorkflowStep').click();
  await sleep(60);
  if(document.querySelectorAll('#workflowSteps .workflow-step').length!==2)throw new Error('Add step failed');
  document.querySelectorAll('#workflowSteps .move-step[data-direction="-1"]')[1].click();
  await sleep(40);
  if(document.querySelectorAll('.wfCompletion')[1]?.value!=='delay')throw new Error('configured step was not preserved when moved down');
  document.querySelectorAll('#workflowSteps .move-step[data-direction="1"]')[0].click();
  await sleep(40);
  if(document.querySelectorAll('.wfCompletion')[0]?.value!=='delay')throw new Error('configured step was not preserved when moved back');
  document.querySelectorAll('#workflowSteps .remove-step')[1].click();
  await sleep(60);
  if(document.querySelectorAll('#workflowSteps .workflow-step').length!==1)throw new Error('Remove step failed');
  document.getElementById('saveWorkflow').click();
  await sleep(100);
  if(document.querySelector('.wfCompletion')?.value!=='delay'||document.querySelector('.wfCompletionValue')?.value!=='5000')throw new Error('saved delay completion was not retained');
  if(document.querySelector('.wfRetryDelay')?.value!=='2500')throw new Error('retry delay was not retained');

  setSmokeStage('persona-policy');
  document.querySelector('[data-tab="profiles"]').click();
  await waitFor(()=>document.getElementById('tab-profiles').classList.contains('active'),'Personas tab before advanced policy checks');
  document.getElementById('advancedPersonaPolicy').open=true;
  window.__smokeInstallProfileAndScript();
  window.__smokeEmitStateChange();
  await waitFor(()=>document.querySelector('#profilesTable tr[data-id="firefox-container-1"]'),'cross-tab storage reconciliation');
  await waitFor(()=>!document.getElementById('profileDirectNotice').classList.contains('hidden'),'direct policy warning');
  if(!document.getElementById('profileDirectNotice').textContent.includes('Direct network'))throw new Error('advanced policy does not warn about Direct personas');
  const policyTable=document.querySelector('.profiles-policy-table');
  if(!policyTable)throw new Error('responsive persona policy table class missing');
  await waitFor(()=>document.querySelector('#profilesTable .export-profile'),'decorated profile row actions');
  window.__smokeInstallManyProfiles(100);
  window.__smokeEmitStateChange();
  await waitFor(()=>document.querySelectorAll('#profilesTable tr[data-id]').length===100,'100-persona policy rendering');
  const policyWrap=document.getElementById('profilesTable');
  if(policyWrap.scrollWidth>policyWrap.clientWidth+2)throw new Error('persona policy controls overflow horizontally at smoke viewport');
  if(window.innerWidth<1100){
    const managedLabel=getComputedStyle(document.querySelector('#profilesTable .policy-managed'),'::before').display;
    const personaLabel=getComputedStyle(document.querySelector('#profilesTable .policy-persona'),'::before').display;
    if(managedLabel!=='none'||personaLabel!=='none')throw new Error('responsive persona policy duplicates Managed/Persona labels');
    const actionLabel=getComputedStyle(document.querySelector('#profilesTable .policy-actions'),'::before').display;
    if(window.innerWidth>=700&&actionLabel!=='none')throw new Error('tablet persona policy shows redundant Actions label');
    if(window.innerWidth<700&&actionLabel==='none')throw new Error('mobile persona policy lost its Actions label');
  }
  const longPersonaRow=await waitFor(()=>document.querySelector('#profilesTable tr[data-id="firefox-container-100"] .persona-identity-copy strong'),'long persona decoration');
  if(!longPersonaRow.title.includes('Long persona'))throw new Error('long persona identity lost its full accessible/title value');
  const policyAction=document.querySelector('#profilesTable .export-profile');
  const wrapRect=policyWrap.getBoundingClientRect();
  const actionRect=policyAction.getBoundingClientRect();
  if(actionRect.right>wrapRect.right+2||actionRect.left<wrapRect.left-2)throw new Error('persona policy action is outside the visible policy surface');
  const directRow=document.querySelector('#profilesTable tr[data-id="firefox-container-3"]');
  const directSelect=directRow?.querySelector('.profile-route');
  if(!directSelect)throw new Error('direct-route regression fixture is missing');
  directSelect.focus();
  if(document.activeElement!==directSelect)throw new Error('Direct route fixture did not accept focus before confirmation');
  directSelect.value='__direct__';
  directSelect.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor(()=>document.querySelector('dialog.confirmation-dialog[open]'),'Direct route confirmation');
  if(!directSelect.disabled)throw new Error('Direct route select was not disabled while confirmation was open');
  if(directSelect.value!=='__block__')throw new Error('Direct route changed before confirmation');
  settleSyntheticDialog(document.querySelector('dialog.confirmation-dialog[open]'),'cancel');
  await waitFor(()=>!document.querySelector('dialog.confirmation-dialog[open]'),'Direct route cancellation');
  await sleep(20);
  if(directSelect.value!=='__block__')throw new Error('cancelling Direct route did not restore the previous route');
  if(directSelect.disabled)throw new Error('Direct route select stayed disabled after cancellation');
  if(document.activeElement!==directSelect)throw new Error('Direct route cancellation did not restore focus to the route select');
  directSelect.value='__direct__';
  directSelect.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor(()=>document.querySelector('dialog.confirmation-dialog[open]'),'Escape-path Direct route confirmation');
  escapeSyntheticDialog(document.querySelector('dialog.confirmation-dialog[open]'));
  await waitFor(()=>!document.querySelector('dialog.confirmation-dialog[open]'),'Escape cancellation');
  await sleep(20);
  if(directSelect.value!=='__block__'||directSelect.disabled)throw new Error('Escape did not cancel Direct routing and re-enable its select');
  if(document.activeElement!==directSelect)throw new Error('Escape did not restore focus to the Direct route select');
  directSelect.value='__direct__';
  directSelect.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor(()=>document.querySelector('dialog.confirmation-dialog[open]'),'second Direct route confirmation');
  settleSyntheticDialog(document.querySelector('dialog.confirmation-dialog[open]'),'confirm');
  await waitFor(()=>directSelect.value==='__direct__','confirmed Direct route');
  await waitFor(()=>!directSelect.disabled,'confirmed Direct route re-enable');
  await sleep(20);
  if(document.activeElement!==directSelect)throw new Error('confirmed Direct routing did not restore focus to its select');
  directSelect.value='__block__';
  directSelect.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor(()=>!directSelect.disabled,'Direct route select after prior success');
  const directNoticeClasses=document.getElementById('profileDirectNotice').classList;
  const originalNoticeToggle=directNoticeClasses.toggle;
  directNoticeClasses.toggle=()=>{throw new Error('injected Direct notice update failure');};
  directSelect.value='__direct__';
  directSelect.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor(()=>document.querySelector('dialog.confirmation-dialog[open]'),'error-path Direct route confirmation');
  settleSyntheticDialog(document.querySelector('dialog.confirmation-dialog[open]'),'confirm');
  await waitFor(()=>!directSelect.disabled,'Direct route select after confirmation handler error');
  await sleep(20);
  directNoticeClasses.toggle=originalNoticeToggle;
  if(document.activeElement!==directSelect)throw new Error('Direct confirmation error did not restore focus to its select');
  directSelect.value='__block__';
  directSelect.dispatchEvent(new Event('change',{bubbles:true}));
  if(document.getElementById('saveProfiles').disabled)throw new Error('profile changes did not enable Save changes');
  if(!document.getElementById('profileDirtyState').textContent.includes('Unsaved'))throw new Error('profile dirty state was not announced');
  document.getElementById('saveProfiles').click();
  await waitFor(()=>document.getElementById('saveProfiles').disabled,'profile save reset dirty state');
  setSmokeStage('workflow-editing');
  setSmokeStage('workflow-validation');
  document.querySelector('[data-tab="automations"]').click();
  await sleep(100);
  document.querySelector('#workflowList [data-workflow-id="draft"]').click();
  await waitFor(()=>document.querySelector('.wfProfile option[value="firefox-container-1"]'),'managed persona option');
  const profile=document.querySelector('.wfProfile');
  profile.value='firefox-container-1';
  profile.dispatchEvent(new Event('change',{bubbles:true}));
  const script=await waitFor(()=>document.querySelector('.wfScript[value="sig"]'),'userscript checkbox');
  const stepScriptFilter=document.querySelector('.wfScriptFilter');
  if(!stepScriptFilter)throw new Error('workflow script filter missing');
  stepScriptFilter.value='no-match';stepScriptFilter.dispatchEvent(new Event('input',{bubbles:true}));
  if(!script.closest('label').hidden)throw new Error('workflow script filter did not hide non-matching scripts');
  stepScriptFilter.value='Signal';stepScriptFilter.dispatchEvent(new Event('input',{bubbles:true}));
  if(script.closest('label').hidden)throw new Error('workflow script filter did not restore matching scripts');
  script.checked=true;
  script.dispatchEvent(new Event('change',{bubbles:true}));
  const signalMode=document.querySelector('.wfCompletion');
  signalMode.value='signal';
  signalMode.dispatchEvent(new Event('change',{bubbles:true}));
  await sleep(50);
  const workflowValidationText=document.getElementById('workflowValidation').innerText;
  if(!workflowValidationText.includes('Ready to run'))throw new Error('valid workflow did not become ready: '+workflowValidationText);
  if(document.getElementById('runWorkflow').disabled)throw new Error('Run stayed disabled after validation passed');
  document.getElementById('saveWorkflow').click();
  await sleep(100);

  setSmokeStage('workflow-package-roundtrip');
  const beforeDuplicate=document.querySelectorAll('#workflowList [data-workflow-id]').length;
  document.getElementById('duplicateWorkflow').click();
  await waitFor(()=>document.querySelectorAll('#workflowList [data-workflow-id]').length===beforeDuplicate+1,'duplicated workflow');
  if(!document.getElementById('wfName').value.includes('copy'))throw new Error('duplicated workflow was not selected');

  document.getElementById('exportWorkflowPackage').click();
  const exportBlob=await waitFor(()=>window.__smokeDownloads.find(blob=>blob.type==='application/zip'),'workflow package download');
  if(!exportBlob.size)throw new Error('workflow package export produced an empty archive');

  // Package structure/hash/completion semantics are covered by
  // workflow-package.test.mjs. This browser smoke validates the UI boundary:
  // export a ZIP, feed that exact ZIP back through the import UI, and require
  // the preview/binding/import flow to complete.
  const input=await waitFor(()=>document.getElementById('workflowPackageFile'),'package file input');
  const importFile=new File([exportBlob],'smoke.personamonkey.zip',{type:'application/zip'});
  Object.defineProperty(input,'files',{configurable:true,value:[importFile]});
  input.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor(()=>!document.getElementById('workflowPackagePreview').classList.contains('hidden'),'package preview');
  const binding=document.querySelector('.package-persona-binding');
  if(!binding||binding.value!=='firefox-container-1')throw new Error('package persona was not suggested automatically');
  const beforeImport=document.querySelectorAll('#workflowList [data-workflow-id]').length;
  document.getElementById('confirmPackageImport').click();
  await waitFor(()=>document.querySelectorAll('#workflowList [data-workflow-id]').length===beforeImport+1,'imported workflow');
  if(!document.getElementById('wfName').value.includes('copy'))throw new Error('imported workflow was not selected');

  document.getElementById('newWorkflow').click();
  await waitFor(()=>document.getElementById('wfName'),'new workflow details');
  document.getElementById('addWorkflowStep').click();
  await sleep(60);
  if(document.querySelectorAll('#workflowSteps .workflow-step').length!==2)throw new Error('Add step failed on new workflow');

  setSmokeStage('diagnostics');
  const activeSmokeJob=window.__smokeGetJobs()[0];
  const historicalSmokeJobs=Array.from({length:35},(_,index)=>({id:'history-'+index,workflowId:'draft',workflowName:'History '+index,state:'completed',createdAt:new Date(Date.now()-(index+10)*60000).toISOString(),startedAt:new Date(Date.now()-(index+10)*60000).toISOString(),finishedAt:new Date(Date.now()-(index+9)*60000).toISOString(),currentStep:0,totalSteps:1,error:null,stepProgress:[],tasks:[]}));
  window.__smokeSetJobs([activeSmokeJob,...historicalSmokeJobs]);
  document.querySelector('[data-tab="activity"]').click();
  await waitFor(()=>document.querySelector('#diagnosticsJobs .diagnostic-job'),'diagnostic job');
  await waitFor(()=>document.querySelectorAll('#diagnosticsJobs .diagnostic-job').length===25,'bounded diagnostic history');
  if(!document.getElementById('showMoreDiagnostics'))throw new Error('diagnostic Show more control missing for long history');
  if(!document.querySelector('[data-diagnostic-job-id="job-smoke"] .stop-diagnostic-job'))throw new Error('active job was not preserved in bounded history');
  document.getElementById('showMoreDiagnostics').click();
  await waitFor(()=>document.querySelectorAll('#diagnosticsJobs .diagnostic-job').length===36,'expanded diagnostic history');
  const historyMenu=document.querySelector('.diagnostic-history-menu');
  if(!historyMenu||historyMenu.open)throw new Error('diagnostic history actions should be collapsed initially');
  let diagnosticText=document.getElementById('tab-activity').innerText;
  const diagnosticAllText=document.getElementById('tab-activity').textContent;
  if(!diagnosticText.includes('smoke proxy error'))throw new Error('proxy diagnostic missing');
  if(!diagnosticText.includes('smoke-block'))throw new Error('blocked-request diagnostic missing');
  if(!diagnosticText.includes('smoke task failure'))throw new Error('task diagnostic missing');
  if(!diagnosticAllText.includes('Page load'))throw new Error('completion diagnostic missing');
  if(!diagnosticText.includes('retrying')&&!diagnosticText.includes('Retrying'))throw new Error('retry progress missing');
  if(!diagnosticAllText.includes('DIRECT'))throw new Error('historical route snapshot missing');
  if(!document.querySelector('.diagnostic-technical'))throw new Error('technical diagnostics disclosure missing');
  if(!document.querySelector('.attempt-history'))throw new Error('attempt history missing');
  const stop=document.querySelector('.stop-diagnostic-job');
  if(!stop)throw new Error('active job Stop button missing');
  stop.click();
  await sleep(120);
  diagnosticText=document.getElementById('tab-activity').innerText;
  if(!diagnosticText.includes('Stopping'))throw new Error('cancellation state did not render');

  if((window.__smokeErrors||[]).length)throw new Error('browser errors recorded: '+JSON.stringify(window.__smokeErrors));

  // End in the original audit's highest-risk surface so optional screenshots
  // are useful review evidence rather than whichever test happened to run last.
  setSmokeStage('final-review');
  document.querySelector('[data-tab="profiles"]').click();
  document.getElementById('advancedPersonaPolicy').open=true;
  const profileFilter=document.getElementById('profileFilter');
  profileFilter.value='';
  profileFilter.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor(()=>document.querySelectorAll('#profilesTable tr[data-id]').length===100,'review policy population');
  document.getElementById('advancedPersonaPolicy').scrollIntoView({block:'start'});
  }

  if((window.__smokeErrors||[]).length)throw new Error('browser errors recorded: '+JSON.stringify(window.__smokeErrors));
  setSmokeStage('pass');
  result.hidden=false;result.textContent='PASS';document.title='PASS';
}catch(error){
  const failure=String(error?.stack||error||'unknown browser assertion');
  result.hidden=false;result.textContent='FAIL: '+failure;
  document.body.dataset.failure=failure;
  document.title='FAIL';
}
</script>`;

html=html.replace('  <script type="module" src="options.js"></script>',browserStub);
html=html.replace('  <script type="module" src="automations.js"></script>','');
html=html.replace('  <script type="module" src="diagnostics.js"></script>','');
html=html.replace("</body>",`${smoke}\n</body>`);
writeFileSync(join(tempRoot,"options/options-browser-smoke.html"),html);

const mime=new Map([[".html","text/html; charset=utf-8"],[".js","text/javascript; charset=utf-8"],[".css","text/css; charset=utf-8"],[".png","image/png"]]);
const server=createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname);
  const relative=normalize(pathname).replace(/^[/\\]+/,"");
  const target=resolve(tempRoot,relative);
  if(!target.startsWith(tempRoot)){res.writeHead(403).end();return;}
  try{
    const body=readFileSync(target);
    res.writeHead(200,{"Content-Type":mime.get(extname(target))||"application/octet-stream","Cache-Control":"no-store"});
    res.end(body);
  }catch{res.writeHead(404).end("not found");}
});

await new Promise((resolvePromise)=>server.listen(0,"127.0.0.1",resolvePromise));
const port=server.address().port;
const candidates=[process.env.CHROME_BIN,"google-chrome","chromium","chromium-browser"].filter(Boolean);
// Wide runs the complete functional scenario. The remaining widths run the
// focused responsive-policy path inside the page so layout coverage is not
// multiplied by expensive workflow/package/diagnostic work.
const viewports=[
  {name:"wide",width:1440,height:1000},
  {name:"desktop-boundary",width:1100,height:1000},
  {name:"tablet",width:900,height:1000},
  {name:"narrow",width:768,height:1000},
  {name:"mobile",width:390,height:844}
];
let browser=null;

for(const command of candidates){
  let unavailable=false;
  for(const viewport of viewports){
    const pageUrl=`http://127.0.0.1:${port}/options/options-browser-smoke.html?viewport=${viewport.name}&width=${viewport.width}`;
    // The full Options smoke intentionally exercises long-lived UI timers (toasts,
    // async renders, confirmation focus restoration) across a dense workflow.
    // 50s matches the established data-management browser harness budget.
    const child=spawn(command,["--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",`--window-size=${viewport.width},${viewport.height}`,"--virtual-time-budget=50000","--dump-dom",pageUrl],{stdio:["ignore","pipe","pipe"]});
    const chunks=[],errors=[];
    child.stdout.on("data",(chunk)=>chunks.push(chunk));
    child.stderr.on("data",(chunk)=>errors.push(chunk));
    const childResult=await new Promise((resolveChild)=>{
      const timer=setTimeout(()=>{child.kill("SIGKILL");resolveChild({code:124});},65000);
      child.on("error",(error)=>{clearTimeout(timer);resolveChild({code:null,error});});
      child.on("close",(code)=>{clearTimeout(timer);resolveChild({code});});
    });
    if(childResult.error?.code==="ENOENT"){unavailable=true;break;}
    const stdout=Buffer.concat(chunks).toString("utf8");
    const stderr=Buffer.concat(errors).toString("utf8");
    if(childResult.code!==0){
      server.close();
      throw new Error(`${command} ${viewport.name} browser smoke exited ${childResult.code}\n${stderr.slice(-4000)}`);
    }
    if(!stdout.includes("<title>PASS</title>")){
      server.close();
      const decode=(value)=>value
        ?.replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
      const failure=decode(stdout.match(/<body[^>]*\bdata-failure="([^"]*)"/i)?.[1]);
      const resultText=decode(stdout.match(/<div[^>]*id="browser-smoke-result"[^>]*>([\s\S]*?)<\/div>/i)?.[1])
        ?.replace(/<[^>]+>/g,"")
        .trim();
      const detail=failure || (resultText && resultText !== "RUNNING" ? resultText : "");
      const stage=decode(stdout.match(/<body[^>]*\bdata-smoke-stage="([^"]*)"/i)?.[1]) || "unknown";
      throw new Error(`Options browser smoke failed using ${command} at ${viewport.name} (${viewport.width}x${viewport.height}).\nSmoke stage: ${stage}${detail ? `\nBrowser assertion:\n${detail}` : ""}\nDOM tail:\n${stdout.slice(-10000)}\nBrowser stderr:\n${stderr.slice(-3000)}`);
    }
    await captureBrowserScreenshot({command,url:pageUrl,width:viewport.width,height:viewport.height,name:`options-${viewport.name}`,virtualTimeBudget:12000});
  }
  if(!unavailable){browser=command;break;}
}
server.close();
if(!browser)throw new Error("No Chrome/Chromium executable available for browser smoke test");
console.log(`v0.8 Options + automation + diagnostics browser smoke passed in ${browser} at 1440, 1100, 900, 768 and 390 CSS-px targets`);
