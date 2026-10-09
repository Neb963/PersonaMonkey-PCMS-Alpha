import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { captureBrowserScreenshot } from "./capture-browser-screenshot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(root, "extension");
const temp = mkdtempSync(join(tmpdir(), "persona-data-smoke-"));

const html = `<!doctype html><html><head><meta charset="utf-8"><title>RUNNING</title><link rel="stylesheet" href="/options/options.css"><link rel="stylesheet" href="/options/v062.css"></head><body>
<header class="topbar"><div class="brand-block"><span class="eyebrow">PersonaMonkey</span><h1>Control center</h1><p>Operate isolated personas, protected routes and automation from one place.</p></div><div class="topbar-status"><span class="status-label">Protection</span><span class="badge good">Fail-closed policy active</span></div></header>
<nav class="tabs"><button data-tab="profiles" class="active">Profiles</button><button data-tab="backup">Data & backup</button></nav>
<main>
<section id="tab-profiles" class="tab active"><div class="section-heading"><div><h2>Profiles</h2><p>old copy</p></div></div><div id="profilesTable"><table><tbody><tr data-id="firefox-container-1"><td><input class="manage-profile" type="checkbox" checked></td><td><strong>Work</strong></td><td>route</td><td>kill</td><td>lan</td><td>1</td><td><button class="edit-profile">Edit</button><button class="test-profile">Test</button></td></tr><tr data-id="firefox-container-2"><td><input class="manage-profile" type="checkbox" checked></td><td><strong>Personal</strong></td><td>route</td><td>kill</td><td>lan</td><td>0</td><td><button class="edit-profile">Edit</button><button class="test-profile">Test</button></td></tr></tbody></table></div><div id="profileEditor"></div></section>
<section id="tab-backup" class="tab"><div class="section-heading"><h2>Data & backup</h2></div><details id="legacyBackupPanel" class="legacy-section legacy-disclosure backup-subview hidden" data-backup-section="legacy"><summary>Legacy JSON compatibility</summary></details></section>
</main>
<div id="scriptEditor"><button id="saveScript">Save</button></div><button data-script-id="script-a">Script</button><div id="toast"></div><div id="result">RUNNING</div>
<script>
(() => {
  window.__errors=[];
  addEventListener('error',(e)=>__errors.push('error: '+(e.error?.stack||e.message||'unknown')));
  addEventListener('unhandledrejection',(e)=>__errors.push('rejection: '+(e.reason?.stack||e.reason||'unknown')));
  window.confirm=()=>true;
  const clone=(v)=>structuredClone(v);
  const icon='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>';
  const containers=[
    {cookieStoreId:'firefox-container-1',name:'Work',color:'blue',colorCode:'#37adff',icon:'briefcase',iconUrl:icon},
    {cookieStoreId:'firefox-container-2',name:'Personal',color:'green',colorCode:'#51cd00',icon:'fingerprint',iconUrl:icon}
  ];
  let state={schemaVersion:2,global:{profileTargetCount:2,profileNamePrefix:'Persona',unmanagedPolicy:'direct',blockSpeculative:true,strictProxyVerification:true,enforcePrivacyControls:true,disableNetworkPrediction:true,webRTCMode:'proxy_only',autoReloadOnRouteChange:true,userscripts:{dependencyFetch:'direct',autoAssignImportedToAllProfiles:true,defaultInjectInto:'auto'},automation:{maxTabsTotal:40,maxTabsPerStep:20,maxJobRuntimeMinutes:60,historyLimit:100},mullvadNative:{enabled:true,autoStart:true,autoStopMinutes:15,requireReady:true}},profiles:{
    'firefox-container-1':{containerId:'firefox-container-1',managed:true,name:'Work',routeId:'__direct__',killSwitch:true,blockLocalNetwork:true,domainMode:'any',allowedDomains:[],blockedDomains:[],scriptIds:['script-a'],notes:'',owned:false},
    'firefox-container-2':{containerId:'firefox-container-2',managed:true,name:'Personal',routeId:'__direct__',killSwitch:true,blockLocalNetwork:true,domainMode:'any',allowedDomains:[],blockedDomains:[],scriptIds:[],notes:'',owned:false}},routes:{},scripts:{
    'script-a':{id:'script-a',name:'Data helper',namespace:'',version:'1',description:'',author:'',homepageURL:'',supportURL:'',updateURL:'',downloadURL:'',icon:'',code:'// ==UserScript==\\n// @name Data helper\\n// @match https://example.com/*\\n// @grant none\\n// ==/UserScript==\\nconsole.log(1);',enabled:true,autoRun:true,matches:['https://example.com/*'],excludeMatches:[],includes:[],excludes:[],runAt:'document_idle',allFrames:false,injectInto:'auto',world:'MAIN',grants:['none'],requires:[],resources:{},connects:[],tags:[],unwrap:false,profileIds:['firefox-container-1'],sourceURL:'',compatibility:{compatible:true,supported:['none'],unsupported:[]},metaBlock:'',updatedAt:new Date().toISOString()}},workflows:{
    'workflow-a':{id:'workflow-a',name:'Data workflow',enabled:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),steps:[{id:'step-1',profileId:'firefox-container-1',urls:['https://example.com/'],concurrency:1,scriptIds:['script-a'],completion:{mode:'load',value:'',timeoutMs:60000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]}},wireguardImports:[]};
  let pendingStatePreview=null;
  const local={automationJobs:{'job-a':{id:'job-a',workflowId:'workflow-a',state:'completed',tasks:[]}},'gm-values:script-a':{saved:'yes'},personaRecoveryLocalConsentV1:{enabled:true,epoch:'local-only-fixture'}};
  const sync={personaRecoveryConsentV1:{version:1,enabled:false,epoch:'synced-opt-out-fixture',updatedAt:new Date().toISOString()}};
  const cookieStores={
    'firefox-container-1':[
      {name:'sid',value:'work-secret',domain:'example.com',hostOnly:true,path:'/',secure:true,httpOnly:true,sameSite:'lax',session:true,firstPartyDomain:'example.com',partitionKey:null,storeId:'firefox-container-1'},
      {name:'sub',value:'work-sub',domain:'deep.example.com',hostOnly:true,path:'/',secure:false,httpOnly:false,sameSite:'unspecified',session:true,firstPartyDomain:'example.com',partitionKey:null,storeId:'firefox-container-1'},
      {name:'third',value:'partitioned-secret',domain:'cdn.example.net',hostOnly:true,path:'/',secure:true,httpOnly:false,sameSite:'none',session:true,firstPartyDomain:'',partitionKey:{topLevelSite:'https://example.com'},storeId:'firefox-container-1'}
    ],
    'firefox-container-2':[{name:'sid',value:'personal-secret',domain:'example.com',hostOnly:true,path:'/',secure:true,httpOnly:true,sameSite:'lax',session:true,firstPartyDomain:'example.com',partitionKey:null,storeId:'firefox-container-2'}]
  };
  const storageArea=(data)=>({async get(keys){if(keys==null)return clone(data);if(typeof keys==='string')return Object.hasOwn(data,keys)?{[keys]:clone(data[keys])}:{};const out={};for(const key of keys||[])if(Object.hasOwn(data,key))out[key]=clone(data[key]);return out;},async set(values){Object.assign(data,clone(values));},async remove(keys){for(const key of Array.isArray(keys)?keys:[keys])delete data[key];}});
  window.__downloads=[];window.__downloadPayloads=[];window.__cookieStores=cookieStores;window.__local=local;window.__sync=sync;window.__saveCount=0;window.__runtimeReloads=0;window.__cookieGetAllCalls=[];window.__openedPersonas=[];window.__routeTests=[];window.__storageClears=[];
  const NativeBlob=window.Blob;
  const blobPayloads=new WeakMap();
  const decodeBlobPart=(part)=>{
    if(typeof part==='string')return part;
    if(part instanceof ArrayBuffer)return new TextDecoder().decode(new Uint8Array(part));
    if(ArrayBuffer.isView(part))return new TextDecoder().decode(new Uint8Array(part.buffer,part.byteOffset,part.byteLength));
    return null;
  };
  window.Blob=new Proxy(NativeBlob,{construct(target,args){
    const blob=Reflect.construct(target,args);
    const parts=Array.isArray(args[0])?args[0]:[];
    let payload='',known=true;
    for(const part of parts){const decoded=decodeBlobPart(part);if(decoded===null){known=false;break;}payload+=decoded;}
    if(known)blobPayloads.set(blob,payload);
    return blob;
  }});
  const nativeCreate=URL.createObjectURL.bind(URL);URL.createObjectURL=(blob)=>{__downloads.push(blob);__downloadPayloads.push(blobPayloads.get(blob)??null);return nativeCreate(blob);};HTMLAnchorElement.prototype.click=function(){};
  window.browser={runtime:{getManifest:()=>({version:'0.6.3'}),sendMessage:async(m)=>{if(m.type==='GET_SNAPSHOT')return {state:clone(state),containers:clone(containers),security:{ready:true,privacySafe:true},userScriptsGranted:true,mullvadNative:{}};if(m.type==='PREVIEW_STATE_CHANGE'){pendingStatePreview=clone(m.state);return {previewId:'data-smoke-state-preview',delta:[]};}if(m.type==='COMMIT_STATE_PREVIEW'){if(!pendingStatePreview)throw new Error('No pending state preview');state=clone(pendingStatePreview);pendingStatePreview=null;__saveCount++;return {state:clone(state),containers:clone(containers),security:{ready:true,privacySafe:true}};}if(m.type==='SAVE_STATE'){state=clone(m.state);__saveCount++;return {state:clone(state),containers:clone(containers),security:{ready:true,privacySafe:true}};}if(m.type==='IMPORT_AUTOMATION_HISTORY'){local.automationJobs=clone(m.jobs||{});return {jobs:Object.values(local.automationJobs).map(clone)};}throw new Error('Unexpected message '+m.type);},reload:()=>{__runtimeReloads++;}},storage:{local:storageArea(local),sync:storageArea(sync)},contextualIdentities:{async query(){return clone(containers);},async create(details){const item={cookieStoreId:'created-'+(containers.length+1),colorCode:'#37adff',...details};containers.push(item);cookieStores[item.cookieStoreId]=[];return clone(item);},async remove(id){const i=containers.findIndex((c)=>c.cookieStoreId===id);if(i>=0)containers.splice(i,1);delete cookieStores[id];}},cookies:{async getAll(d){__cookieGetAllCalls.push(clone(d));let rows=clone(cookieStores[d.storeId]||[]);if(!Object.hasOwn(d,'firstPartyDomain'))throw new Error("First-Party Isolation is enabled, but the required 'firstPartyDomain' attribute was not set");if(d.firstPartyDomain!==null)rows=rows.filter((c)=>(c.firstPartyDomain??'')===d.firstPartyDomain);if(!Object.hasOwn(d,'partitionKey'))rows=rows.filter((c)=>!c.partitionKey?.topLevelSite);else if(d.partitionKey?.topLevelSite)rows=rows.filter((c)=>c.partitionKey?.topLevelSite===d.partitionKey.topLevelSite);return rows;},async remove(d){const list=cookieStores[d.storeId]||[];const host=new URL(d.url).hostname;const i=list.findIndex((c)=>c.name===d.name&&c.domain.replace(/^\\./,'')===host&&(!Object.hasOwn(d,'firstPartyDomain')||d.firstPartyDomain===c.firstPartyDomain)&&(!d.partitionKey||JSON.stringify(d.partitionKey)===JSON.stringify(c.partitionKey)));if(i<0)return null;const [cookie]=list.splice(i,1);return {url:d.url,name:cookie.name,storeId:d.storeId};},async set(d){const record={name:d.name,value:d.value,domain:d.domain||new URL(d.url).hostname,hostOnly:!d.domain,path:d.path||'/',secure:d.secure===true,httpOnly:d.httpOnly===true,sameSite:d.sameSite||'unspecified',session:d.expirationDate==null,expirationDate:d.expirationDate,firstPartyDomain:d.firstPartyDomain??'',partitionKey:d.partitionKey||null,storeId:d.storeId};const list=cookieStores[d.storeId]||[];const identity=(c)=>JSON.stringify([c.domain,c.path,c.name,c.firstPartyDomain??null,c.partitionKey||null]);const i=list.findIndex((c)=>identity(c)===identity(record));if(i>=0)list[i]=record;else list.push(record);cookieStores[d.storeId]=list;return clone(record);}}};
  const originalSendMessage=window.browser.runtime.sendMessage;
  const personaCards=()=>containers.filter((c)=>state.profiles[c.cookieStoreId]?.managed).map((c)=>{const p=state.profiles[c.cookieStoreId];return {id:c.cookieStoreId,name:c.name,icon:c.icon,iconUrl:c.iconUrl,color:c.color,colorCode:c.colorCode,managed:true,owned:Boolean(p.owned),lastUsedAt:new Date(Date.now()-60000).toISOString(),activeTabs:c.cookieStoreId==='firefox-container-1'?3:0,cookies:{count:(cookieStores[c.cookieStoreId]||[]).length,bytes:128},storage:null,health:{status:'healthy',reason:'Proxy, DNS, and exit verified',routeId:p.routeId,routeName:'Mullvad Netherlands',protected:true,proxy:true,dns:true,exitIp:'198.51.100.8',checkedAt:new Date().toISOString(),ageMs:0},protection:'active'};});
  window.browser.runtime.sendMessage=async(m)=>{if(m.type==='LIST_PERSONAS')return {personas:clone(personaCards())};if(m.type==='OPEN_PERSONA'){__openedPersonas.push(m.profileId);return {tab:{id:91}};}if(m.type==='TEST_PROFILE'){__routeTests.push(m.profileId);return {ok:true,checkedAt:new Date().toISOString(),data:{ip:'198.51.100.8'}};}if(m.type==='GET_PERSONA_STORAGE')return {storage:{cookies:{count:(cookieStores[m.profileId]||[]).length,bytes:128,byDomain:[{domain:'example.com',count:2},{domain:'cdn.example.net',count:1}]},localStorage:{items:4,bytes:512},sessionStorage:{items:2,bytes:64},indexedDB:{databases:1},cacheStorage:{caches:2},estimated:{usage:4096,quota:999999},activeTabs:3,inspectedOrigins:['https://example.com'],complete:false,note:'Site-storage counts cover origins currently open in this persona; clearing remains container-scoped.'}};if(m.type==='CLEAR_PERSONA_STORAGE'){__storageClears.push([m.profileId,m.scope]);return {scope:m.scope};}if(m.type==='FULL_WIPE_PERSONA'){__storageClears.push([m.profileId,'full']);return {profile:{containerId:'clean-persona'}};}if(m.type==='EXPORT_PERSONA_PACKAGE')return {bytes:new Uint8Array([80,75,3,4])};if(m.type==='UPDATE_PERSONA_IDENTITY'){const c=containers.find(c=>c.cookieStoreId===m.profileId);Object.assign(c,m.changes);Object.assign(state.profiles[m.profileId],{name:m.changes.name,description:m.changes.description});return {container:clone(c)};}if(m.type==='DUPLICATE_PERSONA'){const source=state.profiles[m.profileId];const id='created-'+(containers.length+1);const sourceContainer=containers.find(c=>c.cookieStoreId===m.profileId);containers.push({...sourceContainer,cookieStoreId:id,name:m.options.name});state.profiles[id]={...source,containerId:id,name:m.options.name,owned:true};cookieStores[id]=m.options.copyCookies?clone(cookieStores[m.profileId]||[]):[];return {profile:clone(state.profiles[id])};}if(m.type==='CREATE_PERSONA'){const id='created-'+(containers.length+1);containers.push({cookieStoreId:id,name:m.input.name,color:'blue',colorCode:'#37adff',icon:'fingerprint',iconUrl:icon});state.profiles[id]={containerId:id,name:m.input.name,managed:true,owned:true,routeId:'__block__',status:'temporary',expiresAt:new Date(Date.now()+m.input.ttlHours*3600000).toISOString()};cookieStores[id]=[];return {profile:clone(state.profiles[id])};}if(m.type==='ARCHIVE_PERSONA'){state.profiles[m.profileId].status='archived';state.profiles[m.profileId].routeId='__block__';return {profile:clone(state.profiles[m.profileId])};}return originalSendMessage(m);};
})();
</script>
<script type="module">
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
const readBlobText=async(blob,label)=>{
  if(!blob)throw new Error(label+' download blob missing');
  const index=window.__downloads.indexOf(blob);
  const captured=index>=0?window.__downloadPayloads[index]:null;
  if(typeof captured==='string')return captured;
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout reading '+label+' download blob')),5000);});
  try{return await Promise.race([blob.text(),timeout]);}
  finally{clearTimeout(timer);}
};
const waitFor=async(fn,label)=>{for(let i=0;i<400;i++){const value=fn();if(value)return value;await sleep(20);}throw new Error('timeout waiting for '+label+'; toast='+(document.getElementById('toast')?.textContent||'')+'; errors='+JSON.stringify(window.__errors));};
const waitForSlow=async(fn,label)=>{for(let i=0;i<3000;i++){const value=fn();if(value)return value;await sleep(20);}throw new Error('timeout waiting for '+label+'; toast='+(document.getElementById('toast')?.textContent||'')+'; errors='+JSON.stringify(window.__errors));};
const acceptConfirmation=async(label)=>{const dialog=await waitFor(()=>document.querySelector('dialog.confirmation-dialog[open]'),label+' confirmation');if(!dialog.querySelector('button[value="confirm"]'))throw new Error('confirmation button missing for '+label);dialog.close('confirm');dialog.dispatchEvent(new Event('close'));await waitFor(()=>!dialog.open,label+' confirmation close');};
const cancelConfirmation=async(label)=>{const dialog=await waitFor(()=>document.querySelector('dialog.confirmation-dialog[open]'),label+' confirmation');const cancel=dialog.querySelector('button[value="cancel"]');if(!cancel)throw new Error('cancel button missing for '+label);cancel.click();if(dialog.open){try{dialog.close('cancel');}catch{}}dialog.dispatchEvent(new Event('close'));await waitFor(()=>!document.querySelector('dialog.confirmation-dialog[open]'),label+' confirmation cancel');};
const result=document.getElementById('result');
const setSmokeStage=(stage)=>{document.body.dataset.smokeStage=stage;};
const local=window.__local;
const sync=window.__sync;
setSmokeStage('bootstrap');
const activateTopLevel=(view)=>{
  for(const button of document.querySelectorAll('.tabs [data-tab]'))button.classList.toggle('active',button.dataset.tab===view);
  for(const panel of document.querySelectorAll('main > .tab'))panel.classList.toggle('active',panel.id==='tab-'+view);
};
try{
  const expectedViewport=new URL(location.href).searchParams.get('viewport');
  if(expectedViewport==='mobile'&&window.innerWidth>560)throw new Error('mobile data-management smoke did not actually run at a mobile viewport: '+window.innerWidth);
  if(expectedViewport==='desktop'&&window.innerWidth<900)throw new Error('desktop data-management smoke did not actually run at a desktop viewport: '+window.innerWidth);
  await import('/options/data-management.js');
  await import('/options/cookies.js');
  await import('/options/profile-ui.js');
  await import('/options/personas-v07.js');
  const {createPersonaCookieService}=await import('/lib/persona-cookies.js');
  const cookieService=createPersonaCookieService({browserApi:window.browser});
  const fixtureSendMessage=window.browser.runtime.sendMessage.bind(window.browser.runtime);
  window.browser.runtime.sendMessage=async(message)=>{
    if(message.type==='PERSONA_COOKIES_LIST')return cookieService.list(message.profileId);
    if(message.type==='PERSONA_COOKIES_SET')return cookieService.set(message.profileId,message.cookie,message.original||null);
    if(message.type==='PERSONA_COOKIES_REMOVE')return cookieService.remove(message.profileId,message.cookie);
    if(message.type==='PERSONA_COOKIES_CLEAR')return cookieService.clear(message.profileId,message.options||{});
    if(message.type==='PERSONA_COOKIES_IMPORT')return cookieService.importRecords(message.profileId,message.records||[],message.mode||'merge');
    return fixtureSendMessage(message);
  };
  setSmokeStage('backup-navigation');
  await waitFor(()=>document.getElementById('advancedBackupPanel'),'advanced backup panel');
  await waitFor(()=>document.getElementById('recoveryStatus')?.innerText.includes('Disabled in Firefox Sync'),'synced recovery opt-out status');
  const localOnlyRecoveryOptIn=document.getElementById('enableRecoverySync');
  const localOnlySaveRecovery=document.getElementById('saveRecoveryNow');
  if(localOnlyRecoveryOptIn.checked||!localOnlySaveRecovery.disabled)throw new Error('local-only recovery consent must not present recovery as enabled or offer a save action');
  const savedLocalConsent=structuredClone(local.personaRecoveryLocalConsentV1);
  localOnlySaveRecovery.click();
  if(sync.personaRecoveryConsentV1.enabled!==false||sync.personaRecoveryConsentV1.epoch!=='synced-opt-out-fixture')throw new Error('rendering or attempting the disabled save action mutated synced opt-out consent');
  if(JSON.stringify(local.personaRecoveryLocalConsentV1)!==JSON.stringify(savedLocalConsent))throw new Error('rendering or attempting the disabled save action mutated local consent');
  localOnlyRecoveryOptIn.checked=true;
  localOnlyRecoveryOptIn.dispatchEvent(new Event('change',{bubbles:true}));
  await cancelConfirmation('recovery re-opt-in review');
  await waitForSlow(()=>!localOnlyRecoveryOptIn.checked,'cancelled recovery re-opt-in');
  if(sync.personaRecoveryConsentV1.enabled!==false||sync.personaRecoveryConsentV1.epoch!=='synced-opt-out-fixture')throw new Error('cancelling explicit re-opt-in mutated synced opt-out consent');
  if(JSON.stringify(local.personaRecoveryLocalConsentV1)!==JSON.stringify(savedLocalConsent))throw new Error('cancelling explicit re-opt-in mutated local consent');
  const backupNav=document.getElementById('backupSectionNav');
  if(!backupNav)throw new Error('backup subnavigation missing');
  if(backupNav.getAttribute('role')!=='tablist')throw new Error('backup subnavigation is not a tablist');
  const backupTab=backupNav.querySelector('[data-backup-view="backup"]');
  if(backupTab.getAttribute('role')!=='tab'||backupTab.getAttribute('aria-selected')!=='true'||backupTab.tabIndex!==0)throw new Error('active backup subview is not exposed as the selected tab');
  if(document.getElementById('advancedBackupPanel').getAttribute('role')!=='tabpanel'||document.getElementById('advancedBackupPanel').getAttribute('aria-hidden')!=='false')throw new Error('backup panel semantics are incomplete');
  if(document.getElementById('advancedBackupPanel').classList.contains('hidden'))throw new Error('Backup should be the default subview');
  // This focused harness does not import options.js, so model the real
  // precondition for backup-subtab keyboard use: Data & backup is visible.
  activateTopLevel('backup');
  if(!document.getElementById('tab-backup').classList.contains('active')||document.getElementById('tab-profiles').classList.contains('active'))throw new Error('backup keyboard fixture did not activate the visible Data & backup surface');
  backupTab.focus();backupTab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  if(document.activeElement!==backupNav.querySelector('[data-backup-view="restore"]')||document.getElementById('advancedImportPanel').classList.contains('hidden'))throw new Error('backup keyboard navigation did not activate Restore');
  backupNav.querySelector('[data-backup-view="backup"]').click();
  backupNav.querySelector('[data-backup-view="restore"]').click();
  if(document.getElementById('advancedImportPanel').classList.contains('hidden')||!document.getElementById('advancedBackupPanel').classList.contains('hidden'))throw new Error('Restore subview did not switch cleanly');
  backupNav.querySelector('[data-backup-view="recovery"]').click();
  if(document.getElementById('recoveryPanel').classList.contains('hidden'))throw new Error('Recovery subview did not open');
  backupNav.querySelector('[data-backup-view="legacy"]').click();
  if(document.getElementById('legacyBackupPanel').classList.contains('hidden'))throw new Error('Legacy subview did not open');
  backupNav.querySelector('[data-backup-view="backup"]').click();
  // Restore the Persona surface before exercising its quick actions.
  activateTopLevel('profiles');
  setSmokeStage('persona-shell');
  await waitFor(()=>document.getElementById('cookiesTabButton'),'cookies tab');
  await waitFor(()=>document.querySelector('.profile-cookies')&&document.querySelector('.export-profile'),'persona quick actions');
  if(!document.querySelector('.persona-identity img'))throw new Error('Firefox persona icon was not rendered');
  if(!document.querySelector('.persona-identity')?.getAttribute('style')?.includes('#37adff'))throw new Error('Firefox persona color was not rendered');
  if(document.querySelector('.brand-block h1').textContent!=='Control center')throw new Error('compact control-center title missing');
  if(getComputedStyle(document.querySelector('.brand-block .eyebrow')).display==='none'||!document.querySelector('.brand-block .eyebrow').textContent.includes('PersonaMonkey'))throw new Error('compact shell lost PersonaMonkey product identity');
  setSmokeStage('persona-dashboard');
  const dashboardCard=await waitFor(()=>document.querySelector('.persona-card[data-persona-id="firefox-container-1"]'),'v0.7 persona card');
  if(!dashboardCard.innerText.includes('Mullvad Netherlands')||!dashboardCard.innerText.includes('Protection: enforced')||!dashboardCard.innerText.includes('Network: verified'))throw new Error('persona intelligence was not rendered');
  const dashboardFilter=document.getElementById('personaDashboardFilter');
  if(!dashboardFilter)throw new Error('persona dashboard filter missing');
  dashboardFilter.value='Personal';dashboardFilter.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor(()=>document.querySelectorAll('.persona-card').length===1,'persona dashboard filter');
  dashboardFilter.value='';dashboardFilter.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor(()=>document.querySelectorAll('.persona-card').length>=2,'persona dashboard filter reset');
  const currentDashboardCard=await waitFor(()=>document.querySelector('.persona-card[data-persona-id="firefox-container-1"]'),'current persona card after filter reset');
  const openedBefore=window.__openedPersonas.length;
  currentDashboardCard.querySelector('[data-action="open"]').click();
  await waitFor(()=>window.__openedPersonas.length===openedBefore+1,'persona open action');
  const reopenedDashboardCard=await waitFor(()=>{
    const card=document.querySelector('.persona-card[data-persona-id="firefox-container-1"]');
    return card&&card!==currentDashboardCard?card:null;
  },'persona card replacement after open refresh');
  const routeTestsBefore=window.__routeTests.length;
  reopenedDashboardCard.querySelector('[data-action="test"]').click();
  await waitFor(()=>window.__routeTests.length===routeTestsBefore+1,'persona route test invocation');
  await waitFor(()=>document.getElementById('toast').innerText.includes('route verified'),'persona route test success toast');
  if(window.__routeTests.length!==routeTestsBefore+1)throw new Error('persona route test fired more than once');
  const postRouteDashboardCard=await waitFor(()=>{
    const card=document.querySelector('.persona-card[data-persona-id="firefox-container-1"]');
    return card&&card!==reopenedDashboardCard?card:null;
  },'persona card replacement after route refresh');
  postRouteDashboardCard.querySelector('[data-action="storage"]').click();await waitFor(()=>document.getElementById('personaModal')?.innerText.includes('Site data'),'persona storage dialog');
  if(!document.querySelector('.persona-storage-breakdown')||document.querySelector('.persona-storage-breakdown').open)throw new Error('technical storage breakdown should be collapsed initially');
  if(!document.querySelector('.persona-storage-reset')||document.querySelector('.persona-storage-reset').open)throw new Error('factory reset should be isolated behind destructive disclosure');
  if(document.querySelector('[data-clear-storage="full"]').closest('.persona-modal-actions'))throw new Error('factory reset leaked into primary storage actions');
  const storageClearsBefore=window.__storageClears.length;
  document.querySelector('[data-clear-storage="cookies"]').click();
  await acceptConfirmation('persona cookie clear');
  await waitFor(()=>window.__storageClears.length===storageClearsBefore+1,'persona cookie clear invocation');
  if(window.__storageClears.length!==storageClearsBefore+1)throw new Error('persona cookie clear fired more than once');
  const refreshedCard=await waitFor(()=>{
    const card=document.querySelector('.persona-card[data-persona-id="firefox-container-1"]');
    return card&&card!==postRouteDashboardCard?card:null;
  },'persona card replacement after cookie clear');
  refreshedCard.querySelector('[data-action="identity"]').click();await waitFor(()=>document.querySelector('[data-confirm-identity]'),'identity dialog');document.getElementById('personaIdentityName').value='Research';document.querySelector('[data-confirm-identity]').click();await waitFor(()=>document.querySelector('.persona-card[data-persona-id="firefox-container-1"] h3')?.innerText==='Research','identity update');
  const researchCard=document.querySelector('.persona-card[data-persona-id="firefox-container-1"]');
  researchCard.querySelector('[data-action="duplicate"]').click();await waitFor(()=>document.querySelector('[data-confirm-clone]'),'clone dialog');
  if(!document.querySelector('[data-clone="copySettings"]').checked||!document.querySelector('[data-clone="copyRoute"]').checked||document.querySelector('[data-clone="copyCookies"]').checked||document.querySelector('[data-clone="copyTabs"]').checked)throw new Error('clone defaults are unsafe');
  document.querySelector('[data-confirm-clone]').click();await waitFor(()=>document.querySelectorAll('.persona-card').length===3,'persona clone');
  document.getElementById('createTemporaryPersona').click();await waitFor(()=>document.querySelector('[data-confirm-temporary]'),'temporary persona dialog');
  const beforeBlankTemporary=document.querySelectorAll('.persona-card').length;
  document.getElementById('temporaryPersonaName').value='   ';
  document.querySelector('[data-confirm-temporary]').click();
  await waitFor(()=>document.getElementById('toast').innerText.includes('Persona name is required'),'blank temporary persona rejection');
  if(document.querySelectorAll('.persona-card').length!==beforeBlankTemporary)throw new Error('blank temporary persona created a fallback persona');
  document.getElementById('temporaryPersonaName').value='Agent-Test-01';
  document.querySelector('[data-confirm-temporary]').click();await waitFor(()=>document.querySelectorAll('.persona-card').length===4,'temporary persona');
  await waitFor(()=>document.querySelectorAll('.cookie-persona-button').length===4,'cookie persona list reconciliation');
  const cookiePersonaIds=[...document.querySelectorAll('.cookie-persona-button')].map((button)=>button.dataset.profileId);
  if(new Set(cookiePersonaIds).size!==cookiePersonaIds.length)throw new Error('cookie persona list rendered duplicate persona entries');
  const beforeV07Export=window.__downloads.length;document.querySelector('.persona-card[data-persona-id="firefox-container-1"] [data-action="export"]').click();await waitFor(()=>window.__downloads.length>beforeV07Export,'v0.7 persona package export');

  setSmokeStage('cookie-workspace');
  document.querySelector('#profilesTable tr[data-id="firefox-container-1"] .profile-cookies').click();
  await waitFor(()=>document.getElementById('tab-cookies')?.classList.contains('active'),'cookies tab activation');
  await waitFor(()=>document.querySelector('.cookie-persona-button[data-profile-id="firefox-container-1"].active'),'source persona activation');
  const sourcePersonaButton=document.querySelector('.cookie-persona-button[data-profile-id="firefox-container-1"]');
  if(sourcePersonaButton.getAttribute('aria-pressed')!=='true')throw new Error('active cookie persona is not exposed semantically');
  if(sourcePersonaButton.querySelector('.persona-network')?.textContent!=='Direct network'||sourcePersonaButton.querySelector('.persona-protection')?.textContent!=='Protection enforced')throw new Error('cookie persona context does not expose network/protection state');
  const personaFilter=document.getElementById('cookiePersonaFilter');
  if(!personaFilter)throw new Error('cookie persona search missing');
  personaFilter.value='Personal';personaFilter.dispatchEvent(new Event('input',{bubbles:true}));
  if(document.querySelectorAll('.cookie-persona-button').length!==1||!document.querySelector('.cookie-persona-button')?.innerText.includes('Personal'))throw new Error('cookie persona search did not filter');
  personaFilter.value='';personaFilter.dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor(()=>document.querySelectorAll('.cookie-persona-button').length>=4,'cookie persona search reset');
  await waitFor(()=>document.querySelector('#cookieTable tr[data-cookie-index]'),'isolated cookies');
  const cookieWrap=document.getElementById('cookieTable');
  const cookieRect=cookieWrap.getBoundingClientRect();
  if(cookieRect.left<-2||cookieRect.right>window.innerWidth+2)throw new Error('cookie workspace escapes the viewport');
  if(expectedViewport==='mobile'&&cookieWrap.scrollWidth>cookieWrap.clientWidth+2)throw new Error('responsive cookie cards still overflow horizontally');
  if(expectedViewport==='desktop'&&!['auto','scroll'].includes(getComputedStyle(cookieWrap).overflowX))throw new Error('desktop cookie table lost its contained horizontal scroll surface');
  const initial=document.getElementById('cookieTable').innerText;
  if(!initial.includes('work-secret')||!initial.includes('work-sub')||!initial.includes('partitioned-secret')||initial.includes('personal-secret'))throw new Error('cookie workspace did not enumerate the complete selected persona store');
  const firstCookieCall=window.__cookieGetAllCalls[0];
  if(firstCookieCall?.firstPartyDomain!==null||!firstCookieCall?.partitionKey||Object.keys(firstCookieCall.partitionKey).length!==0)throw new Error('cookie listing did not request all first-party domains and partitioned/unpartitioned jars');

  const cookiesBeforeIsolationProbe=window.__cookieStores['firefox-container-1'].length;
  document.getElementById('cookieNew').click();
  await waitFor(()=>document.getElementById('cookieEditPartition'),'cookie isolation editor');
  document.querySelector('.cookie-advanced').open=true;
  document.getElementById('cookieEditName').value='partition-probe';
  document.getElementById('cookieEditDomain').value='partition.test';
  document.getElementById('cookieEditValue').value='partition-value';
  document.getElementById('cookieEditSecure').checked=true;
  document.getElementById('cookieEditSameSite').value='no_restriction';
  document.getElementById('cookieEditFirstParty').value='example.com';
  document.getElementById('cookieEditPartition').value='https://example.com';
  document.getElementById('cookieEditorSave').click();
  await waitFor(()=>!document.getElementById('cookieEditorError').hidden,'mutually exclusive cookie isolation validation');
  if(!document.getElementById('cookieEditorError').innerText.includes('either First-party domain or Partition top-level site'))throw new Error('cookie isolation validation did not explain mutually exclusive modes');
  if(document.activeElement!==document.getElementById('cookieEditPartition'))throw new Error('cookie isolation validation did not focus the conflicting partition field');
  if(window.__cookieStores['firefox-container-1'].length!==cookiesBeforeIsolationProbe)throw new Error('invalid mixed isolation metadata reached Firefox');
  document.getElementById('cookieEditFirstParty').value='';
  document.getElementById('cookieEditorSave').click();
  await waitFor(()=>window.__cookieStores['firefox-container-1'].some((c)=>c.name==='partition-probe'&&c.partitionKey?.topLevelSite==='https://example.com'),'partitioned cookie creation');
  const partitionProbeRow=[...document.querySelectorAll('#cookieTable tr[data-cookie-index]')].find((row)=>row.innerText.includes('partition-probe'));
  if(!partitionProbeRow||!partitionProbeRow.innerText.includes('top-level: https://example.com'))throw new Error('partitioned cookie row did not retain its top-level site');
  partitionProbeRow.querySelector('.cookie-edit').click();
  await waitFor(()=>document.getElementById('cookieEditPartition'),'partitioned cookie re-edit');
  if(document.getElementById('cookieEditPartition').value!=='https://example.com'||document.getElementById('cookieEditFirstParty').value!=='')throw new Error('partition metadata was not retained when reopening the cookie editor');
  document.getElementById('cookieEditorCancel').click();

  document.querySelector('#cookieTable .cookie-edit').click();
  await waitFor(()=>document.getElementById('cookieEditValue'),'cookie editor');
  document.getElementById('cookieEditValue').value='work-edited';
  document.getElementById('cookieEditorSave').click();
  await waitFor(()=>window.__cookieStores['firefox-container-1'].some((c)=>c.value==='work-edited'),'edited cookie');
  if(window.__cookieStores['firefox-container-2'][0].value!=='personal-secret')throw new Error('cookie edit touched another persona');

  document.getElementById('cookieNew').click();
  document.getElementById('cookieEditorSave').click();
  await waitFor(()=>!document.getElementById('cookieEditorError').hidden,'cookie inline validation');
  if(!document.getElementById('cookieEditorError').innerText.includes('name'))throw new Error('cookie validation did not identify missing name');
  if(document.activeElement!==document.getElementById('cookieEditName'))throw new Error('cookie validation did not focus the first invalid field');
  if(document.getElementById('cookieEditName').getAttribute('aria-describedby')!=='cookieEditorError')throw new Error('cookie validation message is not associated with the invalid field');
  document.getElementById('cookieEditName').value='copy-me';
  document.getElementById('cookieEditDomain').value='copy.test';
  document.getElementById('cookieEditValue').value='copy-value';
  document.getElementById('cookieEditorSave').click();
  await waitFor(()=>window.__cookieStores['firefox-container-1'].some((c)=>c.name==='copy-me'),'created cookie');
  const copyRow=[...document.querySelectorAll('#cookieTable tr[data-cookie-index]')].find((row)=>row.innerText.includes('copy-me'));
  if(!copyRow)throw new Error('new cookie row missing');
  const copyCheck=copyRow.querySelector('.cookie-select');copyCheck.checked=true;copyCheck.dispatchEvent(new Event('change',{bubbles:true}));
  const target=document.getElementById('cookieCopyTarget');target.value='firefox-container-2';target.dispatchEvent(new Event('change',{bubbles:true}));
  document.getElementById('cookieCopySelected').click();
  await waitFor(()=>window.__cookieStores['firefox-container-2'].some((c)=>c.name==='copy-me'&&c.value==='copy-value'),'copied cookie');

  const beforeCookieExport=window.__downloads.length;
  document.getElementById('cookieExport').click();
  await acceptConfirmation('cookie export');
  await waitFor(()=>window.__downloads.length>beforeCookieExport,'cookie export');
  const cookieText=await readBlobText(window.__downloads.at(-1),'cookie export');const cookiePackage=JSON.parse(cookieText);
  if(cookiePackage.format!=='personamonkey-cookies'||cookiePackage.cookies.length<4)throw new Error('cookie package export incorrect');

  const personaTwo=document.querySelector('.cookie-persona-button[data-profile-id="firefox-container-2"]');personaTwo.click();
  await waitFor(()=>document.querySelector('.cookie-persona-button[data-profile-id="firefox-container-2"].active'),'target persona activation');
  await waitFor(()=>document.getElementById('cookieWorkspace')?.innerText.includes('personal-secret'),'target persona cookies');
  const importInput=document.getElementById('cookieImportFile');Object.defineProperty(importInput,'files',{configurable:true,value:[new File([cookieText],'work.personamonkey-cookies.json',{type:'application/json'})]});importInput.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor(()=>document.getElementById('cookieImportApply'),'cookie import preview');document.getElementById('cookieImportApply').click();
  await waitFor(()=>window.__cookieStores['firefox-container-2'].some((c)=>c.value==='work-edited'),'cookie import');

  document.querySelector('.cookie-persona-button[data-profile-id="firefox-container-1"]').click();
  await waitFor(()=>document.querySelector('.cookie-persona-button[data-profile-id="firefox-container-1"].active'),'source persona reselection');
  await waitFor(()=>document.getElementById('cookieWorkspace')?.innerText.includes('copy-value'),'source persona cookies reloaded');
  document.getElementById('cookieClearDomain').value='example.com';document.getElementById('cookieClearDomainButton').click();
  await acceptConfirmation('cookie domain clear');
  await waitFor(()=>window.__cookieStores['firefox-container-1'].every((c)=>!c.domain.endsWith('example.com')),'domain clear');
  if(!window.__cookieStores['firefox-container-2'].some((c)=>c.domain==='example.com'))throw new Error('domain clear touched another persona');
  document.getElementById('cookieFilter').value='definitely-no-match';document.getElementById('cookieFilter').dispatchEvent(new Event('input',{bubbles:true}));
  await waitFor(()=>document.querySelector('.cookie-empty-state'),'filtered cookie empty state');
  if(!document.querySelector('.cookie-empty-state').innerText.includes('No cookies match this filter'))throw new Error('filtered cookie empty state is ambiguous');
  document.getElementById('cookieClearFilter').click();
  await waitFor(()=>document.querySelector('#cookieTable tr[data-cookie-index]'),'cookie filter reset');

  const beforePersonaExport=window.__downloads.length;
  document.querySelector('#profilesTable tr[data-id="firefox-container-1"] .export-profile').click();
  await waitFor(()=>window.__downloads.length>beforePersonaExport,'persona quick export');
  const personaText=await readBlobText(window.__downloads.at(-1),'persona export');const personaPackage=JSON.parse(personaText);
  if(personaPackage.format!=='personamonkey-backup'||personaPackage.inventory?.personas!==1||personaPackage.inventory?.cookies!==0)throw new Error('persona quick export should be portable and non-sensitive');

  document.querySelector('[data-script-id="script-a"]').click();
  const exportScript=await waitFor(()=>document.getElementById('exportUserscriptFile'),'userscript export button');exportScript.click();
  await waitFor(()=>window.__downloads.some((blob)=>blob.type==='text/javascript'),'userscript download');

  setSmokeStage('backup-password-guard');
  document.getElementById('exportCompleteBackup').click();
  await waitFor(()=>document.getElementById('toast').textContent.includes('require a password'),'complete backup password guard');
  setSmokeStage('backup-selection');
  const persona=await waitFor(()=>document.querySelector('.backupPersona[value="firefox-container-1"]'),'persona selector');persona.checked=true;
  const personaBackupFilter=document.querySelector('.backup-filter[data-kind="Persona"]');
  if(!personaBackupFilter)throw new Error('backup persona filter missing');
  personaBackupFilter.value='Personal';personaBackupFilter.dispatchEvent(new Event('input',{bubbles:true}));
  if(!document.querySelector('.backupPersona[value="firefox-container-1"]').closest('label').hidden)throw new Error('backup persona filter did not hide non-matching persona');
  personaBackupFilter.value='';personaBackupFilter.dispatchEvent(new Event('input',{bubbles:true}));
  document.querySelector('.backup-select-none[data-kind="Persona"]').click();
  if(document.querySelectorAll('.backupPersona:checked').length!==0)throw new Error('backup Persona None control did not clear the selection');
  document.querySelector('.backup-select-all[data-kind="Persona"]').click();
  if(document.querySelectorAll('.backupPersona:checked').length!==document.querySelectorAll('.backupPersona').length)throw new Error('backup Persona All control did not select the collection');
  document.querySelector('.backup-select-none[data-kind="Persona"]').click();
  persona.checked=true;
  document.getElementById('backupIncludeCookies').checked=true;
  setSmokeStage('backup-sensitive-guard');
  document.getElementById('exportSelectedBackup').click();
  await waitFor(()=>document.getElementById('toast').textContent.includes('sensitive data'),'selective sensitive backup password guard');
  document.getElementById('backupIncludeCookies').checked=false;
  document.getElementById('backupIncludeHistory').checked=true;
  setSmokeStage('backup-download');
  const beforeBackup=window.__downloads.length;document.getElementById('exportSelectedBackup').click();
  await waitFor(()=>window.__downloads.length>beforeBackup,'selective backup download');
  setSmokeStage('backup-payload-read');
  const encoded=await readBlobText(window.__downloads.at(-1),'selective backup');const outer=JSON.parse(encoded);
  if(outer.encryption||!outer.payload)throw new Error('non-sensitive selective backup should remain inspectable plaintext');
  if(outer.inventory?.personas!==1||outer.inventory?.userscripts!==1)throw new Error('selective backup dependency inventory incorrect');
  setSmokeStage('backup-import-preview');
  const backupInput=document.getElementById('advancedImportFile');Object.defineProperty(backupInput,'files',{configurable:true,value:[new File([encoded],'smoke.personamonkey-backup.json',{type:'application/json'})]});document.getElementById('inspectAdvancedImport').click();
  await waitFor(()=>document.getElementById('confirmAdvancedImport'),'backup preview');
  const mapping=document.querySelector('.backupPersonaBinding');if(!mapping||mapping.value!=='firefox-container-1')throw new Error('persona mapping was not suggested');
  setSmokeStage('backup-import');
  const before=window.__saveCount;document.getElementById('confirmAdvancedImport').click();await waitFor(()=>window.__saveCount>before,'backup import');
  await waitFor(()=>document.getElementById('toast').innerText.includes('Backup imported'),'backup import completion');
  if(window.__runtimeReloads!==0)throw new Error('backup import reloaded the extension runtime');
  setSmokeStage('recovery');
  const recoveryOptIn=document.getElementById('enableRecoverySync');recoveryOptIn.checked=true;recoveryOptIn.dispatchEvent(new Event('change',{bubbles:true}));
  await waitFor(()=>document.querySelector('dialog.confirmation-dialog[open]'),'recovery consent review');
  [...document.querySelector('dialog.confirmation-dialog[open]').querySelectorAll('button')].at(-1).click();
  // Recovery snapshot generation performs compression + hashing before publishing
  // its generation atomically. Give that crypto/stream path extra CI headroom
  // without weakening the normal UI waits used throughout this smoke test.
  await waitForSlow(()=>window.__sync.personaRecoveryMetaV1?.available===true,'consented sync recovery snapshot');
  await waitForSlow(()=>document.getElementById('recoveryStatus').innerText.includes('Enabled here'),'recovery status');
  if(window.__errors.length)throw new Error('browser errors: '+JSON.stringify(window.__errors));

  // Return to the primary backup subview before optional screenshot capture.
  document.querySelector('#backupSectionNav [data-backup-view="backup"]')?.click();
  document.getElementById('backupSectionNav')?.scrollIntoView({block:'start'});

  setSmokeStage('pass');
  result.textContent='PASS';document.body.append(result);document.title='PASS';
}catch(error){result.textContent='FAIL: '+(error?.stack||error);document.body.append(result);document.title='FAIL';}
</script></body></html>`;
writeFileSync(join(temp, "data-smoke.html"), html);

const mime = new Map([[".html","text/html; charset=utf-8"],[".js","text/javascript; charset=utf-8"],[".css","text/css; charset=utf-8"]]);
const server=createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,"http://127.0.0.1").pathname);const relative=normalize(pathname).replace(/^[/\\]+/,"");const base=relative.startsWith('lib/')||relative.startsWith('options/')?extensionRoot:temp;const target=resolve(base,relative);if(!target.startsWith(base)){res.writeHead(403).end();return;}try{const body=readFileSync(target);res.writeHead(200,{"Content-Type":mime.get(extname(target))||"application/octet-stream","Cache-Control":"no-store"});res.end(body);}catch{res.writeHead(404).end('not found');}});
await new Promise((resolvePromise)=>server.listen(0,"127.0.0.1",resolvePromise));
const port=server.address().port;
const candidates=[process.env.CHROME_BIN,"google-chrome","chromium","chromium-browser"].filter(Boolean);
const viewports=[{name:"desktop",size:"1280,900"},{name:"mobile",size:"390,844"}];
let browser=null;
for(const command of candidates){
  let unavailable=false;
  for(const viewport of viewports){
    const [width,height]=viewport.size.split(",").map(Number);
    const pageUrl=`http://127.0.0.1:${port}/data-smoke.html?viewport=${viewport.name}`;
    const child=spawn(command,["--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",`--window-size=${viewport.size}`,"--virtual-time-budget=120000","--dump-dom",pageUrl],{stdio:["ignore","pipe","pipe"]});
    const chunks=[],errors=[];
    child.stdout.on("data",(c)=>chunks.push(c));
    child.stderr.on("data",(c)=>errors.push(c));
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
      throw new Error(`${command} data-management smoke exited ${childResult.code} at ${viewport.name} (${viewport.size})\n${stderr.slice(-4000)}`);
    }
    if(!stdout.includes('<div id="result">PASS</div>')){
      server.close();
      const decode=(value)=>value
        ?.replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
      const resultText=decode(stdout.match(/<div[^>]*id="result"[^>]*>([\s\S]*?)<\/div>/i)?.[1])
        ?.replace(/<[^>]+>/g,"")
        .trim();
      const detail=resultText?.startsWith("FAIL:") ? resultText.slice(5).trim() : "";
      const stage=decode(stdout.match(/<body[^>]*\bdata-smoke-stage="([^"]*)"/i)?.[1]) || "unknown";
      throw new Error(`Data-management browser smoke failed using ${command} at ${viewport.name} (${viewport.size}).\nSmoke stage: ${stage}${detail ? `\nBrowser assertion:\n${detail}` : ""}\nDOM tail:\n${stdout.slice(-20000)}\nBrowser stderr:\n${stderr.slice(-4000)}`);
    }
    await captureBrowserScreenshot({command,url:pageUrl,width,height,name:`data-${viewport.name}`,virtualTimeBudget:50000,timeoutMs:65000});
  }
  if(!unavailable){browser=command;break;}
}
server.close();
if(!browser)throw new Error('No Chrome/Chromium executable available for data-management smoke test');
console.log(`Persona cookie workspace + backup + recovery browser smoke passed in ${browser} at desktop and mobile widths`);
