import { fetchViaExit } from "./mullvad-native.js";
import { routeDecision, userScriptCookieDomainAllowed, userScriptHostAllowed, userScriptMatches } from "./policy.js";
import { analyzeGrants, shouldUseMainWorld, worldIdForScript } from "./userscripts.js";
import { normalizeStructuredAutomationFailure } from "./orchestrator.js";
import { assertExternalArtifactMetadataMatchesSource } from "./external-artifact-integrity.js";

const dependencyCache = new Map();
const portsByScript = new Map();
const menuCommands = new Map();
const xhrControllers = new Map();
const downloadControllers = new Map();
const pendingXhrAborts = new Map();
const pendingDownloadAborts = new Map();
const downloadWaiters = new Map();
const MAX_DIRECT_DOWNLOAD_BYTES = 20 * 1024 * 1024;
let getStateFn = null;
let automationSignalFn = null;
let automationInputFn = null;
let configured = false;

const VALUE_PREFIX = "gm-values:";
const TAB_DATA_KEY = "gm-tab-data";

function now() { return Date.now(); }
function valueKey(scriptId) { return `${VALUE_PREFIX}${scriptId}`; }
function requestKey(tabId, scriptId, requestId) { return `${tabId ?? -1}:${scriptId}:${requestId}`; }

function rememberPendingAbort(pending, key) {
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);
  if (pending.size >= 256) {
    const oldest = pending.keys().next().value;
    clearTimeout(pending.get(oldest));
    pending.delete(oldest);
  }
  const timer = setTimeout(() => pending.delete(key), 60000);
  timer?.unref?.();
  pending.set(key, timer);
}

function consumePendingAbort(pending, key) {
  const timer = pending.get(key);
  if (!timer) return false;
  clearTimeout(timer);
  pending.delete(key);
  return true;
}

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

async function loadValues(scriptId) {
  const obj = await browser.storage.local.get(valueKey(scriptId));
  const value = obj[valueKey(scriptId)];
  return value && typeof value === "object" ? value : {};
}

async function saveValues(scriptId, values) {
  await browser.storage.local.set({ [valueKey(scriptId)]: values });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchDependencyBytes(url, context = {}) {
  const state = getStateFn ? await getStateFn() : null;
  const decision = networkDecisionFor(state, context.tab?.cookieStoreId, url, "Remote userscript dependency");
  if (decision.mode === "mullvad") {
    const native = await fetchViaExit(decision.route, {
      url,
      method: "GET",
      headers: { Accept: "*/*" },
      timeout_seconds: 30,
      max_redirects: 5,
      network_policy: networkPolicyForProfile(decision.profile),
      connect_policy: connectPolicyForDependency(url, context.script)
    });
    return { bytes: decodeBase64Bytes(native.body_base64), contentType: (native.headers || []).find(([k]) => String(k).toLowerCase() === "content-type")?.[1] || "application/octet-stream" };
  }
  if (decision.mode === "proxy") throw new Error("Remote userscript dependency for a protected non-Mullvad proxy route is blocked to prevent direct-IP leakage");
  const response = await fetch(url, { cache: "no-store", credentials: "omit", redirect: "error" });
  if (!response.ok) throw new Error(`dependency fetch failed (${response.status}): ${url}`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0] };
}

async function fetchDependencies(script, context = {}) {
  const stamp = `${script.updatedAt}|${JSON.stringify(script.requires || [])}|${JSON.stringify(script.resources || {})}`;
  const cached = dependencyCache.get(script.id);
  if (cached?.stamp === stamp) return cached.value;

  const state = getStateFn ? await getStateFn() : null;
  const mode = state?.global?.userscripts?.dependencyFetch || "direct";
  if (mode === "disabled" && ((script.requires || []).length || Object.keys(script.resources || {}).length)) {
    throw new Error("This userscript has @require/@resource dependencies, but dependency fetching is disabled in Userscripts settings");
  }

  const requires = [];
  const dependencyContext = { ...context, script };
  for (const url of script.requires || []) {
    const fetched = await fetchDependencyBytes(url, dependencyContext);
    requires.push({ url, code: new TextDecoder().decode(fetched.bytes) });
  }

  const resources = {};
  for (const [name, url] of Object.entries(script.resources || {})) {
    const fetched = await fetchDependencyBytes(url, dependencyContext);
    const bytes = fetched.bytes;
    let text = "";
    try { text = new TextDecoder().decode(bytes); } catch {}
    resources[name] = {
      url,
      contentType: fetched.contentType,
      text,
      dataUrl: `data:${fetched.contentType};base64,${bytesToBase64(bytes)}`
    };
  }

  const value = { requires, resources };
  dependencyCache.set(script.id, { stamp, value });
  return value;
}

async function buildGMInfo(script, tab, url) {
  let platform = {};
  try { platform = await browser.runtime.getPlatformInfo(); } catch {}
  let browserInfo = {};
  try { browserInfo = await browser.runtime.getBrowserInfo(); } catch {}
  return {
    scriptHandler: "PersonaMonkey (Violentmonkey-compatible runtime)",
    version: browser.runtime.getManifest().version,
    uuid: script.id,
    injectInto: script.injectInto || "auto",
    isIncognito: Boolean(tab?.incognito),
    downloadMode: "browser",
    userAgent: navigator.userAgent,
    platform: {
      arch: platform.arch,
      os: platform.os,
      browserName: browserInfo.name || "Firefox",
      browserVersion: browserInfo.version || ""
    },
    script: {
      name: script.name,
      namespace: script.namespace || "",
      version: script.version || "",
      description: script.description || "",
      author: script.author || "",
      homepageURL: script.homepageURL || "",
      supportURL: script.supportURL || "",
      updateURL: script.updateURL || "",
      downloadURL: script.downloadURL || "",
      icon: script.icon || "",
      matches: script.matches || [],
      excludeMatches: script.excludeMatches || [],
      includes: script.includes || [],
      excludes: script.excludes || [],
      grant: script.grants || [],
      connect: script.connects || [],
      require: script.requires || [],
      resources: Object.entries(script.resources || {}).map(([name, resourceUrl]) => ({ name, url: resourceUrl })),
      runAt: script.runAt,
      noframes: !script.allFrames,
      unwrap: Boolean(script.unwrap),
      tags: script.tags || [],
      options: {
        check_for_updates: Boolean(script.updateURL || script.downloadURL),
        inject_into: script.injectInto || "auto",
        noframes: !script.allFrames
      }
    },
    scriptMetaStr: script.metaBlock || "",
    scriptWillUpdate: Boolean(script.updateURL || script.downloadURL),
    sourceUrl: url
  };
}

function mainPersonaBridge(token) {
  if (!token) return "const Persona=Object.freeze({complete:()=>{},fail:()=>{}});";
  return `const Persona=Object.freeze({complete:()=>{throw new Error('Persona automation signals require an isolated-world userscript grant')},fail:()=>{throw new Error('Persona automation signals require an isolated-world userscript grant')}});`;
}

function grantsObject(grants) {
  return new Set(grants || []);
}


const METHOD_GRANTS = Object.freeze({
  setValue: ["GM_setValue", "GM_setValues", "GM.setValue", "GM.setValues"],
  deleteValue: ["GM_deleteValue", "GM_deleteValues", "GM.deleteValue", "GM.deleteValues"],
  xmlHttpRequest: ["GM_xmlhttpRequest", "GM.xmlHttpRequest", "GM.xmlhttpRequest"],
  abortXhr: ["GM_xmlhttpRequest", "GM.xmlHttpRequest", "GM.xmlhttpRequest"],
  openInTab: ["GM_openInTab", "GM.openInTab"],
  closeTab: ["window.close"],
  focusTab: ["window.focus"],
  setClipboard: ["GM_setClipboard", "GM.setClipboard"],
  notification: ["GM_notification", "GM.notification"],
  download: ["GM_download", "GM.download"],
  abortDownload: ["GM_download", "GM.download"],
  registerMenu: ["GM_registerMenuCommand", "GM.registerMenuCommand"],
  unregisterMenu: ["GM_unregisterMenuCommand", "GM.unregisterMenuCommand"],
  cookieList: ["GM_cookie", "GM.cookie"],
  cookieSet: ["GM_cookie", "GM.cookie"],
  cookieDelete: ["GM_cookie", "GM.cookie"],
  automationSignal: ["Persona.signal"],
  inputRead: ["Persona.input"],
  inputSecret: ["Persona.input"],
  inputWait: ["Persona.input"],
  getTabData: ["GM_getTabData", "GM.getTabData"],
  saveTabData: ["GM_saveTabData", "GM.saveTabData"],
  getTabsData: ["GM_getTabsData", "GM.getTabsData"]
});

function requireGrant(script, method) {
  const accepted = METHOD_GRANTS[method];
  if (!accepted) throw new Error(`${method} denied: bridge method has no userscript grant mapping`);
  const declared = grantsObject(script.grants);
  if (accepted.some((grant) => declared.has(grant))) return;
  throw new Error(`${method} denied: userscript did not declare a matching @grant`);
}

function networkPolicyForProfile(profile) {
  return {
    block_local_network: profile?.blockLocalNetwork !== false,
    domain_mode: profile?.domainMode === "allowlist" ? "allowlist" : "any",
    allowed_domains: Array.isArray(profile?.allowedDomains) ? profile.allowedDomains : [],
    blocked_domains: Array.isArray(profile?.blockedDomains) ? profile.blockedDomains : []
  };
}

function connectPolicyForScript(script, pageUrl) {
  return { page_url: String(pageUrl || ""), rules: Array.isArray(script.connects) ? script.connects : [] };
}

function connectPolicyForDependency(url, script) {
  // The declared dependency origin is allowed as same-origin; redirects also
  // need an explicit @connect rule. Keep dependencies separate from page GM calls.
  return { page_url: String(url || ""), rules: Array.isArray(script?.connects) ? script.connects : [] };
}

function networkDecisionFor(state, cookieStoreId, url, operation = "GM network request") {
  const profile = state?.profiles?.[cookieStoreId];
  if (!profile?.managed) return { mode: "direct", profile, routeId: profile?.routeId, route: null };

  const decision = routeDecision(state, { cookieStoreId, url });
  if (decision.mode === "block") {
    const policyReasons = new Set(["local-network-blocked", "blocked-domain", "not-on-allowlist"]);
    if (policyReasons.has(decision.reason)) throw new Error(`${operation} blocked by Persona URL policy (${decision.reason})`);
    throw new Error(`${operation} blocked because this persona has no usable network route`);
  }
  if (decision.mode === "proxy" && decision.route?.provider !== "mullvad") {
    throw new Error(`${operation} for protected non-Mullvad proxy routes is blocked to prevent direct-IP leakage`);
  }
  return {
    mode: decision.mode === "proxy" ? "mullvad" : decision.mode,
    profile,
    routeId: profile.routeId,
    route: decision.route
  };
}

function contentTypeFromHeaders(headers) {
  return String((headers || []).find(([k]) => String(k).toLowerCase() === "content-type")?.[1] || "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
}

async function cancelBrowserDownload(waiter) {
  let downloadId;
  try { downloadId = await waiter.downloadPromise; }
  catch { return false; } // Firefox did not create a download entry.

  if (waiter.cancelPromise) {
    await waiter.cancelPromise;
    return true;
  }

  const cancelPromise = Promise.resolve()
    .then(() => browser.downloads.cancel(downloadId))
    .catch((error) => {
      const reason = String(error?.message || error).slice(0, 500);
      throw new Error(`Unable to cancel Firefox download: ${reason}`);
    });
  waiter.cancelPromise = cancelPromise;
  try {
    await cancelPromise;
    return true;
  } catch (error) {
    if (waiter.cancelPromise === cancelPromise) waiter.cancelPromise = null;
    throw error;
  }
}

function normalizedRequestHeaders(input) {
  const headers = {};
  if (Array.isArray(input)) {
    for (const item of input) if (item?.name) headers[String(item.name)] = String(item.value ?? "");
  } else if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) headers[String(key)] = String(value ?? "");
  }
  return headers;
}

async function readLimitedResponse(response, limit) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`GM_download response exceeds ${limit} bytes`);
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(`GM_download response exceeds ${limit} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch {}
        throw new Error(`GM_download response exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function gmDownload(script, sender, args, stateSnapshot = null) {
  const d = args?.details || {};
  const tab = sender.tab;
  const pageUrl = sender.url || tab?.url || undefined;
  const url = new URL(String(d.url || ""), pageUrl).href;
  if (!hostAllowed(script, url, pageUrl)) throw new Error(`GM_download blocked by @connect policy: ${new URL(url).hostname}`);
  const requestId = requestKey(tab?.id, script.id, args.requestId || crypto.randomUUID());
  const controller = new AbortController();
  if (consumePendingAbort(pendingDownloadAborts, requestId)) controller.abort("user");
  downloadControllers.set(requestId, controller);

  try {
    const state = stateSnapshot || await getStateFn?.();
    if (controller.signal.aborted) throw new Error("GM_download aborted");
    const decision = networkDecisionFor(state, tab?.cookieStoreId, url);
    const { profile, route } = decision;
    const filename = d.name ? String(d.name).replace(/^\/+/, "") : undefined;
    let downloadUrl;
    if (decision.mode === "mullvad") {
      const headers = normalizedRequestHeaders(d.headers);
      if (d.user && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
        headers.Authorization = `Basic ${btoa(unescape(encodeURIComponent(`${d.user}:${d.password || ""}`)))}`;
      }
      if (tab?.cookieStoreId && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) {
        const cookie = await containerCookieHeader(url, tab.cookieStoreId);
        if (cookie) headers.Cookie = cookie;
      }
      if (controller.signal.aborted) throw new Error("GM_download aborted");
      const native = await fetchViaExit(route, {
        url,
        method: "GET",
        headers,
        timeout_seconds: Math.max(1, Math.ceil(Number(d.timeout || 60000) / 1000)),
        max_redirects: 5,
        network_policy: networkPolicyForProfile(profile),
        connect_policy: connectPolicyForScript(script, pageUrl)
      }, Math.max(70000, Number(d.timeout || 0) + 10000), controller.signal);
      if (Number(native.status || 0) < 200 || Number(native.status || 0) >= 400) {
        throw new Error(`GM_download failed over Mullvad route (HTTP ${native.status || 0})`);
      }
      // Native host intentionally caps bodies. Turning the returned bytes into a
      // data URL prevents browser.downloads from making a second direct request.
      downloadUrl = `data:${contentTypeFromHeaders(native.headers)};base64,${native.body_base64 || ""}`;
    } else {
      const headers = new Headers(normalizedRequestHeaders(d.headers));
      if (d.user && !headers.has("authorization")) {
        headers.set("Authorization", `Basic ${btoa(unescape(encodeURIComponent(`${d.user}:${d.password || ""}`)))}`);
      }
      if (!d.anonymous && tab?.cookieStoreId && !headers.has("cookie")) {
        const cookie = await containerCookieHeader(url, tab.cookieStoreId);
        if (cookie) headers.set("Cookie", cookie);
      }
      if (controller.signal.aborted) throw new Error("GM_download aborted");
      const response = await fetch(url, { method: "GET", headers, redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`GM_download failed (HTTP ${response.status})`);
      const bytes = await readLimitedResponse(response, MAX_DIRECT_DOWNLOAD_BYTES);
      if (controller.signal.aborted) throw new Error("GM_download aborted");
      const contentType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
      downloadUrl = `data:${contentType || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
    }

    if (controller.signal.aborted) throw new Error("GM_download aborted");
    const waiter = { downloadPromise: null, cancelPromise: null };
    const downloadPromise = browser.downloads.download({
      url: downloadUrl,
      filename,
      saveAs: Boolean(d.saveAs),
      conflictAction: ["uniquify", "overwrite", "prompt"].includes(d.conflictAction) ? d.conflictAction : undefined
    });
    waiter.downloadPromise = Promise.resolve(downloadPromise);
    downloadWaiters.set(requestId, waiter);
    let downloadId;
    try { downloadId = await waiter.downloadPromise; }
    catch (error) {
      downloadWaiters.delete(requestId);
      throw error;
    }
    if (controller.signal.aborted) {
      await cancelBrowserDownload(waiter);
      downloadWaiters.delete(requestId);
      throw new Error("GM_download aborted");
    }
    return { id: downloadId, routed: decision.mode === "mullvad" };
  } finally {
    downloadControllers.delete(requestId);
    downloadWaiters.delete(requestId);
  }
}


function wrapperCode(payload, requiresCode, scriptCode) {
  // This bootstrap intentionally uses only WebExtension user-script-world globals.
  // It is serialized per script so legacy GM_getValue can remain synchronous.
  const p = JSON.stringify(payload);
  return `;(()=>{\n` +
`const __P=${p};\n` +
`const __normalizeFailure=${normalizeStructuredAutomationFailure.toString()};\n` +
`const __values=new Map(Object.entries(__P.values||{}));\n` +
`const __grants=new Set(__P.grants||[]);function __need(names,label){if(!names.some(n=>__grants.has(n))){const e=new Error(label+' denied: userscript did not declare a matching @grant');console.error('[PersonaMonkey userscript]',e.message);throw e}}\n` +
`const __listeners=new Map(); let __listenerSeq=0; let __seq=0; const __pending=new Map(); const __menuCallbacks=new Map();\n` +
`const __port=browser.runtime.connect({name:'persona-gm'});\n` +
`__port.onMessage.addListener((m)=>{\n` +
` if(m?.replyTo){const p=__pending.get(m.replyTo);if(p){__pending.delete(m.replyTo);m.ok?p.resolve(m.result):p.reject(new Error(m.error||'GM operation failed'));}return;}\n` +
` if(m?.event==='valueChanged'){const old=m.oldValue,newV=m.newValue; if(m.deleted)__values.delete(m.key); else __values.set(m.key,newV); for(const [id,l] of __listeners){if(l.key===m.key){try{l.cb(m.key,old,newV,!!m.remote)}catch(e){console.error(e)}}}return;}\n` +
` if(m?.event==='menuCommand'){const cb=__menuCallbacks.get(m.commandId);if(cb){try{cb()}catch(e){console.error(e)}}return;}\n` +
` if(m?.event==='notificationClick'){const cb=__P.notificationCallbacks?.[m.id];if(cb)try{cb()}catch(e){console.error(e)}}\n` +
`});\n` +
`function __call(method,args){const id=++__seq;return new Promise((resolve,reject)=>{__pending.set(id,{resolve,reject});try{__port.postMessage({id,method,args})}catch(e){__pending.delete(id);reject(e)}})}\n` +
`const unsafeWindow=__grants.has('unsafeWindow')?(window.wrappedJSObject||window):undefined;\n` +
`const GM_info=__grants.has('GM_info')?Object.freeze(__P.info):undefined;\n` +
`function __getValue(k,d){return __values.has(String(k))?__values.get(String(k)):d}\n` +
`function __getValues(keys){const out={};if(Array.isArray(keys)){for(const k of keys)if(__values.has(String(k)))out[k]=__values.get(String(k));}else if(keys&&typeof keys==='object'){for(const [k,d] of Object.entries(keys))out[k]=__getValue(k,d);}else for(const [k,v] of __values)out[k]=v;return out}\n` +
`function GM_getValue(k,d){__need(['GM_getValue','GM.getValue'],'GM_getValue');return __getValue(k,d)}\n` +
`function GM_getValues(keys){__need(['GM_getValues','GM.getValues'],'GM_getValues');return __getValues(keys)}\n` +
`function GM_setValue(k,v){__need(['GM_setValue','GM_setValues','GM.setValue','GM.setValues'],'GM_setValue');k=String(k);const old=__values.get(k);__values.set(k,v);__call('setValue',{key:k,value:v,oldValue:old}).catch(console.error)}\n` +
`function GM_setValues(data){for(const [k,v] of Object.entries(data||{}))GM_setValue(k,v)}\n` +
`function GM_deleteValue(k){__need(['GM_deleteValue','GM_deleteValues','GM.deleteValue','GM.deleteValues'],'GM_deleteValue');k=String(k);const old=__values.get(k);__values.delete(k);__call('deleteValue',{key:k,oldValue:old}).catch(console.error)}\n` +
`function GM_deleteValues(keys){for(const k of keys||[])GM_deleteValue(k)}\n` +
`function GM_listValues(){__need(['GM_listValues','GM.listValues'],'GM_listValues');return [...__values.keys()]}\n` +
`function GM_addValueChangeListener(key,cb){const id=++__listenerSeq;__listeners.set(id,{key:String(key),cb});return id}\n` +
`function GM_removeValueChangeListener(id){return __listeners.delete(id)}\n` +
`function GM_getResourceText(name){return __P.resources?.[name]?.text}\n` +
`function GM_getResourceURL(name){return __P.resources?.[name]?.dataUrl}\n` +
`function GM_addStyle(css){const el=document.createElement('style');el.textContent=String(css);(document.head||document.documentElement).appendChild(el);return el}\n` +
`function GM_addElement(...a){let parent=document.documentElement,tag,attrs;if(typeof a[0]==='string'){[tag,attrs]=a}else{[parent,tag,attrs]=a}const el=document.createElement(tag);for(const [k,v] of Object.entries(attrs||{})){if(k==='textContent')el.textContent=v;else if(k==='innerHTML')el.innerHTML=v;else if(k in el)try{el[k]=v}catch{el.setAttribute(k,v)}else el.setAttribute(k,v)}(parent||document.documentElement).appendChild(el);return el}\n` +
`function __openInTab(url,opt){__need(['GM_openInTab','GM.openInTab'],'GM_openInTab');return __call('openInTab',{url:String(url),options:opt||{}})}\n` +
`function GM_openInTab(url,opt){return __openInTab(url,opt)}\n` +
`function GM_setClipboard(data,type){__need(['GM_setClipboard','GM.setClipboard'],'GM_setClipboard');return __call('setClipboard',{data:String(data??''),type:type||'text/plain'})}\n` +
`function GM_notification(text,title,image,onclick){__need(['GM_notification','GM.notification'],'GM_notification');const opts=(text&&typeof text==='object')?text:{text,title,image,onclick};return __call('notification',{text:String(opts.text||''),title:String(opts.title||__P.info.script.name),image:String(opts.image||''),tag:String(opts.tag||'')})}\n` +
`function __cleanReq(d){const o={};for(const [k,v] of Object.entries(d||{}))if(typeof v!=='function'&&k!=='context')o[k]=v;return o}\n` +
`function GM_xmlhttpRequest(details){__need(['GM_xmlhttpRequest','GM.xmlHttpRequest','GM.xmlhttpRequest'],'GM_xmlhttpRequest');const d=details||{},requestId='x'+Math.random().toString(36).slice(2);let aborted=false;__call('xmlHttpRequest',{requestId,details:__cleanReq(d)}).then(r=>{if(!aborted){try{d.onload?.(r)}catch(e){console.error(e)};try{d.onloadend?.(r)}catch(e){console.error(e)}}}).catch(e=>{if(!aborted){const r={error:String(e?.message||e),status:0,readyState:4};try{d.onerror?.(r)}catch(x){console.error(x)};try{d.onloadend?.(r)}catch(x){console.error(x)}}});return{abort(){aborted=true;__call('abortXhr',{requestId}).catch(()=>{})}}}\n` +
`function GM_download(a,b){__need(['GM_download','GM.download'],'GM_download');const d=typeof a==='string'?{url:a,name:b}:a||{};let aborted=false,abortFailureReported=false;const requestId='d'+Math.random().toString(36).slice(2);__call('download',{requestId,details:__cleanReq(d)}).then(r=>{if(!aborted)d.onload?.(r)}).catch(e=>{if(!aborted&&!abortFailureReported)d.onerror?.({error:String(e?.message||e)})});return{abort(){aborted=true;__call('abortDownload',{requestId}).catch(e=>{aborted=false;abortFailureReported=true;try{d.onerror?.({error:String(e?.message||e)})}catch(x){console.error(x)}})}}}\n` +
`function GM_registerMenuCommand(name,cb,options){const id='m'+Math.random().toString(36).slice(2);__menuCallbacks.set(id,cb);__call('registerMenu',{commandId:id,name:String(name),options:options||{}}).catch(console.error);return id}\n` +
`function GM_unregisterMenuCommand(id){__menuCallbacks.delete(id);__call('unregisterMenu',{commandId:id}).catch(console.error)}\n` +
`const GM_cookie=Object.freeze({list:(opts,cb)=>__call('cookieList',{options:opts||{}}).then(v=>{cb?.(v)}).catch(e=>cb?.(undefined,String(e.message||e))),set:(opts,cb)=>__call('cookieSet',{options:opts||{}}).then(()=>cb?.()).catch(e=>cb?.(String(e.message||e))),delete:(opts,cb)=>__call('cookieDelete',{options:opts||{}}).then(()=>cb?.()).catch(e=>cb?.(String(e.message||e)))});\n` +
`const GM=Object.freeze({info:GM_info,cookie:GM_cookie,getValue:(k,d)=>(__need(['GM_getValue','GM.getValue'],'GM.getValue'),Promise.resolve(__getValue(k,d))),getValues:(k)=>(__need(['GM_getValues','GM.getValues'],'GM.getValues'),Promise.resolve(__getValues(k))),setValue:async(k,v)=>{__need(['GM_setValue','GM_setValues','GM.setValue','GM.setValues'],'GM.setValue');k=String(k);const old=__values.get(k);__values.set(k,v);await __call('setValue',{key:k,value:v,oldValue:old})},setValues:async(d)=>{for(const [k,v] of Object.entries(d||{}))await GM.setValue(k,v)},deleteValue:async(k)=>{__need(['GM_deleteValue','GM_deleteValues','GM.deleteValue','GM.deleteValues'],'GM.deleteValue');k=String(k);const old=__values.get(k);__values.delete(k);await __call('deleteValue',{key:k,oldValue:old})},deleteValues:async(keys)=>{for(const k of keys||[])await GM.deleteValue(k)},listValues:()=>(__need(['GM_listValues','GM.listValues'],'GM.listValues'),Promise.resolve([...__values.keys()])),addValueChangeListener:(k,cb)=>Promise.resolve(GM_addValueChangeListener(k,cb)),removeValueChangeListener:(id)=>Promise.resolve(GM_removeValueChangeListener(id)),getResourceText:(n)=>Promise.resolve(GM_getResourceText(n)),getResourceUrl:(n)=>Promise.resolve(GM_getResourceURL(n)),getResourceURL:(n)=>Promise.resolve(GM_getResourceURL(n)),addElement:(...a)=>Promise.resolve(GM_addElement(...a)),addStyle:(css)=>Promise.resolve(GM_addStyle(css)),openInTab:__openInTab,registerMenuCommand:(...a)=>Promise.resolve(GM_registerMenuCommand(...a)),unregisterMenuCommand:(id)=>Promise.resolve(GM_unregisterMenuCommand(id)),notification:(...a)=>Promise.resolve(GM_notification(...a)),setClipboard:GM_setClipboard,xmlHttpRequest:(d)=>new Promise((resolve,reject)=>{GM_xmlhttpRequest({...d,onload:r=>{try{d.onload?.(r)}finally{resolve(r)}},onerror:e=>{try{d.onerror?.(e)}finally{reject(e)}}})}),xmlhttpRequest:(d)=>GM.xmlHttpRequest(d),download:(...a)=>new Promise((resolve,reject)=>{const d=typeof a[0]==='string'?{url:a[0],name:a[1]}:{...(a[0]||{})};GM_download({...d,onload:r=>{d.onload?.(r);resolve(r)},onerror:e=>{d.onerror?.(e);reject(e)}})})});\n` +
`const __personaInput=Object.freeze({read:async(name,options={})=>{__need(['Persona.input'],'Persona.input');const chunk=await __call('inputRead',{name:String(name),offset:Number(options.offset)||0,length:Number(options.length)||65536});const raw=atob(chunk.dataBase64||'');const data=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)data[i]=raw.charCodeAt(i);return{...chunk,data}},text:async(name)=>{__need(['Persona.input'],'Persona.input');let offset=0;const chunks=[];for(;;){const chunk=await __personaInput.read(name,{offset,length:65536});chunks.push(chunk.data);offset=chunk.nextOffset;if(chunk.done)break;if(chunks.reduce((n,c)=>n+c.length,0)>4194304)throw new Error('Persona.input text exceeds the 4 MiB limit')}const all=new Uint8Array(offset);let pos=0;for(const part of chunks){all.set(part,pos);pos+=part.length}return new TextDecoder().decode(all)},json:async(name)=>JSON.parse(await __personaInput.text(name)),secret:async(name)=>{__need(['Persona.input'],'Persona.input');return __call('inputSecret',{name:String(name)})},wait:async(name,options={})=>{__need(['Persona.input'],'Persona.input');return __call('inputWait',{name:String(name),sensitivity:options.sensitivity==='secret'?'secret':'normal',timeoutMs:Number(options.timeoutMs)||600000})}});\n` +
`const Persona=Object.freeze({input:__personaInput,complete:(result)=>(__need(['Persona.signal'],'Persona.signal'),__call('automationSignal',{status:'complete',result})),fail:(error)=>(__need(['Persona.signal'],'Persona.signal'),__call('automationSignal',{status:'failed',error:error&&typeof error==='object'?__normalizeFailure(error):String(error??'failed')}))});\n` +
`if(__P.grants.includes('window.close'))try{window.close=()=>{__call('closeTab',{});}}catch{}\n` +
`if(__P.grants.includes('window.focus'))try{window.focus=()=>{__call('focusTab',{});}}catch{}\n` +
`${requiresCode}\n` +
`try{(async function(){\n${scriptCode}\n}).call(unsafeWindow)}catch(e){console.error('[PersonaMonkey userscript]',e);Persona.fail(e?.message||String(e))}\n` +
`//# sourceURL=persona-userscript-${String(payload.scriptId).replace(/[^a-zA-Z0-9_-]/g,"-")}.user.js\n` +
`})();`;
}

export async function prepareUserscriptInjection(script, context = {}) {
  if (script?.externalArtifact) assertExternalArtifactMetadataMatchesSource(script, script.code);
  const compatibility = analyzeGrants(script.grants || []);
  if (!compatibility.compatible) {
    throw new Error(`Unsupported @grant: ${compatibility.unsupported.join(", ")}`);
  }
  const deps = await fetchDependencies(script, context);
  const requiresCode = deps.requires.map((item) => `\n// @require ${item.url}\n${item.code}\n//# sourceURL=${item.url}\n`).join("\n");
  const tab = context.tab || {};
  const info = await buildGMInfo(script, tab, context.url || tab.url || "");
  const main = shouldUseMainWorld(script);

  if (main) {
    const bridge = mainPersonaBridge(context.automationToken || "");
    if (script.unwrap) {
      return {
        world: "MAIN",
        worldId: null,
        code: `${bridge}\n${requiresCode}\n${script.code}\n//# sourceURL=persona-userscript-${script.id}.user.js`
      };
    }
    return {
      world: "MAIN",
      worldId: null,
      code: `;(()=>{${bridge}\n${requiresCode}\n${script.code}\n//# sourceURL=persona-userscript-${script.id}.user.js\n}).call(window);`
    };
  }

  const values = await loadValues(script.id);
  const resources = {};
  for (const [name, item] of Object.entries(deps.resources)) resources[name] = { text: item.text, dataUrl: item.dataUrl, url: item.url };
  const payload = {
    scriptId: script.id,
    values,
    resources,
    grants: script.grants || [],
    info,
    automationToken: context.automationToken || ""
  };
  return {
    world: "USER_SCRIPT",
    worldId: await worldIdForScript(script.id),
    code: wrapperCode(payload, requiresCode, script.code)
  };
}

function portSet(scriptId) {
  let set = portsByScript.get(scriptId);
  if (!set) portsByScript.set(scriptId, set = new Set());
  return set;
}

function menuKey(tabId) { return String(tabId); }
function commandList(tabId) {
  return menuCommands.get(menuKey(tabId)) || [];
}

function broadcastValue(scriptId, sourcePort, event) {
  for (const port of portsByScript.get(scriptId) || []) {
    try { port.postMessage({ event: "valueChanged", ...event, remote: port !== sourcePort }); } catch {}
  }
}

function hostAllowed(script, targetUrl, pageUrl) {
  let target, page;
  try { target = new URL(targetUrl, pageUrl); page = new URL(pageUrl); } catch { return false; }
  if (target.origin === page.origin) return true;
  const rules = script.connects || [];
  if (rules.includes("*")) return true;
  for (const raw of rules) {
    const rule = String(raw).trim().toLowerCase();
    if (!rule) continue;
    if (rule === "self" && target.origin === page.origin) return true;
    const host = target.hostname.toLowerCase();
    const clean = rule.replace(/^\*\./, "").replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
    if (host === clean || host.endsWith(`.${clean}`)) return true;
  }
  return false;
}

function decodeBase64Bytes(value) {
  const binary = atob(String(value || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function headersToRaw(headers) {
  return (headers || []).map(([k, v]) => `${k}: ${v}`).join("\r\n");
}

async function containerCookieHeader(url, storeId) {
  if (!storeId) return "";
  try {
    const cookies = await browser.cookies.getAll({ url, storeId });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch { return ""; }
}

async function gmXhr(script, sender, args, stateSnapshot = null) {
  const details = args?.details || {};
  const pageUrl = sender.url || sender.tab?.url || "";
  const url = new URL(String(details.url || ""), pageUrl).href;
  if (!hostAllowed(script, url, pageUrl)) throw new Error(`GM_xmlhttpRequest blocked by @connect policy: ${new URL(url).hostname}`);
  const requestId = requestKey(sender.tab?.id, script.id, args.requestId || crypto.randomUUID());
  const controller = new AbortController();
  if (consumePendingAbort(pendingXhrAborts, requestId)) controller.abort("user");
  xhrControllers.set(requestId, controller);
  let timer = null;
  if (Number(details.timeout) > 0) timer = setTimeout(() => controller.abort("timeout"), Number(details.timeout));
  try {
    const state = stateSnapshot || await getStateFn?.();
    if (controller.signal.aborted) throw new Error("GM_xmlhttpRequest aborted");
    const decision = networkDecisionFor(state, sender.tab?.cookieStoreId, url);
    const { profile, route } = decision;
    const headersObj = {};
    for (const [k, v] of Object.entries(details.headers || {})) headersObj[String(k)] = String(v);
    if (details.user && !Object.keys(headersObj).some((k) => k.toLowerCase() === "authorization")) {
      headersObj.Authorization = `Basic ${btoa(unescape(encodeURIComponent(`${details.user}:${details.password || ""}`)))}`;
    }
    if (!details.anonymous && sender.tab?.cookieStoreId && !Object.keys(headersObj).some((k) => k.toLowerCase() === "cookie")) {
      const cookie = await containerCookieHeader(url, sender.tab.cookieStoreId);
      if (cookie) headersObj.Cookie = cookie;
    }
    if (controller.signal.aborted) throw new Error("GM_xmlhttpRequest aborted");
    const method = String(details.method || "GET").toUpperCase();
    let body = details.data ?? null;
    if (body != null && typeof body !== "string") {
      if (body instanceof URLSearchParams) body = body.toString();
      else if (typeof body === "number" || typeof body === "boolean") body = String(body);
      else throw new Error("This compatibility build currently supports string GM_xmlhttpRequest request bodies only");
    }

    let response;
    if (decision.mode === "mullvad") {
      // Critical invariant: protected cross-origin userscript traffic must use the same
      // Mullvad relay rather than extension-background networking.
      const native = await fetchViaExit(route, {
        url,
        method,
        headers: headersObj,
        body,
        timeout_seconds: Math.max(1, Math.ceil(Number(details.timeout || 30000) / 1000)),
        max_redirects: 5,
        network_policy: networkPolicyForProfile(profile),
        connect_policy: connectPolicyForScript(script, pageUrl)
      }, Math.max(45000, Number(details.timeout || 0) + 10000), controller.signal);
      const bytes = decodeBase64Bytes(native.body_base64);
      const responseHeaders = headersToRaw(native.headers);
      const responseType = String(details.responseType || "text").toLowerCase();
      let responseValue, responseText = "";
      if (responseType === "arraybuffer") {
        responseValue = bytes.buffer;
      } else if (responseType === "blob") {
        const contentType = (native.headers || []).find(([k]) => String(k).toLowerCase() === "content-type")?.[1] || "application/octet-stream";
        responseValue = new Blob([bytes], { type: contentType });
      } else {
        responseText = new TextDecoder().decode(bytes);
        if (responseType === "json") {
          try { responseValue = JSON.parse(responseText); } catch { responseValue = null; }
        } else responseValue = responseText;
      }
      response = {
        finalUrl: native.final_url || url,
        readyState: 4,
        status: Number(native.status || 0),
        statusText: String(native.status_text || ""),
        responseHeaders,
        response: responseValue,
        responseText
      };
    } else {
      const headers = new Headers(headersObj);
      const direct = await fetch(url, {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : (body ?? undefined),
      redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        cache: "no-store"
      });
      const responseHeaders = [...direct.headers.entries()].map(([k,v]) => `${k}: ${v}`).join("\r\n");
      const responseType = String(details.responseType || "text").toLowerCase();
      let responseValue, responseText = "";
      if (responseType === "json") {
        responseText = await direct.text();
        try { responseValue = JSON.parse(responseText); } catch { responseValue = null; }
      } else if (responseType === "arraybuffer") responseValue = await direct.arrayBuffer();
      else if (responseType === "blob") responseValue = await direct.blob();
      else { responseText = await direct.text(); responseValue = responseText; }
      response = { finalUrl: direct.url, readyState: 4, status: direct.status, statusText: direct.statusText, responseHeaders, response: responseValue, responseText };
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "timeout") throw new Error("GM_xmlhttpRequest timeout");
    if (controller.signal.aborted) throw new Error("GM_xmlhttpRequest aborted");
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    xhrControllers.delete(requestId);
  }
}

async function getTabData() {
  const obj = await browser.storage.local.get(TAB_DATA_KEY);
  return obj[TAB_DATA_KEY] && typeof obj[TAB_DATA_KEY] === "object" ? obj[TAB_DATA_KEY] : {};
}

async function dispatchCall(script, port, message, stateSnapshot = null) {
  const sender = port.sender || {};
  const tab = sender.tab;
  const args = message.args || {};
  requireGrant(script, message.method);
  switch (message.method) {
    case "setValue": {
      const values = await loadValues(script.id);
      const key = String(args.key);
      const oldValue = Object.prototype.hasOwnProperty.call(values, key) ? clone(values[key]) : undefined;
      values[key] = clone(args.value);
      await saveValues(script.id, values);
      broadcastValue(script.id, port, { key, oldValue, newValue: clone(args.value), deleted: false });
      return true;
    }
    case "deleteValue": {
      const values = await loadValues(script.id);
      const key = String(args.key);
      const oldValue = Object.prototype.hasOwnProperty.call(values, key) ? clone(values[key]) : undefined;
      delete values[key];
      await saveValues(script.id, values);
      broadcastValue(script.id, port, { key, oldValue, newValue: undefined, deleted: true });
      return true;
    }
    case "xmlHttpRequest": return gmXhr(script, sender, args, stateSnapshot);
    case "abortXhr": {
      const key = requestKey(tab?.id, script.id, args.requestId);
      xhrControllers.get(key)?.abort("user");
      return true;
    }
    case "openInTab": {
      const url = new URL(String(args.url || ""), sender.url || tab?.url || undefined).href;
      const options = args.options || {};
      const created = await browser.tabs.create({
        url,
        active: options.active !== false,
        cookieStoreId: tab?.cookieStoreId,
        openerTabId: options.insert === false ? undefined : tab?.id
      });
      return { id: created.id, url: created.url, closed: false };
    }
    case "closeTab": if (tab?.id != null) await browser.tabs.remove(tab.id); return true;
    case "focusTab": if (tab?.id != null) await browser.tabs.update(tab.id, { active: true }); return true;
    case "setClipboard": {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable in background context");
      await navigator.clipboard.writeText(String(args.data ?? ""));
      return true;
    }
    case "notification": {
      const id = `persona-gm-${crypto.randomUUID()}`;
      await browser.notifications.create(id, {
        type: "basic",
        iconUrl: args.image || browser.runtime.getURL("icons/icon96.png"),
        title: String(args.title || script.name),
        message: String(args.text || "")
      });
      return id;
    }
    case "download": return gmDownload(script, sender, args, stateSnapshot);
    case "abortDownload": {
      const requestId = requestKey(tab?.id, script.id, args.requestId);
      downloadControllers.get(requestId)?.abort("user");
      const waiter = downloadWaiters.get(requestId);
      if (waiter) {
        await cancelBrowserDownload(waiter);
        downloadWaiters.delete(requestId);
      }
      return true;
    }
    case "registerMenu": {
      if (tab?.id == null) return false;
      const key = menuKey(tab.id);
      const list = commandList(tab.id).filter((c) => !(c.scriptId === script.id && c.commandId === args.commandId));
      list.push({ scriptId: script.id, scriptName: script.name, commandId: String(args.commandId), name: String(args.name || "Command").slice(0, 200), port });
      menuCommands.set(key, list);
      return args.commandId;
    }
    case "unregisterMenu": {
      if (tab?.id == null) return false;
      const key = menuKey(tab.id);
      menuCommands.set(key, commandList(tab.id).filter((c) => !(c.scriptId === script.id && c.commandId === args.commandId)));
      return true;
    }
    case "cookieList": {
      const options = { ...(args.options || {}) };
      options.storeId = tab?.cookieStoreId;
      if (!options.url && sender.url) options.url = sender.url;
      assertCookieScope(script, options, sender.url);
      const cookies = await browser.cookies.getAll(options);
      return cookies.filter((cookie) => cookieResultInScope(script, cookie));
    }
    case "cookieSet": {
      const options = { ...(args.options || {}) };
      options.storeId = tab?.cookieStoreId;
      if (!options.url) options.url = sender.url;
      assertCookieScope(script, options, sender.url);
      return browser.cookies.set(options);
    }
    case "cookieDelete": {
      const options = { ...(args.options || {}) };
      options.storeId = tab?.cookieStoreId;
      if (!options.url) options.url = sender.url;
      assertCookieScope(script, options, sender.url);
      return browser.cookies.remove(options);
    }
    case "automationSignal": {
      if (automationSignalFn) return automationSignalFn({
        tabId: tab?.id,
        scriptId: script.id,
        status: args.status === "failed" ? "failed" : "complete",
        result: args.result,
        error: args.error
      });
      return false;
    }
    case "inputRead":
      if (!automationInputFn) throw new Error("Persona.input is unavailable");
      return automationInputFn({ tabId: tab?.id, scriptId: script.id, action: "read", args });
    case "inputSecret":
      if (!automationInputFn) throw new Error("Persona.input is unavailable");
      return automationInputFn({ tabId: tab?.id, scriptId: script.id, action: "secret", args });
    case "inputWait":
      if (!automationInputFn) throw new Error("Persona.input is unavailable");
      return automationInputFn({ tabId: tab?.id, scriptId: script.id, action: "wait", args });
    case "getTabData": {
      const all = await getTabData();
      return clone(all[`${script.id}:${tab?.id}`] || {});
    }
    case "saveTabData": {
      const all = await getTabData();
      all[`${script.id}:${tab?.id}`] = clone(args.data || {});
      await browser.storage.local.set({ [TAB_DATA_KEY]: all });
      return true;
    }
    case "getTabsData": {
      const all = await getTabData();
      const out = {};
      for (const [key, value] of Object.entries(all)) if (key.startsWith(`${script.id}:`)) out[key.slice(script.id.length + 1)] = clone(value);
      return out;
    }
    default: throw new Error(`Unsupported GM bridge operation: ${message.method}`);
  }
}

function assertCookieScope(script, options, senderUrl) {
  const url = options.url || senderUrl;
  if (!url || !userScriptHostAllowed(script, url)) {
    throw new Error("GM_cookie denied: URL is outside the userscript's declared host scope");
  }
  if (options.domain && !userScriptCookieDomainAllowed(script, options.domain)) {
    throw new Error("GM_cookie denied: domain is outside the userscript's declared host scope");
  }
  if (options.firstPartyDomain && !userScriptCookieDomainAllowed(script, options.firstPartyDomain)) {
    throw new Error("GM_cookie denied: first-party domain is outside the userscript's declared host scope");
  }
  const topLevelSite = options.partitionKey?.topLevelSite;
  if (topLevelSite && !userScriptHostAllowed(script, topLevelSite)) {
    throw new Error("GM_cookie denied: partition is outside the userscript's declared host scope");
  }
}

function cookieResultInScope(script, cookie) {
  if (!userScriptCookieDomainAllowed(script, cookie?.domain || "")) return false;
  if (cookie?.firstPartyDomain && !userScriptCookieDomainAllowed(script, cookie.firstPartyDomain)) return false;
  const topLevelSite = cookie?.partitionKey?.topLevelSite;
  return !topLevelSite || userScriptHostAllowed(script, topLevelSite);
}

export function configureGMCompat({ getState, onAutomationSignal, onAutomationInput } = {}) {
  getStateFn = getState || getStateFn;
  automationSignalFn = onAutomationSignal || automationSignalFn;
  automationInputFn = onAutomationInput || automationInputFn;
  if (configured) return;
  configured = true;
  if (!browser.runtime.onUserScriptConnect) return;
  browser.runtime.onUserScriptConnect.addListener((port) => {
    const worldId = port.sender?.userScriptWorldId || "";
    const tab = port.sender?.tab;
    async function resolveCurrentScript(state, requestedId = "") {
      const candidates = await Promise.all(Object.values(state?.scripts || {}).map(async (candidate) =>
        await worldIdForScript(candidate.id) === worldId ? candidate : null));
      const matches = candidates.filter(Boolean);
      if (matches.length !== 1) return null;
      const candidate = matches[0];
      if (requestedId && candidate.id !== requestedId) return null;
      if (!candidate.enabled || !tab || !candidate.profileIds?.includes(tab.cookieStoreId)) return null;
      if (!userScriptMatches(candidate, port.sender?.url || tab.url || "")) return null;
      if (shouldUseMainWorld(candidate)) return null;
      return candidate;
    }
    void (async () => {
      const state = getStateFn ? await getStateFn() : null;
      const script = await resolveCurrentScript(state);
      if (!script) {
        try { port.disconnect(); } catch {}
        return;
      }
      portSet(script.id).add(port);
      port.onDisconnect.addListener(() => {
        portsByScript.get(script.id)?.delete(port);
        if (tab?.id != null) {
          const key = menuKey(tab.id);
          menuCommands.set(key, commandList(tab.id).filter((c) => c.port !== port));
        }
      });
      port.onMessage.addListener((message) => {
        if (!message?.id || !message.method) return;
        const args = message.args || {};
        if (message.method === "abortXhr" || message.method === "abortDownload") {
          const key = requestKey(tab?.id, script.id, args.requestId);
          const controllers = message.method === "abortXhr" ? xhrControllers : downloadControllers;
          const pending = message.method === "abortXhr" ? pendingXhrAborts : pendingDownloadAborts;
          if (controllers.has(key)) controllers.get(key)?.abort("user");
          else rememberPendingAbort(pending, key);
          if (message.method === "abortDownload") {
            const waiter = downloadWaiters.get(key);
            if (waiter) {
              void cancelBrowserDownload(waiter).then(
                () => { downloadWaiters.delete(key); try { port.postMessage({ replyTo: message.id, ok: true, result: true }); } catch {} },
                (error) => { try { port.postMessage({ replyTo: message.id, ok: false, error: String(error?.message || error) }); } catch {} }
              );
              return;
            }
          }
          try { port.postMessage({ replyTo: message.id, ok: true, result: true }); } catch {}
          return;
        }
        void (async () => {
          const currentState = getStateFn ? await getStateFn() : null;
          const currentScript = await resolveCurrentScript(currentState, script.id);
          if (!currentScript) throw new Error("Userscript permissions or persona assignment changed; reconnect to continue");
          return dispatchCall(currentScript, port, message, currentState);
        })().then(
          (result) => { try { port.postMessage({ replyTo: message.id, ok: true, result }); } catch {} },
          (error) => { try { port.postMessage({ replyTo: message.id, ok: false, error: String(error?.message || error) }); } catch {} }
        );
      });
    })();
  });
}

export function getMenuCommandsForTab(tabId) {
  return commandList(tabId).map(({ port, ...command }) => command);
}

export function runMenuCommand(tabId, scriptId, commandId) {
  const command = commandList(tabId).find((c) => c.scriptId === scriptId && c.commandId === commandId);
  if (!command) return false;
  try { command.port.postMessage({ event: "menuCommand", commandId }); return true; } catch { return false; }
}

export function clearMenuCommandsForTab(tabId) {
  menuCommands.delete(menuKey(tabId));
}

export function invalidateDependencyCache(scriptId) {
  dependencyCache.delete(scriptId);
}

export async function exportUserscriptData() {
  const all = await browser.storage.local.get(null);
  const values = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(VALUE_PREFIX) || key === TAB_DATA_KEY) values[key] = clone(value);
  }
  return values;
}

export async function importUserscriptData(data, mode = "replace") {
  const incoming = data && typeof data === "object" ? data : {};
  const all = await browser.storage.local.get(null);
  if (mode === "replace") {
    const remove = Object.keys(all).filter((key) => key.startsWith(VALUE_PREFIX) || key === TAB_DATA_KEY);
    if (remove.length) await browser.storage.local.remove(remove);
  }
  const safe = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (key.startsWith(VALUE_PREFIX) || key === TAB_DATA_KEY) safe[key] = clone(value);
  }
  if (Object.keys(safe).length) await browser.storage.local.set(safe);
  return true;
}
