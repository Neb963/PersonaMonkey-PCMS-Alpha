# Phase 08 — Firefox acceptance and audit closure record

- Date: 2026-09-25
- Audit baseline: `main` at `e33272a7d4ff49623d613d11fbb65da806d7f869`
- Local Phase 08 branch: `phase-08-firefox-acceptance-audit-closure`
- Local Phase 07 base: `ff7d3636139dbd3ffd0fa51b641d839fadce1b31`; its tree matches GitHub's Phase 07 branch head `18318f605458379e506537305ac9063a94f12a46` (tree `4c2f44cd1dd06bc10567048faba9407a8cd46503`).
- Original Phase 08 implementation candidate: `ba15dcc459b65d04c6f1168adf3ee95c64c86106` (tree `69941e73996a0a513a832a56b6f42ca986fe8492`). The bridge compatibility gate was added afterward; the remote branch also contains a native shutdown-cleanup follow-up, recorded below.

## Overall disposition

Phase 08 implementation and the applicable repository/CI checks pass, and the current-source routing/recovery scenarios exercised in Firefox now pass. The known defects discovered during the standalone routing/lifecycle review—Direct Test Route false rejection, retired-forwarder-token recovery, MV3 idle-stop persistence, stale local-forwarder caching, and non-transactional native upgrade rollback—are fixed with regression coverage. Current Firefox testing also confirmed Direct egress, protected Albania/Tirana egress with clean DNS evidence, Direct-to-protected switching, request-triggered recovery after native Down, explicit restart recovery, and unchanged-route recovery without observed Direct escape.

For the **v1.1.0 release**, the owner has explicitly accepted the remaining evidence-only gaps as non-blocking: real MV3 event-page suspend/wake acceptance, destructive supported-host native install/update/uninstall/service lifecycle acceptance, and Mozilla-signed artifact provenance. These checks are **waived, not passed**. Their absence must remain visible in release notes. The unsigned repository XPI remains suitable only for temporary/development loading; persistent Firefox/LibreWolf installation still requires a genuinely Mozilla-signed artifact under the installer's existing security checks.

With that owner release decision, Phase 08 is accepted for v1.1.0 release preparation.

F-01 is excluded by owner decision: `excluded by owner; historical key already revoked`.

The supplied `AUDIT_MAPPING.md` maps F-13 to Phases 01 and 08 and requires “real Firefox routing/runtime acceptance.” It does not include the original audit title or root-cause narrative. This record does not invent that wording; it records the concrete Phase 08 route-health issues found in review. Per-finding statuses below preserve what was and was not exercised at the time; the owner release decision above governs whether those residual evidence gaps block v1.1.0.

## Candidate and artifact evidence

- Original candidate source commit: `ba15dcc459b65d04c6f1168adf3ee95c64c86106`.
- Remote branch tip before this evidence update: `e135d5c6bf8028d183bfed192fea2d76a8c78457` (tree `cda94009ada9afad0fe84da07599ddb6d2f70a02`), including the daemon-owned shutdown-cleanup follow-up in F-07.
- Local XPI build source before this evidence update: `8d5ce7576747055fc67743df8f17521be3216a12` (tree `6d77e43cc872a7844b58949069dd96bda56c7c30`). The live Firefox status recognized the installed host as compatible with the extension's required `0.3.0` protocol. Firefox Dev MCP did not expose the loaded XPI digest.
- Product version and XPI manifest version: `1.0.0`; release target `1.1.0` was not assigned to this unaccepted candidate.
- Original candidate artifact: `dist/persona-route-manager-v1.0.0.xpi`, SHA-256 `d23655981f9da2e4a97af2a87a729101e5f1ac81e694af9e24b7e4d8ec50e714`.
- Current local build from `8d5ce7576747055fc67743df8f17521be3216a12`: `dist/persona-route-manager-v1.0.0.xpi`, SHA-256 `808e4d1967f7a65bad5b34b70ef95f1d4cdede65e265e827d6433fb94e1343ac`. Two consecutive local `npm run build` runs produced this same XPI hash; Firefox Dev MCP did not provide a digest to correlate it to the installed add-on.
- Both current builds produced `dist/mullvad-signal-check.personamonkey.zip` with SHA-256 `c8a85b9698b71d4e330e0909ccf8d0f9cce1ded7701028c90d949fc73e602901`.
- Manifest ID: `persona-route-manager@local`; Manifest V3.
- Firefox: Developer Edition `157.0`. The exact XPI bytes were loaded through Firefox Dev MCP's base64 BiDi path as a **temporary unsigned add-on**. It was active. This is not persistent installation, Mozilla signing, or release acceptance.
- Native bridge source version: `0.3.0`. This scratch container still lacks running `systemd` and `wg`, so it could not exercise native install/update/uninstall. The live Firefox host later reported an installed, compatible `0.3.0` bridge and completed one real route/egress test; that runtime observation does not verify the host's installation or service lifecycle. See F-13.

The original candidate hash above is retained for historical comparison. Two consecutive local builds from the XPI source above matched the recorded local XPI and companion ZIP hashes.

## Local verification

Passed on implementation candidate `ba15dcc459b65d04c6f1168adf3ee95c64c86106`:

- `npm test` — repository checks passed; all 57 extension test files passed; all 51 native Python tests passed.
- `npm run validate` — passed; 129 extension source files validated.
- `npm run build` twice — passed with matching hashes above.
- `bash -n install.sh uninstall.sh` and `node --check scripts/test-options-browser.mjs` — passed.
- Focused tests passed: `node extension/tests/persona-intelligence.test.mjs`, `node extension/tests/userscripts.test.mjs`, and `node extension/tests/pcms-pagination-cardinality.test.mjs`.
- `git diff --check` passed for each Phase 08 change and across the Phase 08 implementation diff.

`npm run test:browser`, the individual Chromium-dependent browser smokes, and `npm run release:check` were not run, as required by the supplied browser policy. GitHub Actions were not run: the spec allows the final CI gate only after the Firefox and native acceptance gates pass, and those gates remain open.

The bridge compatibility follow-up (`a2bb53dc05e60a3977aa97c387e058a730c3acdf`, with recovery-guidance update `8d5ce7576747055fc67743df8f17521be3216a12`) also passed `npm test` and `npm run validate` in the follow-up verification. This continuation rebuilt the current code twice with matching hashes and reran `npm run test:repository` after updating this ledger.

### Post-acceptance lifecycle hardening — 2026-09-26

A subsequent acceptance run and source-level lifecycle review separated actual defects from scenarios that were merely unverified:

- Direct `route.test` used the protected-route cache context as its stale-result guard, so a legitimate Direct test could be rejected as `Route or protection changed during verification`. Commits `6c772704f043e3e371029709cd5b6d04081649cd`, `c086708b504df01eb74b335a7427a7bfc6c3c4d0`, and `355b8731d41e3bfbdf0633db25fcf17a9fada3c3` split the verification guard from protected health evidence and add Direct regression coverage.
- A still-locally-fresh forwarder credential could already have been retired by a timed-out/competing native operation. Commits `8ebe200a66e25f4aacd4051d79c9e8679f9285f7` and `f46baf2023751c1998a1d8f28b13d029502f7af2` retry only the explicit retired-token condition once with fresh entropy; all other native failures remain fail-closed.
- `autoStopMinutes` relied on an in-memory `lastUseAt`, which can reset when Firefox recreates the MV3 background event page. Commits `ca54d5484cd0bd696744896d3e0c2458a0bb55e9` and `19a6ecc6e7c4c1a3324466c66b29a90a9aa0b8dc` persist only the non-secret idle-start timestamp and verify idle shutdown across runtime recreation.
- A crashed/restarted daemon could leave a fresh localhost forwarder entry cached until its short TTL expired. Commits `acffd2d4c037a34211ac6a98cb5cb87aaa91adc8` and `a56c193e63692e47bd32f32005b910f8b5143d21` invalidate the Mullvad runtime cache immediately on Firefox proxy errors so the next protected request rechecks native state and prepares a fresh authenticated exit.
- Native upgrades previously backed up private configuration but were not transactional after removing the working runtime. Commits `581ef1123a49a1b3fffe57255105b0e6713e07d5` and `8f530e9e8d5956e94c138920f314dcdb3f16b207` snapshot the existing runtime, service state, native manifests, browser XPI deployment, configuration tree, tunnel state, and LibreWolf override, and restore that snapshot if a later install step fails.

Cold startup with the native service unavailable and normal browser restart recovery were reviewed separately and **removed from the defect list**. The routing gate is registered before asynchronous recovery and blackholes/cancels traffic until initialization is authoritative; Mullvad native resolution is lazy and fails protected requests closed when unavailable. Browser/background restart intentionally drops volatile route-test evidence and runtime credentials, reloads persisted Persona/route authority, and prepares a fresh authenticated exit on the next protected request. These paths may still be exercised as release evidence, but absence of an additional live reproduction is not itself a bug.

### Post-hardening repository and CI gate — 2026-09-26

GitHub Actions run 681 passed `npm run release:check` on commit `9b2411eab915b14e9adaa3f98c445aa8dfd7331f`. The gate passed repository validation, all 57 extension test files, all 63 native Python tests (one environment-dependent skip), all four browser smoke families, validation of 129 extension source files, and the production build. The browser coverage included popup responsive states; Options/automation/diagnostics at 1440, 1100, 900, 768, and 390 CSS-pixel targets; cookie/backup/recovery at desktop and mobile widths; and PCMS at desktop and mobile widths. The build produced `dist/persona-route-manager-v1.0.0.xpi` with SHA-256 `cc6213513fae0adf9866a41bfb3134e59196a54ac565a8a3827cc1895e795ace` and the companion workflow ZIP with SHA-256 `c8a85b9698b71d4e330e0909ccf8d0f9cce1ded7701028c90d949fc73e602901`.

The CI cleanup also repaired stale browser-smoke fixtures that had drifted behind production contracts: active-tab/panel ARIA assertions, state/integration preview messages, the `Persona.signal` grant fixture, data-management storage scope and atomic preview commits, a valid partitioned-cookie fixture, the paginated PCMS list contract, and additional timing headroom for recovery snapshot compression/hashing. The original selected-tab browser failure was reproduced on pre-hardening `main`, so it was not attributed to the lifecycle changes.



## Firefox checks completed on the candidate

The exact XPI above loaded temporarily in Firefox Developer Edition 157.0. The Options page rendered. Its Userscripts import review displayed `Execution world: USER_SCRIPT (injection mode: content)` for a controlled `.user.js` fixture declaring `@grant none` and `@inject-into content`; Cancel closed the review and no script was imported. The Sync recovery page showed unchecked consent and a disabled save button when local/synced consent was absent; no consent or snapshot was written. The bundled Management page reported `Connected`, Protocol v1, and Protection Active with zero managed Personas and zero workflow jobs. Options and Management reported no Firefox console errors.

These are UI/package-load checks in Firefox. The profile had no managed Persona, configured proxy route, or Firefox Sync consent. The native-status action timed out after 30 seconds. Afterward the page showed the host installed, the interface down, base SOCKS unreachable, and no configured routes, while still listing six active exit forwarders. Firefox Dev MCP later reconnected without restarting Firefox; `list_pages` showed the same three open tabs (Add-ons Manager, Options, Management).

On the final candidate, a synthetic backup preview was mapped to the existing `Agent-Test-01` container. Its exact security review listed the unmanaged default changing from Block to Direct, the synthetic persona assigned Direct routing with its kill switch disabled, and a new SOCKS route at TEST-NET-1 `192.0.2.44:1080`. The attempted portable Integration trust setting did not appear in the delta. Cancel closed the review without approval. A fresh `GET_SNAPSHOT` then confirmed zero profiles, zero managed personas, zero routes, Integration disabled with no trusted extension IDs, unmanaged policy still `block`, and the same 40 Firefox containers. The preview and synthetic backup file input were cleared.

The final candidate's Persona import UI also received a synthetic package of 33,554,433 bytes, exactly one byte over its 33,554,432-byte limit. Firefox rejected it with `Persona package is too large`, cleared the file input, and opened no import modal. A subsequent `GET_SNAPSHOT` responded with the same empty Persona/route state and unchanged Integration and unmanaged-policy settings. This verifies the UI size guard and background snapshot responsiveness; it does not measure worker peak memory, test malformed ZIP handling in this Firefox session, or exercise route traffic during those checks. No tunnel start, route creation, or public-egress probe was performed during those earlier import/package checks. The contradictory native status from that checkpoint was not egress evidence; the later route retest is recorded under F-13. The temporary add-on was not installed persistently. Firefox was not restarted or closed.

## Phase 08 implementation commits

| Commit | Change | Regression coverage |
| --- | --- | --- |
| `77a4c373969577bdba0b613917eaa288e036915f` | Keep route exit and DNS evidence separate; project native route diagnostics through a secret-safe allowlist. | `persona-intelligence.test.mjs`, `diagnostics.test.mjs` |
| `a0668744dd85ead00b5af6931de440e79d252b8e` | Require security review for SOCKS proxy-DNS to local-DNS downgrades. | `security-delta.test.mjs`, `state-manager.test.mjs` |
| `67740a0cb75b76ef4bc8596e7b2bb555bdc50b14` | Mark public-IP results unverified when strict proxy verification is disabled. | `persona-intelligence.test.mjs` |
| `6ea76ecfbfae08723adb6cbb1ef1b8a80cde3c10` | Authenticate PCMS page cursors with a per-worker HMAC key. | `pcms-pagination-cardinality.test.mjs`, `management-integration.test.mjs` |
| `cc5948763ce2009eb9166f1723da0ceaed89477d` | Show userscript execution world and injection mode in import review. | `userscripts.test.mjs`; browser-smoke case added to `scripts/test-options-browser.mjs` |
| `2ddb60739577508900758df3d4f95a2908cc2b77` | Keep recovery UI disabled unless local and synced consent both permit writes. | `recovery-sync.test.mjs`; browser-smoke coverage added to `scripts/test-data-management-browser.mjs` |
| `55690a48f24e95acae758a81c29151eecd6672a9` | Treat unknown DNS evidence as unverified, including before a route has been tested. | `persona-intelligence.test.mjs` |
| `0c8da5a32e78b3e171a700966b67549fa2145c57` | Align userscript review metadata with runtime `@inject-into content` precedence. | `userscripts.test.mjs`; Chromium smoke source covers the override |
| `4fa7890ee65f27a233ab8a151df1d9bf7650b8bc` | Add explicit stale-cursor coverage across worker boot IDs. | `pcms-pagination-cardinality.test.mjs` |
| `ba15dcc459b65d04c6f1168adf3ee95c64c86106` | Avoid claiming a route exit was verified when a DNS leak is known but no exit evidence exists. | `persona-intelligence.test.mjs` |

Independent reviews checked route-health evidence/reason combinations, userscript parser/runtime precedence, PCMS cursor authentication and restart semantics, SOCKS DNS security deltas, and recovery consent enforcement. Reviews found and prompted fixes for unknown DNS being reported as verified and a missing boot-change cursor test. The recovery UI does not live-refresh when synced consent changes in another device; its write path revalidates consent and rejects an unauthorized stale-page save. Cross-device UI freshness remains an observation, not a consent bypass.

## Finding-by-finding ledger

### F-02 — Fail-closed routing

- **Status:** Prior code fix verified for its specified cases; Phase 08 final acceptance remains open.
- **Root cause and remediation:** Phase 01 closure explains the bootstrap-order, rejected-initialization cache, and listener-failure causes and the early blackhole/cancel gate and retry behavior.
- **Commits and tests:** Exact Phase 01 commits and tests are in [Phase 01 closure](phase-01-f02-closure.md). Phase 08 route-confidence changes: `67740a0cb75b76ef4bc8596e7b2bb555bdc50b14`, `77a4c373969577bdba0b613917eaa288e036915f`, `55690a48f24e95acae758a81c29151eecd6672a9`, and `ba15dcc459b65d04c6f1168adf3ee95c64c86106`; final local coverage includes `background-routing-init.test.mjs`, `background-smoke.test.mjs`, and `persona-intelligence.test.mjs`.
- **Firefox/native/install evidence:** Phase 01 recorded controlled Firefox 157 wake and initialization-failure observations. Phase 08 loaded the candidate in Firefox, but had no managed Persona or route. Native loss, persistent initialization failure/recovery, direct-egress absence, strict mismatch, and stale-result controls were not re-run on this candidate. No supported-host native route was available.
- **Docs and compatibility:** See Phase 01 closure and [`docs/api/integration-v1.md`](../../api/integration-v1.md). The Phase 08 API clarification makes unknown DNS state explicit; no wire identifiers changed.
- **Residual uncertainty:** The full Phase 08 routing-confidentiality matrix and supported-host route-failure/recovery evidence remain outstanding.

### F-03 — State-change authority

- **Status:** Prior code fix locally and UI verified; Phase 08 crafted-import acceptance remains open.
- **Root cause and remediation:** Phase 02 closure describes authorization gaps at the state-commit boundary and the centralized exact-delta preview/commit guard.
- **Commits and tests:** Exact Phase 02 commits and regression files are in [Phase 02 closure](phase-02-f03-f11-closure.md). Phase 08 also adds SOCKS DNS downgrade review in `a0668744dd85ead00b5af6931de440e79d252b8e`; `security-delta.test.mjs` and `state-manager.test.mjs` assert unapproved changes do not persist.
- **Firefox/native/install evidence:** Phase 02 recorded a SOCKS endpoint change preview, cancellation, unchanged storage, and focus restoration. Phase 08 did not apply or cancel a crafted multi-field backup against a live state.
- **Docs and compatibility:** Phase 02 closure and [`docs/api/integration-v1.md`](../../api/integration-v1.md); Integration v1 authority boundaries remain unchanged.
- **Residual uncertainty:** The Phase 08 backup/import matrix for Direct, trusted IDs, kill switch, and endpoint edits, including stale preview and authorized apply, is unverified.

### F-04 — Silent management collection loss

- **Status:** Prior API implementation and synthetic high-cardinality tests pass; real high-cardinality Firefox backing-state acceptance remains open.
- **Root cause and remediation:** Phase 03 closure records sanitizer truncation, single-response UI consumption, and the complete secret-safe pagination/projection fix.
- **Commits and tests:** Exact Phase 03 commits and tests are in [Phase 03 closure](phase-03-f04-f16-closure.md). Phase 08 adds HMAC page-cursor validation in `6ea76ecfbfae08723adb6cbb1ef1b8a80cde3c10` and a worker-restart stale regression in `4fa7890ee65f27a233ab8a151df1d9bf7650b8bc`; tests include `pcms-pagination-cardinality.test.mjs`, `management-integration.test.mjs`, and `pcms-secret-projection.test.mjs`.
- **Firefox/native/install evidence:** Prior Phase 03 Firefox checks used synthetic in-memory facades. Phase 08 Management loaded and connected in Firefox but contained zero Personas; no item 101+ live backing-state result was exercised.
- **Docs and compatibility:** Phase 03 closure; [`docs/api/management-v1.md`](../../api/management-v1.md), [`docs/api/integration-v1.md`](../../api/integration-v1.md), and [`docs/reference/compatibility.md`](../../reference/compatibility.md). Pagination remains additive and secret-safe.
- **Residual uncertainty:** Real browser storage/service-worker behavior with more than 100 live Personas and external-client compatibility remain unverified.

### F-05 — Userscript privilege scope

- **Status:** Prior scope hardening is locally verified; Phase 08 import-world disclosure is verified in Firefox; live cookie-boundary checks remain open.
- **Root cause and remediation:** Phase 05 closure records cookie host-scope and exact-container enforcement, explicit bridge grants, and unassigned imports. Phase 08 corrected the displayed execution world to match runtime precedence.
- **Commits and tests:** Exact Phase 05 commits and tests are in [Phase 05 closure](phase-05-f05-f06-f10-closure.md). Phase 08 disclosure commits: `cc5948763ce2009eb9166f1723da0ceaed89477d` and `0c8da5a32e78b3e171a700966b67549fa2145c57`; regression `userscripts.test.mjs`.
- **Firefox/native/install evidence:** Phase 05 recorded a canceled grant review. On the Phase 08 candidate, Firefox displayed `USER_SCRIPT (injection mode: content)` for `@grant none` plus `@inject-into content`; Cancel left no imported script. No real cross-domain GM cookie denial, exact container cookie operation, FPI, or partition mutation was performed.
- **Docs and compatibility:** Phase 05 closure, [`docs/api/persona-os.md`](../../api/persona-os.md), and [`docs/api/integration-v1.md`](../../api/integration-v1.md). Runtime grant behavior is unchanged; the preview now reports it accurately.
- **Residual uncertainty:** Real Firefox grant isolation and cookie/FPI behavior remain unverified on this candidate.

### F-06 — Firefox Sync recovery lifecycle and privacy

- **Status:** Prior recovery lifecycle fix and Phase 08 consent UI fix are locally verified; cross-device Sync acceptance remains open.
- **Root cause and remediation:** Phase 05 closure records automatic writes, missing durable opt-out, stale-generation hazards, and snapshot disclosure. Phase 08 requires both local and synced consent for the UI save affordance; the storage writer rechecks both.
- **Commits and tests:** Exact Phase 05 commits and tests are in [Phase 05 closure](phase-05-f05-f06-f10-closure.md). Phase 08 UI fix: `2ddb60739577508900758df3d4f95a2908cc2b77`; regression `recovery-sync.test.mjs`.
- **Firefox/native/install evidence:** Phase 05 recorded a canceled opt-in. On the Phase 08 candidate, the isolated Firefox profile had no valid Sync consent; the checkbox was unchecked and Save disabled. No consent was written. No two-device or offline-device race was run.
- **Docs and compatibility:** Phase 05 closure and [`docs/guides/data-portability.md`](../../guides/data-portability.md). Recovery remains opt-in and reinstall-oriented.
- **Residual uncertainty:** Cross-device Sync generation races remain untested. A stale open page may display outdated consent after another device changes it, but the save path revalidates and rejects the write.

### F-07 — Native forwarder and service hardening

- **Status:** Native hardening code is in place, including daemon-owned shutdown cleanup and transactional upgrade rollback. Supported-host install/update/uninstall/service execution was not exercised end-to-end and remains unverified, but the owner has waived that evidence gate as non-blocking for v1.1.0; it is not a known unresolved code defect.
- **Root cause and remediation:** Phase 06 closure records unauthenticated local forwarders, service/file hardening gaps, and missing required native fetch policy; it describes token leases, cleanup, policy validation, and private atomic writes.
- **Commits and tests:** Exact Phase 06 commits and native tests are in [Phase 06 closure](phase-06-f07-f08-native-framing-closure.md). The remote follow-up `e135d5c6bf8028d183bfed192fea2d76a8c78457` removes the systemd `ExecStop` control-socket call and makes daemon shutdown run full `ROUTER.stop()` cleanup; it adds `test_daemon_shutdown_uses_full_router_stop_cleanup` and an `ExecStop` assertion in `test_native_service_hardening.py`. The 51-test native suite passed before that follow-up; this turn did not rerun its new test.
- **Firefox/native/install evidence:** Phase 06 records that systemd was not running and WireGuard tooling was unavailable. Phase 08 environment check again found systemd inactive and `wg` unavailable (`ip` present), so native install/update/uninstall and service lifecycle were not exercised in this scratch container. The later live Firefox retest exercised one token-authenticated forwarder and WireGuard route successfully (see F-13); it did not stop/restart the service or verify cleanup, installation, removal, unauthorized native clients, or recovery behavior.
- **Docs and compatibility:** Phase 06 closure; [`docs/development/testing.md`](../../development/testing.md) and [`docs/getting-started/installation.md`](../../getting-started/installation.md). Extension/native upgrades remain a coordinated compatibility boundary.
- **Residual uncertainty:** Real supported-host install/update/uninstall/service execution and unauthorized-client checks still require the supported Linux environment. Source review no longer treats graceful service shutdown or failed-upgrade rollback as unresolved implementation defects.

### F-08 — Distribution integrity and signature posture

- **Status:** Integrity checks are implemented; Mozilla-signed artifact provenance remains unverified. The owner has waived signing provenance as a v1.1.0 release blocker, without treating it as passed.
- **Root cause and remediation:** Phase 06 closure describes prior signature-enforcement override and absent signed-artifact provenance; local installer integrity and exact-byte digest checks are implemented.
- **Commits and tests:** Exact Phase 06 commits and `tests/test_release.py` coverage are in [Phase 06 closure](phase-06-f07-f08-native-framing-closure.md). Phase 08 `npm test` passed all native/release tests.
- **Firefox/native/install evidence:** Firefox accepted the unsigned local XPI only as a temporary add-on. No persistent signed install, Mozilla-signed XPI, independent trusted digest, or release provenance was available.
- **Docs and compatibility:** Phase 06 closure; [`docs/development/release.md`](../../development/release.md) distinguishes GitHub publication of an explicitly unsigned development artifact from persistent browser installation. Persistent installer deployment still requires Mozilla signing and trusted digest provenance.
- **Residual uncertainty:** Mozilla signature acceptance and independent digest provenance remain unresolved and must not be described as passing. By owner decision they do not block publishing v1.1.0, but an unsigned release XPI is temporary/development-only and cannot satisfy the supported persistent installer path.

### F-09 — Bounded ZIP/package processing

- **Status:** Prior bounded parser and worker implementation is locally verified; exact Phase 08 candidate package-stress acceptance remains open.
- **Root cause and remediation:** Phase 04 closure records unbounded DEFLATE accumulation and distributed package ceilings; it describes streaming runtime limits, metadata/CRC checks, worker isolation, and mutation-boundary reinspection.
- **Commits and tests:** Exact Phase 04 commits and tests are in [Phase 04 closure](phase-04-f09-closure.md). `package-inspector.test.mjs`, `zip.test.mjs`, `backup-package.test.mjs`, and full `npm test` passed.
- **Firefox/native/install evidence:** Phase 04 records a controlled oversized/malformed package Worker test on its own candidate. Phase 08 repeated the UI size-limit rejection on the final candidate with a fixture exactly one byte over the configured limit; no malformed-ZIP, worker-memory, or peak-memory claim is made.
- **Docs and compatibility:** Phase 04 closure and package documentation. ZIP64, encryption, and multi-disk ZIP remain unsupported by design.
- **Residual uncertainty:** Malformed-ZIP rejection, worker behavior under package stress, route traffic during rejection, and worker memory/RSS remain unverified in Firefox.

### F-10 — Integration API hardening

- **Status:** Prior sender, quota, event, and local-authority hardening passes deterministic tests; Phase 08 external-sender stress acceptance remains open.
- **Root cause and remediation:** Phase 05 closure records inherited descriptor lookup, unbounded sender/event work, and caller-supplied confirmation confusion; it describes own-property lookup, quotas, disconnect cleanup, and service-enforced local authority.
- **Commits and tests:** Exact Phase 05 commits and tests are in [Phase 05 closure](phase-05-f05-f06-f10-closure.md). `management-integration.test.mjs`, `integration-contract-parity.test.mjs`, and `integration-lifecycle.test.mjs` passed in full `npm test`.
- **Firefox/native/install evidence:** Phase 05 recorded the authority settings view. Phase 08 bundled Management loaded and connected without console errors; no external-extension sender flood or multi-sender Firefox event stress was run.
- **Docs and compatibility:** Phase 05 closure and [`docs/api/integration-v1.md`](../../api/integration-v1.md). Integration wire version remains 1.
- **Residual uncertainty:** Real external sender concurrency and subscriber disconnect/reconnect behavior remain to be exercised in Firefox.

### F-11 — Imported authority and state preservation

- **Status:** Prior commit-boundary protections pass local tests; Phase 08 verifies crafted-backup review/cancel on the final candidate, while stale-preview acceptance remains open.
- **Root cause and remediation:** Phase 02 closure records imported Integration authority, recovery defaults, and other state writers bypassing review; it describes normalized exact-delta checks and safe import/recovery policy.
- **Commits and tests:** Exact Phase 02 commits and tests are in [Phase 02 closure](phase-02-f03-f11-closure.md). `backup-import.test.mjs`, `state-manager.test.mjs`, `state-integrity.test.mjs`, and recovery tests passed in `npm test`.
- **Firefox/native/install evidence:** Phase 02 records UI cancellation and route-state preservation. Phase 08 inspected a synthetic crafted backup on the final candidate, reviewed its exact security delta, confirmed portable Integration trust was omitted, canceled before approval, and verified state remained unchanged. No backup was applied.
- **Docs and compatibility:** Phase 02 closure, [`docs/api/integration-v1.md`](../../api/integration-v1.md), and [`docs/guides/data-portability.md`](../../guides/data-portability.md). Imports retain the destination's authority policy.
- **Residual uncertainty:** Final-candidate stale-preview conflict handling and an authorized reviewed apply remain open.

### F-12 — Workflow timeout parity

- **Status:** Fixed and locally verified for schema, editors, validation, and runtime timer selection; no real long-running Firefox wait was run.
- **Root cause and remediation:** Phase 07 closure records divergent timeout bounds and the shared inclusive 60-minute maximum.
- **Commits and tests:** Exact Phase 07 commits and boundary/timer tests are in [Phase 07 closure](phase-07-f12-f14-f15-f16-focus-closure.md). `workflow-model.test.mjs`, `workflow-package-schema.test.mjs`, `integration-contract-parity.test.mjs`, and full `npm test` passed.
- **Firefox/native/install evidence:** Phase 08 Management loaded but no workflow was run in Firefox. Accelerated timer tests are not a 60-minute browser wait.
- **Docs and compatibility:** Phase 07 closure and workflow/API docs; max remains 3,600,000 ms inclusive.
- **Residual uncertainty:** Real Firefox workflow timeout and lifecycle behavior remain unverified.

### F-13 — Real Firefox routing/runtime acceptance (per supplied mapping)

- **Status:** Core current-source routing/recovery acceptance passed for the exercised scenarios. Real event-page suspend/wake and supported-host lifecycle evidence remain unverified, but the owner has waived those evidence gaps as non-blocking for v1.1.0.
- **Root cause and remediation:** The supplied mapping identifies the required acceptance area but does not include the original root-cause narrative. Phase 08 review found concrete route-health false positives: generic public IP alone was treated as selected-route proof when strict verification was disabled; `dns.leaking: null` and an untested route were presented as DNS-clean; one DNS-leak reason claimed a verified exit without exit evidence. Phase 08 now separates exit/DNS evidence, requires explicit clean DNS evidence, and qualifies the route reason.
- **Commits and tests:** `77a4c373969577bdba0b613917eaa288e036915f`, `67740a0cb75b76ef4bc8596e7b2bb555bdc50b14`, `55690a48f24e95acae758a81c29151eecd6672a9`, `ba15dcc459b65d04c6f1168adf3ee95c64c86106`, and compatibility gate `a2bb53dc05e60a3977aa97c387e058a730c3acdf`; `persona-intelligence.test.mjs`, `diagnostics.test.mjs`, `mullvad-runtime.test.mjs`, and `background-smoke.test.mjs` passed. The follow-up full `npm test` and validation passed before the later e135d5 native-service change. Independent review checked evidence/reason combinations and prompted the final no-exit wording correction.
- **Firefox/native/install evidence:** Earlier Phase 08 diagnosis used the same Firefox Developer Edition session and managed `Agent-Test-01` (`firefox-container-106`), assigned to the saved Albania/Tirana Mullvad route with kill switch enabled. The old native host reported `0.2.0`; route verification and a normal `example.com` navigation failed, which led to the fail-closed version gate. On 2026-09-25, the later live retest confirmed the host now reports installed and compatible version `0.3.0`. Before the test, a fresh status request found the interface down, base SOCKS unreachable, and zero active exits, although the page's cached badge still said ready. The route's configured `autoStart` was true and `autoStopMinutes` was 15; the observed pre-test state is consistent with the idle auto-stop setting. The `TEST_PROFILE` action passed for `Agent-Test-01`: Mullvad exit verification returned `mullvad_exit_ip: true` for Tirana, Albania, and the DNS check completed with `leaking: false` (one unique resolver observation). The visible Options Test button then displayed `Route OK: Tirana · Albania`. A fresh native status confirmed ready, interface up, base route bound, base SOCKS reachable, one active exit, entry `pl-waw-wg-101`, and a recent handshake. In that same container, ordinary navigation to `https://example.com/` loaded, then ordinary navigation to `https://ipv4.am.i.mullvad.net/json` reported a Mullvad exit in Tirana, Albania via SOCKS over WireGuard. The temporary test tab was closed; Firefox remained open with its original four tabs, and the Persona, route assignment, and kill switch were left unchanged. This verifies one protected routing and egress scenario, not the full acceptance matrix.
- **Docs and compatibility:** [`docs/api/integration-v1.md`](../../api/integration-v1.md) now documents that `healthy` requires exit plus explicit clean DNS evidence, and that `health.dns: false` is not alone proof of a leak. No wire names changed.
- **Residual uncertainty:** The standalone follow-up acceptance expanded this evidence to protected and Direct traffic, route/native loss with no observed Direct leak, same-configuration recovery, stale-result rejection, and warm bridge restart recovery. The two concrete runtime defects discovered there (Direct Test Route and retired-token retry) are fixed in current source. Cold native-down startup and ordinary browser restart recovery are not retained as open bugs after source review and practical use found the expected behavior. Real Firefox event-page suspend/wake on the current source and supported-host native lifecycle execution remain unverified evidence gaps; the owner has accepted them as non-blocking for v1.1.0. The supplied mapping does not contain F-13's original detailed root-cause narrative.


### Targeted recovery retest — 2026-09-26

- **Candidate:** Source `f7b491beb05ae82a178a11789b6a4ebddb30fb8a`; the local candidate XPI still hashes to `cc6213513fae0adf9866a41bfb3134e59196a54ac565a8a3827cc1895e795ace`. Firefox Developer Edition `157.0` reported active `persona-route-manager@local` v`1.0.0`; native bridge `0.3.0`. No rebuild, reinstall, source edit, or native bridge change was made. The temporary XPI source path was no longer present on disk, so the loaded archive could not be independently re-hashed in this turn.
- **Entry comparison:** Native status initially showed `pl-waw-wg-101` ready. The available list contained 537 entry configs. From Down, `pl-waw-wg-101`, `al-tia-wg-001`, and geographically distant `au-syd-wg-001` each started successfully once. Independent status after each showed interface up, base route bound, base SOCKS reachable, and handshake age 0–1 seconds. The original Poland entry was restored.
- **Protected baseline and Direct control:** A new one-hour disposable Persona, `Recovery-Recheck-2026-09-26`, used the existing route `mullvad-1167530f` (Albania/Tirana). Its visible Verify Route passed with `mullvad_exit_ip: true`, Albania/Tirana, and DNS `leaking: false`; a fresh ordinary navigation returned the same result. The same Persona was switched to explicit Direct after the security review listed only that route change. Verify Route and a fresh navigation returned `mullvad_exit_ip: false`, Poland/Gdansk. `Personal` remained Direct and unchanged.
- **Direct → protected:** The same Persona was switched back to the same saved route ID, without route recreation. The earlier “interface up but Mullvad SOCKS is not reachable yet” failure did not reproduce. Verify Route passed with clean DNS, and a fresh navigation returned a Mullvad exit in Albania/Tirana.
- **Fresh request after native loss:** With the protected route still assigned, the Firefox Disconnect control produced an independently confirmed Down state: interface, base route, and base SOCKS were unavailable, with zero active exits. A unique-query top-level navigation in the same test container then returned a Mullvad Albania/Tirana result, not a Direct/Poland response. The following independent status showed the bridge Ready again and one active exit. Because auto-start remained enabled, this is consistent with request-triggered recovery; the request completed over protected egress rather than remaining blocked. No direct escape was observed.
- **Explicit restart and same-configuration recovery:** The Firefox Restart tunnel action completed asynchronously with `ok: true` and `ready: true`. A separate `MULLVAD_STATUS` read confirmed version `0.3.0`, interface up, base route bound, base SOCKS reachable, and `pl-waw-wg-101` selected. Without editing the route or recreating the Persona, another fresh navigation returned `mullvad_exit_ip: true` for Albania/Tirana; Verify Route again passed with DNS `leaking: false`.
- **Host/native evidence:** `/usr/local/bin/persona-mullvad-router status` exited 0 and agreed on Ready, base-route binding, base-SOCKS reachability, and the selected Poland entry. `ip route get 10.64.0.1` used `prm-mv`; `ip link` showed `prm-mv` UP; the service was active. Native status exposed a recent handshake age (0–1 seconds after entry starts; 73 seconds in the later host sample while route tests still passed). `wg show prm-mv latest-handshakes` was denied with `Operation not permitted`. All public IPs are redacted.
- **Cleanup and interpretation:** The disposable Persona and its remaining tab were removed; only its test-created exit forwarder was released. The saved Albania/Tirana route, `Agent-Test-01`, and all real Personas were preserved. `Personal` stayed Direct; auto-start stayed enabled and auto-stop stayed at 15 minutes. Firefox remained open. The bridge returned to its initial Ready state on `pl-waw-wg-101`, with zero active exits. All three entries that failed in the prior attempt now work, so a generic WireGuard startup defect was not reproduced. The earlier outage is consistent with a transient Mullvad/account/service condition, but this run cannot establish its cause.
- **Outcome:** **PASS — recovery confirmed** for this targeted scenario. The same protected Persona and route recovered after both native Down and an explicit Firefox restart, with protected egress verified. A subsequent owner release decision accepts the remaining suspend/wake, supported-host lifecycle, and signing evidence gaps as non-blocking for v1.1.0; those gaps remain unverified rather than passed.

### F-14 — CI and repository hygiene

- **Status:** Repository checks and the post-hardening GitHub Actions release gate pass.
- **Root cause and remediation:** Phase 07 closure records mutable tool pins and repository hygiene gaps and the pinned action/toolchain and validator changes. The final browser gate also exposed stale smoke fixtures that no longer matched current production contracts; those fixtures were reconciled without weakening product behavior.
- **Commits and tests:** Exact Phase 07 commits are in [Phase 07 closure](phase-07-f12-f14-f15-f16-focus-closure.md). GitHub Actions run 681 on `9b2411eab915b14e9adaa3f98c445aa8dfd7331f` passed `npm run release:check`: repository checks, 57 extension suites, 63 native tests (one skip), popup/Options/data-management/PCMS browser smokes, validation, and build.
- **Firefox/native/install evidence:** Not applicable to static CI configuration. The browser smokes are Chromium-based CI evidence and do not replace the separate real-Firefox acceptance evidence recorded above.
- **Docs and compatibility:** Phase 07 closure. No runtime wire or persisted-state compatibility changed by the CI-fixture reconciliation.
- **Residual uncertainty:** None for the repository/CI gate itself. The remaining Firefox/native/signing evidence gaps are retained as unverified but owner-waived for v1.1.0.

### F-15 — Documentation reconciliation

- **Status:** Prior Phase 07 docs are in place; Phase 08 ledger and route-health contract clarification are added by this record.
- **Root cause and remediation:** Phase 07 closure records API and behavior documentation gaps and its reconciliation.
- **Commits and tests:** Exact Phase 07 documentation commit is in [Phase 07 closure](phase-07-f12-f14-f15-f16-focus-closure.md). The Phase 08 documentation commit adds this finding ledger and updates [`docs/api/integration-v1.md`](../../api/integration-v1.md); `npm run test:repository` is the documentation/link gate.
- **Firefox/native/install evidence:** Docs do not replace runtime acceptance; evidence is listed separately above.
- **Compatibility impact:** The Integration API clarifies existing health fields without renaming commands, wire fields, or persisted formats.
- **Residual uncertainty:** Release documentation now records the owner decision that signing provenance and the two remaining environment-specific acceptance exercises are non-blocking for v1.1.0. This does not convert those checks into passes.

### F-16 — Composite API, lifecycle, framing, and event observations

- **Status:** Phase 01/03/06/07 code remediations, Phase 08 cursor authentication, and the post-acceptance lifecycle fixes are implemented; remaining timing/lifecycle items are primarily real-environment acceptance.
- **Root cause and remediation:** The prior records separately describe route-listener ordering, batch and operation correlation, native frame desynchronization, and remaining compatibility observations. Phase 08 signs pagination state to reject tampered cursor fields and stale snapshots.
- **Commits and tests:** Exact prior commit tables are in [Phase 01](phase-01-f02-closure.md), [Phase 03](phase-03-f04-f16-closure.md), [Phase 06](phase-06-f07-f08-native-framing-closure.md), and [Phase 07](phase-07-f12-f14-f15-f16-focus-closure.md). Phase 08 cursor commits: `6ea76ecfbfae08723adb6cbb1ef1b8a80cde3c10` and `4fa7890ee65f27a233ab8a151df1d9bf7650b8bc`. `pcms-pagination-cardinality.test.mjs`, `pcms-replay.test.mjs`, `persona-event-races.test.mjs`, and native framing tests passed in `npm test`.
- **Firefox/native/install evidence:** Final candidate Management loaded; no high-cardinality storage, suspend/wake, container rotation, external retry, or event-subscriber reconnect was exercised in Firefox. Native framing remains unit-tested; no real Firefox native-messaging session was used.
- **Docs and compatibility:** The prior phase records and their API/compatibility documents describe additive pagination and bounded replay. Cursor authentication does not change PCMS v1 request names; a prior-boot cursor returns the existing stale-page error.
- **Residual uncertainty:** Real Firefox event-page suspend/wake, rotation/event ordering, duplicate-effect prevention, and subscriber reconnect acceptance remain useful additional evidence. The source review found and fixed the suspend-related idle-timer persistence bug and did not find a fail-open wake path. For v1.1.0, the owner has waived real event-page suspend/wake as a release blocker; the other residual timing observations are not known open code defects.

## Release decision and remaining gates

**Owner release decision — 2026-09-26:** v1.1.0 is accepted for release preparation from the current hardened source. Known code defects identified by the audit/remediation work are addressed, the repository/CI release gate passes, and targeted current-source Firefox routing/recovery acceptance passes.

The following evidence remains intentionally **unverified and owner-waived as non-blocking for v1.1.0**:

- real Firefox MV3 event-page suspend/wake acceptance;
- destructive supported-host native install/update/uninstall/service lifecycle acceptance;
- Mozilla-signed artifact provenance with an independently authenticated digest.

This waiver does not assert that those checks passed. Release notes must preserve that distinction. In particular, the repository-built XPI is unsigned and may be published only as an explicitly labelled temporary/development artifact; the supported persistent installer path continues to require a genuinely Mozilla-signed XPI and trusted SHA-256 provenance.

Phase 08 is therefore **accepted for v1.1.0 release preparation by owner decision**.
