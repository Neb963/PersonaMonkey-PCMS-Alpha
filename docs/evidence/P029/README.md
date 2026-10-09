# P029 — Durable PCMS timers woken by extension alarms

Scope: **P029 only** / T029.1–T029.3. Claim `CLM-P029-001` epoch **1**; branch `agent/gpt-5-6-sol/p029-t029-1`.
Base main `4d1dfb314fef2f64bf5e89c67f6060c8d897d899`, updated from current main `ee354c07326f13fa9cc3db7563449aaeebac98d4` without overwriting the disjoint P032 claim.

## Implementation and invariants

- **A029-01**: `extension/pcms/services/timers.js` extends the accepted P012 audit/CAS state machine with the `pcms.timers.ensure/v1` convergence operation, durable miss reasons and a best-effort alarm-rearm hook. The durable timer service—not `browser.alarms`—remains authoritative. `extension/pcms/background/alarms/coordinator.js` maps the earliest scheduled durable due time onto `pcms.timers.next` and maintains a five-minute `pcms.core.heartbeat`; both are recreated on Core start. Duplicate/spurious wakes are serialized and idempotent.
- **A029-02**: Startup/wake recovers interrupted `DISPATCHING` timers into durable `MISSED` records, re-declares schedules idempotently, and runs only a bounded due pass. Only an interrupted occurrence can receive one catch-up; other terminal outcomes and old backlog are not replayed. Remaining due work is continued by a later named alarm after a bounded yield. P029 declares only the Core continuity fixture—no Deployer/Refresher/domain scheduler or provider mutation is introduced.
- **A029-03**: The packaged-XPI harness proves two Firefox event-page suspensions with every PCMS page closed, next-due alarm wake, durable `FIRED` state, cold profile restart, alarm recreation, and another unload/wake/fire cycle. Durable timer evidence is read through the existing Core/UI backup command, not raw module/browser storage authority.

## Acceptance mapping

| Gate | Verification |
| --- | --- |
| **A029-01** | `tests/pcms/p029/timers.test.mjs`, `alarms.test.mjs`, `host.test.mjs`, `boundary.test.mjs`; inherited P012 timer suite |
| **A029-02** | Duplicate declaration convergence, old backlog → `MISSED`, interrupted catch-up once, no live `DISPATCHING` takeover, duplicate/spurious wakes, bounded continuation |
| **A029-03** | `tests/pcms/p029/packaged.mjs` on exact pinned Firefox Developer Edition `154.0b10`, built packaged XPI, zero-PCMS-page forced-unload/profile-restart proof |

## Final functional-head verification

Functional/governance head `2b97ac4fcba15ed62a4b0b62d97082455b4be97f` passed independent required CI:

- `verify` PR run [37697271821](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37697271821): **SUCCESS**.
- `verify` push run [37697267401](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37697267401): **SUCCESS**.
- pinned-Firefox PR run [37697271798](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37697271798), job **113052342745**: **SUCCESS**.
- pinned-Firefox push run [37697267414](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37697267414): **SUCCESS**.

The final PR Firefox artifact `firefox-packaged-p029` is ID **11516281079**, ZIP digest
`sha256:ba457345208bce9f8ab36805e165ea7e01651c5eae1282f4994eb0b3db8bcda8`.
Its report is reproduced verbatim in [`packaged-report.json`](./packaged-report.json) and records:

- tested PR integration SHA `c0bef5fd11363693ee1adc28f80a76bdeee3ee80`;
- Firefox archive SHA-256 `681913108bba655d7ec6fadfac2731141b23e48dca88d1988a4d95a6bdaff164`;
- product XPI SHA-256 `797f67aa73c4c5a943b1abdee092e5b7d8f39739468dba2ef7fd8856e9db301e`;
- both Firefox test-hook unloads returned `stopped`;
- timer revision **1 → 3 / FIRED**, then after profile restart **4 → 6 / FIRED**;
- all three P029 packaged checks `true`, `passed: true`.

An earlier same-head-family duplicate push run exposed a harness race: querying background state immediately after Firefox's unload hook could observe the next alarm already transitioning the context to `starting`. `d9f54561041e8e842fa47669fafc4ef57c237ddf` removes only that redundant post-hook query and retains the hook's explicit `stopped` result; the final push and PR runs above independently pass. The continuity fixture lead time was widened to 30 seconds to keep the forced-unload observation deterministic on slower runners.

## Constraints and state

- No migration slot was used. No PersonaMonkey internals, raw native RPC, provider live mutation, Perchance live behavior, operator secret, or Mullvad live-routing input is involved.
- Work remains confined to the P029 claim plus its explicitly claimed background/CI/governance paths.
- P029 is **PR_OPEN / CI_VERIFIED / INTEGRATION_VERIFIED** by deterministic packaged Firefox evidence. It is **not MERGED or ACCEPTED**; those states require their own repository transitions and merged-main verification.
- No successor phase is started.

## Merged-main verification and acceptance

[PR #41](https://github.com/Neb963/persona-monkey-pcms/pull/41) was merged at the operator's request as
`28651a46b1a0f37a56cbe4c327eea81e9bcc7c97`. That exact merged-main commit passed:

- [verify 37698756404](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37698756404);
- [firefox-developer-edition 37698756419](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37698756419),
  including the P029 unit and packaged XPI steps.

**A029-01 PASS · A029-02 PASS · A029-03 PASS.** Phase P029 and claim CLM-P029-001, epoch 1, are **ACCEPTED** at the
operator's instruction. This supersedes the "not MERGED or ACCEPTED" line above, which recorded the pre-merge state.
