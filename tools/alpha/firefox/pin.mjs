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
export async function artifactInventory(root) {
  const entries = [];
  async function visit(dir, prefix = '') {
    const children = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of children) {
      const name = prefix + entry.name, path = join(dir, entry.name), info = await lstat(path);
      const record = { path: name, mode: info.mode & 0o777 };
      if (info.isDirectory()) { entries.push({ ...record, type: 'directory' }); await visit(path, name + '/'); }
      else if (info.isFile()) entries.push({ ...record, type: 'file', size: info.size, sha256: await sha256File(path) });
      else if (info.isSymbolicLink()) entries.push({ ...record, type: 'link', target: await readlink(path) });
      else throw new Error('Unsupported entry in Firefox artifact');
    }
  }
  await visit(root);
  return entries;
}

export function inventoryTreeHash(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) {
    if (entry.type === 'file') hash.update(`${entry.path}\0file\0${entry.mode}\0${entry.size}\0${entry.sha256}\0`);
    else if (entry.type === 'link') hash.update(`${entry.path}\0link\0${entry.target}\0`);
  }
  return hash.digest('hex');
}

export async function artifactTreeHash(root) { return inventoryTreeHash(await artifactInventory(root)); }

export function inventoryDelta(expected, actual) {
  const before = new Map(expected.map(entry => [entry.path, entry]));
  const after = new Map(actual.map(entry => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = paths.filter(path => JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)));
  return { changeCount: changes.length, truncated: changes.length > 16,
    changes: changes.slice(0, 16).map(path => ({ path, before: before.get(path) || null, after: after.get(path) || null })) };
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
  const inventory = await artifactInventory(dirname(await realpath(firefoxBin)));
  const observed = inventoryTreeHash(inventory);
  if (observed !== manifest.extractedTreeSha256) {
    const error = new Error('Extracted Firefox artifact changed after installation');
    error.artifactIntegrity = { baselineTreeSha256: manifest.extractedTreeSha256, observedTreeSha256: observed,
      ...(manifest.artifactInventory ? inventoryDelta(manifest.artifactInventory, inventory) : { inventoryUnavailable: true }) };
    throw error;
  }
  const result = await execFileText(firefoxBin, ['--version'], { env: { ...process.env, MOZ_HEADLESS: '1' }, timeout: 30_000 });
  assertExactVersion(result.stdout, pin.version);
  return { version: pin.version, artifactSha256: pin.archive.sha256, archiveUrl: pin.archive.url,
    extractedTreeSha256: manifest.extractedTreeSha256, buildId: manifest.buildId,
    sourceStamp: manifest.sourceStamp, versionOutput: result.stdout.trim() };
}
