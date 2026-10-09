# 04 — Parallel Agent Coordination

## Model

1. dependencies are encoded in `plan.json`;
2. claim acquisition is serialized;
3. the claim records exact base main SHA and claim epoch;
4. implementations run in isolated branches/worktrees;
5. CI verifies each PR independently;
6. integration-wave/merge-group CI verifies the actual combined candidate;
7. deterministic merge order prefers contract/schema producers before consumers.

## Mechanical conflict dimensions

Two ACTIVE claims conflict when:
- write paths overlap or have ancestor/descendant overlap;
- both write the same contract;
- one assumes a contract SHA replaced by the other;
- both claim the same exclusive resource;
- migration slots collide;
- both edit the same manual authority.

Read/read overlap is allowed.

## Fencing

Reassignment increments `claimEpoch`. CI rejects a stale epoch even if an old agent later resumes.

A commit/green branch is not automatically accepted evidence for a later head. Evidence names exact SHA/run.
