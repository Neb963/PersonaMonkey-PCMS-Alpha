import assert from 'node:assert/strict';

const userConnectListeners = [];
const nativeMessageListeners = [];
const nativeDisconnectListeners = [];
let downloaded = null;
const downloadCalls = [];
let nativeRequest = null;
let pendingNativeFetch = null;
let lastDirectFetchUrl = '';
const nativeCancellations = [];
const cancelledDownloads = [];
const wrapperPortListeners = [];
let releaseBrowserDownload = null;
let browserCancelError = null;
const activeDownloadIds = new Set();
const nativeFetchRequests = [];

const nativePort = {
  onMessage: { addListener(fn) { nativeMessageListeners.push(fn); } },
  onDisconnect: { addListener(fn) { nativeDisconnectListeners.push(fn); } },
  postMessage(msg) {
    nativeRequest = msg;
    if (msg.command === 'fetch_exit') nativeFetchRequests.push(msg.request?.url);
    if (msg.command === 'fetch_exit' && msg.request?.url?.endsWith('/slow-cancel')) {
      pendingNativeFetch = msg;
      return;
    }
    if (msg.command === 'cancel_fetch') {
      nativeCancellations.push(msg.request_id);
      const pending = pendingNativeFetch;
      if (pending?.request.request_id === msg.request_id) {
        pendingNativeFetch = null;
        queueMicrotask(() => {
          for (const fn of [...nativeMessageListeners]) fn({ id: pending.id, ok: false, error: 'request cancelled' });
        });
      }
      queueMicrotask(() => {
        for (const fn of [...nativeMessageListeners]) fn({ id: msg.id, ok: true, cancelled: true });
      });
      return;
    }
    queueMicrotask(() => {
      for (const fn of [...nativeMessageListeners]) fn({
        id: msg.id,
        ok: true,
        status: 200,
        status_text: 'OK',
        final_url: msg.request?.url,
        headers: [['Content-Type', 'text/plain']],
        body_base64: Buffer.from('abc').toString('base64')
      });
    });
  },
  disconnect() {}
};

globalThis.browser = {
  storage: { local: {
    async get(key) { return typeof key === 'string' ? { [key]: undefined } : {}; },
    async set() {},
    async remove() {}
  }},
  runtime: {
    getManifest() { return { version: '0.3.0' }; },
    async getPlatformInfo() { return { arch: 'x86-64', os: 'linux' }; },
    async getBrowserInfo() { return { name: 'Firefox', version: '155' }; },
    connectNative() { return nativePort; },
    onUserScriptConnect: { addListener(fn) { userConnectListeners.push(fn); } },
    lastError: null
  },
  cookies: { async getAll() { return [{ name: 'sid', value: 'container-cookie' }]; } },
  downloads: {
    async download(opts) {
      if (lastDirectFetchUrl.endsWith('/browser-delay') || lastDirectFetchUrl.endsWith('/browser-cancel-fails') || lastDirectFetchUrl.endsWith('/wrapper-cancel-failure')) {
        await new Promise(resolve => { releaseBrowserDownload = resolve; });
      }
      downloaded = opts;
      downloadCalls.push(opts);
      const id = lastDirectFetchUrl.endsWith('/browser-delay') ? 99 : (lastDirectFetchUrl.endsWith('/browser-cancel-fails') || lastDirectFetchUrl.endsWith('/wrapper-cancel-failure')) ? 100 : 77;
      activeDownloadIds.add(id);
      return id;
    },
    async cancel(id) {
      if (browserCancelError) throw browserCancelError;
      cancelledDownloads.push(id);
      activeDownloadIds.delete(id);
    }
  },
  tabs: { async create() { throw new Error('should not create'); }, async remove() {}, async update() {} },
  notifications: { async create() { return 'n'; } }
};

const state = {
  global: { unmanagedPolicy: 'direct' },
  profiles: {
    'firefox-container-1': { managed: true, routeId: 'mv', killSwitch: true, blockLocalNetwork: true, domainMode: 'any', allowedDomains: [], blockedDomains: [] }
  },
  routes: {
    mv: { id: 'mv', provider: 'mullvad', type: 'socks', host: '10.64.0.2', port: 1080 }
  },
  scripts: {
    s1: { id: 's1', name: 'Downloader', enabled: true, profileIds: ['firefox-container-1'], grants: ['GM_download', 'GM_xmlhttpRequest'], connects: ['*'] }
  }
};

const mod = await import(`../lib/gm-compat.js?security=${Date.now()}`);
const { worldIdForScript } = await import('../lib/userscripts.js');
const scriptWorldId = await worldIdForScript('s1');
mod.configureGMCompat({ getState: async () => state });
assert.equal(userConnectListeners.length, 1);

const messageListeners = [];
const replies = [];
const userPort = {
  sender: {
    userScriptWorldId: scriptWorldId,
    url: 'https://example.com/page',
    tab: { id: 9, cookieStoreId: 'firefox-container-1', url: 'https://example.com/page' }
  },
  onDisconnect: { addListener() {} },
  onMessage: { addListener(fn) { messageListeners.push(fn); } },
  postMessage(msg) { replies.push(msg); for (const listener of wrapperPortListeners) listener(msg); },
  disconnect() { throw new Error('unexpected disconnect'); }
};
userConnectListeners[0](userPort);
for (let i = 0; i < 20 && !messageListeners.length; i++) await new Promise(r => setTimeout(r, 1));
assert.equal(messageListeners.length, 1);

async function call(id, method, args = {}) {
  send(id, method, args);
  return waitReply(id);
}

function send(id, method, args = {}) {
  messageListeners[0]({ id, method, args });
}

async function waitReply(id) {
  for (let i = 0; i < 50 && !replies.some(x => x.replyTo === id); i++) await new Promise(r => setTimeout(r, 1));
  return replies.find(x => x.replyTo === id);
}

const downloadReply = await call(1, 'download', { requestId: 'd1', details: { url: 'https://files.example/file.txt', name: 'file.txt' } });
assert.equal(downloadReply.ok, true);
assert.equal(nativeRequest.command, 'fetch_exit');
assert.equal(nativeRequest.request.headers.Cookie, 'sid=container-cookie');
assert.equal(nativeRequest.request.network_policy.block_local_network, true);
assert.deepEqual(nativeRequest.request.connect_policy, { page_url: 'https://example.com/page', rules: ['*'] });
assert.match(downloaded.url, /^data:text\/plain;base64,YWJj$/);
assert.equal(downloaded.filename, 'file.txt');

const dependencyUrl = 'https://cdn.example/lib.js';
await mod.prepareUserscriptInjection({
  ...state.scripts.s1,
  code: 'window.dependencyLoaded = true;',
  requires: [dependencyUrl],
  resources: {}
}, { tab: userPort.sender.tab, url: userPort.sender.url });
assert.equal(nativeRequest.command, 'fetch_exit');
assert.equal(nativeRequest.request.url, dependencyUrl);
assert.deepEqual(nativeRequest.request.connect_policy, { page_url: dependencyUrl, rules: ['*'] }, 'declared dependency fetches carry an explicit scoped connect policy');

let directFetches = 0;
let lastDirectFetchInit = null;
globalThis.fetch = async (_url, init) => {
  directFetches += 1;
  lastDirectFetchUrl = String(_url);
  lastDirectFetchInit = init;
  if (String(_url).endsWith('/oversized')) {
    return new Response(null, { status: 200, headers: { 'content-length': String(20 * 1024 * 1024 + 1) } });
  }
  if (String(_url).endsWith('/redirect')) throw new TypeError('redirect mode is set to error');
  return new Response('direct response', { status: 200 });
};
const xhrReply = await call(2, 'xmlHttpRequest', { requestId: 'x-mullvad', details: { url: 'https://example.com/data' } });
assert.equal(xhrReply.ok, true, 'Mullvad GM_xmlhttpRequest should complete through the native route');
assert.equal(nativeRequest.command, 'fetch_exit');
assert.equal(directFetches, 0, 'Mullvad GM_xmlhttpRequest must not use extension-background fetch');

const originalGrants = [...state.scripts.s1.grants];
const requestCountBeforeGrantRevocation = nativeFetchRequests.length;
state.scripts.s1.grants = [];
const revokedGrant = await call(62, 'xmlHttpRequest', { requestId: 'revoked-grant', details: { url: 'https://example.com/data' } });
assert.equal(revokedGrant.ok, false, 'each GM call must use current @grant metadata');
assert.match(revokedGrant.error, /did not declare/);
assert.equal(nativeFetchRequests.length, requestCountBeforeGrantRevocation, 'revoked grants must not start another native request');
state.scripts.s1.grants = originalGrants;

state.scripts.s1.enabled = false;
const disabledScriptCall = await call(63, 'xmlHttpRequest', { requestId: 'disabled-script', details: { url: 'https://example.com/data' } });
assert.equal(disabledScriptCall.ok, false, 'disabled scripts must lose access through existing ports');
assert.match(disabledScriptCall.error, /permissions or persona assignment changed/);
state.scripts.s1.enabled = true;
state.scripts.s1.profileIds = [];
const unassignedScriptCall = await call(64, 'xmlHttpRequest', { requestId: 'unassigned-script', details: { url: 'https://example.com/data' } });
assert.equal(unassignedScriptCall.ok, false, 'unassigned scripts must lose access through existing ports');
state.scripts.s1.profileIds = ['firefox-container-1'];
state.scripts.collision = { ...state.scripts.s1, id: 's1', name: 'Colliding identity' };
const ambiguousWorldCall = await call(65, 'xmlHttpRequest', { requestId: 'ambiguous-world', details: { url: 'https://example.com/data' } });
assert.equal(ambiguousWorldCall.ok, false, 'ambiguous world IDs must not route privileged calls');
assert.match(ambiguousWorldCall.error, /permissions or persona assignment changed/);
delete state.scripts.collision;

for (const [routeId, label, baseId] of [
  [undefined, 'missing', 3],
  ['deleted-route', 'unknown', 5],
  ['__block__', 'blocked', 7]
]) {
  state.profiles['firefox-container-1'].routeId = routeId;
  const downloadsBefore = downloadCalls.length;
  const fetchesBefore = directFetches;
  const blockedDownload = await call(baseId, 'download', {
    requestId: `d-${label}`, details: { url: 'https://files.example/file.txt' }
  });
  assert.equal(blockedDownload.ok, false, `GM_download must fail closed when the route is ${label}`);
  assert.match(blockedDownload.error, /usable network route/);
  assert.equal(downloadCalls.length, downloadsBefore, `a ${label} route must not start a direct browser download`);
  const blockedXhr = await call(baseId + 1, 'xmlHttpRequest', {
    requestId: `x-${label}`, details: { url: 'https://example.com/data' }
  });
  assert.equal(blockedXhr.ok, false, `GM_xmlhttpRequest must fail closed when the route is ${label}`);
  assert.match(blockedXhr.error, /usable network route/);
  assert.equal(directFetches, fetchesBefore, `a ${label} route must not start a direct extension fetch`);
}

// A forged or imported route object under a reserved sentinel must not override
// the routeDecision contract, and disabled Mullvad routes must fail closed when
// the Persona kill switch is enabled.
state.routes.__block__ = { id: '__block__', provider: 'mullvad', type: 'socks', host: '10.64.0.2', port: 1080, enabled: true };
state.routes.disabled = { id: 'disabled', provider: 'mullvad', type: 'socks', host: '10.64.0.2', port: 1080, enabled: false };
for (const [routeId, label, baseId] of [['__block__', 'reserved Block', 20], ['disabled', 'disabled Mullvad', 22]]) {
  state.profiles['firefox-container-1'].routeId = routeId;
  const before = { downloads: downloadCalls.length, fetches: directFetches, native: nativeRequest };
  const blockedXhr = await call(baseId, 'xmlHttpRequest', { requestId: `x-${label}`, details: { url: 'https://example.com/data' } });
  const blockedDownload = await call(baseId + 1, 'download', { requestId: `d-${label}`, details: { url: 'https://files.example/file.txt' } });
  assert.equal(blockedXhr.ok, false, `${label} must not route GM_xmlhttpRequest`);
  assert.equal(blockedDownload.ok, false, `${label} must not route GM_download`);
  assert.match(blockedXhr.error, /no usable network route/);
  assert.equal(downloadCalls.length, before.downloads);
  assert.equal(directFetches, before.fetches);
  assert.equal(nativeRequest, before.native, `${label} must not invoke native Mullvad networking`);
}

state.routes.generic = { id: 'generic', provider: 'generic', enabled: true };
state.profiles['firefox-container-1'].routeId = 'generic';
const genericDownload = await call(9, 'download', { requestId: 'd-generic', details: { url: 'https://files.example/file.txt' } });
assert.equal(genericDownload.ok, false, 'a protected generic proxy must not silently fall back to a direct download');
assert.match(genericDownload.error, /non-Mullvad proxy routes/);
const genericXhr = await call(10, 'xmlHttpRequest', { requestId: 'x-generic', details: { url: 'https://example.com/data' } });
assert.equal(genericXhr.ok, false, 'a protected generic proxy must not silently fall back to direct fetch');
assert.match(genericXhr.error, /non-Mullvad proxy routes/);
assert.equal(directFetches, 0);

state.profiles['firefox-container-1'].routeId = '__direct__';
const directXhr = await call(11, 'xmlHttpRequest', { requestId: 'x-direct', details: { url: 'https://example.com/data' } });
assert.equal(directXhr.ok, true, 'explicit Direct routing remains an intentional network bypass');
assert.equal(directFetches, 1);
assert.equal(lastDirectFetchInit.redirect, 'error', 'Direct GM XHR must fail closed on redirects');
const directDownload = await call(12, 'download', { requestId: 'd-direct', details: { url: 'https://files.example/file.txt' } });
assert.equal(directDownload.ok, true);
assert.equal(directFetches, 2, 'Direct GM_download must fetch the bytes before starting a browser download');
assert.equal(lastDirectFetchInit.redirect, 'error', 'Direct GM_download must fail closed on redirects');
assert.match(downloaded.url, /^data:text\/plain;base64,/);

const directDownloadsBeforeDeniedConnect = downloadCalls.length;
const directFetchesBeforeDeniedConnect = directFetches;
state.scripts.s1.connects = ['allowed.example'];
const connectDeniedXhr = await call(66, 'xmlHttpRequest', { requestId: 'connect-denied-xhr', details: { url: 'https://files.example/data' } });
const connectDeniedDownload = await call(67, 'download', { requestId: 'connect-denied-download', details: { url: 'https://files.example/file' } });
assert.equal(connectDeniedXhr.ok, false);
assert.match(connectDeniedXhr.error, /@connect policy/);
assert.equal(connectDeniedDownload.ok, false);
assert.match(connectDeniedDownload.error, /@connect policy/);
assert.equal(directFetches, directFetchesBeforeDeniedConnect, '@connect denial must happen before any direct fetch');
assert.equal(downloadCalls.length, directDownloadsBeforeDeniedConnect, '@connect denial must not start a browser download');
state.scripts.s1.connects = ['*'];

const oversizedDownload = await call(68, 'download', { requestId: 'oversized-download', details: { url: 'https://files.example/oversized' } });
assert.equal(oversizedDownload.ok, false, 'oversized direct responses must be rejected before Firefox downloads them');
assert.match(oversizedDownload.error, /exceeds 20971520 bytes/);
assert.equal(downloadCalls.length, directDownloadsBeforeDeniedConnect);
const redirectedDownload = await call(69, 'download', { requestId: 'redirected-download', details: { url: 'https://files.example/redirect' } });
assert.equal(redirectedDownload.ok, false, 'Direct downloads must not follow redirects');
assert.equal(lastDirectFetchInit.redirect, 'error');
assert.equal(downloadCalls.length, directDownloadsBeforeDeniedConnect);

// Persona URL restrictions apply to extension-origin GM traffic, including
// explicit Direct, even though Direct intentionally bypasses protected routing.
state.profiles['firefox-container-1'].blockLocalNetwork = true;
state.profiles['firefox-container-1'].blockedDomains = ['blocked.example'];
state.profiles['firefox-container-1'].domainMode = 'allowlist';
state.profiles['firefox-container-1'].allowedDomains = ['*.example.com'];
for (const [url, reason, baseId] of [
  ['http://127.0.0.1/admin', 'local-network-blocked', 30],
  ['https://blocked.example/data', 'blocked-domain', 32],
  ['https://outside.test/data', 'not-on-allowlist', 34]
]) {
  const before = { downloads: downloadCalls.length, fetches: directFetches };
  const deniedXhr = await call(baseId, 'xmlHttpRequest', { requestId: `x-policy-${baseId}`, details: { url } });
  const deniedDownload = await call(baseId + 1, 'download', { requestId: `d-policy-${baseId}`, details: { url } });
  assert.equal(deniedXhr.ok, false, `Persona URL policy must block GM_xmlhttpRequest to ${url}`);
  assert.match(deniedXhr.error, new RegExp(reason));
  assert.equal(deniedDownload.ok, false, `Persona URL policy must block GM_download to ${url}`);
  assert.match(deniedDownload.error, new RegExp(reason));
  assert.equal(downloadCalls.length, before.downloads);
  assert.equal(directFetches, before.fetches);
}

// Native-routed aborts must reach the daemon and stop GM completion callbacks,
// including GM_download's pre-browser-download fetch stage.
state.profiles['firefox-container-1'].routeId = 'mv';
send(40, 'xmlHttpRequest', { requestId: 'cancel-xhr', details: { url: 'https://example.com/slow-cancel' } });
for (let i = 0; i < 50 && !pendingNativeFetch; i++) await new Promise(r => setTimeout(r, 1));
assert.ok(pendingNativeFetch, 'the test request should be held by the mocked native route');
const xhrCancelId = pendingNativeFetch.request.request_id;
send(41, 'abortXhr', { requestId: 'cancel-xhr' });
const [xhrAborted, xhrAbortAck] = await Promise.all([waitReply(40), waitReply(41)]);
assert.equal(xhrAbortAck.ok, true);
assert.equal(xhrAborted.ok, false);
assert.match(xhrAborted.error, /aborted/);
assert.ok(nativeCancellations.includes(xhrCancelId), 'GM_xmlhttpRequest abort must cancel the native routed request');

state.profiles['firefox-container-1'].allowedDomains.push('files.example');
send(42, 'download', { requestId: 'cancel-download', details: { url: 'https://files.example/slow-cancel' } });
for (let i = 0; i < 50 && !pendingNativeFetch; i++) await new Promise(r => setTimeout(r, 1));
assert.ok(pendingNativeFetch, 'the test download should be held before browser.downloads.download');
const downloadCancelId = pendingNativeFetch.request.request_id;
const downloadsBeforeCancel = downloadCalls.length;
send(43, 'abortDownload', { requestId: 'cancel-download' });
const [downloadAborted, downloadAbortAck] = await Promise.all([waitReply(42), waitReply(43)]);
assert.equal(downloadAbortAck.ok, true);
assert.equal(downloadAborted.ok, false);
assert.ok(nativeCancellations.includes(downloadCancelId), 'GM_download abort must cancel the native routed fetch');
assert.equal(downloadCalls.length, downloadsBeforeCancel, 'an aborted routed download must not start a browser download');

state.profiles['firefox-container-1'].routeId = '__direct__';
send(44, 'download', { requestId: 'cancel-browser-download', details: { url: 'https://files.example/browser-delay' } });
for (let i = 0; i < 50 && !releaseBrowserDownload; i++) await new Promise(r => setTimeout(r, 1));
assert.ok(releaseBrowserDownload, 'test download should pause while Firefox creates its download entry');
send(45, 'abortDownload', { requestId: 'cancel-browser-download' });
releaseBrowserDownload();
const [abortBrowserAck, browserDownloadAborted] = await Promise.all([waitReply(45), waitReply(44)]);
assert.equal(abortBrowserAck.ok, true);
assert.equal(browserDownloadAborted.ok, false, JSON.stringify(browserDownloadAborted));
assert.match(browserDownloadAborted.error, /aborted/);
assert.ok(cancelledDownloads.includes(99), 'abort during downloads.download must cancel the created Firefox download');

// Firefox may reject cancel when a download has completed or is no longer cancellable.
// The pending-create case must not acknowledge cancellation until that result is known.
browserCancelError = new Error('download is no longer active');
releaseBrowserDownload = null;
send(46, 'download', { requestId: 'cancel-browser-download-fails', details: { url: 'https://files.example/browser-cancel-fails' } });
for (let i = 0; i < 50 && !releaseBrowserDownload; i++) await new Promise(r => setTimeout(r, 1));
assert.ok(releaseBrowserDownload, 'test download should pause before Firefox returns its download ID');
send(47, 'abortDownload', { requestId: 'cancel-browser-download-fails' });
releaseBrowserDownload();
const [failedBrowserDownload, failedBrowserAbort] = await Promise.all([waitReply(46), waitReply(47)]);
assert.equal(failedBrowserAbort.ok, false, 'abort must report Firefox cancellation failure instead of acknowledging success');
assert.match(failedBrowserAbort.error, /Unable to cancel Firefox download: download is no longer active/);
assert.equal(failedBrowserDownload.ok, false);
assert.match(failedBrowserDownload.error, /Unable to cancel Firefox download: download is no longer active/);
assert.ok(activeDownloadIds.has(100), 'a rejected cancel must leave the still-active mocked download untouched');

// The injected API must surface a rejected cancellation through its onerror callback.
browser.runtime.connect = () => ({
  onMessage: { addListener(listener) { wrapperPortListeners.push(listener); } },
  postMessage(message) { for (const listener of messageListeners) listener(message); }
});
const callbackScript = {
  ...state.scripts.s1,
  code: "globalThis.cancelResultErrors=[]; globalThis.cancelHandle=GM_download({url:'https://files.example/wrapper-cancel-failure',onerror:e=>globalThis.cancelResultErrors.push(e.error)});",
  updatedAt: 'cancel-callback-test',
  injectInto: 'auto',
  requires: [],
  resources: {}
};
const callbackInjection = await mod.prepareUserscriptInjection(callbackScript, { tab: userPort.sender.tab, url: userPort.sender.url });
assert.equal(callbackInjection.world, 'USER_SCRIPT');
releaseBrowserDownload = null;
const callbackDownloadCount = downloadCalls.length;
Function(callbackInjection.code)();
for (let i = 0; i < 50 && !releaseBrowserDownload; i++) await new Promise(r => setTimeout(r, 1));
assert.ok(releaseBrowserDownload, 'the wrapped GM_download should reach the pending Firefox download');
globalThis.cancelHandle.abort();
releaseBrowserDownload();
for (let i = 0; i < 50 && downloadCalls.length === callbackDownloadCount; i++) await new Promise(r => setTimeout(r, 1));
assert.ok(downloadCalls.length > callbackDownloadCount, 'the wrapped GM_download should reach Firefox');
for (let i = 0; i < 50 && !globalThis.cancelResultErrors?.length; i++) await new Promise(r => setTimeout(r, 1));
assert.match(globalThis.cancelResultErrors?.[0] || '', /Unable to cancel Firefox download: download is no longer active/);
browserCancelError = null;

// Abort must be recorded before the first asynchronous state read. Dispatches
// from a user-script port can overlap while the state snapshot is loading.
let stateReadStarted = false;
let releaseStateRead;
mod.configureGMCompat({ getState: () => {
  stateReadStarted = true;
  return new Promise(resolve => { releaseStateRead = () => resolve(state); });
} });
const immediateFetchesBefore = directFetches;
send(60, 'xmlHttpRequest', { requestId: 'abort-before-state-xhr', details: { url: 'https://example.com/immediate-abort' } });
for (let i = 0; i < 50 && !stateReadStarted; i++) await new Promise(r => setTimeout(r, 1));
assert.ok(stateReadStarted, 'the GM XHR should be waiting on its initial state read');
send(61, 'abortXhr', { requestId: 'abort-before-state-xhr' });
assert.equal((await waitReply(61)).ok, true);
releaseStateRead();
const immediateXhrAbort = await waitReply(60);
assert.equal(immediateXhrAbort.ok, false);
assert.match(immediateXhrAbort.error, /aborted/);
assert.equal(directFetches, immediateFetchesBefore, 'an immediate XHR abort must not start network activity after state resolves');

stateReadStarted = false;
releaseStateRead = null;
const immediateDownloadsBefore = downloadCalls.length;
send(160, 'download', { requestId: 'abort-before-state-download', details: { url: 'https://files.example/immediate-abort' } });
for (let i = 0; i < 50 && !stateReadStarted; i++) await new Promise(r => setTimeout(r, 1));
assert.ok(stateReadStarted, 'the GM download should be waiting on its initial state read');
send(161, 'abortDownload', { requestId: 'abort-before-state-download' });
assert.equal((await waitReply(161)).ok, true);
releaseStateRead();
const immediateDownloadAbort = await waitReply(160);
assert.equal(immediateDownloadAbort.ok, false);
assert.match(immediateDownloadAbort.error, /aborted/);
assert.equal(downloadCalls.length, immediateDownloadsBefore, 'an immediate download abort must not start a Firefox download after state resolves');
mod.configureGMCompat({ getState: async () => state });

// Privileged bridge calls must be enforced against the script's @grant list.
const denied = await call(50, 'setClipboard', { data: 'should-not-run' });
assert.equal(denied.ok, false);
assert.match(denied.error, /did not declare a matching @grant/);

console.log('GM grant and routed-download security tests passed');
