import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRun } from '../../../tools/alpha/ci-evidence.mjs';

const repository = 'Neb963/PersonaMonkey-PCMS-Alpha';
const proof = { id: 123, sha: 'a'.repeat(40), name: 'alpha-governance' };
const good = { id: 123, repository: { full_name: repository }, head_sha: proof.sha, name: proof.name, status: 'completed', conclusion: 'success', event: 'push', html_url: 'https://github.com/example/run' };
test('acceptance checks real run coordinates; mismatched or failed runs cannot unlock G0', async () => {
  assert.equal((await verifyRun(proof, { repository, fetchImpl: async () => ({ ok: true, json: async () => good }) })).conclusion, 'success');
  for (const change of [{ head_sha: 'b'.repeat(40) }, { name: 'unrelated' }, { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' }, { repository: { full_name: 'other/repo' } }]) {
    await assert.rejects(verifyRun(proof, { repository, fetchImpl: async () => ({ ok: true, json: async () => ({ ...good, ...change }) }) }), /does not verify/);
  }
  await assert.rejects(verifyRun(proof, { repository, fetchImpl: async () => ({ ok: false }) }), /Cannot verify/);
});
test('CI authentication and response failures never expose the token', async () => {
  const token = 'fixture-sensitive-token';
  await assert.rejects(verifyRun(proof, { repository, token, fetchImpl: async () => ({ ok: false }) }), error => !error.message.includes(token));
  await assert.rejects(verifyRun({ ...proof, id: -1 }, { repository }), /Invalid independent/);
  await assert.rejects(verifyRun(proof, { repository: '../other' }), /Invalid evidence/);
});
