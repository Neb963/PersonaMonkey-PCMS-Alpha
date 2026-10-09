# P035 — Toolbar popup PCMS status block

## Provenance and claim

- Phase: P035; tasks T035.1, T035.2 and T035.3.
- Claim: `CLM-P035-001`; owner `gpt-6`; epoch `1`; branch `agent/gpt-6/p035-t035-1`.
- Initial unit-test candidate: `1b2d26c6f02b7a28d6bf5ce0a1c6cc4ca76e74bc`.
- Packaged-FDE acceptance candidate: `3090aa8bfbd6ee03ec2e730c085a4891ebc496e5`.
- PR: https://github.com/Neb963/persona-monkey-pcms/pull/48
- Independent `verify` CI: https://github.com/Neb963/persona-monkey-pcms/actions/runs/37709670126 — **PASS** for the exact candidate above.
- Independent acceptance workflow: https://github.com/Neb963/persona-monkey-pcms/actions/runs/37711608724 — **SUCCESS**, including the P035 packaged Firefox test on the candidate `3090aa8bfbd6ee03ec2e730c085a4891ebc496e5`.
- Exact pinned browser used in that acceptance: Firefox Developer Edition **154.0b10**, Mozilla Linux x86_64 artifact SHA-256 `681913108bba655d7ec6fadfac2731141b23e48dca88d1988a4d95a6bdaff164`.

## Changes

- `extension/popup/popup.js` reads only `browser.storage.session["pcms.status.v1"]` and projects whitelisted non-secret fields. It never calls a PCMS Core constructor or makes PCMS UI/Core requests.
- Stable active `personaUid` matches the non-secret `personaAccounts` projection. A validated Account ID is URI-encoded in `#/accounts/<id>`; the popup reuses and focuses a PCMS dashboard tab or opens one.
- Status block displays Running, Starting, Unavailable, and cached Idle/last-known status, attention counts, recovery hold, and the account link. Unmanaged context shows only attention/hold (not account details).
- Popup retains fixed 370px body width, compact ellipsis text, and a bounded 560px scrolling main surface. Existing route/privacy controls remain intact.
- The frozen upstream `popup.js` now lives in the exact-byte snapshot alongside upstream popup HTML/CSS. Derived popup files are recorded by blob SHA and byte size in `docs/upstream/import-manifest.json`.

## Acceptance evidence (packaged-FDE candidate above)

| ID | Verified evidence | Result |
| --- | --- | --- |
| A035-01 | Node regression asserts intrinsic fixed 370px body width, no viewport-relative body sizing, bounded 560px content, and ellipsis for long labels. | **PASS (U, pinned FDE)**; packaged popup document measured at exactly 370px intrinsic width with a 560px maximum content height and no horizontal overflow. Native Firefox ESR toolbar-panel sizing was not exercised. |
| A035-02 | VM-based browser mock injects secret, cookieStoreId and HumanTask instruction fields into the session summary; rendered PCMS status contains none. Frozen upstream provenance integrity also passes. | **PASS (U, SEC regression)** |
| A035-03 | VM-based browser mock verifies Core statuses, stable Persona-account mapping, invalid-ID rejection, correct account hash, existing-tab reuse/focus, new-tab creation, unmanaged hiding, recovery hold and live session-summary updates without Core RPC. | **PASS (U, pinned FDE)**; real PersonaMonkey created a managed Persona, Core created a bound Account and published `pcms.status.v1`, and the popup rendered that Account and navigated an existing PCMS tab. The actual extension popup document was loaded in a same-origin managed-Persona iframe for deterministic browser automation (not a native toolbar panel). |

## Verification performed

- Independent hosted `verify` workflow `37709670126`: **SUCCESS**. This runs `verify:repo`, `verify:views`, `verify:claims`, P032 tests, Firefox harness contract tests, and `verify:upstream`. `tests/upstream/import-integrity.test.mjs` imports `tests/pcms/p035/popup.test.mjs` as part of that path.
- Initial `verify` workflow caught three regression failures (cross-realm test comparison, singular attention copy, and Core Unavailable precedence). All three were corrected before the successful candidate run.
- Focused P035 packaged test `tests/pcms/p035/packaged.mjs` is invoked by the independent `verify` pipeline through the P035-owned upstream-integrity test entrypoint. CI run `37711608724` reported `✔ A035-01/A035-03 — packaged Firefox popup layout and account deep link` (12.77s) with 11/11 tests passing and zero skips. It operates against the packaged XPI and exact pinned browser with a disposable profile, not Firefox DevTools MCP.
- The native toolbar panel itself and Firefox ESR 153 remain **not directly tested**. Existing static regression and pinned-FDE rendering evidence support the sizing invariant, but do not constitute a native ESR popup measurement.

## Merged-main verification and final acceptance

- PR #48 merged to `main` at `d9724df03d4f34fc8e1254409a0c105164a961ce` (parents `93ac1cd2ce04ac82838415486456b05d03256fd6` and `c65e585c1e9c0057dc0fee9462bc809f7e77a764`).
- Merged-main `verify` run [37768475568](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37768475568): **SUCCESS** for `d9724df03d4f34fc8e1254409a0c105164a961ce` (push).
- Merged-main `firefox-developer-edition` run [37768475864](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37768475864): **SUCCESS** for `d9724df03d4f34fc8e1254409a0c105164a961ce` (push), including the pinned Firefox job and all packaged regression jobs.
- A035-01, A035-02 and A035-03 have the U/SEC/pinned-FDE evidence listed above. These gates require pinned-FDE proof, not separate native ESR hardware acceptance.
- Scope limit remains explicit: the popup document was tested in the packaged extension's managed-Persona iframe; native Firefox ESR toolbar-panel geometry was **not** directly measured. This is not reported as a performed test.
- After green merged-main verification, `CLM-P035-001` epoch 1 and phase P035 are marked **ACCEPTED**. No successor phase was implemented.
