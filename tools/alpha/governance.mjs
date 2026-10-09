import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const PLAN = 'docs/implementation/alpha/plan.json';
export const CLAIMS = 'docs/implementation/alpha/claims.json';
export const LOCK = 'docs/implementation/alpha/contracts.lock.json';
export const POLICIES = 'docs/implementation/alpha/policies.json';
export const CONTRACT_FILES = [
  'docs/implementation/alpha/CONTRACTS.md',
  'extension/alpha/contracts/index.d.ts',
  'extension/alpha/contracts/surface.json'
];
export const AMENDMENT = Object.freeze({ id: 'AMEND-P103-LIST-001', branch: 'agent/alpha-contract-amendment/amend-p103-list-001', contextPath: 'docs/evidence/alpha/AMEND-P103-LIST-001/context.json', previousHash: '9b379980e16fdd557e0ea8a7f8273421f4a581c1c1563fe7661308038e29ee12', nextHash: '8ef33e48ae5b16037f31f93a8da64146bc6d34829390a3db16616991e345bd7e', revision: 2 });
// Reusable governance-only maintenance. The trusted-main copy of this validator
// owns the scope; candidate edits cannot expand their own authorization.
export const MAINTENANCE = Object.freeze({
  agentId: 'alpha-maintenance',
  authority: 'OWNER_PR_COMMENT_V1',
  contextPattern: /^MAINT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  writePaths: Object.freeze([
    'tools/alpha/governance.mjs',
    'tools/alpha/ci.mjs',
    'tools/alpha/maintenance-approval.mjs',
    'tests/alpha/governance/**',
    'docs/implementation/alpha/GOVERNANCE.md',
    '.github/workflows/alpha-maintenance-verification.yml'
  ])
});
export const ACTIVE = new Set(['ACTIVE', 'PR_OPEN']);
export const SHA = /^[a-f0-9]{40}$/;
const PHASE_STATES = new Set(['LOCKED', 'READY', 'CLAIMED', 'IN_PROGRESS', 'PR_OPEN', 'MERGED', 'ACCEPTED']);
const CLAIM_STATES = new Set([...ACTIVE, 'MERGED', 'ACCEPTED', 'RELEASED', 'REASSIGNED']);
const AGENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function requireThat(condition, message) { if (!condition) throw new Error(message); }
export function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 24 * 1024 * 1024 }).trim();
}
export function json(root, path) { return JSON.parse(readFileSync(resolve(root, path), 'utf8')); }
export function load(root = '.', ref) {
  const read = path => ref ? JSON.parse(git(root, ['show', `${ref}:${path}`])) : json(root, path);
  return { plan: read(PLAN), registry: read(CLAIMS), lock: read(LOCK), policies: read(POLICIES) };
}
export function hasAuthority(root, ref) {
  try { git(root, ['cat-file', '-e', `${ref}:${PLAN}`]); return true; } catch { return false; }
}
export function pathPrefix(path) {
  requireThat(typeof path === 'string' && path.length > 0 && path.length <= 300, 'Invalid ownership path');
  const prefix = path.endsWith('/**') ? path.slice(0, -3) : path;
  requireThat(!/[\\\0*?\[\]{}:]/.test(prefix) && !prefix.startsWith('/') && !prefix.endsWith('/'), `Unsafe ownership path: ${path}`);
  requireThat(prefix.split('/').every(p => p && p !== '.' && p !== '..' && !/^\s|\s$/.test(p)), `Unsafe ownership path: ${path}`);
  return prefix;
}
export function overlaps(a, b) {
  const x = pathPrefix(a), y = pathPrefix(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
export function owns(pattern, path) {
  const prefix = pathPrefix(pattern);
  pathPrefix(path);
  return path === prefix || (pattern.endsWith('/**') && path.startsWith(`${prefix}/`));
}
export function ownership(phase) {
  return { ...phase.ownership, writePaths: [...phase.ownership.writePaths, `docs/evidence/alpha/${phase.id}/**`] };
}
export function contractHash(root = '.') {
  const hash = createHash('sha256');
  for (const path of CONTRACT_FILES) {
    const bytes = readFileSync(resolve(root, path));
    hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}
function sameSet(a, b) {
  return Array.isArray(a) && Array.isArray(b) && new Set(a).size === a.length && equal([...a].sort(), [...b].sort());
}
export function eligible(plan, phase) {
  if (plan.bootstrap.state !== 'ACCEPTED') return false;
  const round = plan.rounds.find(r => r.round === phase.round);
  if (!round || !['READY', 'IN_PROGRESS'].includes(round.status)) return false;
  return phase.dependsOn.every(id => id === 'G0' || plan.phases.find(p => p.id === id)?.status === 'ACCEPTED');
}
export function checkConflicts(a, b) {
  requireThat(a.phaseId !== b.phaseId, `Duplicate active phase: ${a.phaseId}`);
  requireThat(a.agentId !== b.agentId, `Agent already has an active claim: ${a.agentId}`);
  for (const x of a.writePaths) for (const y of b.writePaths) requireThat(!overlaps(x, y), `Write-path overlap: ${x} / ${y}`);
  for (const id of a.contractWrites) requireThat(!b.contractWrites.includes(id) && !(id in b.contractReads), `Contract write/read conflict: ${id}`);
  for (const id of b.contractWrites) requireThat(!(id in a.contractReads), `Contract read/write conflict: ${id}`);
  for (const id of a.exclusiveResources) requireThat(!b.exclusiveResources.includes(id), `Exclusive resource conflict: ${id}`);
  for (const id of a.migrationSlots) requireThat(!b.migrationSlots.includes(id), `Migration slot conflict: ${id}`);
}
export function validateSnapshot(s, { root, verifyHash = true } = {}) {
  const { plan, registry, lock, policies } = s;
  requireThat(plan.schemaVersion === 1 && plan.product === 'PersonaMonkey-PCMS-Alpha' && plan.designOnly === false, 'Alpha design has not been approved');
  requireThat(plan.authority === PLAN && plan.designApproval === 'docs/provenance/alpha-design-package.json', 'Invalid Alpha authority');
  requireThat(['IN_PROGRESS', 'MERGED', 'ACCEPTED'].includes(plan.bootstrap.state), 'Invalid G0 state');
  requireThat(plan.bootstrap.claimEpoch === 1 && plan.bootstrap.agentId === 'codex-g0' && SHA.test(plan.bootstrap.baseMainSha), 'Invalid serialized G0 lease');
  requireThat(plan.bootstrap.branch === 'agent/codex-g0/g0', 'Invalid G0 branch');
  requireThat(policies.claims.serialized && policies.claims.epochFencing && policies.verification.independentCIRequired, 'Required governance policy disabled');
  requireThat(plan.phases.length === 30 && plan.rounds.length === 6, 'Expected six rounds of five phases');
  const ids = new Set(plan.phases.map(p => p.id));
  requireThat(ids.size === 30, 'Duplicate phase ID');
  for (const r of plan.rounds) {
    requireThat(r.id === `R${r.round}` && r.gateId === `GATE-R${r.round}`, 'Invalid round identity');
    requireThat(sameSet(r.phaseIds, plan.phases.filter(p => p.round === r.round).map(p => p.id)) && r.phaseIds.length === 5, 'Invalid round membership');
    requireThat(['LOCKED', 'READY', 'IN_PROGRESS', 'ACCEPTED'].includes(r.status), 'Invalid round state');
    if (r.round > 1 && r.status !== 'LOCKED') requireThat(plan.rounds.find(p => p.round === r.round - 1)?.status === 'ACCEPTED', 'Previous round gate is not accepted');
    if (r.status === 'ACCEPTED') requireThat(r.phaseIds.every(id => plan.phases.find(p => p.id === id).status === 'ACCEPTED'), 'Round accepted before its phases');
  }
  for (const p of plan.phases) {
    requireThat(PHASE_STATES.has(p.status), `Invalid phase state: ${p.id}`);
    requireThat(p.dependsOn.every(id => id === 'G0' || ids.has(id)), `Unknown dependency: ${p.id}`);
    requireThat(new Set(p.acceptanceIds).size === 3 && p.acceptanceIds.every(id => id.startsWith(`A${p.id}-`)), `Invalid acceptance IDs: ${p.id}`);
    for (const path of ownership(p).writePaths) pathPrefix(path);
    if (p.status !== 'LOCKED' && p.status !== 'ACCEPTED') requireThat(eligible(plan, p), `Unmet dependency or locked round: ${p.id}`);
    if (p.status === 'ACCEPTED') requireThat(plan.bootstrap.state === 'ACCEPTED' && p.dependsOn.every(id => id === 'G0' || plan.phases.find(x => x.id === id).status === 'ACCEPTED'), `Premature acceptance: ${p.id}`);
  }
  function visit(id, path = new Set()) {
    if (id === 'G0') return;
    requireThat(!path.has(id), `Dependency cycle: ${id}`);
    const next = new Set(path).add(id);
    for (const dep of plan.phases.find(p => p.id === id).dependsOn) visit(dep, next);
  }
  for (const id of ids) visit(id);
  requireThat(lock.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(lock.contracts['alpha.contracts.v1']) && (lock.contractRevision === undefined || lock.contractRevision === AMENDMENT.revision), 'Invalid contract lock');
  if (root && verifyHash) requireThat(contractHash(root) === lock.contracts['alpha.contracts.v1'], 'Frozen contract bytes have changed');
  requireThat(registry.schemaVersion === 1 && sameSet(Object.keys(registry.epochs), [...ids]) && Array.isArray(registry.claims), 'Invalid claim registry');
  for (const epoch of Object.values(registry.epochs)) requireThat(Number.isSafeInteger(epoch) && epoch >= 0, 'Invalid authoritative claim epoch');
  const seen = new Set();
  for (const c of registry.claims) {
    const p = plan.phases.find(p => p.id === c.phaseId);
    requireThat(p && c.schemaVersion === 1 && AGENT.test(c.agentId), 'Invalid claim identity');
    requireThat(Number.isSafeInteger(c.claimEpoch) && c.claimEpoch > 0 && c.claimEpoch <= registry.epochs[c.phaseId], 'Invalid claim epoch');
    requireThat(c.claimId === `CLM-${c.phaseId}-${String(c.claimEpoch).padStart(3, '0')}` && !seen.has(c.claimId), 'Duplicate or invalid claim ID');
    seen.add(c.claimId);
    requireThat(SHA.test(c.baseMainSha) && c.branch === `agent/${c.agentId}/${c.phaseId.toLowerCase()}`, 'Invalid claim base or branch');
    requireThat(CLAIM_STATES.has(c.state), 'Invalid claim state');
    const scope = ownership(p);
    for (const key of ['writePaths', 'contractWrites', 'exclusiveResources', 'migrationSlots']) requireThat(sameSet(c[key], scope[key]), `Claim widens or changes ${key}: ${c.phaseId}`);
    requireThat(sameSet(Object.keys(c.contractReads), scope.contractReads), 'Claim contract read set differs from plan');
    requireThat(sameSet(c.acceptanceIds, p.acceptanceIds), 'Claim acceptance IDs differ from plan');
    if (ACTIVE.has(c.state)) {
      requireThat(c.claimEpoch === registry.epochs[c.phaseId], `Stale active claim epoch: ${c.phaseId}`);
      requireThat(eligible(plan, p) && ['CLAIMED', 'IN_PROGRESS', 'PR_OPEN'].includes(p.status), `Active claim before dependency acceptance: ${c.phaseId}`);
      for (const [id, hash] of Object.entries(c.contractReads)) requireThat(lock.contracts[id] === hash, `Stale contract read: ${id}`);
    }
  }
  for (const id of ids) requireThat((registry.epochs[id] === 0 && !registry.claims.some(c => c.phaseId === id)) || registry.claims.some(c => c.phaseId === id && c.claimEpoch === registry.epochs[id]), `Epoch lacks a durable claim: ${id}`);
  const active = registry.claims.filter(c => ACTIVE.has(c.state));
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) checkConflicts(active[i], active[j]);
  for (const p of plan.phases) if (['CLAIMED', 'IN_PROGRESS', 'PR_OPEN'].includes(p.status)) requireThat(active.some(c => c.phaseId === p.id), `Phase lacks active claim: ${p.id}`);
  if (plan.bootstrap.state !== 'ACCEPTED') requireThat(active.length === 0 && plan.phases.every(p => p.status === 'LOCKED') && plan.rounds.every(r => r.status === 'LOCKED'), 'R1 is locked until merged G0 acceptance');
  return { phases: ids.size, activeClaims: active.length, bootstrap: plan.bootstrap.state };
}
export function acquire(s, { phaseId, agentId, baseMainSha, expectedEpoch, action = 'acquire' }) {
  validateSnapshot(s, { verifyHash: false });
  requireThat(AGENT.test(agentId) && SHA.test(baseMainSha), 'Invalid agent or base SHA');
  const p = s.plan.phases.find(p => p.id === phaseId);
  requireThat(p && eligible(s.plan, p), 'Phase dependency or round gate is unavailable');
  requireThat(expectedEpoch === s.registry.epochs[phaseId], 'Stale acquisition epoch');
  requireThat(['acquire', 'reassign'].includes(action), 'Unsupported claim action');
  const next = structuredClone(s), phase = next.plan.phases.find(p => p.id === phaseId);
  const old = next.registry.claims.find(c => c.phaseId === phaseId && ACTIVE.has(c.state));
  if (action === 'acquire') requireThat(!old && ['READY', 'LOCKED'].includes(phase.status), 'Phase is already claimed or completed');
  else { requireThat(old, 'No active claim to reassign'); old.state = 'REASSIGNED'; }
  const epoch = expectedEpoch + 1;
  const scope = ownership(phase);
  const c = { schemaVersion: 1, claimId: `CLM-${phaseId}-${String(epoch).padStart(3, '0')}`, phaseId, agentId,
    claimEpoch: epoch, state: 'ACTIVE', baseMainSha, branch: `agent/${agentId}/${phaseId.toLowerCase()}`,
    ...scope, contractReads: Object.fromEntries(scope.contractReads.map(id => [id, next.lock.contracts[id]])), acceptanceIds: [...phase.acceptanceIds] };
  next.registry.epochs[phaseId] = epoch;
  next.registry.claims.push(c);
  phase.status = 'CLAIMED';
  next.plan.rounds.find(r => r.round === phase.round).status = 'IN_PROGRESS';
  validateSnapshot(next, { verifyHash: false });
  return next;
}
function assertFiles(files, paths) {
  for (const file of files) requireThat(paths.some(p => owns(p, file)), `Change outside ownership: ${file}`);
}
export function validateTransition(main, head, context, { mainSha, headBranch, files }) {
  validateSnapshot(head, { verifyHash: false });
  requireThat(context?.schemaVersion === 1 && SHA.test(context.baseMainSha), 'Missing valid branch context');
  requireThat(context.branch === headBranch, 'Context branch does not match PR branch');
  if (!main) {
    requireThat(context.kind === 'BOOTSTRAP' && context.phaseId === 'G0' && context.baseMainSha === mainSha, 'Only serialized G0 may seed an empty repository');
    requireThat(head.plan.bootstrap.state === 'IN_PROGRESS' && head.registry.claims.length === 0, 'Bootstrap cannot pre-accept G0 or acquire round claims');
  } else {
    validateSnapshot(main, { verifyHash: false });
    if (context.kind !== 'CONTRACT_AMENDMENT') requireThat(equal(main.lock, head.lock), 'Frozen shared contracts require a separate authorized gate amendment');
    requireThat(equal(main.policies, head.policies), 'Policy amendment is outside this claim');
  }
  if (context.kind === 'MAINTENANCE') {
    requireThat(main?.plan.bootstrap.state === 'ACCEPTED' &&
      context.baseMainSha === mainSha, 'Maintenance requires accepted G0 and exact current main');
    requireThat(typeof context.maintenanceId === 'string' &&
      MAINTENANCE.contextPattern.test(context.maintenanceId) &&
      context.phaseId === context.maintenanceId &&
      context.agentId === MAINTENANCE.agentId &&
      context.branch === `agent/${MAINTENANCE.agentId}/${context.maintenanceId.toLowerCase()}` &&
      context.claimEpoch === 0 && context.authorization === MAINTENANCE.authority &&
      Number.isSafeInteger(context.pullRequest) && context.pullRequest > 0,
      'Unauthorized or malformed maintenance context');
    requireThat(context.contractHash === main.lock.contracts['alpha.contracts.v1'] &&
      equal(context.claimEpochs, main.registry.epochs), 'Stale maintenance contracts or claim epochs');
    requireThat(equal(main.plan, head.plan) && equal(main.registry, head.registry) &&
      equal(main.lock, head.lock) && equal(main.policies, head.policies),
      'Maintenance cannot change plans, claims, contracts or policies');
    const contextPath = `docs/evidence/alpha/${context.maintenanceId}/context.json`;
    requireThat(files.includes(contextPath), 'Maintenance needs its own new context');
    assertFiles(files, [...MAINTENANCE.writePaths, contextPath]);
  } else if (context.kind === 'CONTRACT_AMENDMENT') {
    requireThat(main?.plan.bootstrap.state === 'ACCEPTED' && context.baseMainSha === mainSha, 'Contract amendment requires accepted G0 and exact current main');
    requireThat(context.amendmentId === AMENDMENT.id && context.phaseId === AMENDMENT.id &&
      context.agentId === 'alpha-contract-amendment' && context.branch === AMENDMENT.branch &&
      context.claimEpoch === 1 && context.previousHash === AMENDMENT.previousHash &&
      context.nextHash === AMENDMENT.nextHash, 'Unauthorized or malformed contract amendment');
    requireThat(main.lock.contracts['alpha.contracts.v1'] === AMENDMENT.previousHash &&
      main.lock.contractRevision === undefined, 'Amendment already applied or previous contract changed');
    requireThat(head.lock.contracts['alpha.contracts.v1'] === AMENDMENT.nextHash &&
      head.lock.contractRevision === AMENDMENT.revision &&
      Object.keys(head.lock.contracts).length === 1, 'Amendment changed unexpected contract locks');
    requireThat(equal(main.plan, head.plan) && equal(main.policies, head.policies), 'Contract amendment cannot change phase eligibility or policies');
    const active = main.registry.claims.filter(c => ACTIVE.has(c.state));
    requireThat(equal([...context.affectedClaims].sort(), active.map(c => c.phaseId).sort()), 'Amendment omitted or invented affected claims');
    const expectedRegistry = structuredClone(main.registry);
    for (const c of expectedRegistry.claims) if (ACTIVE.has(c.state)) {
      requireThat(c.contractReads['alpha.contracts.v1'] === AMENDMENT.previousHash, 'Unexpected active contract read hash');
      c.contractReads['alpha.contracts.v1'] = AMENDMENT.nextHash;
    }
    requireThat(equal(head.registry, expectedRegistry), 'Amendment must revalidate reads only; epoch, owner, scope and history are immutable');
    const p103 = main.plan.phases.find(p => p.id === 'P103');
    requireThat(p103.status === 'READY' && main.registry.epochs.P103 === 0 &&
      !main.registry.claims.some(c => c.phaseId === 'P103'), 'P103 has been acquired; halt amendment for claim review');
    assertFiles(files, [
      'extension/alpha/contracts/index.d.ts', 'extension/alpha/contracts/surface.json',
      'docs/implementation/alpha/CONTRACTS.md', LOCK, CLAIMS,
      'docs/implementation/alpha/GOVERNANCE.md', 'tools/alpha/governance.mjs',
      'tools/alpha/ci.mjs', 'tools/alpha/verify-amendment.mjs',
      'tests/alpha/governance/contracts.test.mjs', 'tests/alpha/governance/contract-amendment.test.mjs',
      '.github/workflows/alpha-contract-amendment.yml', AMENDMENT.contextPath
    ]);
  } else if (context.kind === 'BOOTSTRAP') {
    const lease = main?.plan.bootstrap ?? head.plan.bootstrap;
    requireThat(context.agentId === lease.agentId && context.claimEpoch === lease.claimEpoch && context.branch === lease.branch && context.baseMainSha === lease.baseMainSha, 'Stale or invalid G0 lease');
    requireThat(!main || main.plan.bootstrap.state !== 'ACCEPTED', 'G0 is already accepted');
    requireThat(head.registry.claims.length === 0, 'No round claim during G0');
    if (main) {
      if (head.plan.bootstrap.state === 'IN_PROGRESS') {
        requireThat(equal(main.plan, head.plan) && equal(main.registry, head.registry), 'G0 repair cannot change eligibility or claims');
        assertFiles(files, ['tools/alpha/**', 'tests/alpha/governance/**', '.github/workflows/**', 'docs/evidence/alpha/G0/**']);
        return { kind: context.kind, phaseId: 'G0', claimEpoch: context.claimEpoch, validatedMainSha: mainSha };
      }
      assertFiles(files, [PLAN, 'ROADMAP.md', 'docs/progress/alpha/STATUS.md', 'docs/evidence/alpha/G0/**']);
      const a = structuredClone(main.plan), b = structuredClone(head.plan);
      for (const x of [a, b]) { delete x.bootstrap.state; delete x.bootstrap.evidence; for (const p of x.phases) delete p.status; for (const r of x.rounds) delete r.status; }
      requireThat(equal(a, b), 'G0 acceptance changed the approved plan');
      requireThat(head.plan.bootstrap.state === 'ACCEPTED' && head.plan.bootstrap.evidence === 'docs/evidence/alpha/G0/independent-ci.json', 'G0 acceptance requires independent merged-main evidence');
      requireThat(head.plan.phases.every(p => p.status === (p.round === 1 ? 'READY' : 'LOCKED')), 'Only R1 may be unlocked by G0');
      requireThat(head.plan.rounds.every(r => r.status === (r.round === 1 ? 'READY' : 'LOCKED')), 'Only R1 may be unlocked by G0');
    }
  } else if (context.kind === 'CLAIM') {
    requireThat(main?.plan.bootstrap.state === 'ACCEPTED' && context.baseMainSha === mainSha, 'Claims require accepted G0 and exact current main');
    const expected = acquire(main, context);
    requireThat(equal(head.plan, expected.plan) && equal(head.registry, expected.registry), 'Claim mutation differs from serialized acquisition');
    requireThat(context.claimEpoch === expected.registry.epochs[context.phaseId], 'Claim context epoch does not match acquisition');
    assertFiles(files, [PLAN, CLAIMS, 'ROADMAP.md', 'docs/progress/alpha/STATUS.md', `docs/evidence/alpha/${context.phaseId}/context.json`]);
  } else if (context.kind === 'PHASE') {
    requireThat(main?.plan.bootstrap.state === 'ACCEPTED', 'G0 is not accepted on main');
    requireThat(equal(main.plan, head.plan) && equal(main.registry, head.registry), 'Phase PR must retain current-main authority; control changes need a separate PR');
    const c = main.registry.claims.find(c => c.phaseId === context.phaseId && ACTIVE.has(c.state));
    requireThat(c && c.agentId === context.agentId && c.branch === headBranch && c.claimEpoch === context.claimEpoch && c.baseMainSha === context.baseMainSha, 'Stale epoch, wrong owner, or unpublished claim');
    assertFiles(files, c.writePaths);
  } else if (context.kind === 'GATE') {
    requireThat(main?.plan.bootstrap.state === 'ACCEPTED' && context.baseMainSha === mainSha, 'Gate requires exact accepted current main');
    const round = main.plan.rounds.find(r => r.gateId === context.phaseId);
    requireThat(round && round.status === 'IN_PROGRESS' && AGENT.test(context.agentId) && context.branch === `agent/${context.agentId}/${context.phaseId.toLowerCase()}`, 'Invalid assigned gate context');
    assertFiles(files, [PLAN, CLAIMS, 'ROADMAP.md', 'docs/progress/alpha/STATUS.md', `docs/evidence/alpha/${context.phaseId}/**`]);
    const expected = structuredClone(main);
    const r = expected.plan.rounds.find(r => r.id === round.id);
    r.status = 'ACCEPTED';
    for (const id of round.phaseIds) {
      const phase = expected.plan.phases.find(p => p.id === id);
      const c = expected.registry.claims.find(c => c.phaseId === id && ACTIVE.has(c.state));
      requireThat(c, `Gate lacks published phase ownership: ${id}`);
      c.state = 'ACCEPTED'; phase.status = 'ACCEPTED';
    }
    const next = expected.plan.rounds.find(r => r.round === round.round + 1);
    if (next) {
      next.status = 'READY';
      for (const id of next.phaseIds) expected.plan.phases.find(p => p.id === id).status = 'READY';
    }
    requireThat(equal(head.plan, expected.plan) && equal(head.registry, expected.registry), 'Gate may accept only this round and unlock its immediate successor');
  } else {
    throw new Error('Unsupported context kind; contract amendment needs an explicitly assigned governance change');
  }
  return { kind: context.kind, phaseId: context.phaseId, claimEpoch: context.claimEpoch, validatedMainSha: mainSha };
}
