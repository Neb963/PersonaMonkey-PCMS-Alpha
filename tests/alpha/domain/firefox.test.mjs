import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileText, loadBrowserPin, writeJson } from '../../../tools/firefox/lib.mjs';
import { PackagedFirefox, waitFor } from '../../../tools/firefox/packaged-harness.mjs';

const inActions = process.env.GITHUB_ACTIONS === 'true';
test('AP102-01/02/03: actual pinned Firefox IndexedDB migrations, races, aborts, corruption and process restart',
  { skip: !process.env.FIREFOX_BIN && !inActions, timeout: 300000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'alpha-p102-'));
    const pin = await loadBrowserPin();
    const commitSha = (await execFileText('git', ['rev-parse', 'HEAD'])).stdout.trim();
    let firefoxBin = process.env.FIREFOX_BIN, browser;
    const report = { phaseId: 'P102', version: pin.version, archiveSha256: pin.archive.sha256, providerLive: false,
      commitSha, workflowRun: process.env.GITHUB_RUN_ID || null,
      worktreeDirty: Boolean((await execFileText('git', ['status', '--porcelain'])).stdout.trim()),
      contentSandboxDisabled: process.env.MOZ_DISABLE_CONTENT_SANDBOX === '1', passed: false };
    try {
      if (!firefoxBin) {
        // Reuse the repository installer and the existing CI's bounded runtime setup.
        await execFileText('bash', ['-c', 'packages="libgtk-3-0 libdbus-glib-1-2 libasound2t64 libx11-xcb1 libxt6"; if ! dpkg -s $packages >/dev/null 2>&1; then sudo timeout 150 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update && sudo timeout 150 apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y $packages; fi'], { timeout: 180000 });
        const installed = await execFileText(process.execPath, ['tools/firefox/install-pinned.mjs'],
          { env: { ...process.env, FIREFOX_INSTALL_ROOT: join(root, 'runtime') }, timeout: 120000 });
        firefoxBin = JSON.parse(installed.stdout.trim().split('\n').at(-1)).firefoxBin;
      }
      const fixture = join(root, 'fixture'); await mkdir(fixture, { recursive: true });
      const paths = [
        'extension/alpha/domain/validation.js', 'extension/alpha/domain/records.js',
        'extension/alpha/storage/migrations.js', 'extension/alpha/storage/store.js',
        'tests/alpha/domain/fixtures.js', 'tests/alpha/domain/storage-cases.js',
        'tests/alpha/domain/probe.js', 'tests/alpha/domain/probe.html'
      ];
      const hashes = {};
      for (const path of paths) {
        const destination = join(fixture, path); await mkdir(join(destination, '..'), { recursive: true });
        await copyFile(path, destination);
        const source = await readFile(path), copy = await readFile(destination); assert.deepEqual(source, copy);
        hashes[path] = createHash('sha256').update(copy).digest('hex');
      }
      report.copiedSourceSha256 = hashes;
      const id = 'alpha-p102-storage@tests';
      await writeFile(join(fixture, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Alpha P102 isolated storage fixture',
        version: '1.0', permissions: ['storage'], browser_specific_settings: { gecko: { id, strict_min_version: pin.version } } }));
      const xpi = join(root, 'fixture.xpi'); await execFileText('zip', ['-q', '-X', '-r', xpi, '.'], { cwd: fixture });
      report.fixtureXpiSha256 = createHash('sha256').update(await readFile(xpi)).digest('hex');
      browser = await PackagedFirefox.create({ firefoxBin, root: join(root, 'profile') });
      await appendFile(join(browser.profilePath, 'user.js'), [
        'user_pref("network.proxy.type", 1);', 'user_pref("network.proxy.http", "127.0.0.1");',
        'user_pref("network.proxy.http_port", 9);', 'user_pref("network.proxy.ssl", "127.0.0.1");',
        'user_pref("network.proxy.ssl_port", 9);', 'user_pref("network.proxy.no_proxies_on", "localhost,127.0.0.1");',
        'user_pref("network.proxy.failover_direct", false);', 'user_pref("network.dns.disablePrefetch", true);'
      ].join('\n') + '\n');
      if (inActions) assert.notEqual(process.env.MOZ_DISABLE_CONTENT_SANDBOX, '1');
      await browser.start(); assert.equal(await browser.install(xpi), id);
      await browser.openPage(id, 'tests/alpha/domain/probe.html');
      const collect = () => waitFor(async () => {
        const body = await browser.pageScript('return document.body.textContent');
        if (!body.startsWith('{')) return null;
        const result = JSON.parse(body); assert.equal(result.passed, true, result.error); return result;
      }, 'P102 real IndexedDB cases', 90000);
      report.storage = await collect(); assert.equal(report.storage.count, 20);
      await browser.restart(); await browser.openPage(id, 'tests/alpha/domain/probe.html?stage=restart');
      report.restart = await collect(); assert.equal(report.restart.count, 1);
      report.passed = true;
    } catch (error) {
      report.failure = { message: error.message, browserStderr: browser?.stderr?.slice(-3000) };
      try { report.failure.document = await browser?.pageScript('return {url:location.href,title:document.title,text:document.body?.textContent?.slice(0,300)}'); } catch {}
      throw error;
    } finally {
      await browser?.stop();
      await writeJson(resolve('.agent-runs/alpha-p102-firefox.json'), report);
      await rm(root, { recursive: true, force: true });
    }
  });
