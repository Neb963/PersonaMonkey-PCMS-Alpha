/**
 * Reconstruct a past in-progress round from the current authority without
 * inheriting later claims. Historical governance tests must not bind their
 * "prior" claim-epoch vector to a moving production registry.
 *
 * Only tests may use this projection. Actual CI always validates live main
 * directly with the trusted validator and complete current claim registry.
 */
export function historicalRoundSnapshot(published, roundNumber) {
  if (!published || !Number.isSafeInteger(roundNumber) ||
      roundNumber < 1 || roundNumber > 6 ||
      !Array.isArray(published.plan?.phases) ||
      !Array.isArray(published.plan?.rounds) ||
      !Array.isArray(published.registry?.claims)) {
    throw new TypeError('Invalid historical round fixture');
  }
  const snapshot = structuredClone(published);
  // Historical R4 tests retain the contract accepted by its owners. Future
  // contracts must not retroactively rewrite their claims or lock.
  if (roundNumber === 4) {
    const oldHash = '8ef33e48ae5b16037f31f93a8da64146bc6d34829390a3db16616991e345bd7e';
    snapshot.lock.contractRevision = 2;
    snapshot.lock.contracts['alpha.contracts.v1'] = oldHash;
    for (const claim of snapshot.registry.claims) if (['ACTIVE','PR_OPEN'].includes(claim.state) &&
      snapshot.plan.phases.some(p => p.id === claim.phaseId && p.round <= 4)) {
      claim.contractReads['alpha.contracts.v1'] = oldHash;
    }
  }
  const later = new Set(snapshot.plan.phases
    .filter(phase => phase.round > roundNumber).map(phase => phase.id));
  for (const round of snapshot.plan.rounds) {
    if (round.round === roundNumber) round.status = 'IN_PROGRESS';
    else if (round.round > roundNumber) round.status = 'LOCKED';
  }
  for (const phase of snapshot.plan.phases) {
    if (phase.round === roundNumber) phase.status = 'CLAIMED';
    else if (phase.round > roundNumber) phase.status = 'LOCKED';
  }
  snapshot.registry.claims = snapshot.registry.claims
    .filter(claim => !later.has(claim.phaseId));
  for (const id of later) snapshot.registry.epochs[id] = 0;
  for (const claim of snapshot.registry.claims) {
    if (snapshot.plan.phases.some(p => p.id === claim.phaseId &&
      p.round === roundNumber) &&
      claim.claimEpoch === snapshot.registry.epochs[claim.phaseId]) {
      claim.state = 'ACTIVE';
    }
  }
  return snapshot;
}
