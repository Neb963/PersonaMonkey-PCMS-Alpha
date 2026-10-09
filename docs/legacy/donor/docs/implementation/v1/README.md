# PCMS Implementation Authority v1

This directory is the implementation authority beneath accepted architecture and ADRs.

## Canonical manual sources

- `plan.json` — phase/task/dependency/status authority.
- `policies.json` — cross-cutting execution/CI/security rules.
- `claims/*.json` — active task ownership/fencing.
- contract and acceptance data added by their owning phases.

## Generated views

- `ROADMAP.md`
- `docs/progress/STATUS.md`

Generated views must be reproducible from manual authorities and must not be hand-edited.

## Execution model

A fresh agent normally receives:

> Implement the next eligible phase.

Eligibility requires:
- dependencies ACCEPTED;
- no conflicting ACTIVE claim;
- exact accepted contract inputs;
- allocated migrations/resources;
- phase-specific acceptance defined.

The agent implements only its claim, publishes checkpoints, opens/updates its PR, passes independent CI, and stops.

## Parallelism

Claim acquisition is serialized; implementation is parallel when claims are mechanically disjoint.

A reassigned task increments `claimEpoch`; stale epochs cannot merge.
