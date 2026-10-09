import { requireThat, SHA } from './governance.mjs';

// GitHub's public signed actor attribution is outside the candidate tree.
// No candidate-supplied string, ordinary PR approval, or edited validator is
// sufficient: the repository owner must attest the exact main and PR head.
export function approvalBody({ maintenanceId, baseMainSha, approvedHeadSha }) {
  return [
    'ALPHA_GOVERNANCE_MAINTENANCE_APPROVAL_V1',
    `maintenanceId=${maintenanceId}`,
    `baseMainSha=${baseMainSha}`,
    `approvedHeadSha=${approvedHeadSha}`
  ].join('\n');
}

export async function verifyMaintenanceApproval(context, {
  repository, mainSha, approvedHeadSha, request = fetch,
  token = process.env.GITHUB_TOKEN
}) {
  requireThat(repository === 'Neb963/PersonaMonkey-PCMS-Alpha' &&
    SHA.test(mainSha) && SHA.test(approvedHeadSha) &&
    context.baseMainSha === mainSha, 'Invalid maintenance approval repository or commit');
  const url = `https://api.github.com/repos/${repository}`;
  // Actions must use its short-lived repository token rather than consuming
  // the shared anonymous API quota. Never print the credential or API body.
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'alpha-governance-maintenance',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (typeof token === 'string' && token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  async function get(route) {
    const response = await request(`${url}${route}`, { headers });
    requireThat(response.ok, `Cannot independently verify maintenance approval (HTTP ${response.status})`);
    return response.json();
  }
  const pr = await get(`/pulls/${context.pullRequest}`);
  requireThat(pr.base?.ref === 'main' &&
    pr.head?.ref === context.branch &&
    pr.head?.sha === approvedHeadSha,
    'Maintenance approval PR or head differs from exact candidate');
  const expected = approvalBody({
    maintenanceId: context.maintenanceId,
    baseMainSha: mainSha,
    approvedHeadSha
  });
  let authorized = false;
  for (let page = 1; page <= 10 && !authorized; page++) {
    const comments = await get(`/issues/${context.pullRequest}/comments?per_page=100&page=${page}`);
    requireThat(Array.isArray(comments), 'Invalid GitHub approval observations');
    // GitHub can store owner-authored comments with CRLF or LF. Canonicalize
    // only line endings; every attested byte of content must otherwise match.
    authorized = comments.some(c => c.user?.login === 'Neb963' &&
      c.author_association === 'OWNER' &&
      typeof c.body === 'string' &&
      c.body.trim().replace(/\r\n/g, '\n') === expected);
    if (comments.length < 100) break;
  }
  requireThat(authorized, 'Missing exact repository-owner maintenance approval comment');
  return { maintenanceId: context.maintenanceId, approvedHeadSha, approved: true };
}
