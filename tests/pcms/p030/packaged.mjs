// T030.3 packaged proof (A030-01 FDE, A030-02 FDE/PKG/SEC, A030-03 FDE).
//
// The product XPI is installed once into the exact pinned Developer Edition.
// 1. From a product extension page the harness reaches the real background page
//    document (runtime.getBackgroundPage) and frames both declared sandbox pages in it,
//    exactly as the P030 frame factory does: each must load with an opaque origin.
// 2. A background-hosted controller frame must ignore a bootstrap from a window that is
//    not its parent (the P004 one-time parent bootstrap).
// 3. Controller source generated here at run time (random nonce, so it cannot be in the
//    XPI) executes in the shipped controller page. The harness page is the parent and
//    plays the P004 host over a private MessagePort, granting no capability. Firefox
//    attributes a postMessage to the calling realm, so only background-realm code can
//    bootstrap a background-hosted frame; that product host path is P031's live wiring.
// 4. An event-page unload discards every background-hosted frame.
// Nothing is injected into the product XPI.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileText, loadBrowserPin, sha256File, writeJson } from '../../../tools/firefox/lib.mjs';
import { PackagedFirefox, waitFor } from '../../../tools/firefox/packaged-harness.mjs';
import { evaluateModuleRuntimeFloor, parseFirefoxMajor } from '../../../extension/pcms/runtime/browser-floor.js';

const PRODUCT = 'persona-route-manager@local';
const root = resolve(process.env.FIREFOX_PACKAGED_DIR || join(tmpdir(), 'pcms-firefox-p030'));
const reportPath = resolve(process.env.FIREFOX_P030_REPORT || join(root, 'p030-report.json'));
const pin = await loadBrowserPin();
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const xpi = resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report = { schemaVersion: 1, phase: 'P030', commitSha: process.env.GITHUB_SHA ||
  (await execFileText('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  workflowRun: process.env.GITHUB_RUN_ID || null, version: pin.version,
  artifactSha256: pin.archive.sha256, productXpiSha256: await sha256File(xpi),
  osContentSandboxDisabled: process.env.MOZ_DISABLE_CONTENT_SANDBOX === '1', checks: {}, facts: {} };

let h, server;
async function page(code, args = []) {
  const result = await h.pageScript(`const done = arguments[arguments.length - 1];
    (async () => { const api = window.wrappedJSObject.browser; const w = window.wrappedJSObject; ${code} })()
      .then(value => done({ok:true,value:JSON.parse(JSON.stringify(value ?? null))}),
        error => done({ok:false,error:[error && error.name, error && error.message, error && error.stack, String(error)].filter(Boolean).join(' | ')}));`, args, { async: true });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

// Runs in a product extension page. arguments[0] = page path, arguments[1] = controller
// source (null: isolation only), arguments[2] = network URL that must stay unreachable,
// arguments[3] = 'background' (frame the page in the real background document) or 'page'
// (frame it in this extension page, which then acts as the P004 host).
const FRAME_PROBE = `
  const [pagePath, source, networkUrl, hostKind] = [arguments[0], arguments[1], arguments[2], arguments[3]];
  const bg = await api.runtime.getBackgroundPage();
  const doc = hostKind === 'background' ? bg.document : document;
  const out = { hostKind, backgroundUrl: String(bg.location.href), framesBefore: doc.querySelectorAll('iframe').length };
  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('hidden', '');
  frame.setAttribute('data-pcms-module', 'p030.packaged-proof');
  frame.setAttribute('data-pcms-generation', '1');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sandbox frame load timeout')), 8000);
    frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
    frame.setAttribute('src', api.runtime.getURL(pagePath));
    (doc.body || doc.documentElement).appendChild(frame);
  });
  out.frameInHostDocument = frame.ownerDocument === doc && doc.querySelectorAll('iframe').length === out.framesBefore + 1;
  out.contentDocumentNull = frame.contentDocument === null;
  try { void frame.contentWindow.document.title; out.contentWindowDocumentThrows = false; }
  catch { out.contentWindowDocumentThrows = true; }
  if (!source) { frame.remove(); out.framesAfterRemove = doc.querySelectorAll('iframe').length; return out; }
  if (hostKind === 'background') {
    // P004 bootstrap rule: a controller accepts its port only from its parent window.
    // This page is not the parent of a background-hosted frame, so it must be ignored.
    const probe = new MessageChannel();
    let answered = false;
    probe.port1.addEventListener('message', () => { answered = true; });
    probe.port1.start();
    try {
      frame.contentWindow.postMessage({ type: 'pcms.sandbox.bootstrap', version: 1, sessionId: 'p030-foreign' }, '*', [probe.port2]);
      out.foreignBootstrapDelivery = 'posted';
    } catch (error) {
      out.foreignBootstrapDelivery = 'refused: ' + (error && (error.name + ' ' + error.message));
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    out.foreignBootstrapIgnored = !answered;
    probe.port1.close();
    frame.remove();
    out.framesAfterRemove = doc.querySelectorAll('iframe').length;
    return out;
  }

  const sessionId = 'p030-' + Math.random().toString(16).slice(2);
  let step = 'channel';
  try {
  const channel = new MessageChannel();
  const port = channel.port1;
  const pending = new Map();
  const capabilityCalls = [];
  let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
  const send = (message) => port.postMessage(message);
  port.addEventListener('message', (event) => {
    const message = JSON.parse(JSON.stringify(event.data));
    if (message.sessionId !== sessionId) return;
    if (message.type === 'ready') { readyResolve(); return; }
    if (message.type === 'response') { pending.get(message.requestId)?.(message); pending.delete(message.requestId); return; }
    if (message.type === 'capability.call') {
      // No capability is granted to this controller: every call is denied.
      capabilityCalls.push(message.capability);
      send({ version: 1, sessionId, type: 'capability.result', callId: message.callId, ok: false,
        error: { code: 'PCMS_SANDBOX_CAPABILITY_DENIED', message: 'Capability is not granted' } });
    }
  });
  port.start();
  let sequence = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = 'req-' + (++sequence);
    const timer = setTimeout(() => reject(new Error('controller request timeout: ' + method)), 8000);
    pending.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
    send({ version: 1, sessionId, type: 'request', requestId, method, params });
  });
  step = 'bootstrap';
  // Firefox 154 Xray behaviour for transfer lists is recorded, not assumed.
  const bootstrap = { type: 'pcms.sandbox.bootstrap', version: 1, sessionId };
  const attempts = [
    ['sandbox-array', () => frame.contentWindow.postMessage(bootstrap, '*', [channel.port2])],
    ['options-transfer', () => frame.contentWindow.postMessage(bootstrap, { targetOrigin: '*', transfer: [channel.port2] })]
  ];
  out.bootstrapAttempts = [];
  for (const [name, attempt] of attempts) {
    try { attempt(); out.bootstrapTransfer = name; break; }
    catch (error) { out.bootstrapAttempts.push(name + ': ' + (error && (error.name + ' ' + error.message))); }
  }
  if (!out.bootstrapTransfer) throw new Error('bootstrap postMessage failed: ' + out.bootstrapAttempts.join('; '));
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('controller bootstrap timeout')), 8000))]);
  out.bootstrapped = true;
  step = 'controller.load';
  out.load = await request('controller.load', { source, initial: { networkUrl } });
  step = 'controller.invoke';
  out.denied = await request('controller.invoke', { method: 'callUngranted', args: null });
  out.capabilityCalls = capabilityCalls.slice();
  step = 'controller.dispose';
  out.dispose = await request('controller.dispose', {});
  port.close();
  } catch (error) {
    frame.remove();
    throw new Error('P030 step ' + step + ' failed: ' + (error && (error.name + ' ' + error.message)) + ' ' + JSON.stringify(out));
  }
  frame.remove();
  out.framesAfterRemove = doc.querySelectorAll('iframe').length;
  return out;
`;

function controllerSource(nonce) {
  // Supplied at run time; never written into the extension tree.
  return `(api) => ({
    async start(initial) {
      const facts = { nonce: ${JSON.stringify(nonce)}, computed: 40 + 2, protocolVersion: api.version,
        browserAbsent: typeof browser === 'undefined', chromeAbsent: typeof chrome === 'undefined',
        selfOrigin: String(self.origin) };
      try { void parent.document.title; facts.parentDocumentBlocked = false; } catch { facts.parentDocumentBlocked = true; }
      try { await fetch(initial.networkUrl); facts.networkBlocked = false; } catch { facts.networkBlocked = true; }
      try { indexedDB.open('p030'); facts.indexedDbBlocked = false; } catch { facts.indexedDbBlocked = true; }
      try { void localStorage.length; facts.localStorageBlocked = false; } catch { facts.localStorageBlocked = true; }
      const loadImage = (src) => new Promise((resolve) => {
        const image = new Image();
        const timer = setTimeout(() => resolve('timeout'), 3000);
        image.onload = () => { clearTimeout(timer); resolve('loaded'); };
        image.onerror = () => { clearTimeout(timer); resolve('blocked'); };
        image.src = src;
      });
      // One sandbox CSP serves both pages (ADR-003 §1 option 1): extension images load, remote ones never.
      facts.extensionImage = await loadImage(new URL('../../icons/icon48.png', location.href).href);
      facts.remoteImage = await loadImage(initial.networkUrl + '.png');
      return facts;
    },
    async callUngranted() {
      try { await api.call('module.storage.write', { key: 'k', value: 'v' }); return { denied: false }; }
      catch (error) { return { denied: true, code: error.code }; }
    },
    dispose() { return { disposed: true }; }
  })`;
}

try {
  if (process.env.CI) assert.equal(report.osContentSandboxDisabled, false, 'CI acceptance must enable the OS content sandbox');
  await mkdir(root, { recursive: true });
  h = await PackagedFirefox.create({ root: join(root, 'profiles-p030') });
  await h.start();
  assert.equal(await h.install(xpi), PRODUCT);
  let tab = await h.openPage(PRODUCT, 'popup/popup.html');

  const platform = await page(`return { info: await api.runtime.getBrowserInfo(), manifest: api.runtime.getManifest() };`);
  report.facts.browser = { name: platform.info.name, version: platform.info.version };
  // The pinned 154.0b10 build reports runtime.getBrowserInfo().version as "154.0" (CI observation):
  // the floor compares the major version only.
  assert.equal(platform.info.name, 'Firefox');
  assert.equal(parseFirefoxMajor(platform.info.version), parseFirefoxMajor(pin.version));
  assert.equal(evaluateModuleRuntimeFloor({ browserInfo: platform.info, manifest: platform.manifest }).state, 'AVAILABLE');
  report.checks.floorAvailableInPinnedBuild = true;
  assert.deepEqual(platform.manifest.sandbox?.pages, manifest.sandbox.pages, 'pinned build accepts the manifest sandbox key');
  report.checks.pinnedBuildAcceptsSandboxManifest = true;

  // A030-01 FDE: both declared pages load as opaque-origin frames of the background document.
  for (const pagePath of manifest.sandbox.pages) {
    const isolated = await page(FRAME_PROBE, [pagePath, null, null, 'background']);
    assert.equal(isolated.frameInHostDocument, true, pagePath);
    assert.equal(isolated.contentDocumentNull, true, pagePath);
    assert.equal(isolated.contentWindowDocumentThrows, true, pagePath);
    assert.equal(isolated.framesAfterRemove, isolated.framesBefore, pagePath);
    report.facts[pagePath] = isolated;
  }
  report.checks.declaredSandboxPagesAreIsolatedBackgroundFrames = true;

  // SEC: a background-hosted controller frame ignores a bootstrap from any window but its parent.
  const foreign = await page(FRAME_PROBE, ['pcms/sandbox/controller.html', 'unused', null, 'background']);
  assert.equal(foreign.frameInHostDocument, true);
  assert.equal(foreign.contentDocumentNull, true);
  assert.equal(foreign.foreignBootstrapIgnored, true);
  report.facts.foreignBootstrap = foreign;
  report.checks.backgroundFrameIgnoresNonParentBootstrap = true;

  // A030-02: runtime-supplied controller source executes in the packaged sandbox page.
  // Driving the P004 host from the background realm needs product host code there, which
  // P031 wires (live activation); here this extension page is the parent and P004 host.
  let networkRequests = 0;
  server = createServer((_req, res) => { networkRequests++; res.end('unexpected'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const networkUrl = `http://127.0.0.1:${server.address().port}/must-be-blocked`;
  const nonce = randomBytes(16).toString('hex');
  const run = await page(FRAME_PROBE, ['pcms/sandbox/controller.html', controllerSource(nonce), networkUrl, 'page']);
  report.facts.controllerRun = run;
  assert.ok(run.backgroundUrl.startsWith('moz-extension://'));
  assert.equal(run.hostKind, 'page');
  assert.equal(run.frameInHostDocument, true);
  assert.equal(run.contentDocumentNull, true);
  assert.equal(run.bootstrapped, true);
  assert.equal(run.load.ok, true, JSON.stringify(run.load));
  const facts = run.load.result;
  assert.equal(facts.nonce, nonce, 'the executed controller is the one supplied at run time');
  assert.equal(facts.computed, 42);
  assert.equal(facts.protocolVersion, 1);
  assert.equal(facts.browserAbsent, true);
  assert.equal(facts.chromeAbsent, true);
  assert.equal(facts.selfOrigin, 'null');
  assert.equal(facts.parentDocumentBlocked, true);
  assert.equal(facts.networkBlocked, true);
  assert.equal(networkRequests, 0);
  assert.equal(facts.indexedDbBlocked, true);
  assert.equal(facts.localStorageBlocked, true);
  assert.equal(facts.remoteImage, 'blocked', 'the sandbox CSP blocks remote images');
  assert.equal(facts.extensionImage, 'loaded', 'pinned build: the shared sandbox CSP governs the controller page');
  assert.deepEqual(run.denied.result, { denied: true, code: 'PCMS_SANDBOX_CAPABILITY_DENIED' });
  assert.deepEqual(run.capabilityCalls, ['module.storage.write']);
  assert.deepEqual(run.dispose.result, { disposed: true });
  assert.equal(run.framesAfterRemove, run.framesBefore);
  report.checks.runtimeControllerExecutesInPackagedSandboxPage = true;
  report.checks.ungrantedCapabilityDeniedAndNoAmbientAuthority = true;
  await new Promise(resolve => server.close(resolve)); server = null;

  // A030-03: frames are ephemeral. An event-page unload discards the background
  // document; the next wake starts with no controller frame.
  const leftBehind = await page(`const bg = await api.runtime.getBackgroundPage();
    const frame = bg.document.createElement('iframe'); frame.setAttribute('sandbox','allow-scripts');
    frame.setAttribute('data-pcms-generation','7'); frame.setAttribute('src', api.runtime.getURL('pcms/sandbox/controller.html'));
    bg.document.body.appendChild(frame); return bg.document.querySelectorAll('iframe').length;`);
  assert.equal(leftBehind, 1, 'a controller frame is attached before the unload');
  await h.closePage(tab);
  await h.setIdleTimeout(500);
  report.unload = await h.forceIdleUnload(PRODUCT);
  await h.resetIdleTimeout();
  tab = await h.openPage(PRODUCT, 'popup/popup.html');
  const afterWake = await waitFor(() => page(`const bg = await api.runtime.getBackgroundPage();
    return { frames: bg.document.querySelectorAll('iframe').length };`).catch(() => null), 'background wakes after unload');
  assert.equal(afterWake.frames, 0, 'no controller frame survives an event-page unload');
  report.checks.framesDisposedOnUnload = true;
  await h.closePage(tab);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = String(error.stack || error); throw error;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await h?.stop();
  await writeJson(reportPath, report);
  if (h) await rm(h.profilePath, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
