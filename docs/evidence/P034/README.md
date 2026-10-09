# P034 — Accounts UX with Persona/account pickers

State: **ACCEPTED**. Claim CLM-P034-001, claimEpoch 1, branch `agent/gpt-6/p034-t034-1`. All A034-01/A034-02/A034-03 acceptance gates were met by deterministic tests and pinned Firefox CI; no provider-live tests were represented as PASS.

## Governance
- Dependency P032 ACCEPTED. Original claim base `1ea1c08286c976ebd3bbc6aaa32169f18e74a603`.
- P035 holds a separate active claim with disjoint product write paths. P034's exact app mounting, Core composition, package and Firefox workflow paths were allocated via serialized governance commit `0b82d566ace67cf31d9fae15eb476ce907176db2`.
- No PersonaMonkey or raw browser authority was added; all state mutations pass through existing Core accounts commands.
- No migration, contract write, provider live operation, CAPTCHA bypass or successor phase was introduced.

## Implementation
- `views/accounts/accounts-view.js`: bounded table (25 per page), name/persona search, provider/route filters, account deep links, details and rebind dialog.
- `views/accounts/model.js`: deterministic slug key generation with collision suffixes, sorting/filtering/pagination, validated Persona and last observed route status. Unverified provider session is explicitly Unknown.
- `ui/picker/entity-picker.js`: keyboard-searchable reusable picker of named Personas, disabling Personas bound to other accounts, no free-text durable IDs.
- `pcms-modules/p014/accounts.js` and Core composition: fail-closed durable RemoteOperation inspection before and after target Persona resolution. Account-scoped correlation is read from durable operation context when available. Unknown correlation blocks rather than replays/rebinds.
- The old P026 form IDs are hidden to preserve inherited assertions. P040, not P034, owns eventual removal.

## Acceptance mapping
| Gate | Deterministic evidence |
| --- | --- |
| A034-01 | `tests/pcms/p034/accounts-model.test.mjs` validates auto-generated IDs and picker usage; packaged Firefox creates the dialog and verifies read-only key and picker DOM |
| A034-02 | `tests/pcms/p034/rebind-guard.test.mjs` checks initial/racing unresolved guards, unchanged account state and successful resolved rebind; packaged Firefox verifies disabled rebind and visible warning |
| A034-03 | 52-account Node fixture validates page/sort/filter/deep links; `tests/pcms/p034/packaged.mjs` drives 25/25/2 rows, interactive search, descending sort, a URL-backed status filter and detail in exact pinned Firefox Developer Edition 154.0b10 |

## Final verification, integration and acceptance evidence

- Source branch checkpoint: `13a063c1672bccb057ae4c7f337f0b09279b040a`, claim epoch 1. PR [#49](https://github.com/Neb963/persona-monkey-pcms/pull/49) merged non-force into `main` as `7bdda8e8652a48580e6473c6999dfac614c92e7a`.
- Independent PR CI for the exact source checkpoint: [repository verify #37710530889](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37710530889) — **PASS**; [pinned Firefox Developer Edition #37710530879](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37710530879) — **PASS**, including isolated packaged P034 and inherited P032 jobs plus the full pinned-Firefox job.
- Independent **merged-main** CI at `7bdda8e8652a48580e6473c6999dfac614c92e7a`: [repository verify #37711256643](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37711256643) — **PASS**; [pinned Firefox Developer Edition #37711256652](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37711256652) — **PASS**. All three browser jobs passed: `p034-packaged`, `p032-packaged`, `pinned-firefox`.
- Statuses are distinct: implementation committed on the source branch; independent CI verified at the head; integration verified by merged-main CI; PR #49 is **MERGED**; this subsequent governance-only update records **ACCEPTED**.
- Earlier pinned-browser test assertion failure was isolated to a test checking the display name inside the technical detail panel; corrected in source commit `1e4c3d4d373856d2f84ffb7c53ed8a574d76362d` and the final enlarged fixture passed on PR head and merged main.
- Route text reflects last-observed PersonaMonkey public health from `persona.list`, **not** a new `route.get` probe. Perchance session remains Unknown without authoritative provider observation.
- No provider-live testing or operator Firefox acceptance was performed; those are reserved for P043/P044. P034 introduced no new migration or versioned contract write, and no successor phase was begun.
