import { appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileText, assertFileSha256, writeJson } from '../../firefox/lib.mjs';
import { REPO_ROOT, loadAlphaPin, assertExactVersion, artifactTreeHash, verifyInstallation } from './pin.mjs';

const pin = await loadAlphaPin();
const root = resolve(process.env.FIREFOX_INSTALL_ROOT || join(tmpdir(), 'alpha-p101-firefox'));
// Retain the proven downloader/extractor, but validate Alpha authority and the
// entire installed artifact in addition to the inherited version-prefix check.
await execFileText(process.execPath, [join(REPO_ROOT, 'tools/firefox/install-pinned.mjs')], {
  cwd: REPO_ROOT, env: { ...process.env, FIREFOX_INSTALL_ROOT: root }, timeout: 240_000,
});
const firefoxBin = join(root, 'versions', pin.version, 'firefox', 'firefox');
const archivePath = join(root, 'downloads', pin.archive.fileName);
await assertFileSha256(archivePath, pin.archive.sha256);
const version = await execFileText(firefoxBin, ['--version'], { env: { ...process.env, MOZ_HEADLESS: '1' }, timeout: 30_000 });
assertExactVersion(version.stdout, pin.version);
const ini = await readFile(join(dirname(firefoxBin), 'application.ini'), 'utf8');
const buildId = /^BuildID=(\d{14})$/m.exec(ini)?.[1], sourceStamp = /^SourceStamp=([a-f0-9]{40})$/m.exec(ini)?.[1];
if (!buildId || !sourceStamp || !ini.includes('CodeName=Firefox Developer Edition')) throw new Error('Unexpected Mozilla artifact identity');
const manifestPath = join(root, 'alpha-install-manifest.json');
await writeJson(manifestPath, { schemaVersion: 1, phaseId: 'P101', product: pin.product, version: pin.version,
  artifactSha256: pin.archive.sha256, archiveUrl: pin.archive.url, archivePath, firefoxBin,
  extractedTreeSha256: await artifactTreeHash(dirname(firefoxBin)), buildId, sourceStamp });
const proof = await verifyInstallation({ firefoxBin, manifestPath });
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
  `firefox_bin=${firefoxBin}\nfirefox_version=${pin.version}\nalpha_install_manifest=${manifestPath}\n`);
console.log(JSON.stringify({ installed: true, ...proof, firefoxBin, manifestPath }));
