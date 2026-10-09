import { createHash } from 'node:crypto';
import { readdir, lstat, readlink, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrowserPin, sha256File, assertFileSha256, execFileText } from '../../firefox/lib.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const ALPHA_PIN = join(REPO_ROOT, 'docs/implementation/alpha/browser-pin.json');
export const DONOR_PIN = join(REPO_ROOT, 'docs/implementation/v1/browser-pin.json');

export async function loadAlphaPin() {
  const pin = await loadBrowserPin(ALPHA_PIN);
  if (!(await readFile(ALPHA_PIN)).equals(await readFile(DONOR_PIN))) {
    throw new Error('Alpha and donor Firefox pins differ; an authorized pin amendment is required');
  }
  return pin;
}

export function assertExactVersion(output, version) {
  // Do not accept a prefix match such as 154.0b100 for 154.0b10.
  if (output.trim() !== `Mozilla Firefox ${version}`) throw new Error('Firefox version differs from the exact pin');
}

// Frame every file, mode and symlink so the unpacked artifact is independently
// reproducible and edits to libxul/prefs cannot hide behind an unchanged binary.
export async function artifactTreeHash(root) {
  const hash = createHash('sha256');
  async function visit(dir, prefix = '') {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = prefix + entry.name, path = join(dir, entry.name), info = await lstat(path);
      if (info.isDirectory()) await visit(path, name + '/');
      else if (info.isFile()) hash.update(`${name}\0file\0${info.mode & 0o777}\0${info.size}\0${await sha256File(path)}\0`);
      else if (info.isSymbolicLink()) hash.update(`${name}\0link\0${await readlink(path)}\0`);
      else throw new Error('Unsupported entry in Firefox artifact');
    }
  }
  await visit(root);
  return hash.digest('hex');
}

export async function verifyInstallation({ firefoxBin = process.env.FIREFOX_BIN,
  manifestPath = process.env.FIREFOX_INSTALL_MANIFEST } = {}) {
  if (!firefoxBin || !manifestPath) throw new Error('FIREFOX_BIN and FIREFOX_INSTALL_MANIFEST are required; run the Alpha installer');
  const pin = await loadAlphaPin(), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.phaseId !== 'P101' || manifest.version !== pin.version ||
      manifest.artifactSha256 !== pin.archive.sha256 || manifest.archiveUrl !== pin.archive.url ||
      await realpath(firefoxBin) !== await realpath(manifest.firefoxBin)) {
    throw new Error('Firefox installation provenance differs from the Alpha pin');
  }
  await assertFileSha256(manifest.archivePath, pin.archive.sha256);
  if (await artifactTreeHash(dirname(await realpath(firefoxBin))) !== manifest.extractedTreeSha256) {
    throw new Error('Extracted Firefox artifact changed after installation');
  }
  const result = await execFileText(firefoxBin, ['--version'], { env: { ...process.env, MOZ_HEADLESS: '1' }, timeout: 30_000 });
  assertExactVersion(result.stdout, pin.version);
  return { version: pin.version, artifactSha256: pin.archive.sha256, archiveUrl: pin.archive.url,
    extractedTreeSha256: manifest.extractedTreeSha256, buildId: manifest.buildId,
    sourceStamp: manifest.sourceStamp, versionOutput: result.stdout.trim() };
}
