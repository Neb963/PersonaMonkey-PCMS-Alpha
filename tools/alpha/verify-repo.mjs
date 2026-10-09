import { access, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { json, load, validateSnapshot, requireThat, pathPrefix, PLAN } from './governance.mjs';

export function blobHash(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
export async function verifyDonor(root = '.') {
  const m = json(root, 'docs/provenance/alpha-donor.json');
  requireThat(m.commitSha === '482dc9d9273dcdcd7d2ef4c4b0df8c7c6933d5ca' && m.treeSha === '07e005b7b5647215a10dc957c633aae2d76435cc' && m.entries.length === 726, 'Donor provenance drift');
  const paths = new Set();
  for (const e of m.entries) {
    pathPrefix(e.path);
    requireThat(!paths.has(e.path) && e.destinationPath === `docs/legacy/donor/${e.path}`, 'Invalid donor snapshot mapping');
    paths.add(e.path);
    const file = resolve(root, e.destinationPath), bytes = await readFile(file);
    requireThat(bytes.length === e.size && blobHash(bytes) === e.blobSha, `Frozen donor blob drift: ${e.path}`);
    requireThat(Boolean((await stat(file)).mode & 0o111) === (e.mode === '100755'), `Frozen donor mode drift: ${e.path}`);
  }
  return m;
}
export async function verifyG0Runtime(root = '.') {
  const m = await verifyDonor(root);
  for (const e of m.entries.filter(e => /^(extension|pcms-modules|native|tests|fixtures|scripts)\//.test(e.path))) {
    requireThat(blobHash(await readFile(resolve(root, e.path))) === e.blobSha, `G0 changed inherited runtime or regression: ${e.path}`);
  }
}
export async function verifyRepository(root = '.') {
  const required = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', PLAN,
    'docs/specs/alpha/SPEC.md', 'docs/implementation/alpha/CONTRACTS.md', 'docs/implementation/alpha/GATES.md',
    'docs/implementation/alpha/ACCEPTANCE.md', 'docs/implementation/alpha/GOVERNANCE.md',
    'docs/implementation/alpha/browser-pin.json', 'docs/evidence/alpha/G0/context.json',
    '.github/workflows/alpha-governance.yml', '.github/workflows/firefox.yml'];
  for (const path of required) await access(resolve(root, path));
  const s = load(root), result = validateSnapshot(s, { root });
  const approval = json(root, 'docs/provenance/alpha-design-package.json');
  requireThat(approval.approvedBy === 'operator' && approval.packageSha256 === 'dc01b88e35983e26c75c93aa271fcb81944396d0c51934918d922cca2a91a493' && approval.seedFiles.length === 7, 'Missing approved design provenance');
  for (const e of approval.seedFiles) {
    const bytes = await readFile(resolve(root, 'docs/provenance/alpha-design', e.path));
    requireThat(createHash('sha256').update(bytes).digest('hex') === e.sha256, `Approved seed drift: ${e.path}`);
  }
  requireThat((await readFile(resolve(root, 'docs/implementation/alpha/browser-pin.json'))).equals(await readFile(resolve(root, 'docs/implementation/v1/browser-pin.json'))), 'G0 changed inherited Firefox pin');
  const accepted = await readFile(resolve(root, 'docs/implementation/alpha/ACCEPTANCE.md'), 'utf8');
  for (const p of s.plan.phases) for (const id of p.acceptanceIds) requireThat(accepted.includes(`- ${id}:`), `Missing acceptance ID: ${id}`);
  await verifyDonor(root);
  if (s.plan.bootstrap.state !== 'ACCEPTED') await verifyG0Runtime(root);
  console.log(JSON.stringify({ passed: true, authority: 'Alpha', ...result, frozenDonorBlobs: 726 }));
}
