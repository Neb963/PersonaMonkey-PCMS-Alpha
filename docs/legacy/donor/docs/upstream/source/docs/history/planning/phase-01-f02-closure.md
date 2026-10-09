# Phase 01 — F-02 fail-closed routing closure

Date: 2026-09-24. Audit baseline: `main` at `e33272a7d4ff49623d613d11fbb65da806d7f869`. Scope is F-02 and the routing portions of F-13/F-16; this record does not close the remaining findings.

## Status and cause

**F-02: fixed and verified for the specified initialization, wake, route-loss, and retry paths.** Previously, routing listeners were registered after asynchronous bootstrap, a rejected initialization promise stayed cached, and an exception from a blocking listener could let Firefox choose fallback behavior. A blackhole proxy alone could not establish the confidentiality property.

The static routing gate registers `proxy.onRequest` and blocking `webRequest.onBeforeRequest` before recovery awaits. Until the full handlers are ready, or if either handler rejects, the proxy gate returns a blackhole result and the request gate cancels the request. Registration is idempotent. Bootstrap and background initialization share each in-flight attempt and clear rejected attempts for a later request. Diagnostics use bounded reason codes without request URLs or exception text.

Recovery rejects missing or malformed local authority. If existing Firefox containers cannot be restored from Sync, it persists an unmanaged `block` quarantine rather than deriving Direct authority from defaults. It preserves the previous Sync snapshot while quarantined. A failed recovered-state write keeps the gate closed and permits retry.

## Commits on `phase-01-fail-closed-routing`

| Commit | Change |
| --- | --- |
| `050fc6969ea6ca7d2d8bd5299f7017db8737a7c6` | Register routing gate before recovery. |
| `5ffb525db33d7391a5125fae6e329f15d0073b97` | Retry initialization and contain listener failures. |
| `b84c15d162b31c95e2c76b3600fa7e760b32bf70` | Add startup, failure, and recovery regression tests. |
| `f2174919630bd53ffd36362133a449548048d576` | Quarantine lost routing state and retry bootstrap. |
| `91f835249fe6f828a28329a0d2cd5b3ff8eaf69c` | Cover bootstrap retry and state-loss quarantine. |
| `0e69faaf6201bb22b5fe096903dbb238a4d50d8c` | Document the startup guard and recovery quarantine. |

## Local verification

`extension/tests/background-routing-init.test.mjs` covers registration before the first recovery read, one-shot and persistent storage failures, concurrent initialization, retry without duplicate listeners, Direct authority, unmanaged block, missing or disabled routes, strict proxy mismatch, bounded diagnostics, failed recovery write, and missing/corrupt/malformed state quarantine. The test asserts both the proxy result and `{cancel:true}` during guard failures, rather than relying on port 9 alone.

Passed locally: all 51 extension test files (`npm run test:extension`), 22 native tests (`npm run test:native`), `npm run test:repository`, `npm run validate` (116 extension source files), and `npm run build`. The final candidate XPI SHA-256 is `c99ca147fbf3e9ae0006a93a067f10b026ada4b2b2b69b2f0093aeef39df8538`. Chromium-only browser scripts and the aggregate `release:check` were not run under the phase's browser policy. No GitHub Actions run was dispatched.

## Firefox 157 evidence

Installed the candidate XPI as a temporary extension with ID `persona-route-manager@local`. The selected managed tab was `firefox-container-1`; tests used the external `https://am.i.mullvad.net/json` endpoint with distinct `phase01` query labels. The unmodified candidate returned HTTP 200 with `mullvad_exit_ip:true` and `SOCKS through WireGuard` for `final-routed`.

| Scenario | Observation |
| --- | --- |
| Native route unavailable | Temporarily set the existing Mullvad native setting `enabled:false`. The managed `final-native-unavailable` navigation produced no HTTP response; the prior page remained. Extension status recorded `mullvad-local-service-unavailable` for `firefox-container-1`. Restored the original `enabled:true` value; `final-native-restored` returned HTTP 200 through Mullvad. |
| Background suspension and wake | Forced `terminateBackground` and confirmed `stopped` with the managed tab selected. The immediate `final-managed-wake-first` navigation produced no HTTP response and kept the prior page; the background then reported `running`. The next `final-managed-wake-ready` navigation returned HTTP 200, `mullvad_exit_ip:true`, `SOCKS through WireGuard` in the same managed tab. |
| Controlled initialization failure | Installed a temporary **test-only** XPI made from the candidate by adding a single conditional throw before `stateManager.initialize()`, gated by a `phase01TestFault` local-storage flag. Its SHA-256 was `f29f3613cbfe7bfe14f44e91ede6a8cecfff926a03ea974a3e20f7a789452a12`. With the flag true, the managed `controlled-init-fault` navigation produced no HTTP response and kept the prior page. After removing the flag, `controlled-init-recovered` returned HTTP 200 through Mullvad; the privileged Firefox background-context object was identical before and after, so no extension reload was needed. The test flag was removed and the **unchanged** candidate XPI reinstalled. `final-restored-candidate` again returned HTTP 200 through Mullvad. |

The network observations establish absence of a successful direct response at the controlled endpoint; they do not constitute packet-level proof of every possible egress path. The local tests assert the explicit cancellation decision that makes the blackhole proxy a secondary mechanism.

## Compatibility and remaining boundary

Explicit Direct Personas retain Direct routing after valid state loads. Existing Firefox containers with lost local state and no recoverable Sync snapshot are conservatively blocked until state is restored or the user reassigns them. An empty fresh install still receives the existing default-container behavior; no known managed Persona exists in that case.

If the Sync metadata read itself fails, the current recovery reader treats it as an unavailable snapshot. Existing containers are safely quarantined, but Sync restoration is not automatically retried after quarantine completes. A prior portable backup can be imported manually. Automatic Sync retry and packet-level capture remain open for later recovery-hardening work; neither limitation authorizes Direct for a known container.
