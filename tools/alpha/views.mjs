import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { json, PLAN } from './governance.mjs';

export function renderViews(plan) {
  const lines = ['# Alpha roadmap', '', `> Generated from ${PLAN}. Do not hand-edit.`, '', `G0: **${plan.bootstrap.state}**.`, ''];
  for (const r of plan.rounds) {
    lines.push(`## ${r.id} — ${r.title}`, '', `State: **${r.status}**. Gate: ${r.gateId}.`, '');
    for (const p of plan.phases.filter(p => p.round === r.round)) lines.push(`- ${p.id}: **${p.status}** — ${p.title}`);
    lines.push('');
  }
  const status = ['# Alpha status', '', `> Generated from ${PLAN}. Do not hand-edit.`, '',
    `- G0: **${plan.bootstrap.state}**`,
    `- Ready: **${plan.phases.filter(p => p.status === 'READY').map(p => p.id).join(', ') || 'none'}**`,
    `- Claimed: **${plan.phases.filter(p => ['CLAIMED', 'IN_PROGRESS', 'PR_OPEN'].includes(p.status)).map(p => p.id).join(', ') || 'none'}**`,
    `- Accepted phases: **${plan.phases.filter(p => p.status === 'ACCEPTED').map(p => p.id).join(', ') || 'none'}**`,
    '- Provider-live acceptance: **not established**', '',
    'Work starts only with an explicit operator assignment and a valid claim on current main.',
    'R1 requires accepted, independently verified merged G0. Later rounds require their preceding round gate.', ''].join('\n');
  return { 'ROADMAP.md': lines.join('\n').trimEnd() + '\n', 'docs/progress/alpha/STATUS.md': status };
}
export async function generateViews({ root = '.', check = false } = {}) {
  for (const [path, expected] of Object.entries(renderViews(json(root, PLAN)))) {
    const file = resolve(root, path);
    if (check) {
      const actual = await readFile(file, 'utf8');
      if (actual !== expected) throw new Error(`Generated Alpha view is stale: ${path}`);
    } else { await mkdir(dirname(file), { recursive: true }); await writeFile(file, expected); }
  }
  console.log(`Generated Alpha views ${check ? 'verified' : 'updated'}.`);
}
