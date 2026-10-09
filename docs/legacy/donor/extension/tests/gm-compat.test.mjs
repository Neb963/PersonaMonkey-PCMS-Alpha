import assert from 'node:assert/strict';

const store = {};
globalThis.browser = {
  storage:{local:{async get(k){return {[k]:store[k]}},async set(o){Object.assign(store,o)},async remove(){}}},
  runtime:{
    getManifest(){return {version:'0.3.0'}},
    async getPlatformInfo(){return {arch:'x86-64',os:'linux'}},
    async getBrowserInfo(){return {name:'Firefox',version:'155'}},
    onUserScriptConnect:undefined
  }
};
const {prepareUserscriptInjection}=await import(`../lib/gm-compat.js?test=${Date.now()}`);
const tab={id:1,url:'https://example.com/',cookieStoreId:'firefox-container-1',incognito:false};
const base={id:'s1',name:'T',code:'window.__x=1;',enabled:true,profileIds:['firefox-container-1'],matches:['*://*/*'],excludes:[],excludeMatches:[],includes:[],runAt:'document_idle',requires:[],resources:{},connects:[],allFrames:false,updatedAt:'x'};
let p=await prepareUserscriptInjection({...base,grants:['none'],injectInto:'auto',unwrap:false},{tab,url:tab.url});
assert.equal(p.world,'MAIN');
assert.equal(p.worldId,null);
p=await prepareUserscriptInjection({...base,grants:['GM_getValue','GM_setValue'],injectInto:'auto',unwrap:false},{tab,url:tab.url});
assert.equal(p.world,'USER_SCRIPT');
assert.ok(p.worldId.startsWith('persona-'));
assert.match(p.code,/browser\.runtime\.connect/);
assert.match(p.code,/function GM_xmlhttpRequest\(details\)\{__need\(\['GM_xmlhttpRequest'/,"injected GM runtime must reject undeclared privileged APIs locally");
assert.match(p.code,/function GM_setValue\(k,v\)\{__need\(\['GM_setValue'/,"local GM value mutations must be grant-gated before changing the in-page cache");
await assert.rejects(()=>prepareUserscriptInjection({...base,grants:['GM_unknown'],injectInto:'auto'},{tab,url:tab.url}),/Unsupported @grant/);
console.log('GM compatibility preparation tests passed');
