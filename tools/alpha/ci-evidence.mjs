import { requireThat } from './governance.mjs';

export async function verifyRun(proof, { repository, fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  requireThat(Number.isSafeInteger(proof.id) && proof.id > 0 && /^[0-9a-f]{40}$/.test(proof.sha) && typeof proof.name === 'string', 'Invalid independent CI proof');
  requireThat(/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository || ''), 'Invalid evidence repository');
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs/${proof.id}`, {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  requireThat(response.ok, 'Cannot verify independent CI run');
  const run = await response.json();
  requireThat(run.repository?.full_name === repository && run.head_sha === proof.sha && run.name === proof.name && run.status === 'completed' && run.conclusion === 'success' && run.event === 'push', 'Independent CI run does not verify the exact merged main');
  return { id: run.id, sha: run.head_sha, name: run.name, conclusion: run.conclusion, url: run.html_url };
}
