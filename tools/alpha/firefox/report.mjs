import { execFileText, writeJson } from '../../firefox/lib.mjs';

export async function newReport(suite) {
  const commitSha = (await execFileText('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const treeSha = (await execFileText('git', ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  const dirty = Boolean((await execFileText('git', ['status', '--porcelain'])).stdout.trim());
  if (process.env.CI && dirty) throw new Error('Browser CI requires a clean committed checkout');
  return { schemaVersion: 1, phaseId: 'P101', suite, commitSha, treeSha,
    prHeadSha: process.env.ALPHA_HEAD_SHA || commitSha, workflowRun: process.env.GITHUB_RUN_ID || null,
    worktreeDirty: dirty, providerLive: false,
    contentSandboxDisabled: process.env.MOZ_DISABLE_CONTENT_SANDBOX === '1',
    networkIsolation: 'startup-rejecting-proxy-and-exact-origin-parent-observer',
    checks: {}, passed: false };
}

export async function saveReport(path, report, error) {
  // Publish only controlled stage/codes; never include page source, console,
  // storage, browser stderr, provider responses, credentials or profile files.
  if (error) report.failure = { stage: report.stage, code: 'REGRESSION_FAILED' };
  if (error?.artifactIntegrity) report.artifactIntegrity = error.artifactIntegrity;
  delete report.stage;
  await writeJson(path, report);
  console.log(JSON.stringify(report));
}
