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

## Operator-attested governance maintenance (reusable after trust bootstrap)

`MAINTENANCE` is a separate **governance-only** transition, not a phase claim,
contract amendment, gate or general escape hatch. An operator must explicitly
authorize each transaction and attest its final **exact candidate SHA** using a
GitHub issue comment on that maintenance PR, under the repository owner's
GitHub identity. The context alone never confers approval: the trusted-main
validator looks up GitHub's independently attributed `OWNER` comment.

Maintenance agents use `agent/alpha-maintenance/<maintenance-id-lowercase>`,
with a unique `MAINT-*` identifier and
`docs/evidence/alpha/<maintenance-id>/context.json`. The context pins the
base main SHA, contract lock hash, entire claim-epoch vector, PR number, agent,
branch and approval mode `OWNER_PR_COMMENT_V1`. The allowed changes are
**only** the trusted governance checker/CI code, its approval helper,
`tests/alpha/governance/**`, this governance procedure and the dedicated
maintenance verification workflow, plus exactly its new context. A new context
is required for each transaction and cannot be reused after merge.

No maintenance operation may change `plan.json`, `claims.json`,
`contracts.lock.json`, `policies.json`, Alpha contract declarations,
`AGENTS.md`, phase evidence, product code or unrelated workflows. Snapshots
before and after must have identical plan, registry, lock and policies.
The validator checks active claims, ownership, epochs and frozen contract reads
before considering maintenance authorization. Normal PHASE, CLAIM, GATE,
BOOTSTRAP and CONTRACT_AMENDMENT transitions have no maintenance privileges.

Approval comment (an issue comment on the **maintenance PR** by the repository
owner; ordinary author-supplied text, labels or candidate code do not count):

```text
ALPHA_GOVERNANCE_MAINTENANCE_APPROVAL_V1
maintenanceId=<MAINT-ID>
baseMainSha=<exact trusted main SHA>
approvedHeadSha=<exact final maintenance PR head SHA>
```

On PRs the validator checks the independent comment against the actual PR
branch and head. On `main` push it requires a non-forced **two-parent merge
commit**, parent 1 equal to the approved base main and parent 2 equal to the
attested PR head. It then rechecks the approval. A stale SHA, altered PR head,
different base, non-owner, mismatched branch or missing comment fails closed.
Future maintenance is reusable only with a **fresh context, PR and operator
attestation**, reviewed against the validator that was already trusted on
`main`; candidate modifications can never authorize themselves. No GitHub
credentials or approval tokens belong in repository files.

### One-time trusted-validator bootstrap: MAINT-ALPHA-GOV-001

The 2026-10-09 operator instruction authorizes **one** exceptional merge for
the introduction of the missing maintenance transition, incorporating the
previously reviewed PR #19 test fix. Original trusted main
`a1c9a5676921420e75e296771e95a951064c270e` rejects governance edits
because it has no MAINTENANCE context dispatch. This is an expected
pre-bootstrap trust limitation, **not a passing check**. PR #18's independent
`alpha-governance` failure also stems from the historical-test drift.

The one-time integration may occur **only** when the exact final candidate's
complete diff, fixed contract hash and full epoch vector have been inspected,
the candidate-local repaired governance suite, repository checks, derivative
packaging and relevant pinned Firefox regressions pass in independent GitHub
runners, and the operator has attested the exact PR head and base above.
Record the exact candidate, files, independent CI run IDs and permission for
the exceptional merge on that PR. Recheck `main` immediately before making
a non-forced, expected-SHA fast-forward to a two-parent merge commit. Do not
claim the old trusted-main validation passed or retry a substantive CI failure
under this exception. If parentage or any check differs, stop.

Immediately after the bootstrap, the **new trusted-main validator** must
accept the merged push as MAINTENANCE; all ordinary `alpha-governance`,
`alpha-firefox` and `firefox-developer-edition` workflows must pass on
the exact merged `main`. Until then no governance gate is accepted. The
bootstrap does not acquire P103, merge obsolete PR #18, accept R1, unlock R2,
or authorize provider-live claims.
