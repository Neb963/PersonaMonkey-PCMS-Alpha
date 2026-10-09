# P028 — Background-authoritative PCMS Core and UI client protocol

Implementation scope: T028.1–T028.3 under CLM-P028-001, **epoch 2**. The operator reassigned the claim from
`gpt-5-6-sol` (epoch 1, no work pushed) on 2026-10-07. An epoch-1 branch cannot merge.

## What changed

| Area | Files |
|---|---|
| Background entry (T028.1) | `extension/pcms/background/entry.js` is imported statically by `extension/lib/recovery-bootstrap.js` directly after the routing gate. It has **no static imports**, so a PCMS link failure can never take down PersonaMonkey's fail-closed graph. During evaluation it registers `runtime.onMessage` (answers only `PCMS_UI_REQUEST`), `alarms.onAlarm` (`pcms.*` only), `runtime.onStartup` and `runtime.onInstalled`. Listeners only enqueue work. |
| Idempotent Core (T028.1) | `extension/pcms/background/core-host.js` — `ensurePcmsCore()` returns one promise per background context, awaits PersonaMonkey's `bootstrap()` first and reports `UNAVAILABLE` (`personamonkey-bootstrap-failed`) without constructing Core when it fails. A later wake retries. |
| In-process broker endpoint (T028.1) | `extension/lib/pcms-internal-broker-endpoint.js` (`pcms.persona-broker.internal-endpoint/v1`). `background.js` registers `managementIntegration.handleInternalRequest` / `attachInternalPort` behind `initialize()`. Requests and responses are structured-cloned and failures are sanitized, matching the `runtime.sendMessage` path, which is retained for migration. |
| Wake recovery (T028.2) | `recoverPcmsWarmWake` in `integration/live-core.js`. Absent `storage.session` marker = cold start (P026 recovery unchanged). Present = warm wake: only `DISPATCHING` operations become `UNCERTAIN` under `RECOVERY_HOLD`. `PREPARED`/`RETRYABLE`/`UNCERTAIN` keep their per-target rules. |
| HumanTask handoff (T028.2) | `integration/provider-handoff.js` replaces the in-memory `<dialog>` (`app/operator-bridge.js` deleted). Dispatch records a durable handoff and a `provider.confirm-apply` HumanTask; the outcome is unknown, so ProviderGate records `UNCERTAIN`. The answer (`APPLIED` / `NOT_APPLIED` / `UNKNOWN`) is recorded on the task and submitted through the existing reconcile path. `UNKNOWN` opens a fresh task. Nothing is replayed. |
| UI client protocol (T028.3) | `integration/ui-client-contract.js` (`pcms.ui-client/v1`), `background/ui-dispatcher.js`, `app/ui-client.js`, `platform/firefox-ui-client-transport.js`. Exact-key envelope schema, `/pcms/` sender rule, an allow-list of Core service methods, read-only Broker proxy (`persona.list`, `system.status`), durable idempotency receipts (`core.ui-receipts`, 7-day retention, large results not retained, interrupted commands reported unknown and never re-run). Revision signal `storage.session pcms.ui.revision {seq,topics}` and non-secret summary `pcms.status.v1`. |
| Dashboard as client (T028.3) | `app/live-runtime.js` now builds a UI client facade that mirrors the service methods the accepted P021/P026 views call. The P026 DOM IDs and controls are unchanged. Projections refresh on the revision signal. |

## Scope notes

- No timers (P029): `alarms.onAlarm` is registered and filters `pcms.*`, but no PCMS alarm is created yet.
- The claim's write paths were extended (plan ownership updated to match) so required CI can run the P028 evidence:
  `package.json`, `.github/workflows/firefox.yml`, `tools/firefox/packaged.mjs`, and the upstream
  `extension/tests/background-routing-init.test.mjs`. That upstream regression assumed PersonaMonkey's listener is the only
  `runtime.onMessage` listener. ADR-002 places the PCMS listener first, so the test now also asserts that order (after the
  routing guards, before the first storage read) and drives PersonaMonkey's listener explicitly. All 9 scenarios pass. Derivative
  bookkeeping follows P025/P026: frozen copies under `docs/upstream/source/`, overrides recorded in the import manifest.
- No new IndexedDB migration. The new namespaces `integration.live-provider-handoff` and `core.ui-receipts` are rows in the
  existing v1 record store.

## Acceptance mapping

| Gate | Evidence |
|---|---|
| **A028-01** | `tests/pcms/p028/boundary.test.mjs` (static import graph of the dashboard reaches no Core module or constructor; entry has no static imports, follows the routing gate and starts no work before bootstrap; synchronous listener registration; PersonaMonkey messages are ignored), `endpoint.test.mjs` (readiness, cloning, sanitized errors, Integration-v1 parity for envelopes, errors and bootId/revision preconditions, event subscription), `host.test.mjs` (one Core for any number of tabs and requests; bootstrap failure → `UNAVAILABLE`). FDE: packaged run checks `constructedCores === 1` across two dashboards. |
| **A028-02** | `recovery.test.mjs` (cold/warm classification table; existing hold preserved; FAULT unload at the dispatch boundary and at every RemoteOperation step), `host.test.mjs` (real Core over a shared durable store: cold → warm → restart; assisted deploy handed off, every tab closed, page unloaded, answered from a new tab in a new context, `UNKNOWN` re-asks, `APPLIED` reconciles, dispatch opened exactly once). PKG: warm wake with zero PCMS dashboards stays `NORMAL`; restart is `COLD`. |
| **A028-03** | `ui-protocol.test.mjs` (schema and sender rejection before any Core work, idempotent replay, idempotency conflict, concurrent duplicates from two tabs share one execution, interrupted command reported unknown, receipt retention and pruning, facade retries transport loss with the same key), `host.test.mjs` (revision signal topics and non-secret status). FDE/PKG: second-tab command refreshes the first tab through the revision signal; popup-page sender rejected; Core starts after a wake with no dashboard open. |

## Verification

Local: P028 **29/29**, P026 **15/15**, upstream integrity **3/3**, upstream baseline rerun **passed** (frozen XPI digest
unchanged), Firefox contract tests **5/5**, `background-routing-init` **9/9 scenarios**. The full `tests/pcms` suite has
the same three failures as `main` at `cfa0d07` (two P023 and one P025 static assertion that P026 already superseded;
none of them runs in required CI).
The packaged run cannot execute in this development container because the Mozilla archive download is blocked (HTTP 403),
so FDE/PKG evidence comes from the required `firefox-developer-edition` workflow on the PR. No live provider, Mullvad,
account secrets, operator profiles or routing inputs are used.

## Independent CI checkpoint

CI_VERIFIED on head `26335aebd7355f73bad5b8662133689f98b4756f` (PR #37):

- `verify` run [37681163018](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37681163018): success.
- `firefox-developer-edition` run [37681162986](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37681162986),
  job `pinned-firefox`: success, including "Verify P028 background Core, wake recovery and UI client protocol" and the
  packaged XPI run with the P028 checks (one Core across two dashboards, revision signal, sender rejection, warm wake,
  cold restart).

This commit only records evidence; CI on it re-confirms the same tree.

## Final PR verification and merge

Final head `dac1e5bdd8983c02e02a90483f8b05e0af8579ee` passed both independent workflows on
[PR #37](https://github.com/Neb963/persona-monkey-pcms/pull/37): `verify` job `repository` and
`firefox-developer-edition` job `pinned-firefox` (run
[37681791262](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37681791262)). The PR was mergeable against
claimed base `cfa0d07d80cae66072bae3dc693615d6d48eea73` (main had not moved) and was merged at the operator's request as
`401fa524225b35c45eaf239112974c27492d3bbc`.

## Merged-main verification and acceptance

Exact merged-main commit `401fa524225b35c45eaf239112974c27492d3bbc` passed:

- [verify 37682185657](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37682185657);
- [firefox-developer-edition 37682185713](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37682185713),
  job **113000770442**, including "Verify P028 background Core, wake recovery and UI client protocol" and the packaged
  XPI run with the P028 checks.

**A028-01 PASS · A028-02 PASS · A028-03 PASS.** Phase P028 and claim CLM-P028-001, epoch 2, are **ACCEPTED** at the
operator's instruction. P029, P030 and P032 become READY through their accepted dependency.
