import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, git, validateTransition, MAINTENANCE, P201_CI_MIGRATION } from '../../../tools/alpha/governance.mjs';

// Historical immutable inputs, never today's moving registry.
const proposal = JSON.parse(readFileSync('docs/evidence/alpha/MAINT-P201-CI-SCOPE-004/context.json'));
const base = load('.', proposal.baseMainSha);
const followup = {
  ...proposal, phaseId: P201_CI_MIGRATION.maintenanceId,
  maintenanceId: P201_CI_MIGRATION.maintenanceId,
  branch: 'agent/alpha-maintenance/maint-p201-ci-migration-005',
  scopeAmendmentId: P201_CI_MIGRATION.scopeAmendmentId, pullRequest: 12345
};
const files = [`docs/evidence/alpha/${followup.maintenanceId}/context.json`,
  ...P201_CI_MIGRATION.writePaths];
const check = (ctx = followup, changed = files, next = base) =>
  validateTransition(base, next, ctx, { mainSha: proposal.baseMainSha, headBranch: ctx.branch, files: changed });

test('scope proposal stays in already-authorized ordinary maintenance paths', () => {
  assert.equal(validateTransition(base, base, proposal, {
    mainSha: proposal.baseMainSha, headBranch: proposal.branch,
    files: [`docs/evidence/alpha/${proposal.maintenanceId}/context.json`,
      'tools/alpha/governance.mjs', 'tools/alpha/ci.mjs',
      'docs/implementation/alpha/GOVERNANCE.md', 'tests/alpha/governance/p201-ci-scope.test.mjs']
  }).kind, 'MAINTENANCE');
  assert.ok(!MAINTENANCE.writePaths.includes('.github/workflows/firefox.yml'));
  assert.throws(() => check(proposal, [
    `docs/evidence/alpha/${proposal.maintenanceId}/context.json`, '.github/workflows/firefox.yml'
  ]), /outside ownership/);
});

test('old trusted main rejects the follow-up scope; a candidate cannot approve its own expansion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-prior-ci-authority-'));
  try {
    const file = join(dir, 'governance.mjs');
    writeFileSync(file, git('.', ['show', `${proposal.baseMainSha}:tools/alpha/governance.mjs`]));
    const old = await import(pathToFileURL(file));
    assert.throws(() => old.validateTransition(base, base, followup, {
      mainSha: proposal.baseMainSha, headBranch: followup.branch, files
    }), /outside ownership/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only the exact follow-up ID and scope-amendment ID receive the narrow paths', () => {
  assert.equal(check().kind, 'MAINTENANCE');
  for (const scopeAmendmentId of [undefined, 'MAINT-OTHER', followup.maintenanceId])
    assert.throws(() => check({ ...followup, scopeAmendmentId }), /separate approved scope/);
  const ordinary = { ...followup, maintenanceId: 'MAINT-OTHER', phaseId: 'MAINT-OTHER',
    branch: 'agent/alpha-maintenance/maint-other' };
  assert.throws(() => check(ordinary, ['docs/evidence/alpha/MAINT-OTHER/context.json', '.github/workflows/firefox.yml']),
    /Ordinary maintenance/);
  delete ordinary.scopeAmendmentId;
  assert.throws(() => check(ordinary, ['docs/evidence/alpha/MAINT-OTHER/context.json', '.github/workflows/firefox.yml']),
    /outside ownership/);
});

test('migration cannot edit product, historical tests, snapshots, pins or other workflows', () => {
  for (const path of [
    'extension/lib/recovery-bootstrap.js', 'extension/manifest.json',
    'extension/alpha/core/index.js', 'tests/alpha/core/packaged.test.mjs',
    'tests/pcms/p028/boundary.test.mjs', 'tools/firefox/packaged.mjs',
    'docs/legacy/donor/extension/background.js', 'docs/provenance/alpha-donor.json',
    'docs/implementation/alpha/browser-pin.json', '.github/workflows/alpha-governance.yml',
    'package.json', 'docs/evidence/alpha/P203/context.json',
    'tools/alpha/ci-migration/unreviewed.mjs'
  ]) assert.throws(() => check(followup, [...files, path]), /outside ownership/);
});

test('scope never changes P201 eligibility, R2 state, parallel claims, locks or policies', () => {
  for (const mutate of [
    s => s.plan.phases.find(p => p.id === 'P201').status = 'CLAIMED',
    s => s.registry.epochs.P201++,
    s => s.registry.claims.find(c => c.phaseId === 'P205').agentId = 'attacker',
    s => s.plan.rounds[1].status = 'READY',
    s => s.lock.contracts['alpha.contracts.v1'] = 'a'.repeat(64),
    s => s.policies.verification.requiredWorkflows = ['alpha-governance']
  ]) {
    const after = structuredClone(base); mutate(after);
    assert.throws(() => check(followup, files, after));
  }
});
