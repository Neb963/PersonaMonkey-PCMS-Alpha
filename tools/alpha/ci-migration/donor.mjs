import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { requireThat } from '../governance.mjs';

export const DONOR = Object.freeze({
  commit: '482dc9d9273dcdcd7d2ef4c4b0df8c7c6933d5ca',
  tree: '07e005b7b5647215a10dc957c633aae2d76435cc',
  xpi: 'bbe084a0f3495a1a505f87f69c5a29cfdfd538bf15ec35afee35d34b9ae6b5f1',
});
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

// The authority directory is extracted from exact current main by the workflow.
// Candidate provenance and environment settings cannot change the historical target.
export async function materializeDonor({ root, authority, destination }) {
  root = await realpath(root);
  destination = resolve(destination);
  requireThat(!destination.startsWith(root + sep), 'Donor must be separate from the derivative');
  const manifest = JSON.parse(await readFile(join(authority, 'docs/provenance/alpha-donor.json')));
  requireThat(manifest.commitSha === DONOR.commit && manifest.treeSha === DONOR.tree &&
    manifest.localBaseline.xpiSha256 === DONOR.xpi && manifest.entries.length === 726,
  'Trusted donor provenance differs from the frozen target');
  await mkdir(destination); // Never reuse a dirty or branch-selected product directory.
  const paths = new Set();
  for (const e of manifest.entries) {
    requireThat(typeof e.path === 'string' && e.path.split('/').every(p => p && p !== '.' && p !== '..') &&
      !/[\\\0:]/.test(e.path) && !e.path.startsWith('/') && !paths.has(e.path) &&
      ['100644', '100755'].includes(e.mode) && e.destinationPath === `docs/legacy/donor/${e.path}`,
    'Unsafe frozen donor entry');
    paths.add(e.path);
    const input = join(root, e.destinationPath), actual = await realpath(input), info = await lstat(input);
    requireThat(actual === input && info.isFile() && info.size === e.size,
      `Frozen donor file or size changed: ${e.path}`);
    const bytes = await readFile(input);
    requireThat(hash('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])) === e.blobSha,
      `Frozen donor blob changed: ${e.path}`);
    const output = join(destination, e.path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes);
    await chmod(output, e.mode === '100755' ? 0o755 : 0o644);
  }
  const git = args => execFileSync('git', args, { cwd: destination, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['-c', 'core.filemode=true', 'add', '-f', '--all']);
  requireThat(git(['write-tree']) === DONOR.tree, 'Materialized donor is not the exact pinned Git tree');
  execFileSync(process.execPath, ['scripts/build-extension.mjs'], { cwd: destination, stdio: 'pipe' });
  requireThat(hash('sha256', await readFile(join(destination, 'dist/persona-route-manager-v1.2.0.xpi'))) === DONOR.xpi,
    'Packaged donor XPI differs from the frozen target');
  return { source: 'frozen donor', donorCommit: DONOR.commit, donorTree: DONOR.tree,
    xpiSha256: DONOR.xpi, providerLive: false };
}
