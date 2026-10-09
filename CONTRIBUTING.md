# Contributing to Alpha

Read the root `AGENTS.md` and the accepted Alpha specification, contracts, plan,
policies, gates and acceptance matrix. The donor's roadmap and claims are history.
The operator assigns one phase or gate; do not select another eligible task.

Follow `docs/implementation/alpha/GOVERNANCE.md`. Claim acquisition/reassignment
and authority changes are serialized PRs. Product changes use the valid published
claim, exact epoch, frozen contract hashes and disjoint owned paths. Evidence is
isolated under `docs/evidence/alpha/<assigned-id>/`.

Run applicable actual checks, inspect the diff and acceptance mapping, commit and
publish coherent checkpoints, open the PR, and inspect independent CI. Revalidate
against exact current main immediately before a serialized non-forced merge. A
phase agent does not accept a round; that requires its separately assigned checker.
G0 is the serialized bootstrap exception and may not implement an Alpha feature.
