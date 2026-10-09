import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireThat } from './governance.mjs';

const args = process.argv.slice(2);
requireThat(args.length === 0 || (args.length === 2 && args[0] === '--root'), 'Usage: run-tests.mjs [--root path]');
const root = resolve(args[1] || '.'), files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    requireThat(!e.isSymbolicLink(), 'Alpha test discovery does not follow symlinks');
    const path = join(dir, e.name);
    if (e.isDirectory()) await walk(path);
    else if (e.isFile() && /\.(?:test|spec)\.(?:mjs|cjs|js)$/.test(e.name)) files.push(path);
  }
}
for (const e of await readdir(join(root, 'tests/alpha'), { withFileTypes: true })) {
  requireThat(!e.isSymbolicLink(), 'Alpha test discovery does not follow symlinks');
  if (e.name === 'governance') continue; // Already executed by npm run verify.
  if (e.isDirectory()) await walk(join(root, 'tests/alpha', e.name));
}
if (!files.length) {
  console.log('No Alpha feature test files exist yet; G0 establishes no feature acceptance.');
} else {
  // A separate test runner must not inherit a parent node:test worker identity.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...files.sort()], { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status || (result.signal ? 1 : 0);
}
