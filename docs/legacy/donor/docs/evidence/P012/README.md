# P012 — HumanTask/Attention + timers/services

Phase state: **ACCEPTED**.

## Implemented scope

- durable HumanTask records under `core.human-tasks` with OPEN/RESOLVED/CANCELLED state;
- deterministic Attention projection over open tasks with bounded priority ordering;
- atomic HumanTask state transition + P007 audit append;
- explicit in-memory Core service registry with owner/generation fencing and opaque registration tokens;
- durable one-shot timers under `core.timers`;
- timer target fencing by service owner/generation, with known stale generations reconciled to MISSED;
- bounded due processing and bounded restart recovery;
- overdue timers become MISSED rather than replaying an unbounded backlog;
- DISPATCHING is durable before service delivery; interrupted/ambiguous dispatch is reconciled to MISSED, never blindly replayed;
- no generic scheduler/workflow engine, no raw browser/native/PersonaMonkey authority, and no direct IndexedDB/migration authority.

Implementation files:

- `extension/pcms/services/errors.js`
- `extension/pcms/services/registry.js`
- `extension/pcms/services/human-tasks.js`
- `extension/pcms/services/timers.js`

Focused tests:

- `tests/pcms/p012-harness.mjs`
- `tests/pcms/p012-services.test.mjs`
- `tests/pcms/p012-boundary.test.mjs`

## Acceptance mapping

### A012-01 — HumanTask / Attention

Covers durable audited HumanTask creation/completion, stable identity, CAS/revision fencing, deterministic open-task Attention ordering, and rejection of duplicate identity. HumanTask rows intentionally do not include a generic operator-response payload or secret value field.

### A012-02 — timers

Covers one-shot durable delivery, service-generation fencing, bounded due processing, overdue MISSED semantics, cancellation/state invariants, and no replay after FIRED.

### A012-03 — service registry / restart

Covers service owner/generation fencing, stale registration/unregister protection, hidden service-surface rejection, restart requiring explicit service re-registration, and interrupted DISPATCHING timer recovery to MISSED instead of replay.

## Focused verification actually run

Node: **v22.16.0**

Command:

`node --test tests/pcms/p012-services.test.mjs tests/pcms/p012-boundary.test.mjs`

Result after final hardening: **11 tests passed, 0 failed, exit 0**.

The locally executed P012 product/test files were checked by Git blob hash against the branch:

- `extension/pcms/services/errors.js` — `03dce3e0e9318493b4b70b192513ca448be13ffa`
- `extension/pcms/services/registry.js` — `37126d963d6da05b15074585d984df2af423ff93`
- `extension/pcms/services/human-tasks.js` — `dfab2d71c5503caa00e87eb14288f5603073c278`
- `extension/pcms/services/timers.js` — `0a7cc89e1e758c10e0277ccaa6328e350f26e7cf`
- `tests/pcms/p012-harness.mjs` — `baa50aa3cc6f6bce6e89043d82ba259380eb4292`
- `tests/pcms/p012-services.test.mjs` — `26c84819e4560be0b79b0e8e9c9f5d1ddf842b2c`
- `tests/pcms/p012-boundary.test.mjs` — `50e3119f828f6b897617d202e8115004faf3ad3b`

The integration run used the exact accepted P007 `audit/journal.js` (`7127cfc7205ba844346d05956e9a59ffb3451648`) and `audit/errors.js` (`c2f3363957a8309cd9f087caffb079d6e8ab062a`) with an in-memory audit backend. The local execution tree used a schema-compatible reconstruction for P007 schema normalization because a full repository clone was unavailable in the execution container. The committed P012 harness imports the real repository `audit/schema.js` (`b6f8b0c5a5818372d8632a0647c056c403d12239`); this distinction must be preserved when interpreting local evidence.

Implementation checkpoint before this evidence: `df94831549856348bf8885516ebe6a294121137c`.

Final reconciled PR head `474e29292aee38ba5aba6300fb3e1e6e99a9eef4` passed:

- GitHub Actions `verify`, run **349** / run id **37259110931** — **success**;
- GitHub Actions `firefox-developer-edition`, run **344** / run id **37259110922** — **success**.

Merged main commit `11466b760a0f9b1eb27beef87a6d478651d91a30` passed:

- GitHub Actions `verify`, run **350** / run id **37259235479** — **success**;
- GitHub Actions `firefox-developer-edition`, run **345** / run id **37259235483** — **success**.

PR #12 is merged. Acceptance still requires the MERGED governance checkpoint to pass.

## Acceptance decision

The MERGED governance checkpoint `75a7d65b31d4c0702697549579a62f92955a54c8` passed:

- repository verification run **355** / run id **37259329940** — **success**;
- pinned Firefox Developer Edition run **350** / run id **37259329908** — **success**.

Together with the 11-test focused suite, final PR-head CI, exact merged-main CI, and the accepted P007/P011 dependencies, this satisfies **A012-01**, **A012-02**, and **A012-03**. P012 is **ACCEPTED**.
