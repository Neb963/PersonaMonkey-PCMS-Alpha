# Serialized Alpha claims and merge procedure

This is G0's executable clarification of the approved plan/policies, not an
additional implementation round. G0 preserves donor runtime and materializes
shared declarations plus governance. It implements no Alpha feature.

## State and ownership

`plan.json` determines phase ownership, dependencies and round eligibility.
`claims.json` is the serialized registry: monotone epochs and append-only claim
history. ACTIVE/PR_OPEN claims have one current epoch, one owner, one branch,
exact plan write paths plus their isolated phase evidence directory, frozen
contract reads, exclusive resources, migration slots and acceptance IDs. The
validator rejects invalid paths, widening, overlapping paths, read/write contract
conflicts, stale contract hashes, shared resources/migrations and duplicate owners.

The first round has five disjoint possible claims. That is tested through in-memory
fixtures only; G0 acquires none. R1 becomes READY only in a separate G0 acceptance
PR after product G0 is merged and both independent workflows pass on exact main.
R2–R6 remain LOCKED until the preceding separately assigned round checker accepts
the combined round. Individual green PRs never constitute round acceptance.

## Acquiring an explicitly assigned phase

1. Fetch current main and inspect the operator assignment, Alpha authority and
   required dependencies. Start a clean isolated branch at exact `origin/main`.
2. Use `agent/<agent-id>/<phase-id-in-lowercase>` and run, for example,
   `node tools/alpha/claim.mjs acquire --phase P101 --agent agent-one --epoch 0`.
   The explicit epoch is the current registry epoch, not the requested new epoch.
   The command fetches main, validates eligibility and existing ownership, writes
   only plan/registry/views and the phase context, and allocates epoch 1.
3. Commit/publish a control-only claim PR. Its `CLAIM` context names the exact main
   SHA. Product edits in acquisition PRs are rejected. Revalidate current main and
   independent CI before serial merge. If main moves, regenerate from its latest
   authority; never overwrite another acquisition or widen ownership.
4. After the claim is on main, update the isolated phase branch to exact current
   main and run `claim.mjs context --phase P101 --agent agent-one --epoch 1`.
   This writes a `PHASE` token with the published owner/epoch/base. Implement only
   that claim. The context command does not acquire or reassign anything.
5. Commit/publish acceptance slices and actual evidence under the phase directory.
   Product PRs retain current-main authority unchanged. Update from current main
   before CI and merge; never overwrite another claim registry or phase record.

An operator-authorized reassignment uses `reassign` instead of `acquire` with the
current epoch. The old record becomes REASSIGNED and the next epoch is appended.
An old owner/token/branch cannot pass even after copying current authority into
its branch. There is no automatic claim selection or silent ownership takeover.

## Independent CI and current-main fencing

`alpha-governance` and `firefox-developer-edition` run on PRs, main pushes and
merge groups. They do not run again on every agent checkpoint push. The first
bootstrap PR has no predecessor validator; subsequent PRs execute the validator
extracted from current main, against the candidate checkout. A PR cannot weaken
the active validator to approve its own stale epoch or scope expansion.

The trusted guard checks exact current main, ancestry, published owner/epoch,
contract hashes, ownership and a clean candidate tree. Its content-free report
names main/head/tree/run. A final guard checks that main did not move during the
full suite. A branch check that was green before a main change is insufficient.

Before merging: fetch main/head; independently inspect the actual diff, acceptance
evidence and every required CI conclusion; validate that exact candidate against
that exact main again. Prefer a configured merge queue. Without a queue, serialize
merges, create a merge commit with exact main and PR-head parents, and update main
with `force:false` and an expected current main SHA. Git's non-fast-forward
rejection is the final race fence: a competing new main not included in the
validated candidate cannot be overwritten. Do not enable force-with-lease or use
an API merge without a current-main precondition. If the ref moves or the PR head
changes, stop that merge, update and rerun the relevant verification.

Post-merge workflows must pass on exact merged main before accepting G0/a round.
G0's acceptance proof is verified against GitHub's actual run records in CI,
including repository, merged SHA, workflow, event and successful completion.
COMMITTED, CI_VERIFIED, MERGED, GATE_VERIFIED, ACCEPTED and LIVE_VERIFIED remain
distinct. No deterministic check establishes provider-live acceptance.

## History and source preservation

The exact 726 donor blobs/modes and original approved seed files are immutable
snapshots. `verify:donor` reconstructs and executes the donor's actual verification
and reproducible build. Hosted Firefox runs against the active derivative XPI.
Original donor scripts/tests remain available; all donor roadmap authority is
historical. G0 additionally proves that inherited runtime/regressions are byte
exact and that the only new Alpha extension files are two declaration surfaces.
Later changes require their assigned phase ownership and actual regressions.

The inherited Firefox pin remains 154.0b10 with its existing Mozilla checksum.
P101 owns its separately assigned Alpha browser harness; G0 does not implement it.
P103's discovery-v3 observations are not present in this design ZIP or the donor;
that source-specific evidence must be supplied/located before claiming its
observation-dependent acceptance. Unknown provider behavior remains fail-closed.

## One-time operator-authorized P103 contract amendment

`AMEND-P103-LIST-001` is a **single-use**, serialized correction for the unkeyed `PerchanceAdapter.listGenerators` return type. It is not a P103 phase claim, not a gate acceptance and not a general contract unlock. Its fixed context path is `docs/evidence/alpha/AMEND-P103-LIST-001/context.json` and its branch is `agent/alpha-contract-amendment/amend-p103-list-001`. The authorization is the operator's 2026-10-09 instruction; the validator pins the prior and new contract hashes, revision, exact current-main SHA, limited changed files and every active claim's exact before/after registry projection.

The procedure is: inspect all current active claims and PRs; prepare a dedicated branch from exact main; revalidate contract-read hashes of all affected active claims **without** changing epochs, owners, paths, states or plan; run the amendment-only fixture suite and independent CI; compare the entire diff and current main again; serialize and merge only when the repository's trusted-main guard and required CI permit it, followed by merged-main CI. A candidate may not approve itself by modifying the validation code copied from current main. If the old validator does not support this one-time transition, **do not merge** based only on a self-hosted amendment workflow; obtain a separately approved trusted-validator bootstrap path first. No ordinary PHASE, CLAIM or GATE transition receives the amendment's privileges.

PR #8 contains an obsolete P103 claim acquisition plus unrelated P105 control changes, based on a superseded main. It must remain unmerged; closing the draft with a recorded explanation preserves its historical branch and work. After a valid amendment, P103 remains READY/unclaimed at epoch 0 for its rightful agent's new current-main claim or separately authorized continuation. No R2 unlock or P103 acceptance is implied.
