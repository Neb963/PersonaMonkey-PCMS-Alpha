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
