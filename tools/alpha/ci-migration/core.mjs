import { run } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requireThat } from '../governance.mjs';
import { verifyDerivative, validateP201Events, P201_FILE } from './policy.mjs';

const args = process.argv.slice(2);
requireThat(args.length === 4 && args[0] === '--root' && args[2] === '--main-ref',
  'Usage: core.mjs --root derivative --main-ref exact-predecessor-main');
const root = resolve(args[1]), policy = await verifyDerivative(root, args[3]);
let result = policy;
if (policy.p201 === 'REQUIRED') {
  requireThat(process.env.FIREFOX_BIN && process.env.FIREFOX_INSTALL_MANIFEST,
    'P201 verification requires the installed, attested pinned Firefox');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const events = [];
  // Child processes, all owned Core tests, no name filters or branch-selected skip mode.
  for await (const event of run({ files: policy.testFiles.map(p => join(root, p)), cwd: root,
    env, execArgv: [], concurrency: 1, timeout: 600_000 })) {
    if (['test:pass', 'test:fail', 'test:summary'].includes(event.type)) events.push(event);
  }
  result = validateP201Events(events, join(root, P201_FILE));
}
await mkdir(join(root, '.agent-runs'), { recursive: true });
await writeFile(join(root, '.agent-runs/alpha-p201-verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
