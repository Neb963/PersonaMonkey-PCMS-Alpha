import assert from 'node:assert/strict';
import { createPersonaPackage } from '../lib/persona-package.js';

const listeners = {};
const event = (name) => ({ addListener(fn){ listeners[name] = fn; }, removeListener(){}, hasListener(){return true;} });
const nativeRequests = [];
let nativeBridgeVersion = '0.3.0';
function nativeEvent() {
  const callbacks = new Set();
  return {
    addListener(fn){ callbacks.add(fn); },
    removeListener(fn){ callbacks.delete(fn); },
    emit(value){ for (const fn of [...callbacks]) fn(value); }
  };
}
function connectNative() {
  const onMessage = nativeEvent();
  const onDisconnect = nativeEvent();
  return {
    onMessage,
    onDisconnect,
    postMessage(message) {
      nativeRequests.push(structuredClone(message));
      let response = {id:message.id,ok:true};
      if (message.command === 'status') {
        response = {id:message.id,ok:true,version:nativeBridgeVersion,ready:true,selected_entry:'test-entry',interface_up:true};
      } else if (message.command === 'prepare_exit') {
        response = {
          id:message.id,ok:true,ready:true,selected_entry:'test-entry',
          local_host:'127.0.0.1',local_port:19090,
          route_id:message.route_id,relay_ip:message.relay_ip,relay_port:message.relay_port
        };
      } else if (message.command === 'stop') {
        response = {id:message.id,ok:true,ready:false,stopped:true,selected_entry:'test-entry'};
      }
      queueMicrotask(() => onMessage.emit(response));
    },
    disconnect(){}
  };
}
let stored = {
  state: {
    schemaVersion:1,
    global:{
      profileTargetCount:30, profileNamePrefix:'Persona', unmanagedPolicy:'direct', blockSpeculative:true,
      strictProxyVerification:true, enforcePrivacyControls:true, disableNetworkPrediction:true,
      webRTCMode:'proxy_only', autoReloadOnRouteChange:true
    },
    profiles:{'firefox-container-1':{containerId:'firefox-container-1',managed:true,name:'P1',routeId:'r1',killSwitch:true,blockLocalNetwork:true,domainMode:'any',allowedDomains:[],blockedDomains:[],scriptIds:[],owned:true,status:'temporary',expiresAt:new Date(Date.now()+3600000).toISOString()}},
    routes:{r1:{id:'r1',name:'R1',provider:'mullvad',type:'socks',host:'10.124.1.240',port:1080,proxyDNS:true,enabled:true,username:'private-user',password:'private-password'}},
    scripts:{}, wireguardImports:[]
  }
};
function setting(value){
  let v=value;
  return { async get(){return {value:v,levelOfControl:'controllable_by_this_extension'};}, async set({value}){v=value;return true;}, onChange:event('setting'+Math.random()) };
}
const routeTestFetches=[];
const routeTestProxyDecisions=[];
const routeTestBeforeDecisions=[];
let dnsObservationsAvailable = true;
let conflictingDnsObservation = false;
let mullvadExitAvailable = true;
let forceRouteTestProxyMismatch = false;
let failPrimaryConnectionCheck = false;
let blockNextPrimaryCheck = false;
let primaryCheckEntered = null;
let releaseBlockedPrimaryCheck = null;
let tabsCreated = 0;
let tabUpdates = 0;
let tabMessages = 0;

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  const isConnectionCheck = target === 'https://am.i.mullvad.net/json'
    || target === 'https://ipv4.am.i.mullvad.net/json';
  const isDnsCheck = target.endsWith('.dnsleak.am.i.mullvad.net/');
  if (!isConnectionCheck && !isDnsCheck) throw new Error(`Unexpected background fetch: ${target}`);

  const details = {
    url: target,
    type: 'xmlhttprequest',
    tabId: -1,
    documentUrl: 'moz-extension://test/background.js'
  };
  const proxyDecision = await listeners['proxy.onRequest'](details);
  routeTestFetches.push({
    target,
    cache: options.cache,
    credentials: options.credentials,
    redirect: options.redirect,
    referrerPolicy: options.referrerPolicy
  });
  routeTestProxyDecisions.push(structuredClone(proxyDecision));

  const expectedProxy = Array.isArray(proxyDecision) ? proxyDecision[0] : proxyDecision;
  const proxyInfo = forceRouteTestProxyMismatch ? {type:'direct'} : expectedProxy;
  const beforeDecision = await listeners['webRequest.onBeforeRequest']({...details, proxyInfo});
  routeTestBeforeDecisions.push(structuredClone(beforeDecision));
  if (beforeDecision?.cancel) throw new Error('Route-test request was cancelled');

  if (blockNextPrimaryCheck && target === 'https://ipv4.am.i.mullvad.net/json') {
    blockNextPrimaryCheck = false;
    primaryCheckEntered?.();
    await new Promise((resolve) => { releaseBlockedPrimaryCheck = resolve; });
  }

  if (failPrimaryConnectionCheck && target === 'https://ipv4.am.i.mullvad.net/json') {
    return {ok:false,status:503,async json(){return {};}};
  }

  return {
    ok: true,
    status: 200,
    async json() {
      if (isConnectionCheck) {
        return {
          ip:'203.0.113.10',
          country:'Test',
          city:'Test City',
          mullvad_exit_ip:mullvadExitAvailable,
          mullvad_exit_ip_hostname:mullvadExitAvailable ? 'test-wg-socks5-001' : undefined
        };
      }
      if (!dnsObservationsAvailable) return [];
      if (conflictingDnsObservation) {
        return [
          {ip:'198.51.100.53',mullvad_dns:false,organization:'Unexpected DNS'},
          {ip:'198.51.100.53',mullvad_dns:true,mullvad_dns_hostname:'test-dns'}
        ];
      }
      return [{ip:'198.51.100.53',mullvad_dns:true,mullvad_dns_hostname:'test-dns'}];
    }
  };
};

const contextualIdentityState = new Map([
  ['firefox-container-1', {cookieStoreId:'firefox-container-1',name:'P1',color:'blue',icon:'fingerprint'}]
]);

globalThis.browser = {
  runtime:{
    id:'persona-route-manager@local',
    getURL:()=> 'moz-extension://test/',
    getManifest:()=>({version:'0.7.0'}),
    connectNative,
    onMessage:event('runtime.onMessage'),
    onConnect:event('runtime.onConnect'),
    onMessageExternal:event('runtime.onMessageExternal'),
    onConnectExternal:event('runtime.onConnectExternal'),
    onInstalled:event('runtime.onInstalled')
  },
  storage:{ local:{ async get(){return stored;}, async set(obj){stored={...stored,...obj};} }, onChanged:event('storage.onChanged') },
  privacy:{ network:{ networkPredictionEnabled:setting(true), peerConnectionEnabled:setting(true), webRTCIPHandlingPolicy:setting('default') } },
  proxy:{ onRequest:event('proxy.onRequest'), onError:event('proxy.onError'), settings:{async get(){return {levelOfControl:'controllable_by_this_extension'};},onChange:event('proxy.settings.onChange')} },
  webRequest:{ onBeforeRequest:event('webRequest.onBeforeRequest') },
  webNavigation:{ onCommitted:event('webNavigation.onCommitted'), onDOMContentLoaded:event('webNavigation.onDOMContentLoaded'), onCompleted:event('webNavigation.onCompleted') },
  contextualIdentities:{
    async query(){return [...contextualIdentityState.values()].map(value=>structuredClone(value));},
    async get(id){
      const value=contextualIdentityState.get(id);
      if(!value) throw new Error('Contextual identity not found');
      return structuredClone(value);
    },
    async create(details){
      const created={cookieStoreId:'firefox-container-rotated',...structuredClone(details)};
      contextualIdentityState.set(created.cookieStoreId,created);
      return structuredClone(created);
    },
    async update(id,changes){
      const value=contextualIdentityState.get(id);
      if(!value) throw new Error('Contextual identity not found');
      Object.assign(value,structuredClone(changes));
      return structuredClone(value);
    },
    async remove(id){
      if(!contextualIdentityState.has(id)) throw new Error('Contextual identity not found');
      contextualIdentityState.delete(id);
    },
    onUpdated:event('contextualIdentities.onUpdated'), onRemoved:event('contextualIdentities.onRemoved'),
    async getSupportedColors(){return [{color:'blue'}];}, async getSupportedIcons(){return [{icon:'fingerprint'}];}
  },
  tabs:{
    async query(){return [];},
    async reload(){},
    async get(){throw new Error('not used');},
    async create(){tabsCreated++; throw new Error('route verification must not create a page tab');},
    async update(){tabUpdates++; throw new Error('route verification must not navigate a page tab');},
    async sendMessage(){tabMessages++; throw new Error('route verification must not use a content-script probe');},
    async remove(){},
    onActivated:event('tabs.onActivated'),
    onUpdated:event('tabs.onUpdated'),
    onRemoved:event('tabs.onRemoved')
  },
  cookies:{ async getAll(){return [];}, async remove(){}, async set(){return {};} },
  browsingData:{ async remove(){} },
  permissions:{ async contains(){return false;} },
  scripting:{ async executeScript(){throw new Error('Missing host permission for the tab');} },
};

await import('../background.js?smoke=1');
await new Promise(r=>setTimeout(r,20));
assert.equal(typeof listeners['proxy.onRequest'], 'function');
assert.equal(typeof listeners['webRequest.onBeforeRequest'], 'function');
assert.equal(typeof listeners['runtime.onMessage'], 'function');
assert.equal(typeof listeners['runtime.onConnect'], 'function');
assert.equal(typeof listeners['runtime.onMessageExternal'], 'function');
assert.equal(typeof listeners['runtime.onConnectExternal'], 'function');

const extensionSender = { id:'persona-route-manager@local', url:'moz-extension://test/options/options.html' };
const contentSender = { id:'persona-route-manager@local', url:'https://example.com/', tab:{id:1,url:'https://example.com/'} };

await assert.rejects(listeners['runtime.onMessage']({
  type:'IMPORT_AUTOMATION_HISTORY', jobs:[]
}, contentSender), /Privileged extension message rejected/);
await assert.rejects(listeners['runtime.onMessage']({
  type:'IMPORT_AUTOMATION_HISTORY', jobs:[]
}, {id:extensionSender.id,url:'moz-extension://test/popup/popup.html'}), /restricted to local PersonaMonkey settings/);
const importedHistory = await listeners['runtime.onMessage']({
  type:'IMPORT_AUTOMATION_HISTORY',
  jobs:[
    {id:'local-imported-job',workflowId:'workflow-local',state:'completed',tasks:[]},
    {id:'spoofed-external-job',workflowId:'external-exec',state:'completed',externalOwner:{senderId:'spoofed-sender'},tasks:[]}
  ]
}, extensionSender);
assert.equal(importedHistory.jobs.some((job)=>job.id==='local-imported-job'),true);
assert.equal(importedHistory.jobs.some((job)=>job.id==='spoofed-external-job'||job.externalOwner),false,
  'local history import cannot create or forge external ownership');
assert.equal((await listeners['runtime.onMessage']({type:'LIST_AUTOMATION_JOBS',limit:100},extensionSender)).jobs.some((job)=>job.id==='local-imported-job'),true);

const described = await listeners['runtime.onMessage']({
  type: 'PCMS_REQUEST', version: 1, requestId: 'describe-smoke', command: 'system.describe', params: {}
}, extensionSender);
assert.equal(described.ok, true);
assert.equal(described.requestId, 'describe-smoke');
assert.equal(described.result.protocolVersion, 1);
assert.ok(described.result.capabilities.includes('personas'));

const routes = await listeners['runtime.onMessage']({
  type: 'PCMS_REQUEST', version: 1, requestId: 'routes-smoke', command: 'route.list', params: {}
}, extensionSender);
assert.equal(routes.ok, true);

// External Integration API is disabled by default, can only be authorized from
// the trusted PersonaMonkey extension page, and never forwards legacy PCMS_REQUEST.
const trustedExternalSender = { id:'pcms@example.test', url:'moz-extension://pcms/options.html' };
const unknownExternalSender = { id:'unknown@example.test', url:'moz-extension://unknown/options.html' };
const externalDescribe = (requestId) => ({
  type:'PERSONAMONKEY_INTEGRATION_REQUEST',
  version:1,
  requestId,
  command:'system.describe',
  params:{}
});
const disabledExternal = await listeners['runtime.onMessageExternal'](
  externalDescribe('external-disabled'),
  trustedExternalSender
);
assert.equal(disabledExternal.ok, false);
assert.equal(disabledExternal.error.code, 'INTEGRATION_DISABLED');

const initialIntegrationPolicy = await listeners['runtime.onMessage'](
  { type:'GET_INTEGRATION_POLICY' },
  extensionSender
);
assert.deepEqual(initialIntegrationPolicy.policy, {
  enabled:false,
  trustedExtensionIds:[],
  allowDestructive:false,
  allowDirect:false,
  allowExternalAutomation:false,
  allowExecutableInstall:false
});
const newIntegrationPolicy = {
    enabled:true,
    trustedExtensionIds:['pcms@example.test'],
    allowDestructive:false,
    allowDirect:false,
    allowExternalAutomation:false,
    allowExecutableInstall:false
};
await assert.rejects(listeners['runtime.onMessage']({
  type:'UPDATE_INTEGRATION_POLICY', policy:newIntegrationPolicy
}, extensionSender), (error) => error?.code === 'SECURITY_AUTHORIZATION_REQUIRED');
const policyPreview = await listeners['runtime.onMessage']({
  type:'PREVIEW_INTEGRATION_POLICY', policy:newIntegrationPolicy
}, extensionSender);
await assert.rejects(listeners['runtime.onMessage']({
  type:'AUTHORIZE_SECURITY_PREVIEW',previewId:policyPreview.previewId,approvedDelta:policyPreview.delta
}, {id:extensionSender.id,url:'moz-extension://test/popup/popup.html'}),
  (error)=>error?.code==='SECURITY_AUTHORIZATION_REQUIRED');
assert.deepEqual(policyPreview.delta.filter((entry) => entry.kind === 'trusted-extension-added').map((entry) => entry.path),
  ['global.integration.trustedExtensionIds["pcms@example.test"]']);
const policyApproval = await listeners['runtime.onMessage']({
  type:'AUTHORIZE_SECURITY_PREVIEW', previewId:policyPreview.previewId, approvedDelta:policyPreview.delta
}, extensionSender);
await assert.rejects(listeners['runtime.onMessage']({
  type:'UPDATE_INTEGRATION_POLICY', policy:{...newIntegrationPolicy,allowDirect:true}, authorizationId:policyApproval.authorizationId
},extensionSender),/changed after preview/,
  'an authorization ID cannot commit a policy different from the exact preview it approved');
const updatedIntegrationPolicy = await listeners['runtime.onMessage']({
  type:'UPDATE_INTEGRATION_POLICY', policy:newIntegrationPolicy, authorizationId:policyApproval.authorizationId
}, extensionSender);
assert.equal(updatedIntegrationPolicy.policy.enabled, true);
assert.deepEqual(updatedIntegrationPolicy.policy.trustedExtensionIds, ['pcms@example.test']);
const relayPreview = await listeners['runtime.onMessage']({type:'CREATE_MULLVAD_ROUTE',relay:{ipv4_address:'198.51.100.9',port:1080,country:'Test'}},extensionSender);
assert.equal(relayPreview.delta[0].kind,'proxy-destination-added');
assert.equal(relayPreview.delta[0].after.host,'198.51.100.9');
await assert.rejects(listeners['runtime.onMessage']({type:'CREATE_MULLVAD_ROUTE',authorizationId:relayPreview.previewId},extensionSender),
  (error)=>error?.code==='SECURITY_AUTHORIZATION_REQUIRED');
await listeners['runtime.onMessage']({type:'AUTHORIZE_SECURITY_PREVIEW',previewId:relayPreview.previewId,approvedDelta:relayPreview.delta},extensionSender);
const addedRelay = await listeners['runtime.onMessage']({type:'CREATE_MULLVAD_ROUTE',authorizationId:relayPreview.previewId},extensionSender);
assert.equal(addedRelay.route.host,'198.51.100.9');

const authorizedExternal = await listeners['runtime.onMessageExternal'](
  externalDescribe('external-authorized'),
  trustedExternalSender
);
assert.equal(authorizedExternal.ok, true);
assert.equal(authorizedExternal.result.integrationProtocolVersion, 1);
assert.equal(authorizedExternal.result.commands.every((entry) => typeof entry.batchable === 'boolean'), true);

// Prove legacy/local entrypoints share Persona control admission. The gate must
// reject the local side effect before the underlying Persona manager runs.
const automationPolicy = { ...newIntegrationPolicy, allowExternalAutomation: true };
const automationPreview = await listeners['runtime.onMessage']({
  type:'PREVIEW_INTEGRATION_POLICY', policy:automationPolicy
}, extensionSender);
const automationApproval = await listeners['runtime.onMessage']({
  type:'AUTHORIZE_SECURITY_PREVIEW', previewId:automationPreview.previewId, approvedDelta:automationPreview.delta
}, extensionSender);
await listeners['runtime.onMessage']({
  type:'UPDATE_INTEGRATION_POLICY', policy:automationPolicy, authorizationId:automationApproval.authorizationId
}, extensionSender);
const fenceSnapshot = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'}, extensionSender);
const fencePersona = fenceSnapshot.state.profiles['firefox-container-1'];
assert.ok(fencePersona?.personaUid, 'managed Persona receives its stable UID during initialization');
fenceSnapshot.state.workflows.localFenceTest = {
  id:'localFenceTest', name:'Local fence test', enabled:true,
  steps:[{id:'fence-step',profileId:'firefox-container-1',urls:['https://example.com/'],concurrency:1,scriptIds:[],completion:{mode:'load',timeoutMs:1000},retries:0,retryDelayMs:0}]
};
fenceSnapshot.state.scripts.localFenceScript = {
  id:'localFenceScript', name:'Fence test script', namespace:'fence-test', version:'1', enabled:true,
  code:'', matches:['https://example.com/*'], profileIds:['firefox-container-1'], grants:[], connects:[]
};
await listeners['runtime.onMessage']({type:'SAVE_STATE',state:fenceSnapshot.state},extensionSender);
async function integrationRequest(requestId,operationId,command,params) {
  const latest = await listeners['runtime.onMessage']({
    type:'PCMS_REQUEST', version:1, requestId:`${requestId}-describe`, command:'system.describe', params:{}
  },extensionSender);
  return listeners['runtime.onMessageExternal']({
    type:'PERSONAMONKEY_INTEGRATION_REQUEST', version:1, requestId, operationId, command, params,
    precondition:{bootId:latest.bootId,revision:latest.revision}
  },trustedExternalSender);
}
const acquiredFenceLease = await integrationRequest(
  'fence-lease-acquire','fence-lease-acquire-op','persona.control.acquire',
  {personaUid:fencePersona.personaUid,purpose:'local mutation fence test',ttlMs:60000}
);
assert.equal(acquiredFenceLease.ok,true,JSON.stringify(acquiredFenceLease.error));
const harmlessPolicyEdit = { ...automationPolicy, allowDestructive:true };
const harmlessPolicyPreview = await listeners['runtime.onMessage']({type:'PREVIEW_INTEGRATION_POLICY',policy:harmlessPolicyEdit},extensionSender);
const harmlessPolicyApproval = await listeners['runtime.onMessage']({type:'AUTHORIZE_SECURITY_PREVIEW',previewId:harmlessPolicyPreview.previewId,approvedDelta:harmlessPolicyPreview.delta},extensionSender);
await listeners['runtime.onMessage']({type:'UPDATE_INTEGRATION_POLICY',policy:harmlessPolicyEdit,authorizationId:harmlessPolicyApproval.authorizationId},extensionSender);
assert.ok((await listeners['runtime.onMessage']({type:'GET_EXTERNAL_AUTOMATION_CONTROL_LEASES'},extensionSender)).leases
  .some((lease) => lease.leaseId === acquiredFenceLease.result.leaseId),
  'policy edits retain leases owned by a sender that remains authorized');
const routeBeforeFence = (await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender)).state.profiles['firefox-container-1'].routeId;
const packageStateWithChangedScript = (await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender)).state;
packageStateWithChangedScript.scripts.localFenceScript.enabled = false;
const packageBeforeFence = await createPersonaPackage({
  profileId:'firefox-container-1',state:packageStateWithChangedScript,
  container:{name:'P1',color:'blue',icon:'fingerprint'},appVersion:'test'
});
const scriptStateBeforeImportFence = (await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender)).state.scripts.localFenceScript;
const containersBeforeImportFence = (await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender)).containers;
await assert.rejects(listeners['runtime.onMessage']({
  type:'IMPORT_PERSONA_PACKAGE',bytes:Array.from(packageBeforeFence)
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY',
  'package import that could overwrite an assigned script is fenced across existing Personas');
assert.deepEqual((await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender)).state.scripts.localFenceScript,
  scriptStateBeforeImportFence, 'a blocked Persona package import leaves the assigned script unchanged');
assert.ok((await listeners['runtime.onMessage']({type:'GET_EXTERNAL_AUTOMATION_CONTROL_LEASES'},extensionSender)).leases
  .some((lease) => lease.leaseId === acquiredFenceLease.result.leaseId), 'a blocked package import preserves the active lease');
assert.deepEqual((await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender)).containers,containersBeforeImportFence,
  'blocked package import rejects before creating a Persona or container');
const policyOnlySave = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
policyOnlySave.state.global.integration.allowExecutableInstall = true;
const policyOnlySavePreview = await listeners['runtime.onMessage']({type:'PREVIEW_STATE_CHANGE',state:policyOnlySave.state},extensionSender);
await listeners['runtime.onMessage']({type:'AUTHORIZE_SECURITY_PREVIEW',previewId:policyOnlySavePreview.previewId,approvedDelta:policyOnlySavePreview.delta},extensionSender);
await listeners['runtime.onMessage']({
  type:'SAVE_STATE',state:policyOnlySave.state,authorizationId:policyOnlySavePreview.previewId
},extensionSender);
assert.ok((await listeners['runtime.onMessage']({type:'GET_EXTERNAL_AUTOMATION_CONTROL_LEASES'},extensionSender)).leases
  .some((lease) => lease.leaseId === acquiredFenceLease.result.leaseId),
  'policy-only SAVE_STATE succeeds and retains a lease owned by a still-authorized sender');
async function mixedPolicyStateCandidate(routeId) {
  const snapshot = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
  snapshot.state.global.integration.trustedExtensionIds = [
    ...snapshot.state.global.integration.trustedExtensionIds, 'additional-reviewed-sender@example.test'
  ];
  snapshot.state.profiles['firefox-container-1'].routeId = routeId;
  return snapshot.state;
}
const mixedSaveState = await mixedPolicyStateCandidate('__block__');
const mixedSavePreview = await listeners['runtime.onMessage']({type:'PREVIEW_STATE_CHANGE',state:mixedSaveState},extensionSender);
await listeners['runtime.onMessage']({type:'AUTHORIZE_SECURITY_PREVIEW',previewId:mixedSavePreview.previewId,approvedDelta:mixedSavePreview.delta},extensionSender);
await assert.rejects(listeners['runtime.onMessage']({
  type:'SAVE_STATE',state:mixedSaveState,authorizationId:mixedSavePreview.previewId
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY',
  'mixed SAVE_STATE policy and route edits reject while a retained sender leases the Persona');
let afterMixedSave = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
assert.equal(afterMixedSave.state.profiles['firefox-container-1'].routeId,routeBeforeFence,
  'rejected mixed SAVE_STATE does not partially commit the route edit');
assert.equal(afterMixedSave.state.global.integration.trustedExtensionIds.includes('additional-reviewed-sender@example.test'),false,
  'rejected mixed SAVE_STATE does not partially commit the policy edit');
const mixedCommitState = await mixedPolicyStateCandidate('__block__');
const mixedCommitPreview = await listeners['runtime.onMessage']({type:'PREVIEW_STATE_CHANGE',state:mixedCommitState},extensionSender);
await listeners['runtime.onMessage']({type:'AUTHORIZE_SECURITY_PREVIEW',previewId:mixedCommitPreview.previewId,approvedDelta:mixedCommitPreview.delta},extensionSender);
await assert.rejects(listeners['runtime.onMessage']({
  type:'COMMIT_STATE_PREVIEW',authorizationId:mixedCommitPreview.previewId
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY',
  'mixed COMMIT_STATE_PREVIEW policy and route edits reject while a retained sender leases the Persona');
afterMixedSave = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
assert.equal(afterMixedSave.state.profiles['firefox-container-1'].routeId,routeBeforeFence,
  'rejected mixed preview commit does not partially commit the route edit');
assert.equal(afterMixedSave.state.global.integration.trustedExtensionIds.includes('additional-reviewed-sender@example.test'),false,
  'rejected mixed preview commit does not partially commit the policy edit');
await assert.rejects(listeners['runtime.onMessage']({
  type:'UPDATE_PROFILE_ROUTE',profileId:'firefox-container-1',routeId:'__direct__',allowDirect:true
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY');
await assert.rejects(listeners['runtime.onMessage']({
  type:'FULL_WIPE_PERSONA',profileId:'firefox-container-1'
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY');
await assert.rejects(listeners['runtime.onMessage']({
  type:'ARCHIVE_PERSONA',profileId:'firefox-container-1'
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY');
await assert.rejects(listeners['runtime.onMessage']({
  type:'PERSONA_COOKIES_CLEAR',profileId:'firefox-container-1'
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY');
await assert.rejects(listeners['runtime.onMessage']({
  type:'PERSONA_COOKIES_IMPORT',profileId:'firefox-container-1',records:[],mode:'merge'
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY');
await assert.rejects(listeners['runtime.onMessage']({
  type:'PERSONA_API',namespace:'WorkflowRunner',method:'run',args:['localFenceTest']
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY',
  'legacy WorkflowRunner.run cannot bypass exact local workflow admission');
await assert.rejects(listeners['runtime.onMessage']({
  type:'PERSONA_API',namespace:'WorkflowRunner',method:'delete',args:['localFenceTest']
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY',
  'dynamic workflow methods with non-Persona identifiers still fence all Personas');
await assert.rejects(listeners['runtime.onMessage']({
  type:'PERSONA_API',namespace:'UserscriptManager',method:'assign',args:['localFenceScript','firefox-container-1']
},extensionSender), (error) => error?.code === 'PERSONA_CONTROL_BUSY',
  'dynamic UserscriptManager mutations resolve the second argument as the Persona target');
await assert.rejects(listeners['runtime.onMessage']({
  type:'RUN_WORKFLOW',workflowId:'localFenceTest',overrideConfirmation:{expectedPersonaUids:[fencePersona.personaUid],leases:[],takeControl:false}
},extensionSender), (error) => ['PERSONA_CONTROL_BUSY','PERSONA_CONTROL_LEASE_LOST'].includes(error?.code),
  'local workflow admission rejects a lease snapshot that omits the active control lease');
const stateCopy = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
stateCopy.state.profiles['firefox-container-1'].routeId = '__direct__';
await assert.rejects(listeners['runtime.onMessage']({type:'SAVE_STATE',state:stateCopy.state},extensionSender),
  (error) => error?.code === 'PERSONA_CONTROL_BUSY', 'state writes that change a leased Persona route are blocked');
const scriptEdit = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
scriptEdit.state.scripts.localFenceScript.code = '/* changed assigned script */';
await assert.rejects(listeners['runtime.onMessage']({type:'SAVE_STATE',state:scriptEdit.state},extensionSender),
  (error) => error?.code === 'PERSONA_CONTROL_BUSY', 'script assignment state writes are fenced for every affected Persona');
const routeStateExport = await listeners['runtime.onMessage']({type:'EXPORT_STATE',includeSecrets:true},extensionSender);
const importPreview = await listeners['runtime.onMessage']({type:'IMPORT_STATE',payload:routeStateExport,mode:'replace'},extensionSender);
if (importPreview.delta?.length) await listeners['runtime.onMessage']({
  type:'AUTHORIZE_SECURITY_PREVIEW',previewId:importPreview.previewId,approvedDelta:importPreview.delta
},extensionSender);
await assert.rejects(listeners['runtime.onMessage']({type:'IMPORT_STATE',authorizationId:importPreview.previewId,mode:'replace'},extensionSender),
  (error) => error?.code === 'PERSONA_CONTROL_BUSY', 'state import commits are blocked while a target Persona is externally controlled');
const nativeCallsBeforeFence = nativeRequests.length;
await assert.rejects(listeners['runtime.onMessage']({type:'MULLVAD_STOP'},extensionSender),
  (error) => error?.code === 'PERSONA_CONTROL_BUSY', 'native route changes are blocked while a mapped Persona is externally controlled');
assert.equal(nativeRequests.length,nativeCallsBeforeFence,'rejected native route changes never reach the native bridge');
assert.equal((await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender)).state.profiles['firefox-container-1'].routeId,routeBeforeFence);
const disabledAutomationPolicy = { ...harmlessPolicyEdit, allowExternalAutomation:false };
const mixedRevocationState = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
mixedRevocationState.state.global.integration = disabledAutomationPolicy;
mixedRevocationState.state.profiles['firefox-container-1'].routeId = '__block__';
const mixedRevocationPreview = await listeners['runtime.onMessage']({type:'PREVIEW_STATE_CHANGE',state:mixedRevocationState.state},extensionSender);
if (mixedRevocationPreview.delta.length) await listeners['runtime.onMessage']({
  type:'AUTHORIZE_SECURITY_PREVIEW',previewId:mixedRevocationPreview.previewId,approvedDelta:mixedRevocationPreview.delta
},extensionSender);
await listeners['runtime.onMessage']({type:'COMMIT_STATE_PREVIEW',authorizationId:mixedRevocationPreview.previewId},extensionSender);
assert.equal((await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender)).state.profiles['firefox-container-1'].routeId,'__block__',
  'a mixed policy and Persona edit can commit when its policy revokes the lease owner');
assert.equal((await listeners['runtime.onMessage']({type:'GET_EXTERNAL_AUTOMATION_CONTROL_LEASES'},extensionSender)).leases
  .some((lease) => lease.leaseId === acquiredFenceLease.result.leaseId),false,
  'mixed policy commit revokes the removed sender lease before committing');
const restoredFenceState = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
restoredFenceState.state.profiles['firefox-container-1'].routeId = routeBeforeFence;
await listeners['runtime.onMessage']({type:'SAVE_STATE',state:restoredFenceState.state},extensionSender);

const unknownExternal = await listeners['runtime.onMessageExternal'](
  externalDescribe('external-unknown'),
  unknownExternalSender
);
assert.equal(unknownExternal.ok, false);
assert.equal(unknownExternal.error.code, 'INTEGRATION_UNAUTHORIZED');

const selfExternal = await listeners['runtime.onMessageExternal'](
  externalDescribe('external-self'),
  extensionSender
);
assert.equal(selfExternal.ok, false);
assert.equal(selfExternal.error.code, 'INTEGRATION_UNAUTHORIZED');

const legacyExternal = await listeners['runtime.onMessageExternal']({
  type:'PCMS_REQUEST',
  version:1,
  requestId:'external-legacy',
  command:'system.describe',
  params:{}
}, trustedExternalSender);
assert.equal(legacyExternal.ok, false);
assert.equal(legacyExternal.error.code, 'INTEGRATION_BAD_REQUEST');

let untrustedExternalDisconnected = false;
listeners['runtime.onConnectExternal']({
  name:'PERSONAMONKEY_INTEGRATION_EVENTS',
  sender:unknownExternalSender,
  postMessage(){ throw new Error('untrusted external port attached'); },
  disconnect(){ untrustedExternalDisconnected = true; },
  onDisconnect:{ addListener(){} }
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(untrustedExternalDisconnected, true);

const externalEventMessages = [];
let externalDisconnectListener;
listeners['runtime.onConnectExternal']({
  name:'PERSONAMONKEY_INTEGRATION_EVENTS',
  sender:trustedExternalSender,
  postMessage(message){ externalEventMessages.push(message); },
  disconnect(){},
  onDisconnect:{ addListener(fn){ externalDisconnectListener = fn; } }
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(typeof externalDisconnectListener, 'function');

const freshSnapshot = await listeners['runtime.onMessage']({ type:'GET_SNAPSHOT' }, extensionSender);
const metadataFree = structuredClone(freshSnapshot.state);
delete metadataFree.__stateMeta;
await assert.rejects(
  listeners['runtime.onMessage']({ type:'SAVE_STATE', state:metadataFree }, extensionSender),
  (error) => error?.code === 'STATE_CONFLICT'
);
const validSave = await listeners['runtime.onMessage']({ type:'SAVE_STATE', state:freshSnapshot.state }, extensionSender);
assert.ok(validSave.state.__stateMeta, 'fresh compatibility snapshots must remain writable with revision metadata');
await assert.rejects(
  listeners['runtime.onMessage']({type:'UPDATE_PROFILE_ROUTE',profileId:'firefox-container-1',routeId:'__direct__'},extensionSender),
  (error) => error?.code === 'DIRECT_ROUTE_REQUIRES_OPT_IN'
);
assert.equal(stored.state.profiles['firefox-container-1'].routeId,'r1');
await listeners['runtime.onMessage']({type:'UPDATE_PROFILE_ROUTE',profileId:'firefox-container-1',routeId:'__direct__',allowDirect:true},extensionSender);
assert.equal(stored.state.profiles['firefox-container-1'].routeId,'__direct__');
await listeners['runtime.onMessage']({type:'UPDATE_PROFILE_ROUTE',profileId:'firefox-container-1',routeId:'r1'},extensionSender);

const routeTest = await listeners['runtime.onMessage']({ type:'TEST_PROFILE', profileId:'firefox-container-1' }, extensionSender);
assert.equal(routeTest.ok, true, 'Mullvad route verification must complete through extension-context checks');
assert.equal(routeTest.data.ip, '203.0.113.10');
assert.equal(routeTest.data.mullvad_exit_ip, true);
assert.equal(routeTest.dns.checked, true);
assert.equal(routeTest.dns.leaking, false);
assert.equal(routeTest.dns.servers.length, 1, 'duplicate resolver observations should be collapsed by IP');
assert.equal(tabsCreated, 0, 'route verification must not create a hidden web page');
assert.equal(tabUpdates, 0, 'route verification must not navigate a hidden web page');
assert.equal(tabMessages, 0, 'route verification must not depend on a content-script probe');

const firstRouteTestFetches = routeTestFetches.slice(0,4);
assert.equal(firstRouteTestFetches.length, 4, 'route verification should perform one exit check plus three DNS checks');
assert.equal(firstRouteTestFetches[0].target, 'https://ipv4.am.i.mullvad.net/json');
const firstDnsFetches = firstRouteTestFetches.slice(1).map((item) => item.target);
assert.equal(new Set(firstDnsFetches).size, 3, 'DNS probe hostnames must be unique');
for (const item of firstRouteTestFetches) {
  assert.equal(item.cache, 'no-store');
  assert.equal(item.credentials, 'omit');
  assert.equal(item.redirect, 'error');
  assert.equal(item.referrerPolicy, 'no-referrer');
}
for (const url of firstDnsFetches) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'https:');
  assert.match(parsed.hostname.split('.')[0], /^[0-9a-f-]{36}$/i);
  assert.ok(parsed.hostname.endsWith('.dnsleak.am.i.mullvad.net'));
}
for (let index = 0; index < 4; index++) {
  const proxyDecision = routeTestProxyDecisions[index];
  assert.equal(proxyDecision[0].type, 'socks');
  assert.equal(proxyDecision[0].host, '127.0.0.1');
  assert.equal(proxyDecision[0].port, 19090);
  assert.equal(proxyDecision[0].proxyDNS, true, 'every route-test hostname must be delegated to SOCKS DNS');
  assert.equal(proxyDecision[0].connectionIsolationKey, 'firefox-container-1');
  assert.equal(proxyDecision.at(-1), null, 'route-test proxy chain must be explicitly fail-closed');
  assert.deepEqual(routeTestBeforeDecisions[index], {}, 'strict proxy verification should allow the expected route');
}
assert.ok(nativeRequests.some((request) =>
  request.command === 'prepare_exit'
  && request.route_id === 'r1'
  && request.relay_ip === '10.124.1.240'
), 'Mullvad route verification must prepare the selected native exit');

const prepareCountBeforeProxyError = nativeRequests.filter((request) => request.command === 'prepare_exit').length;
listeners['proxy.onError']({ message: 'local SOCKS forwarder connection refused' });
const recoveredAfterProxyError = await listeners['proxy.onRequest']({
  url:'https://example.com/recover-after-proxy-error',
  type:'main_frame',
  cookieStoreId:'firefox-container-1',
  tabId:77
});
assert.equal(recoveredAfterProxyError[0].type, 'socks');
assert.equal(recoveredAfterProxyError[0].host, '127.0.0.1');
assert.equal(
  nativeRequests.filter((request) => request.command === 'prepare_exit').length,
  prepareCountBeforeProxyError + 1,
  'a proxy error must invalidate the cached local forwarder so the next protected request prepares a fresh exit'
);

for (const unboundUrl of [
  'https://am.i.mullvad.net/json',
  'https://00000000-0000-4000-8000-000000000000.dnsleak.am.i.mullvad.net/'
]) {
  const unboundDetails = {
    url: unboundUrl,
    type: 'xmlhttprequest',
    tabId: -1,
    documentUrl: 'moz-extension://test/background.js'
  };
  const unboundProxy = await listeners['proxy.onRequest'](unboundDetails);
  assert.equal(unboundProxy[0].host, '127.0.0.1', 'an unbound extension route-test request must be blackholed');
  assert.equal(unboundProxy[0].port, 9);
  assert.equal(unboundProxy.at(-1), null);
  assert.deepEqual(
    await listeners['webRequest.onBeforeRequest']({...unboundDetails, proxyInfo:{type:'direct'}}),
    {cancel:true},
    'an unbound extension route-test request must also be cancelled at webRequest'
  );
}

conflictingDnsObservation = true;
const conflictingDnsRouteTest = await listeners['runtime.onMessage']({ type:'TEST_PROFILE', profileId:'firefox-container-1' }, extensionSender);
assert.equal(conflictingDnsRouteTest.ok, false, 'conflicting duplicate resolver records must fail closed');
assert.equal(conflictingDnsRouteTest.dns.checked, true);
assert.equal(conflictingDnsRouteTest.dns.leaking, true);
assert.equal(conflictingDnsRouteTest.dns.servers.length, 1, 'resolver display data may still be deduplicated by IP');
assert.match(conflictingDnsRouteTest.error, /DNS leak detected/);
conflictingDnsObservation = false;

dnsObservationsAvailable = false;
const incompleteDnsRouteTest = await listeners['runtime.onMessage']({ type:'TEST_PROFILE', profileId:'firefox-container-1' }, extensionSender);
assert.equal(incompleteDnsRouteTest.ok, false, 'route verification must fail when DNS observations are unavailable');
assert.equal(incompleteDnsRouteTest.dns.checked, false);
assert.match(incompleteDnsRouteTest.error, /DNS check returned no resolver observations/);
dnsObservationsAvailable = true;

mullvadExitAvailable = false;
const wrongExitRouteTest = await listeners['runtime.onMessage']({ type:'TEST_PROFILE', profileId:'firefox-container-1' }, extensionSender);
assert.equal(wrongExitRouteTest.ok, false, 'Mullvad verification must reject a non-Mullvad exit');
assert.match(wrongExitRouteTest.error, /did not use a Mullvad exit/);
mullvadExitAvailable = true;

failPrimaryConnectionCheck = true;
const fallbackRouteTest = await listeners['runtime.onMessage']({ type:'TEST_PROFILE', profileId:'firefox-container-1' }, extensionSender);
assert.equal(fallbackRouteTest.ok, true, 'the IPv4 JSON fallback should preserve verification when the primary endpoint fails');
assert.match(fallbackRouteTest.connectionCheckError, /Route check HTTP 503/);
assert.ok(routeTestFetches.some((item) => item.target === 'https://am.i.mullvad.net/json'));
failPrimaryConnectionCheck = false;

forceRouteTestProxyMismatch = true;
const mismatchedRouteTest = await listeners['runtime.onMessage']({ type:'TEST_PROFILE', profileId:'firefox-container-1' }, extensionSender);
assert.equal(mismatchedRouteTest.ok, false, 'route verification must fail closed if Firefox reports a direct route-test connection');
assert.match(mismatchedRouteTest.error, /Connection check failed/);
assert.match(mismatchedRouteTest.connectionCheckError, /Route-test request was cancelled/);
forceRouteTestProxyMismatch = false;

let signalPrimaryEntered;
const primaryEntered = new Promise((resolve) => { signalPrimaryEntered = resolve; });
primaryCheckEntered = signalPrimaryEntered;
blockNextPrimaryCheck = true;
const primaryCountBefore = routeTestFetches.filter((item) => item.target === 'https://ipv4.am.i.mullvad.net/json').length;
const concurrentFirst = listeners['runtime.onMessage']({ type:'TEST_PROFILE', profileId:'firefox-container-1' }, extensionSender);
await primaryEntered;

const unrelatedSameUrl = {
  url:'https://ipv4.am.i.mullvad.net/json',
  type:'xmlhttprequest',
  tabId:88,
  cookieStoreId:'firefox-default',
  documentUrl:'https://example.com/'
};
assert.deepEqual(
  await listeners['proxy.onRequest'](unrelatedSameUrl),
  {type:'direct'},
  'a non-extension request to the shared check URL must not inherit an active Persona route-test override'
);
assert.deepEqual(
  await listeners['webRequest.onBeforeRequest']({...unrelatedSameUrl,proxyInfo:{type:'direct'}}),
  {},
  'the unrelated request should retain its own unmanaged/direct routing policy'
);

const concurrentSecond = listeners['runtime.onMessage']({ type:'TEST_PROFILE', profileId:'firefox-container-1' }, extensionSender);
await new Promise((resolve) => setTimeout(resolve, 0));
const primaryCountWhileBlocked = routeTestFetches.filter((item) => item.target === 'https://ipv4.am.i.mullvad.net/json').length;
assert.equal(
  primaryCountWhileBlocked,
  primaryCountBefore + 1,
  'concurrent route tests must serialize the shared exit-check URL instead of overwriting its route binding'
);
releaseBlockedPrimaryCheck();
const concurrentResults = await Promise.all([concurrentFirst, concurrentSecond]);
assert.ok(concurrentResults.every((result) => result.ok), 'serialized concurrent route tests should both complete successfully');
primaryCheckEntered = null;
releaseBlockedPrimaryCheck = null;

// All consumers must derive health from the current state, including the
// popup projection and management summary after legacy and PCMS mutations.
let requestNumber = 0;
async function health() {
  const response = await listeners['runtime.onMessage']({type:'GET_PERSONA',profileId:'firefox-container-1'},extensionSender);
  return response.persona?.health || null;
}
async function management(command,params) {
  const response = await listeners['runtime.onMessage']({type:'PCMS_REQUEST',version:1,requestId:`health-${++requestNumber}`,command,params},extensionSender);
  assert.equal(response.ok,true,JSON.stringify(response.error));
  return response.result;
}
async function editState(edit) {
  const snapshot = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
  edit(snapshot.state);
  const preview = await listeners['runtime.onMessage']({type:'PREVIEW_STATE_CHANGE',state:snapshot.state},extensionSender);
  if (preview.delta.length) {
    await listeners['runtime.onMessage']({type:'AUTHORIZE_SECURITY_PREVIEW',previewId:preview.previewId,approvedDelta:preview.delta},extensionSender);
  }
  await listeners['runtime.onMessage']({type:'SAVE_STATE',state:snapshot.state,authorizationId:preview.previewId},extensionSender);
}
async function noOldExit(status) {
  const snapshot = await health();
  assert.equal(snapshot?.status,status);
  assert.equal(snapshot?.exitIp,null);
  assert.equal(snapshot?.checkedAt,null);
}
assert.equal((await health()).exitIp,'203.0.113.10');
const activeTab = {id:7,cookieStoreId:'firefox-container-1',url:'https://example.com/',title:'Test'};
browser.tabs.query = async()=>[activeTab];
assert.equal((await listeners['runtime.onMessage']({type:'GET_ACTIVE_CONTEXT'},extensionSender)).routeTest.data.ip,'203.0.113.10');
await management('route.assign',{profileId:'firefox-container-1',routeId:'__block__'});
await noOldExit('blocked');
assert.equal((await listeners['runtime.onMessage']({type:'GET_ACTIVE_CONTEXT'},extensionSender)).routeTest,null);
await listeners['runtime.onMessage']({type:'UPDATE_PROFILE_ROUTE',profileId:'firefox-container-1',routeId:'r1'},extensionSender);
await noOldExit('untested');
await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
await editState(state=>{state.profiles['firefox-container-1'].routeId='__direct__';});
await noOldExit('direct');
await editState(state=>{state.profiles['firefox-container-1'].routeId='r1';});
await noOldExit('untested');
await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
await editState(state=>{state.routes.r1.enabled=false;});
await noOldExit('error');
await editState(state=>{state.routes.r1.enabled=true;});
await noOldExit('untested');
await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
await editState(state=>{state.routes.r1.host='10.124.1.241';});
await noOldExit('untested');
await editState(state=>{state.routes.r1.host='10.124.1.240';});
await noOldExit('untested');
await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
const originalPredictionGet=browser.privacy.network.networkPredictionEnabled.get;
browser.privacy.network.networkPredictionEnabled.get=async()=>({value:true,levelOfControl:'controlled_by_other_extensions'});
await listeners['runtime.onMessage']({type:'REFRESH_SECURITY'},extensionSender);
await noOldExit('error');
await listeners['runtime.onMessage']({type:'UPDATE_PROFILE_ROUTE',profileId:'firefox-container-1',routeId:'__direct__',allowDirect:true},extensionSender);
await editState((state) => {
  state.workflows.directReadiness = {
    id: 'directReadiness', name: 'Direct readiness', enabled: true,
    steps: [{ id: 'direct-step', profileId: 'firefox-container-1', urls: ['https://example.com/'], concurrency: 1, scriptIds: [], completion: { mode: 'load', timeoutMs: 1000 }, retries: 0, retryDelayMs: 0 }]
  };
});
const tabCreateCountBeforeDirectWorkflow = tabsCreated;
const directWorkflow = await listeners['runtime.onMessage']({type:'RUN_WORKFLOW',workflowId:'directReadiness'},extensionSender);
let directJob;
for (let attempt = 0; attempt < 100; attempt++) {
  directJob = await listeners['runtime.onMessage']({type:'LIST_AUTOMATION_JOBS',limit:50},extensionSender);
  directJob = directJob.jobs.find((job) => job.id === directWorkflow.job.id);
  if (['completed','failed'].includes(directJob?.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(directJob.state,'failed');
assert.equal(tabsCreated,tabCreateCountBeforeDirectWorkflow + 1,
  'Direct workflow readiness must pass proxy-only privacy checks before reaching the mocked page-tab boundary');
const directRouteTestStart = routeTestFetches.length;
const directDuringPrivacyFailure = await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
assert.doesNotMatch(directDuringPrivacyFailure.error || '',/privacy controls are not in a safe state/i,
  'explicit Direct profile tests must not inherit proxy-only privacy safety gates');
assert.equal(routeTestFetches.length - directRouteTestStart,4,'Direct verification must reach its network checks despite unsafe proxy-only privacy controls');
assert.deepEqual(routeTestBeforeDecisions.slice(-4),[{}, {}, {}, {}],'Direct extension-context checks must not be blocked by proxy-only privacy safety gates');
assert.deepEqual(await listeners['webRequest.onBeforeRequest']({
  url:'https://example.com/direct',type:'main_frame',cookieStoreId:'firefox-container-1',tabId:1,proxyInfo:{type:'direct'}
}),{},'explicit Direct requests remain available while proxy-only privacy controls are unsafe');
await listeners['runtime.onMessage']({type:'UPDATE_PROFILE_ROUTE',profileId:'firefox-container-1',routeId:'r1'},extensionSender);
await noOldExit('error');
browser.privacy.network.networkPredictionEnabled.get=originalPredictionGet;
await listeners['runtime.onMessage']({type:'REFRESH_SECURITY'},extensionSender);
await noOldExit('untested');
assert.equal((await management('system.status',{})).routeHealth.healthy,0);
await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
assert.equal((await management('system.status',{})).routeHealth.healthy,1);
const originalProxySettingsGet=browser.proxy.settings.get;
browser.proxy.settings.get=async()=>{throw new Error('Proxy control could not be inspected');};
await listeners['runtime.onMessage']({type:'REFRESH_SECURITY'},extensionSender);
await noOldExit('error');
assert.equal((await management('system.status',{})).routeHealth.healthy,0,'unknown proxy control must never count as verified');
browser.proxy.settings.get=originalProxySettingsGet;
await listeners['runtime.onMessage']({type:'REFRESH_SECURITY'},extensionSender);
await noOldExit('untested');
await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
assert.equal((await health()).status,'healthy','fresh evidence after control recovery must remain usable');
await editState(state=>{state.global.strictProxyVerification=false;});
await noOldExit('untested');
await editState(state=>{state.global.strictProxyVerification=true;});
await noOldExit('untested');
await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
assert.equal((await health()).status,'healthy','fresh evidence after restoring strict verification must remain usable');
const savedProfile=structuredClone(stored.state.profiles['firefox-container-1']);
await editState(state=>{delete state.profiles['firefox-container-1'];});
assert.equal((await health()),null,'removing a persona must erase its test evidence');
await editState(state=>{state.profiles['firefox-container-1']={...savedProfile,routeId:'r1'};});
await noOldExit('untested');
let markInFlight;
primaryCheckEntered = () => markInFlight();
const inFlight = new Promise(resolve => { markInFlight = resolve; });
blockNextPrimaryCheck = true;
const pendingVerification = listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
await inFlight;
await editState(state=>{state.profiles['firefox-container-1'].routeId='__block__';});
await editState(state=>{state.profiles['firefox-container-1'].routeId='r1';});
releaseBlockedPrimaryCheck();
const changedDuringCheck = await pendingVerification;
assert.equal(changedDuringCheck.ok,false,'an in-flight result must be rejected after route A → Block → A');
assert.match(changedDuringCheck.error,/changed during verification/);
await noOldExit('untested');
primaryCheckEntered = null;
releaseBlockedPrimaryCheck = null;

assert.equal(routes.result.find(route => route.id === 'r1').username, undefined);
assert.equal(routes.result.find(route => route.id === 'r1').password, undefined);

await assert.rejects(
  listeners['runtime.onMessage']({
    type:'PCMS_REQUEST', version:1, requestId:'content-pcms', command:'system.describe', params:{}
  }, contentSender),
  /Privileged extension message rejected/
);
await assert.rejects(
  listeners['runtime.onMessage']({ type:'SAVE_STATE', state:stored.state }, contentSender),
  /Privileged extension message rejected/
);

let untrustedDisconnectRegistered = false;
listeners['runtime.onConnect']({
  name:'PCMS_EVENTS', sender:contentSender, postMessage(){ throw new Error('untrusted port attached'); },
  onDisconnect:{ addListener(){ untrustedDisconnectRegistered = true; } }
});
assert.equal(untrustedDisconnectRegistered, false, 'content scripts must not attach the privileged PCMS event port');

const eventMessages = [];
let disconnectListener;
listeners['runtime.onConnect']({
  name: 'PCMS_EVENTS',
  sender: extensionSender,
  postMessage(message){ eventMessages.push(message); },
  onDisconnect:{ addListener(fn){ disconnectListener = fn; } }
});
assert.equal(typeof disconnectListener, 'function');

const details={url:'https://example.com/',type:'main_frame',cookieStoreId:'firefox-container-1',tabId:1};
const proxyDecision=await listeners['proxy.onRequest'](details);
assert.equal(proxyDecision[0].type,'socks');
assert.equal(proxyDecision[0].host,'127.0.0.1');
assert.equal(proxyDecision[0].port,19090);
assert.equal(proxyDecision[0].proxyDNS,true);
assert.equal(proxyDecision.at(-1),null);

const allowed=await listeners['webRequest.onBeforeRequest']({...details,proxyInfo:{type:'socks',host:'127.0.0.1',port:19090,proxyDNS:true}});
assert.deepEqual(allowed,{});
const blocked=await listeners['webRequest.onBeforeRequest']({...details,proxyInfo:{type:'direct'}});
assert.deepEqual(blocked,{cancel:true});
const speculative=await listeners['webRequest.onBeforeRequest']({...details,type:'speculative',proxyInfo:{type:'socks',host:'127.0.0.1',port:19090,proxyDNS:true}});
assert.deepEqual(speculative,{cancel:true});

const staleSnapshot = await listeners['runtime.onMessage']({ type:'GET_SNAPSHOT' }, extensionSender);
const routeChange = await listeners['runtime.onMessage']({
  type:'PCMS_REQUEST', version:1, requestId:'route-revision', command:'route.assign',
  params:{ profileId:'firefox-container-1', routeId:'__direct__', options:{allowDirect:true}, expectedRevision:staleSnapshot.state.__stateMeta.revision }
}, extensionSender);
assert.equal(routeChange.ok, true, 'PCMS should commit the intervening route change');
await assert.rejects(
  listeners['runtime.onMessage']({ type:'SAVE_STATE', state:staleSnapshot.state }, extensionSender),
  (error) => error?.code === 'STATE_CONFLICT'
);
assert.equal(stored.state.profiles['firefox-container-1'].routeId, '__direct__', 'a stale options snapshot must not overwrite the committed PCMS route');
await listeners['runtime.onMessage']({type:'UPDATE_PROFILE_ROUTE',profileId:'firefox-container-1',routeId:'r1'},extensionSender);
await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-1'},extensionSender);
let wipeTabs=[activeTab];
browser.tabs.query=async({cookieStoreId}={})=>wipeTabs.filter(tab=>!cookieStoreId||tab.cookieStoreId===cookieStoreId);
browser.tabs.remove=async(ids)=>{
  const removing=new Set(Array.isArray(ids)?ids:[ids]);
  wipeTabs=wipeTabs.filter(tab=>!removing.has(tab.id));
};
const wipe = await listeners['runtime.onMessage']({type:'FULL_WIPE_PERSONA',profileId:'firefox-container-1'},extensionSender);
assert.equal(wipe.profile.containerId,'firefox-container-rotated');
const rotationEvent=[...eventMessages].reverse().find(message=>message.type==='persona.container.rotated');
assert.ok(rotationEvent,'full wipe must publish the semantic container-rotation event');
assert.equal(rotationEvent.version,1);
assert.equal(typeof rotationEvent.bootId,'string');
assert.equal(Number.isInteger(rotationEvent.revision),true);
assert.deepEqual(rotationEvent.data,{
  personaUid:wipe.personaUid,
  oldCookieStoreId:'firefox-container-1',
  newCookieStoreId:'firefox-container-rotated',
  operationId:wipe.operationId
});
assert.equal(await health(),null,'old identity must not keep verification after a full wipe');
const replacement = await listeners['runtime.onMessage']({type:'GET_PERSONA',profileId:'firefox-container-rotated'},extensionSender);
assert.equal(replacement.persona.health.status,'untested');
assert.equal(replacement.persona.health.exitIp,null);

const beforeLegacy = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
const incomingLegacy = structuredClone(beforeLegacy.state);
incomingLegacy.profiles['firefox-container-rotated'].routeId='__direct__';
incomingLegacy.profiles['firefox-container-rotated'].killSwitch=false;
incomingLegacy.routes.r1.host='reviewed.example';
incomingLegacy.global.integration.allowDirect=true;
const legacyPayload={format:'persona-route-manager',state:incomingLegacy};
const legacyPreview=await listeners['runtime.onMessage']({type:'IMPORT_STATE',payload:legacyPayload,mode:'replace'},extensionSender);
assert.deepEqual(legacyPreview.delta.filter((entry)=>entry.kind==='proxy-destination-changed').map((entry)=>entry.after.host),['reviewed.example']);
assert.equal(legacyPreview.delta.some((entry)=>entry.kind==='direct-authority-enabled'),false,'imported Integration authority must be excluded');
assert.equal(stored.state.routes.r1.host,'10.124.1.240','preview must not mutate state');
await assert.rejects(listeners['runtime.onMessage']({type:'IMPORT_STATE',authorizationId:legacyPreview.previewId},extensionSender),
  (error)=>error?.code==='SECURITY_AUTHORIZATION_REQUIRED');
await listeners['runtime.onMessage']({type:'AUTHORIZE_SECURITY_PREVIEW',previewId:legacyPreview.previewId,approvedDelta:legacyPreview.delta},extensionSender);
await listeners['runtime.onMessage']({type:'IMPORT_STATE',authorizationId:legacyPreview.previewId},extensionSender);
assert.equal(stored.state.profiles['firefox-container-rotated'].routeId,'__direct__');
assert.equal(stored.state.profiles['firefox-container-rotated'].killSwitch,false);
assert.equal(stored.state.global.integration.allowDirect,false);
const beforeFallback = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
const disableAssigned = structuredClone(beforeFallback.state);
disableAssigned.profiles['firefox-container-rotated'].routeId='r1';
disableAssigned.routes.r1.enabled=false;
await assert.rejects(listeners['runtime.onMessage']({type:'SAVE_STATE',state:disableAssigned},extensionSender),
  (error)=>error?.code==='SECURITY_AUTHORIZATION_REQUIRED' && error.delta.some((item)=>item.kind==='proxy-route-direct-fallback'));
await editState((state)=>{state.global.unmanagedPolicy='direct';});
const deleteManaged = await listeners['runtime.onMessage']({type:'GET_SNAPSHOT'},extensionSender);
delete deleteManaged.state.profiles['firefox-container-rotated'];
await assert.rejects(listeners['runtime.onMessage']({type:'SAVE_STATE',state:deleteManaged.state},extensionSender),
  (error)=>error?.code==='SECURITY_AUTHORIZATION_REQUIRED' && error.delta.some((item)=>item.kind==='persona-unmanaged-with-direct-policy'));

const userScriptExecutions = [];
browser.permissions.contains = async ({permissions}) => permissions.includes('userScripts');
browser.userScripts = {
  async execute(details) { userScriptExecutions.push(details); },
  async configureWorld() {}
};
await editState((state) => {
  state.scripts = {
    actualDocument: {
      id: 'actualDocument', name: 'Actual document', enabled: true, autoRun: true,
      runAt: 'document_start', profileIds: ['firefox-container-rotated'],
      matches: ['https://example.com/*'], code: '/* actual-document-script */',
      grants: ['none'], injectInto: 'page'
    },
    spoofedDocument: {
      id: 'spoofedDocument', name: 'Spoofed document', enabled: true, autoRun: true,
      runAt: 'document_start', profileIds: ['firefox-container-rotated'],
      matches: ['https://attacker.test/*'], code: '/* spoofed-document-script */',
      grants: ['none'], injectInto: 'page'
    }
  };
});
await listeners['runtime.onMessage']({
  type: 'US_STAGE', stage: 'document_start', url: 'https://attacker.test/forged'
}, {
  id: browser.runtime.id,
  url: 'https://example.com/real-document',
  tab: { id: 99, url: 'https://example.com/real-document', cookieStoreId: 'firefox-container-rotated' },
  frameId: 0,
  documentId: 'url-spoof-regression'
});
assert.equal(userScriptExecutions.length, 1, 'US_STAGE must select scripts using browser sender context, not caller-provided URL');
assert.match(userScriptExecutions[0].js[0].code, /actual-document-script/);
assert.doesNotMatch(userScriptExecutions[0].js[0].code, /spoofed-document-script/);

await editState((state)=>{
  state.profiles['firefox-container-rotated'].routeId='r1';
  state.profiles['firefox-container-rotated'].killSwitch=true;
});
nativeBridgeVersion = '0.2.0';
const oldBridgeStatus = await listeners['runtime.onMessage']({type:'MULLVAD_STATUS'},extensionSender);
assert.equal(oldBridgeStatus.status.compatible, false, 'the installed bridge must be checked against the token-auth contract version');
assert.equal(oldBridgeStatus.status.ready, false, 'an older host must not be displayed as ready');
const fetchCountBeforeOldBridgeTest = routeTestFetches.length;
const prepareCountBeforeOldBridgeTest = nativeRequests.filter((request)=>request.command==='prepare_exit').length;
const oldBridgeRouteTest = await listeners['runtime.onMessage']({type:'TEST_PROFILE',profileId:'firefox-container-rotated'},extensionSender);
assert.equal(oldBridgeRouteTest.ok, false, 'a stale native bridge must fail route verification before network probes');
assert.match(oldBridgeRouteTest.error, /0\.2\.0.*0\.3\.0/);
assert.equal(routeTestFetches.length, fetchCountBeforeOldBridgeTest, 'no public egress probes should be sent through an incompatible bridge');
assert.equal(nativeRequests.filter((request)=>request.command==='prepare_exit').length, prepareCountBeforeOldBridgeTest,
  'an incompatible bridge must not receive a token-authenticated prepare_exit request');
console.log('background smoke tests passed');
