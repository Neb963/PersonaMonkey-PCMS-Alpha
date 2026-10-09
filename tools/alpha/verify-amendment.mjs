import { git, load, requireThat, validateTransition, AMENDMENT, contractHash } from './governance.mjs';
import { verifyRepository } from './verify-repo.mjs';
import { readFileSync } from 'node:fs';
const event = process.env.GITHUB_EVENT_NAME || 'local';
const mainRef = event === 'push' ? 'HEAD^1' : 'origin/main';
git('.', ['fetch', 'origin', 'main']);
const mainSha = git('.', ['rev-parse', mainRef]), headSha = git('.', ['rev-parse', 'HEAD']);
git('.', ['merge-base', '--is-ancestor', mainSha, headSha]);
requireThat(!git('.', ['status', '--porcelain']), 'Amendment candidate has uncommitted changes');
const context = JSON.parse(readFileSync(AMENDMENT.contextPath, 'utf8'));
const files = git('.', ['diff', '--name-only', mainSha, headSha]).split('\n').filter(Boolean);
const result = validateTransition(load('.', mainRef), load('.'), context, {
  mainSha, headBranch: AMENDMENT.branch, files
});
requireThat(context.baseMainSha === mainSha, 'Amendment was prepared against a different main');
requireThat(contractHash() === AMENDMENT.nextHash, 'Amendment contract hash mismatch');
await verifyRepository('.');
const now = git('.', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
requireThat(now === (event === 'push' ? headSha : mainSha), 'Current main moved during amendment verification');
console.log(JSON.stringify({ passed: true, ...result, mainSha, headSha, contractHash: AMENDMENT.nextHash, files, providerLive: false }));
