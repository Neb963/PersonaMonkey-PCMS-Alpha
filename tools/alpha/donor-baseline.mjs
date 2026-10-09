import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyDonor } from './verify-repo.mjs';

const root = resolve('.'), manifest = await verifyDonor(root);
const work = await mkdtemp(join(tmpdir(), 'alpha-frozen-donor-'));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: work, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Frozen donor command failed: ${command} ${args.join(' ')}`);
}
try {
  for (const e of manifest.entries) {
    const dest = join(work, e.path);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(resolve(root, e.destinationPath), dest);
    await chmod(dest, e.mode === '100755' ? 0o755 : 0o644);
  }
  run('git', ['init', '-q']);
  run('git', ['add', '-A']);
  run('npm', ['run', 'verify']);
  run(process.execPath, ['scripts/build-extension.mjs']);
  const xpiSha256 = createHash('sha256').update(await readFile(join(work, 'dist/persona-route-manager-v1.2.0.xpi'))).digest('hex');
  if (xpiSha256 !== manifest.localBaseline.xpiSha256) throw new Error('Frozen donor XPI digest differs from executed preflight');
  console.log(JSON.stringify({ passed: true, source: 'frozen donor', donorCommit: manifest.commitSha, xpiSha256, commands: ['npm run verify', 'node scripts/build-extension.mjs'], providerLive: false }));
} finally { await rm(work, { recursive: true, force: true }); }
