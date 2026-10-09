# Phase 07 closure — F-12, F-14, F-15, remaining F-16, and Options focus

**Status:** Phase 07 implementation complete on `phase-07-correctness-ci-documentation`, based on Phase 06 commit `f31aed5545e8480812e6ee8348297ff8eb6a1e8f`.

The release version remains `1.0.0`. Phase 07 closes the findings and verification listed below; it does not publish the planned `v1.1.0` release. F-01 remains excluded as directed.

## F-12 — workflow timeout parity

`MAX_WORKFLOW_STEP_TIMEOUT_MS` in `extension/lib/constants.js` is the shared 60-minute maximum. The runtime page waiter, workflow validator and package normalization, persisted-state normalization, Integration API schema, and both workflow editors use it. The published JSON Schema remains the static value `3,600,000`; a parity test checks it against the shared constant. Existing persisted values through the maximum are preserved; over-limit values normalize to the maximum.

Boundary coverage accepts max−1 and max, and rejects max+1 in the workflow and Integration API validators and the package schema. Runtime coverage captures the actual `waitForTabComplete` timer and accelerates its callback, proving a configured 60-minute timeout reaches the runtime waiter without waiting an hour.

## F-14 — CI and repository hygiene

Every workflow action is pinned to a full commit SHA. The workflow grants only `contents: read`, uses `ubuntu-24.04`, and explicitly provisions Node.js `22.23.3`, Python `3.12.14`, and Chrome for Testing `154.0.8037.57`; browser tests receive the provisioned Chrome path through `CHROME_BIN`. `.gitignore` excludes root-level `.xpi` and `.log` files plus local browser profile and scratch directories. Repository validation enforces the action pins, permissions, runner and tool versions, Chrome configuration, ignore rules, and the absence of active `[skip ci]` contributor guidance. No workflow was dispatched or rerun.

Two consecutive final builds produced the same extension XPI SHA-256, `79febe6b8fc10f1a66b124b8c1ef6c73e931c8b8dd913d3cede879045d89a338`, and the same example-package SHA-256, `c8a85b9698b71d4e330e0909ccf8d0f9cce1ded7701028c90d949fc73e602901`.

## F-15 — documentation reconciliation

- `docs/api/integration-v1.md` already listed policy-gated `workflow.delete`; repository validation now guards that contract.
- `docs/api/management-v1.md` now lists `persona.container.rotated`, its stable Persona UID and old/new cookie store IDs, and the Phase 03 pagination, response, snapshot, batch, and replay limits.
- Workflow package documentation describes the inclusive 60-minute timeout maximum.
- Compatibility and management docs state that Direct bypasses proxy-only readiness checks, remains unprotected, and still needs explicit intent and local authority.
- Sync recovery remains documented as explicit opt-in, quota-limited reinstall recovery in `docs/guides/data-portability.md`. Installation and release docs continue to state that unsigned local XPIs are for temporary development use and persistent installation requires a genuinely Mozilla-signed artifact plus an independently trusted digest.

## Remaining F-16 observations

| Observation | Disposition |
| --- | --- |
| `US_STAGE` URL trust | Uses Firefox `sender.url` or `sender.tab.url`; caller-supplied `message.url` is ignored. A spoofed-URL regression verifies only scripts matching the real sender URL execute. |
| Blackhole and port 9 | No change needed. Existing startup and strict-proxy tests establish cancellation independently of a privileged port 9 refusing connections; unbound route-test requests are independently cancelled by `webRequest`. |
| Direct privacy checks and status | Explicit Direct routing bypasses proxy-only privacy-safety gates and is reported with `protected: false`. Proxy checks remain fail-closed, strict verification may reject traffic that is not actually direct, and Direct assignment still passes through the Phase 02 local authority boundary. |
| `AUTOMATION_PAGE_SIGNAL` | Retained as a fail-closed compatibility sink: page-world messages cannot complete an automation task; the isolated user-script runtime port remains authoritative. The orchestrator test covers this invariant. |
| `persona-storage.clear(..., "full")` | Removed the misleading in-place full-clear scope and `fullWipe` alias. Cookie/site-data clearing remains container-scoped; true full wipe routes through Persona container rotation. Tests assert the storage service rejects the old scope, and rotation recovery tests cover the supported full-wipe path. |
| Cookie FPD and partition metadata | Validation now accepts Firefox's `firstPartyDomain` string/null form and `partitionKey.topLevelSite` with its optional boolean `hasCrossSiteAncestor`. It rejects malformed values, non-HTTP(S) or non-site URLs, credentials, unsupported fields, and simultaneous non-empty FPD plus partition key before calling Firefox. Exact `cookieStoreId` scoping remains. It intentionally does not require the cookie domain, FPD, and top-level site to match. |
| Batch and `requestId` closure | Phase 03 mechanisms remain unchanged. `pcms-replay.test.mjs` verifies same-ID idempotency, payload conflicts, 32-entry capacity, expiry, and in-flight retention through TTL. |

## Options focus regression

The Direct confirmation passes the route select as its explicit focus-return target before disabling it. Firefox focus restoration runs after the promise cleanup re-enables the control. A focused test covers Cancel, Escape, success, and caller error.

In Firefox Developer Edition 157, the temporary XPI was loaded through Firefox Dev MCP, and the Options page was opened in a second tab beside the existing Add-ons tab. A short-lived `Phase07 Focus Check` Persona was created through the UI and deleted after testing. Cancel and Escape retained Block; confirmation selected Direct; an injected Direct notice-update error surfaced its error toast. In all four cases, the route select was enabled, connected, and `document.activeElement` after settlement. The temporary add-on and test tab were removed; Firefox was not restarted or closed. This verifies the Options interaction only; the unsigned XPI was not persistently installed.

## Verification

- `npm test`: passed repository validation, all 57 extension test files, and all 51 Python tests.
- `npm run validate`: passed for 129 extension source files.
- `npm run build`: passed twice with matching hashes above.
- Targeted checks included timeout boundaries/runtime timer, cookie package and service validation, Direct sender/routing regressions, persona status, storage rotation, replay, and focus restoration.
- `npm run test:browser` and `npm run release:check` were not run because their local browser path requires Chromium. Firefox Dev MCP was used for the real UI check. GitHub Actions were not run.

## Phase 07 commits

| Commit | Change |
| --- | --- |
| [`b6463a49cda130196054fd49fb180d9a79c7ce6f`](https://github.com/Neb963/persona-router/commit/b6463a49cda130196054fd49fb180d9a79c7ce6f) | Align workflow timeout across runtime and schema. |
| [`551cc2738f713bc679598bfae6c9c65f3fddb8ef`](https://github.com/Neb963/persona-router/commit/551cc2738f713bc679598bfae6c9c65f3fddb8ef) | Harden Direct routing and cookie isolation. |
| [`173093841e65cd934d0aef2fc4c87ec28ff12a69`](https://github.com/Neb963/persona-router/commit/173093841e65cd934d0aef2fc4c87ec28ff12a69) | Restore focus after Direct route confirmation. |
| [`4008664cd8cbae89d5f1afb19fb4a77cb7cde7d9`](https://github.com/Neb963/persona-router/commit/4008664cd8cbae89d5f1afb19fb4a77cb7cde7d9) | Pin CI actions, runner, and browser test version. |
| [`f3738ec43571db7503d1276a24532aaf3cda3eb1`](https://github.com/Neb963/persona-router/commit/f3738ec43571db7503d1276a24532aaf3cda3eb1) | Reconcile Phase 07 API and behavior documentation. |
| [`0811aa81165057610344c53812fbce5cae49d71c`](https://github.com/Neb963/persona-router/commit/0811aa81165057610344c53812fbce5cae49d71c) | Pin exact CI tool patch versions. |
