import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { acquire, git, load, equal, requireThat, PLAN, CLAIMS, ACTIVE } from './governance.mjs';
import { generateViews } from './views.mjs';

const [action, ...args] = process.argv.slice(2), options = {};
requireThat(['acquire', 'reassign', 'context'].includes(action), 'Usage: claim.mjs acquire|reassign|context --phase Pxxx --agent id --epoch N');
for (let i = 0; i < args.length; i += 2) {
  requireThat(['--phase', '--agent', '--epoch'].includes(args[i]) && args[i + 1] && !(args[i] in options), 'Invalid or duplicate claim argument');
  options[args[i]] = args[i + 1];
}
const phaseId = options['--phase'], agentId = options['--agent'], epochText = options['--epoch'];
requireThat(/^P[1-6]0[1-5]$/.test(phaseId || '') && /^[0-9]+$/.test(epochText || ''), 'Explicit assigned phase and epoch are required');
const epoch = Number(epochText), root = resolve('.');
git(root, ['fetch', 'origin', 'main']);
const baseMainSha = git(root, ['rev-parse', 'origin/main']);
requireThat(git(root, ['rev-parse', 'HEAD']) === baseMainSha && !git(root, ['status', '--porcelain']), 'Start with a clean branch at exact current main');
const main = load(root, 'origin/main');
requireThat(equal(load(root), main), 'Working authority differs from current main');
const branch = `agent/${agentId}/${phaseId.toLowerCase()}`;
requireThat(git(root, ['branch', '--show-current']) === branch, `Use the isolated branch ${branch}`);
let context;
async function save(path, value) { const file = resolve(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
if (action === 'context') {
  const c = main.registry.claims.find(c => c.phaseId === phaseId && ACTIVE.has(c.state));
  requireThat(c && c.agentId === agentId && c.claimEpoch === epoch && c.branch === branch, 'No matching current-main claim; stale claimant cannot resume');
  context = { schemaVersion: 1, kind: 'PHASE', phaseId, agentId, branch, claimEpoch: epoch, baseMainSha: c.baseMainSha };
} else {
  const next = acquire(main, { action, phaseId, agentId, baseMainSha, expectedEpoch: epoch });
  await save(PLAN, next.plan); await save(CLAIMS, next.registry);
  context = { schemaVersion: 1, kind: 'CLAIM', action, phaseId, agentId, branch, claimEpoch: epoch + 1, expectedEpoch: epoch, baseMainSha };
  await generateViews({ root });
}
await save(`docs/evidence/alpha/${phaseId}/context.json`, context);
console.log(JSON.stringify({ context, nextStep: action === 'context' ? 'Implement only this published claim' : 'Commit a control-only PR; validate and merge before product work' }));
