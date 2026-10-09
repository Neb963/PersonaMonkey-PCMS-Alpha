import assert from 'node:assert/strict';

const listeners = {};
const nativeRequests = [];
const event = (name) => ({ addListener(fn){ listeners[name] = fn; }, removeListener(){}, hasListener(){return true;} });
let stored = {
  state: {
    schemaVersion:1,
    global:{
      profileTargetCount:30, profileNamePrefix:'Persona', unmanagedPolicy:'direct', blockSpeculative:true,
      strictProxyVerification:true, enforcePrivacyControls:true, disableNetworkPrediction:true,
      webRTCMode:'proxy_only', autoReloadOnRouteChange:true,
      mullvadNative:{enabled:true,autoStart:true,autoStopMinutes:15,requireReady:true}
    },
    profiles:{'firefox-container-1':{containerId:'firefox-container-1',managed:true,name:'P1',routeId:'mv1',killSwitch:true,blockLocalNetwork:true,domainMode:'any',allowedDomains:[],blockedDomains:[],scriptIds:[],owned:true}},
    routes:{mv1:{id:'mv1',name:'Mullvad NL',provider:'mullvad',type:'socks',host:'10.124.0.4',port:1080,proxyDNS:true,enabled:true}},
    scripts:{}, wireguardImports:[]
  }
};
function setting(value){ let v=value; return { async get(){return {value:v,levelOfControl:'controllable_by_this_extension'};}, async set({value}){v=value;return true;}, onChange:event('setting'+Math.random()) }; }
function nativePort(){
  const messageListeners=[]; const disconnectListeners=[];
  return {
    onMessage:{addListener(fn){messageListeners.push(fn)}},
    onDisconnect:{addListener(fn){disconnectListeners.push(fn)}},
    postMessage(req){
      nativeRequests.push(req);
      queueMicrotask(()=>{
        let response={id:req.id,ok:true};
        if(req.command==='status') response={...response,version:'0.3.0',ready:true,interface_up:true,base_proxy_reachable:true,selected_entry:'se-test'};
        if(req.command==='prepare_exit') response={...response,ready:true,local_host:'127.0.0.1',local_port:41234,selected_entry:'se-test'};
        for(const fn of messageListeners) fn(response);
      });
    },
    disconnect(){ for(const fn of disconnectListeners) fn(); }
  };
}

globalThis.browser = {
  runtime:{ getURL:()=> 'moz-extension://test/', getManifest:()=>({version:'0.7.0'}), connectNative:()=>nativePort(), onMessage:event('runtime.onMessage'), onInstalled:event('runtime.onInstalled'), lastError:null },
  storage:{ local:{ async get(){return stored;}, async set(obj){stored={...stored,...obj};} }, onChanged:event('storage.onChanged') },
  privacy:{ network:{ networkPredictionEnabled:setting(true), peerConnectionEnabled:setting(true), webRTCIPHandlingPolicy:setting('default') } },
  proxy:{ onRequest:event('proxy.onRequest'), onError:event('proxy.onError'), settings:{async get(){return {levelOfControl:'controllable_by_this_extension'};},onChange:event('proxy.settings.onChange')} },
  webRequest:{ onBeforeRequest:event('webRequest.onBeforeRequest') },
  webNavigation:{ onCommitted:event('webNavigation.onCommitted'), onDOMContentLoaded:event('webNavigation.onDOMContentLoaded'), onCompleted:event('webNavigation.onCompleted') },
  contextualIdentities:{ async query(){return [];}, onUpdated:event('contextualIdentities.onUpdated'), onRemoved:event('contextualIdentities.onRemoved') },
  tabs:{ async query(){return [];}, async reload(){}, async get(){throw new Error('not used');}, onActivated:event('tabs.onActivated') },
  cookies:{ async getAll(){return [];}, async remove(){}, async set(){return {};} },
  browsingData:{ async remove(){} },
  permissions:{ async contains(){return false;} }, scripting:{},
  alarms:{create(){},onAlarm:event('alarms.onAlarm')}
};

await import('../background.js?mullvad-smoke=1');
await new Promise(r=>setTimeout(r,20));
const details={url:'https://example.com/',type:'main_frame',cookieStoreId:'firefox-container-1',tabId:1};
const decision=await listeners['proxy.onRequest'](details);
assert.equal(decision[0].type,'socks');
assert.equal(decision[0].host,'127.0.0.1');
assert.equal(decision[0].port,41234);
assert.equal(decision[0].proxyDNS,true);
const prepareRequest=nativeRequests.find((request)=>request.command==='prepare_exit');
assert.match(prepareRequest.forwarder_token,/^[0-9a-f]{64}$/);
assert.equal(decision[0].username,'persona');
assert.equal(decision[0].password,prepareRequest.forwarder_token,'Firefox receives the native forwarder credential as SOCKS auth');
assert.equal(decision.at(-1),null);

const good=await listeners['webRequest.onBeforeRequest']({...details,proxyInfo:{type:'socks',host:'127.0.0.1',port:41234,proxyDNS:true}});
assert.deepEqual(good,{});
const staleRemote=await listeners['webRequest.onBeforeRequest']({...details,proxyInfo:{type:'socks',host:'10.124.0.4',port:1080,proxyDNS:true}});
assert.deepEqual(staleRemote,{cancel:true});
console.log('Mullvad native routing smoke tests passed');
