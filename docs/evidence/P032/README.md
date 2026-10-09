# P032 — PCMS dashboard shell v2 as UI client

State: **ACCEPTED** after verified P032 product merge, targeted Firefox harness repair and governance reconciliation.

## Governance and provenance

- ACCEPTED claim CLM-P032-001, epoch 1, owner gpt-5-6-sol; branch agent/gpt-5-6-sol/p032-t032-1.
- Original base main: 4d1dfb314fef2f64bf5e89c67f6060c8d897d899.
- The P028 pcms.ui-client/v1 protocol was accepted at 401fa524225b35c45eaf239112974c27492d3bbc.
- P029 merged in PR #41 at 28651a46b1a0f37a56cbe4c327eea81e9bcc7c97.
- Governance PR #43 merged at 837f0b2e149240dc3d34fc63ce52f310f908100e. It reconciled P029 to MERGED (not ACCEPTED) and expressly extended P032 ownership to the UI-client contract, background dispatcher, package script and pinned Firefox workflow, with pcms.ui-client/v1 contract-write authority.
- P032 integrated that main with a non-force, two-parent merge commit 453bdf555c593aedfb041b7906b866273d96b419, preserving P029 product changes.
- Orphaned-PENDING implementation checkpoint: cae150254b006fd178f0b7ffac2e6dac57c73f33; the current branch also includes the completion-time retention correction. No migrations, resources other than CI workflow ownership, or PersonaMonkey/browser authority were added.

## Scope and acceptance

### A032-01: Canonical shell and safe routing

- V2 canonical hash routes cover Overview, Attention, Accounts, Generators, built-in modules, Activity, Settings, Diagnostics and Search.
- Legacy routes canonicalize. Invalid or stale entity links fail closed to Overview with a reason.
- Existing P026 Accounts and module controls are rehosted, without starting P033 module-contract work or P034 Accounts redesign.
- Consistent tokens and sidebar; duplicate dashboard bootstrap was fixed at d5f76d0adb31422ba0d9292d9f6afbc9b5067ad1.

### A032-02: Core-owned durable receipts and HumanTasks

- Added the additive read-only operation uiReceipts.list to the allow-listed pcms.ui-client/v1 contract and background UI dispatcher.
- Core alone owns the existing core.ui-receipts store. A dashboard never uses raw storage, IndexedDB or its own durable receipt database.
- Each response contains at most 20 records, with ONLY receiptId, fixed allow-listed command subject, status, recordedAt and completedAt. Request hashes, command inputs/results, stored errors and raw records do not cross the UI boundary.
- Filtering matches the existing seven-day Core receipt retention, using completion time for settled commands and creation time for outstanding commands. Malformed and future-dated rows are discarded. Unknown, failed and pending outcomes are prioritized over successful ones.
- An orphaned PENDING receipt without a matching current-Core in-flight operation is reported UNKNOWN. The UI must not claim an interrupted operation is still Running or replay it.
- The action tray reads durable receipts when opened or signaled by a revision. Immediate command feedback is de-duplicated. HumanTasks remain durable, separate Attention entries.
- A failed receipt-list request leaves the rest of the UI functioning and shows an action-history-unavailable indication.
- Native P032 regressions include cross-tab revision visibility, all-tabs-closed/reopen with a new background context, failed and redacted receipts, max-results and expiry, orphaned pending and strict read-only authorization.
- Packaged pinned-Firefox A032-02 test: tests/pcms/p032/packaged.mjs opens two actual dashboard tabs, creates a Core-backed backup command receipt, verifies both DOM trays and secret-safe RPC, closes every dashboard, forces event-page unload, then reopens and checks receipt persistence without command replay.

### A032-03: Core health and multi-tab operation

- Diagnostics is available even when Core bootstrap is unavailable, with mutation forms disabled on failure.
- Core status presentation distinguishes live Running, cached Idle, Starting and Unavailable.
- Refresh remains P028 revision-driven. No dashboard operator timer, background Core construction, or raw browser automation was added.
- Unloading a tab removes its listeners and does not stop Core.

## Verification and honest acceptance boundaries

| Gate | Files and coverage |
| --- | --- |
| A032-01 | app/router-v2.js, app/primitives.js, routes.test.mjs, shell.test.mjs, inherited packaged Firefox UI probe |
| A032-02 | integration/ui-client-contract.js, background/ui-dispatcher.js, receipt-read.test.mjs, durability.test.mjs, ui-client.test.mjs |
| A032-03 | app/live-runtime.js, app/app.js, primitives.test.mjs, shell.test.mjs, P028 revision/lifecycle tests |

- Repository verification now includes npm run test:p032 under native Node. The pinned Firefox workflow also runs these P032 suites ahead of packaged-XPI probes.
- The new receipt API and native test suite passed repository verification at implementation checkpoint 801cacf5e8c8936d203a150fc0927abb27ebce4e: https://github.com/Neb963/persona-monkey-pcms/actions/runs/37701975348.
- The orphaned-PENDING correction at cae150254b006fd178f0b7ffac2e6dac57c73f33 and later retention-time fix were covered by final P032 implementation verification in runs 37706520958 and 37706521058.
- Historical pre-amendment implementation checkpoint d5f76d0adb31422ba0d9292d9f6afbc9b5067ad1 passed repository verify run 37695873000 and pinned Firefox run 37695873021. Fourteen earlier P032 test bodies also passed a V8 shimming harness, not native Node; that evidence is superseded by explicit test:p032 CI.
- The old A032-02 blocker was confirmed: second/reopened tabs saw no receipts from the first tab using the P028-only response protocol. Its root cause is addressed by the amended claim and Core read-only receipt-list facade, not by UI-owned state or raw storage access.
- Hosted pinned Firefox CI is distinct from final provider-live testing, reserved for P043/P044. No successor phase is started.

## Final acceptance evidence

- P032 product PR [#42](https://github.com/Neb963/persona-monkey-pcms/pull/42) merged at `76ac9e7239ef58ddbcacb4dde85d5023930ee270` from head `d28affccad9b30a5fa94c815cc4ce0fb7096f7c1`.
- P032 product CI: [repository verify 37706520958](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37706520958) and [pinned Firefox 37706521058](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37706521058), both **PASS** including native P032 tests and two-tab/all-tabs-closed/reopened packaged receipt proof.
- Subsequent independent rerun exposed intermittent extension-page navigation timeouts in both the P029 and P032 packaged tests. Root cause: the P032 dashboard canonicalizes the route fragment to `#/overview`, while `PackagedFirefox.openPage` previously required byte-for-byte equality of the entire URL, including its fragment.
- Narrow governance amendment [PR #45](https://github.com/Neb963/persona-monkey-pcms/pull/45) authorized the shared Firefox harness file for P032. Targeted repair [PR #46](https://github.com/Neb963/persona-monkey-pcms/pull/46) merged at `7214c5d833b5a4a7de6677da529d73d7100a6c0a`, source `0d7107848116d8ab944ceacf8de7510ec4cd736f`.
- The repaired harness compares protocol, host, path and query while permitting fragment normalization; wrong extension origins, documents, queries and `about:blank` still fail. `tests/pcms/p032/firefox-navigation.test.mjs` proves the helper and the actual packaged `openPage` path.
- Independent repair CI: [repository verify 37707904437](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37707904437) **PASS**, [pinned Firefox 37707904519](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37707904519) **PASS**. The latter includes successful isolated P032 receipt-reopen test and inherited P027, P029 restart, and P030 packaged tests.
- The P032 claim epoch was 1 throughout the work, with all implementation changes limited to explicitly claimed files, no runtime migrations, no successor-phase implementation and no live provider acceptance (reserved for P043/P044).
- This governance-only acceptance update changes the authoritative P032 phase and claim to **ACCEPTED**, regenerates the two derived views, and records this evidence. It does not change product runtime or the tested harness.
