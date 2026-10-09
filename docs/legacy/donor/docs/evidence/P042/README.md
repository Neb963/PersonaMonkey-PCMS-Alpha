# P042 — Unattended Perchance automation via PersonaMonkey execution artifacts (gated)

P042 is **ACCEPTED** after independent PR and merged-main verification. Claim `CLM-P042-001`,
epoch 1, owns A042-01/02/03. Claim [PR #69](https://github.com/Neb963/persona-monkey-pcms/pull/69)
merged as `5532b90873fc158e96e9fc9ed6111ec55b5e22df`; product
[PR #70](https://github.com/Neb963/persona-monkey-pcms/pull/70) (head
`2e2de4e9f84c4cb41145ba2d48a905cecc8f17f8`) merged as `51bac5b402b30ce7c2ee9f69f090d642481065e2`.
The unattended capability stays **disabled for real Perchance** until the final live phase
confirms it (P044). No successor phase has been started.

## Implemented scope

- **T042.1** `generator.update` v2 as a reviewed, immutable PersonaMonkey execution artifact
  (`providers/perchance/execution-update-driver.js`, `deploy-artifact.js`). The driver installs and
  assigns one artifact per fixture origin, acquires a short control lease, stages the release as a
  transient execution input (never in the artifact source or PCMS rows), starts one execution,
  validates the exact result, acknowledges it, discards the input and releases the lease. A failure
  before `execution.start` is `NOT_APPLIED`; anything ambiguous after it is uncertain and
  ProviderGate records `UNCERTAIN`. `live-mutations.js` records the dispatch mode durably before
  the artifact runs; reconciliation runs the same artifact in verify mode for exactly that
  operation and otherwise falls back to the operator handoff. Nothing is replayed. Production
  composes no automation profile: `unattended`, `listing` and `thumbnail` are false and real
  Perchance stays an assisted handoff. `generator.create` is never offered.
- **T042.2** Automatic mode (`pcms-modules/p015/automatic.js`). Gates: unattended driver,
  `generator.observe`, provider compatibility, recovery NORMAL, no open challenge task, operator
  choice; `enable()` refuses and names every unmet gate. Eligibility: `deploy: auto` repository
  release matching the pinned snapshot, `PENDING`, not in sync, not paused, drifted, uncertain,
  failed or repeatedly failed, bound account, snapshot fresher than two check intervals; a
  never-deployed target first needs a fresh hash-only read proving it exists. The pass is a Core
  timer service: one dispatch per occurrence, reserved durably before dispatch, at most 10 per
  cycle and at least 20 seconds apart; a repository check starts a cycle. Two consecutive
  `NOT_APPLIED` for one desired revision pause the target (`REPEATED_FAILURE`). The Deployer page
  previews unmet gates, turns Automatic on/off, shows the mode and raises unmet-gate conditions.
- **T042.3** Emulator end-to-end and pinned-Firefox fixture proofs (below).

## Acceptance mapping

| Gate | Deterministic coverage (`npm run test:p042`, 26 tests) | Browser coverage (`p042-packaged`) |
| --- | --- | --- |
| A042-01 | No profile ⇒ no broker call; all execution/input commands must be authorized; exact command order, lease, transient input digest; pre-start `NOT_APPLIED`, post-start uncertain; verify-mode reconciliation and operator fallback; artifact executed in a VM against a fixture editor; static boundaries (no `browser.*`, `userScripts`, IndexedDB, `fetch`, dynamic code in PCMS paths) | Three leased executions through the real PersonaMonkey broker (two reads, one deployment), acquire/release balanced, one staged input |
| A042-02 | Every gate refuses enable; drifted/uncertain/paused/failed/held/manual/stale targets never dispatched; ≤10 per cycle, ≥20 s spacing, one per occurrence; repeated failure pause; recovery hold stops the pass; existence read before first deploy; UI preview/conditions | Gates met through the real broker; existence read and spaced dispatch run from the durable timer alarm with zero extension pages open |
| A042-03 | Emulator: release → automatic dispatch → post-apply verification baseline → later provider edit is drift, paused, never overwritten; production wiring keeps unattended off and Automatic refuses to turn on | One byte-exact save by `deploy:gen:alpha:1:1`, `SUCCEEDED`, provider baseline equals the release hash, no replay after another unload |

## Verification actually run

- Local `npm run verify`: PASS on the product tree (includes `test:p042` 26/26 and inherited suites).
- Pinned Firefox could not be installed in the authoring sandbox (archive.mozilla.org blocked by
  its proxy); the packaged proof was established only by hosted CI.
- Pre-existing and unrelated: four tests in `tests/pcms/p023` and `tests/pcms/p025` fail identically
  on `main` without this change; they are not part of `verify` or CI and were not modified.

## Independent evidence

- PR head `2e2de4e`, integration candidate `ebeb38bff205bb81d54e1901a2314310c8b074cb`:
  [repository verification](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37830200398)
  and [pinned Firefox](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37830200413)
  SUCCESS; all eleven Firefox jobs passed, including `p042-packaged` (job 113493259221,
  `packaged-pr-ci.json`).
- Merged-main SHA `51bac5b402b30ce7c2ee9f69f090d642481065e2`:
  [repository verification](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37830815327)
  and [pinned Firefox](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37830815141)
  SUCCESS; all eleven Firefox jobs passed on attempt 2, including `p042-packaged` (job 113495365721).
- Attempt 1 of the merged-main Firefox run failed only in the inherited `p031-packaged` job
  (`Timed out: module schedule wakes the unloaded background`). The identical product XPI
  (`bbe084a0…`) passed that job on the PR run; with Automatic off P042 declares no timers and
  that test configures no repository. The single permitted re-run of the failed job passed
  (job 113499143885). Both attempts are recorded in `independent-ci.json`, the acceptance ledger.

Firefox Developer Edition is exactly **154.0b10**, archive SHA-256
`681913108bba655d7ec6fadfac2731141b23e48dca88d1988a4d95a6bdaff164`. The hosted report uses the
normal content sandbox, a clean Actions checkout, a startup-rejecting proxy and a parent HTTP
observer allowing only the loopback fixture origin. Product files are copied byte for byte from the
built XPI into the separate fixture add-on, which alone holds the fixture profiles.

## Scope limits

Real Perchance unattended deployment, `generator.create` and real editor selectors are not
implemented and remain gated for P043/P044. A live discrepancy must first be encoded as a
deterministic regression fixture.
