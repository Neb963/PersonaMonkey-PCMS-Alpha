import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { createIsolatedProfile, execFileText, loadBrowserPin } from './lib.mjs';
import { connectMarionette } from './marionette.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Chrome-context inspection is CI-only. It is never packaged or used by PCMS.
export const extensionLookup = `const extension = WebExtensionPolicy.getByID(arguments[0])?.extension;
  if (!extension) throw new Error('Extension is not installed');`;

// Navigation resolves to a document, not to a permanent hash fragment. The
// P032 router may canonicalize #/overview before Marionette reads location.href.
// Still require the precise extension scheme, host, path and query to avoid
// mistaking about:blank, an error page or another extension for a successful load.
export function matchesExtensionDocumentUrl(actual, requested) {
  try {
    const a=new URL(actual), b=new URL(requested);
    return a.protocol===b.protocol && a.host===b.host &&
      a.pathname===b.pathname && a.search===b.search;
  } catch { return false; }
}

export class PackagedFirefox {
  constructor({ firefoxBin, profilePath }) { this.firefoxBin = firefoxBin; this.profilePath = profilePath; }
  static async create({ firefoxBin = process.env.FIREFOX_BIN, root } = {}) {
    if (!firefoxBin) throw new Error('FIREFOX_BIN is required');
    const pin = await loadBrowserPin();
    const version = await execFileText(firefoxBin, ['--version'], { env: { ...process.env, MOZ_HEADLESS: '1' } });
    if (!(version.stdout + version.stderr).includes(pin.version)) throw new Error('Packaged harness requires the exact browser pin');
    const profilePath = await createIsolatedProfile(root);
    await appendFile(join(profilePath, 'user.js'), [
      'user_pref("marionette.enabled", true);',
      'user_pref("xpinstall.signatures.required", false);',
      'user_pref("extensions.autoDisableScopes", 0);',
      'user_pref("extensions.enabledScopes", 15);',
      'user_pref("browser.startup.page", 0);',
      'user_pref("browser.startup.homepage", "about:blank");',
      'user_pref("extensions.update.enabled", false);',
      'user_pref("extensions.systemAddon.update.enabled", false);',
    ].join('\n') + '\n');
    return new PackagedFirefox({ firefoxBin, profilePath });
  }
  async start() {
    if (this.process) throw new Error('Firefox already running');
    const port = await unusedPort();
    await appendFile(join(this.profilePath, 'user.js'), `user_pref("marionette.port", ${port});\n`);
    this.process = spawn(this.firefoxBin, ['--headless', '--no-remote', '--profile', this.profilePath,
      '--marionette', '--remote-allow-system-access', 'about:blank'], {
      env: { ...process.env, MOZ_HEADLESS: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.stderr = '';
    this.process.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8000); });
    this.process.on('error', error => { this.startError = error; });
    try { this.client = await connectMarionette(port); }
    catch (error) { await this.stop(); throw new Error(`${error.message}; ${this.startError?.message || this.stderr}`); }
    return this;
  }
  async install(xpiPath) {
    const result = await this.client.command('Addon:Install', { path: xpiPath, temporary: false });
    return result.value;
  }
  async extension(id) {
    return this.client.script(`${extensionLookup}
      return {id:extension.id, url:extension.baseURI.spec, state:extension.backgroundState,
        persistent:extension.persistentBackground, manifestVersion:extension.manifest.manifest_version};`, [id]);
  }
  async setIdleTimeout(ms) {
    await this.client.script('Services.prefs.setIntPref("extensions.background.idle.timeout", arguments[0]);', [ms]);
  }
  async resetIdleTimeout() {
    await this.client.script('Services.prefs.clearUserPref("extensions.background.idle.timeout");');
  }
  async forceIdleUnload(id) {
    // The product receives proxy/webRequest and other Firefox events even with
    // every dashboard closed. A short idle pref alone cannot fence those resets.
    // Use Firefox's own test hook to deterministically suspend the real context.
    const result = await this.client.script(`${extensionLookup}
      const done = arguments[arguments.length - 1];
      if (extension.persistentBackground) throw new Error('Expected a non-persistent background');
      (async () => {
        if (extension.backgroundState !== 'stopped') {
          await extension.terminateBackground({disableResetIdleForTest:true,ignoreDevToolsAttached:true});
        }
        return {state:extension.backgroundState, mode:'firefox-test-hook'};
      })().then(done, error => done({error:String(error)}));`, [id], { async: true });
    if (result.error) throw new Error(result.error);
    if (result.state !== 'stopped') throw new Error('Firefox did not suspend the event page');
    return result;
  }
  async openPage(id, path) {
    const extension = await this.extension(id);
    await this.client.command('Marionette:SetContext', { value: 'content' });
    const before = await this.client.command('WebDriver:GetWindowHandles');
    const requestedUrl=new URL(path, extension.url).href;
    await this.client.script(`const tab = window.gBrowser.addTab(arguments[0], {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      window.gBrowser.selectedTab = tab;`, [requestedUrl]);
    await this.client.command('Marionette:SetContext', { value: 'content' });
    const after = await this.client.command('WebDriver:GetWindowHandles');
    const handle = (after.value ?? after).find(value => !(before.value ?? before).includes(value));
    if (!handle) throw new Error('Failed to open extension tab');
    await this.client.command('WebDriver:SwitchToWindow', { handle });
    await waitFor(async () => matchesExtensionDocumentUrl(
      await this.pageScript('return location.href'), requestedUrl
    ), 'extension page navigation');
    return handle;
  }
  async closePage(handle) {
    await this.client.command('Marionette:SetContext', { value: 'content' });
    await this.client.command('WebDriver:SwitchToWindow', { handle });
    await this.client.command('WebDriver:CloseWindow');
    const handles = await this.client.command('WebDriver:GetWindowHandles');
    await this.client.command('WebDriver:SwitchToWindow', { handle: (handles.value ?? handles)[0] });
  }
  async pageScript(script, args = [], options = {}) {
    return this.client.script(script, args, { ...options, context: 'content' });
  }
  async stop() {
    if (!this.process) return;
    const child = this.process;
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { await this.client?.command('Marionette:Quit', { flags: ['eAttemptQuit'] }); } catch { /* connection may close first */ }
    this.client?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(timer);
    }
    this.process = null; this.client = null;
  }
  async restart() { await this.stop(); return this.start(); }
}
