import { createServer } from 'node:http';
import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PackagedFirefox } from '../../firefox/packaged-harness.mjs';
import { verifyInstallation } from './pin.mjs';

export function validateOrigins(origins) {
  if (!Array.isArray(origins) || new Set(origins).size !== origins.length) throw new Error('Invalid loopback allowlist');
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== origin) {
      throw new Error('Browser fixtures require exact HTTP loopback origins');
    }
  }
  return [...origins];
}

export class IsolatedFirefox extends PackagedFirefox {
  static async create({ firefoxBin = process.env.FIREFOX_BIN, root, allowedOrigins = [] } = {}) {
    if (process.env.CI && process.env.MOZ_DISABLE_CONTENT_SANDBOX === '1') throw new Error('CI must enable the Firefox content sandbox');
    const origins = validateOrigins(allowedOrigins), proof = await verifyInstallation({ firefoxBin });
    const base = await PackagedFirefox.create({ firefoxBin, root });
    const browser = new IsolatedFirefox({ firefoxBin, profilePath: base.profilePath });
    browser.allowedOrigins = origins; browser.artifact = proof;
    try {
      // Apply before startup, including before any extension is installed.
      browser.denyProxy = createServer((_request, response) => { response.writeHead(403); response.end(); });
      browser.denyProxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
      await new Promise((done, reject) => { browser.denyProxy.once('error', reject); browser.denyProxy.listen(0, '127.0.0.1', done); });
      const port = browser.denyProxy.address().port;
      await appendFile(join(browser.profilePath, 'user.js'), [
        'user_pref("network.proxy.type", 1);',
        'user_pref("network.proxy.http", "127.0.0.1");',
        `user_pref("network.proxy.http_port", ${port});`,
        'user_pref("network.proxy.ssl", "127.0.0.1");',
        `user_pref("network.proxy.ssl_port", ${port});`,
        'user_pref("network.proxy.no_proxies_on", "127.0.0.1");',
        'user_pref("network.proxy.failover_direct", false);',
        'user_pref("network.dns.disablePrefetch", true);',
        'user_pref("network.trr.mode", 5);',
        'user_pref("network.http.speculative-parallel-limit", 0);',
      ].join('\n') + '\n');
      return browser;
    } catch (error) { await browser.dispose(); throw error; }
  }
  async start() {
    await super.start();
    try {
      // Parent-process inspection is confined to this test harness. Reinstall
      // on each restart; no fixture or test hook enters the product archive.
      await this.client.script(`const allowed = new Set(arguments[0]);
        Services.prefs.clearUserPref("alpha.tests.lastDeniedLoopbackOrigin");
        Services.obs.addObserver({observe(subject) {
          const channel = subject.QueryInterface(Components.interfaces.nsIHttpChannel);
          if (!allowed.has(channel.URI.prePath)) {
            if (["127.0.0.1", "localhost"].includes(channel.URI.host)) {
              Services.prefs.setStringPref("alpha.tests.lastDeniedLoopbackOrigin", channel.URI.prePath);
            }
            channel.cancel(Components.results.NS_ERROR_ABORT);
          }
        }}, "http-on-modify-request");`, [this.allowedOrigins]);
      const identity = await this.client.script(`return {buildId:Services.appinfo.appBuildID,
        channel:Services.prefs.getDefaultBranch("").getCharPref("app.update.channel")};`);
      if (identity.buildId !== this.artifact.buildId || identity.channel !== 'aurora') throw new Error('Running Firefox identity differs from installed Developer Edition');
      return this;
    } catch (error) { await this.stop(); throw error; }
  }
  async navigate(url) {
    await this.client.command('Marionette:SetContext', { value: 'content' });
    return this.client.command('WebDriver:Navigate', { url });
  }
  async deniedLoopbackOrigin(origin) {
    return this.client.script('return Services.prefs.getStringPref("alpha.tests.lastDeniedLoopbackOrigin", "") === arguments[0];', [origin]);
  }
  async dispose() {
    try { await this.stop(); }
    finally {
      this.denyProxy?.closeAllConnections();
      if (this.denyProxy?.listening) await new Promise(done => this.denyProxy.close(done));
      await rm(this.profilePath, { recursive: true, force: true });
    }
  }
}
