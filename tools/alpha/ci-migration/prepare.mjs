import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requireThat } from '../governance.mjs';
import { materializeDonor } from './donor.mjs';
const args = process.argv.slice(2);
requireThat(args.length === 6 && args[0] === '--root' && args[2] === '--authority' && args[4] === '--destination',
  'Usage: prepare.mjs --root derivative --authority trusted-main --destination empty-donor-directory');
const root = resolve(args[1]);
const report = await materializeDonor({ root, authority: resolve(args[3]), destination: resolve(args[5]) });
await mkdir(join(root, '.agent-runs'), { recursive: true });
await writeFile(join(root, '.agent-runs/alpha-frozen-donor.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
