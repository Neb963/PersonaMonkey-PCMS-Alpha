import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { git, json, load, hasAuthority, requireThat, validateSnapshot, validateTransition, owns, ACTIVE, AMENDMENT, MAINTENANCE, P201_CI_MIGRATION } from './governance.mjs';
import { verifyRepository, verifyG0Runtime } from './verify-repo.mjs';
import { verifyRun } from './ci-evidence.mjs';
import { verifyMaintenanceApproval } from './maintenance-approval.mjs';
import { verifyDerivative } from './ci-migration/policy.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  requireThat(['--root', '--main-ref', '--head-ref', '--branch'].includes(process.argv[i]) && process.argv[i + 1], 'Invalid CI argument');
  options[process.argv[i]] = process.argv[i + 1];
}
const root = resolve(options['--root'] || '.'), event = process.env.ALPHA_EVENT || 'local';
const headSha = git(root, ['rev-parse', options['--head-ref'] || process.env.ALPHA_HEAD_SHA || 'HEAD']);
const mainRef = options['--main-ref'] || (event === 'push' ? `${headSha}^1` : 'origin/main');
const mainSha = git(root, ['rev-parse', mainRef]);
requireThat(!git(root, ['diff', '--name-only', headSha]) && !git(root, ['ls-files', '--others', '--exclude-standard']), 'Candidate checkout has uncommitted changes or differs from PR head');
git(root, ['merge-base', '--is-ancestor', mainSha, headSha]);
const head = load(root), main = hasAuthority(root, mainRef) ? load(root, mainRef) : null;
await verifyRepository(root);
const files = git(root, ['diff', '--name-only', mainSha, headSha]).split('\n').filter(Boolean);
let branch = options['--branch'] || process.env.ALPHA_HEAD_BRANCH;
let contexts;
if (branch || event === 'local') {
  branch ||= git(root, ['branch', '--show-current']);
  const contextPath = branch === AMENDMENT.branch ? AMENDMENT.contextPath :
    `docs/evidence/alpha/${branch.split('/').at(-1).toUpperCase()}/context.json`;
  contexts = [json(root, contextPath)];
} else {
  const changed = files.filter(p => /^docs\/evidence\/alpha\/(G0|P[1-6]0[1-5]|GATE-R[1-6]|AMEND-P103-LIST-001|MAINT-[A-Z0-9-]+)\/context\.json$/.test(p));
  if (changed.length) contexts = changed.map(p => json(root, p));
  else if (!main || main.plan.bootstrap.state !== 'ACCEPTED') contexts = [json(root, 'docs/evidence/alpha/G0/context.json')];
  else {
    const owners = main.registry.claims.filter(c => ACTIVE.has(c.state) && files.some(p => c.writePaths.some(w => owns(w, p))));
    contexts = owners.map(c => json(root, `docs/evidence/alpha/${c.phaseId}/context.json`));
  }
  requireThat(contexts.length > 0, 'No assigned context for this main/merge-group change');
}
if (contexts.length > 1) {
  requireThat(contexts.every(c => c.kind === 'PHASE'), 'Control changes are serialized; do not group claim/gate PRs');
  const claims = contexts.map(c => main.registry.claims.find(p => p.phaseId === c.phaseId && ACTIVE.has(p.state)));
  requireThat(claims.every(Boolean) && files.every(p => claims.some(c => c.writePaths.some(w => owns(w, p)))), 'Combined candidate includes unowned changes');
}
const results = contexts.map(c => {
  const owned = contexts.length === 1 ? files : files.filter(p => main.registry.claims.find(x => x.phaseId === c.phaseId && ACTIVE.has(x.state)).writePaths.some(w => owns(w, p)));
  return validateTransition(main, head, c, { mainSha, headBranch: branch || c.branch, files: owned });
});
const context = contexts[0], report = { ...results[0], contexts: results };
if (context.kind === 'MAINTENANCE') {
  if (context.maintenanceId === P201_CI_MIGRATION.maintenanceId) {
    // This must exist in the predecessor authority, not merely in the candidate.
    // Its main-push CI checked the independently attributed exact-head approval.
    const scopePath = `docs/evidence/alpha/${P201_CI_MIGRATION.scopeAmendmentId}/context.json`;
    const scope = JSON.parse(git(root, ['show', `${mainRef}:${scopePath}`]));
    requireThat(scope.kind === 'MAINTENANCE' &&
      scope.maintenanceId === P201_CI_MIGRATION.scopeAmendmentId &&
      scope.authorization === MAINTENANCE.authority,
      'P201 CI migration scope must be independently approved on current main first');
  }
  const path = `docs/evidence/alpha/${context.maintenanceId}/context.json`;
  let existsOnMain = false;
  try { git(root, ['cat-file', '-e', `${mainRef}:${path}`]); existsOnMain = true; } catch {}
  requireThat(!existsOnMain, 'Maintenance authorization has already been consumed');
  // A main push is the serialized two-parent merge of the reviewed PR head.
  // Its first parent is exact old main; its second parent is the approved PR.
  let approvedHeadSha = headSha;
  if (event === 'push') {
    const parents = git(root, ['rev-list', '--parents', '-n', '1', headSha]).split(' ');
    requireThat(parents.length === 3 && parents[1] === mainSha,
      'Maintenance must merge exact current main and approved PR head');
    approvedHeadSha = parents[2];
  }
  const auth = await verifyMaintenanceApproval(context, {
    repository: process.env.GITHUB_REPOSITORY || 'Neb963/PersonaMonkey-PCMS-Alpha',
    mainSha, approvedHeadSha
  });
  requireThat(auth.approved === true, 'Maintenance owner authorization was not verified');
}
if (context.kind === 'BOOTSTRAP' && !main) {
  await verifyG0Runtime(root);
  const additions = git(root, ['ls-tree', '-r', '--name-only', headSha, 'extension/alpha']).split('\n').filter(Boolean);
  requireThat(additions.length === 2 && additions.every(p => ['extension/alpha/contracts/index.d.ts', 'extension/alpha/contracts/surface.json'].includes(p)), 'G0 introduced Alpha feature code');
}
if (context.kind === 'BOOTSTRAP' && head.plan.bootstrap.state === 'ACCEPTED') {
  const evidence = json(root, head.plan.bootstrap.evidence);
  requireThat(evidence.phaseId === 'G0' && evidence.state === 'ACCEPTED' && evidence.providerLive === false, 'Invalid G0 acceptance evidence');
  git(root, ['merge-base', '--is-ancestor', evidence.mergedMainSha, mainSha]);
  const expected = head.policies.verification.requiredWorkflows;
  requireThat(evidence.ciRuns.length === expected.length && expected.every(name => evidence.ciRuns.some(p => p.name === name && p.sha === evidence.mergedMainSha)), 'G0 lacks both exact merged-main CI proofs');
  if (process.env.GITHUB_ACTIONS === 'true') for (const proof of evidence.ciRuns) await verifyRun(proof, { repository: process.env.GITHUB_REPOSITORY });
}
if (context.kind === 'GATE') {
  const evidence = json(root, `docs/evidence/alpha/${context.phaseId}/independent-ci.json`);
  const round = main.plan.rounds.find(r => r.gateId === context.phaseId);
  requireThat(evidence.phaseId === context.phaseId && evidence.providerLive === false && evidence.phases.length === 5 && evidence.mergedMainSha === mainSha, 'Gate lacks exact combined-main evidence');
  for (const id of round.phaseIds) {
    const proof = evidence.phases.find(p => p.phaseId === id), phase = main.plan.phases.find(p => p.id === id);
    requireThat(proof && JSON.stringify([...proof.acceptanceIds].sort()) === JSON.stringify([...phase.acceptanceIds].sort()), `Gate lacks acceptance mapping: ${id}`);
    git(root, ['merge-base', '--is-ancestor', proof.commitSha, mainSha]);
    const published = json(root, `docs/evidence/alpha/${id}/acceptance.json`);
    const claim = main.registry.claims.find(c => c.phaseId === id && ACTIVE.has(c.state));
    requireThat(published.phaseId === id && published.state === 'MERGED' && published.claimEpoch === claim.claimEpoch && published.commitSha === proof.commitSha && published.providerLive === false, `Gate lacks published merged phase evidence: ${id}`);
    requireThat(JSON.stringify([...published.acceptanceIds].sort()) === JSON.stringify([...phase.acceptanceIds].sort()), `Published phase acceptance mapping differs: ${id}`);
    git(root, ['merge-base', '--is-ancestor', published.mergedMainSha, mainSha]);
    requireThat(published.ciRuns.length === main.policies.verification.requiredWorkflows.length && main.policies.verification.requiredWorkflows.every(name => published.ciRuns.some(p => p.name === name && p.sha === published.mergedMainSha)), `Phase lacks independent merged-main CI: ${id}`);
    if (process.env.GITHUB_ACTIONS === 'true') for (const run of published.ciRuns) await verifyRun(run, { repository: process.env.GITHUB_REPOSITORY });
  }
  requireThat(evidence.ciRuns.length === main.policies.verification.requiredWorkflows.length && main.policies.verification.requiredWorkflows.every(name => evidence.ciRuns.some(p => p.name === name && p.sha === mainSha)), 'Gate lacks combined-main independent CI');
  if (process.env.GITHUB_ACTIONS === 'true') for (const proof of evidence.ciRuns) await verifyRun(proof, { repository: process.env.GITHUB_REPOSITORY });
}
if (process.env.GITHUB_ACTIONS === 'true') {
  const observed = git(root, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
  requireThat(observed === (event === 'push' ? headSha : mainSha), 'Main moved during validation; refresh and rerun instead of merging stale CI');
}
await verifyDerivative(root, mainRef);
validateSnapshot(head, { root });
const path = resolve(root, process.env.ALPHA_REPORT || '.agent-runs/alpha-ci.json');
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify({ passed: true, ...report, headSha, candidateTree: git(root, ['rev-parse', `${headSha}^{tree}`]), workflowRun: process.env.GITHUB_RUN_ID || null, providerLive: false }, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, ...report, headSha, providerLive: false }));
