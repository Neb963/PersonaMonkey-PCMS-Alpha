# P040 evidence — Refresher, Explorer and Provisioning background services and UI migration

Claim: CLM-P040-001, epoch 1; dependencies P033, P036 and P029 accepted. Claim recorded on main by [PR #61](https://github.com/Neb963/persona-monkey-pcms/pull/61) (merge `b19a7001690197506bbcec0d3d9c40b525a86c8e`; base `ddf7cee4`).
Implementation: [PR #63](https://github.com/Neb963/persona-monkey-pcms/pull/63), tested head `2f92dca136f353ff359be2dd5ac7e21d53a07a52`. Migration slot: `MIG-P040-refresher-state-v2`.
Claim history: the claim was narrowed while P038 held the background Core factory and CI wiring, and extended to own them only after P038 was accepted (no overlapping active claims at any time).

## Implementation

- **T040.1** — Refresher state v2 (`pcms-modules/p017`, `MIG-P040-refresher-state-v2`, lossless v1 → v2 on read). Members follow the Deployer's *confirmed* release (`release-source.js`, a read-only cross-module query); a refresh pins it at prepare time, reads its content from the pinned repository commit only at dispatch (hashes re-verified, nothing stored) and is refused/discarded if the confirmed release moved, so a refresh never rolls Perchance back. Bounded background pass (daily budget, ≤ 4 dispatches per pass, uncertain outcomes never retried) registered as the Core timer service `refresher.background` (`pcms.timers.ensure/v1`), declared on every due pass and re-declared after each delivery; skipped under recovery hold. Unattended dispatch is capability-gated by the Perchance provider probe (`unattended`), failing closed; with the shipped assisted driver the pass never opens tabs or mutates, wakes at the 6 h horizon and surfaces due refreshes in Attention ("Refresh now").
- **T040.2** — Built-in Refresher, Explorer and Provisioning pages (`pcms-modules/p016|p017|p019/ui.js`). Explicit **New cohort…** with generated key and human schedule fields; account / Persona / generator pickers (shared P034 picker) in a Core-rendered input dialog; Explorer hashes an uploaded source file and generates discovery, reservation and deployment IDs; Provisioning stores the credential through the dedicated secret host and keeps only the SecretRef. Additive `pcms.ui-contribution/v1` `secret` input kind (built-in only, never a setting/preview/bulk, `{"$pcmsSecret":…}` envelope); the UI dispatcher hashes the redacted request (`pcms.ui-client/v1`), so no durable receipt derives from a secret.
- **T040.3** — P026 legacy operator forms, overview backup/restore/release forms and legacy module cards removed; `live-controls.js` keeps only ADR-002 §9 handoff/HumanTask handling. Superseding assertions: P025 live wiring, P026 boundary, P032 shell, P034 accounts model, P041 boundary, and the P028 packaged harness (backup now through Settings → Backup & restore; module connectivity through `ui.snapshot`).

## Acceptance evidence

| Gate | Evidence |
| --- | --- |
| A040-01 (U, I) | `tests/pcms/p040/ui.test.mjs` (descriptor inputs never typed IDs/hashes/SecretRefs; cohorts only via New cohort…; generated Explorer IDs; Provisioning SecretRef via secret host and cleanup on failure), `secret-input.test.mjs` (contract kind, runtime/preview/settings refusal, receipt redaction and equal hash for different secrets), `refresher-background.test.mjs` (explicit, account-fenced membership) |
| A040-02 (U, I, PKG) | `refresher-background.test.mjs`, `scheduler.test.mjs` (timer-driven pass, recovery hold, capability gate fails closed), `migration.test.mjs`, `fixture-rehearsal.test.mjs`; packaged job `p040-packaged` (below) |
| A040-03 (U, C) | `legacy-removal.test.mjs` plus the superseding assertions listed above, all run in required CI (`test:p032`, `test:p034`, `test:p041`, inherited P026 step, `firefox:packaged`) |

- [Repository verification run #37788386879](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37788386879): SUCCESS (`npm run verify`, including `test:p040` — 78 tests).
- [Pinned Firefox run #37788386853](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37788386853): SUCCESS, all nine jobs including `pinned-firefox` (`test:p040`, superseded P026 regressions, P028 packaged harness) and `p040-packaged`.
- **P040 packaged proof** (exact pinned Firefox Developer Edition `154.0b10`, artifact SHA-256 `681913108bba…f164`; product XPI `cacabec36744…bdc3`; report artifact `firefox-packaged-p040`): a separate fixture add-on runs 155 product files copied byte for byte (tree digest `3ff422ab…74d6`) in a real MV3 event page over IndexedDB. Seeded 13:57:05Z, pass due 13:58:05Z; every tab closed and the event page stopped by the Firefox test hook; the `pcms.timers.next` alarm alone woke it (start 13:58:05.423Z, pass 13:58:05.433Z, before any tab reopened). Result: budget 2/2 used, `alpha` and `beta` SUCCEEDED with v2 release fingerprints, `gamma` IDLE, no release content stored, next pass re-declared for 19:58:05Z (6 h horizon).
- Unit baseline: the full `tests/pcms/**` suite has the same four non-CI failures before and after P040 (A023 ×3, P025 production-runtime), none introduced or touched by this phase beyond the superseded P025 assertion.

## Scope and limits

No real Perchance mutation, CAPTCHA automation or Firefox DevTools MCP. Enabling unattended refresh against real Perchance stays with P042/P044 (capability gate). The Deployer's `connect` action (P037/P038, `pcms-modules/p015/**`, outside this claim) still accepts a typed SecretRef for private repositories; public access needs none.

**Merged-main acceptance:** PR #63 merged at `110c820fd99970487fc1a31fa5515f0abc21e749`.
- [Merged-main verify #37789786058](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37789786058): SUCCESS.
- [Merged-main pinned Firefox #37789785927](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37789785927): SUCCESS; all jobs, including `pinned-firefox` and the P040 packaged zero-tab Refresher proof.
This independent merged-main evidence justifies P040 and claim CLM-P040-001 `ACCEPTED`. No successor phase has been started.
