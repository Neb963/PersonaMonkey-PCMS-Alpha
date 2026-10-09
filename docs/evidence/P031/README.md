# P031 — Runtime module lifecycle live in production

Implementation scope: T031.1–T031.3 under CLM-P031-001, **epoch 1**, base `0d81b897ca83835d06304be7848f8865f7b92328`
(P029 and P030 accepted), updated to main `6198d81` (P034 accepted) before review.

## What changed

| Area | Files |
|---|---|
| Module supervisor (T031.1, A031-01/03) | `extension/pcms/background/modules/supervisor.js` runs install, approve, reject, update, disable, enable, rollback, remove and purge live in the background Core over the accepted P008/P011/P022 registry, lifecycle and runtime. A new authority opens an approval Attention task; unchanged authority applies directly. Modules activate lazily (ADR-003 §3) before work addressed to them: a UI `modules.call` or a due schedule. A failed activation records bounded backoff (1 → 30 minutes) and one HIGH Attention task per failure episode, resolved on recovery. |
| Module schedules (T031.1, A031-02) | `schedules.js` maps a module schedule `name` onto the Core timer `module.<id>/<name>`, delivered by the service `module.<id>.scheduler` (owner `module.<id>`, generation 0). Every Core context registers the schedulers of admitted modules before its first due pass. A declaration made inside `onTimer`, while the timer is DISPATCHING, is stored durably and applied when the occurrence completes (`pcms.timers.ensure/v1` is only read). An interrupted, overdue or failed occurrence is caught up once, after backoff if delivery failed, and never without a supported runtime. |
| Capability set v1 (T031.2, A031-02) | `capabilities.js` (`pcms.module-capabilities/v1`): module storage (own namespace `module.<id>.data`, CAS, key ≤ 256 B, value ≤ 32 KiB, ≤ 4096 keys), timers (≤ 32, 1 minute to 7 days), Attention (own `module:<id>/…` tasks, ≤ 200 open), audit (subject `module/<id>`, ≤ 4 KiB, secret-named keys redacted), read projections (accounts, generators; ≤ 100 per page; no `personaUid`, sources or secrets) and `provider.perchance.generator.update` through the Account-bound ProviderGate as the module-scoped RemoteOperation `module.<id>.<operationKey>`. Mutations stop during recovery hold. Every mutation re-checks the generation, so a fenced generation cannot write, schedule or dispatch. |
| Background host binding | `host.js` frames controllers in the real background document through the P030 frame factory and detects the browser floor; without a document the module runtime reports `UNAVAILABLE` and Core keeps working. `core-factory.js` and `live-core.js` wire the supervisor, handlers and timer hooks; `registry.js` gains `listModules`, `module-runtime.js` gains `isRunning`/`listRunning`. |
| UI client (`pcms.ui-client/v1`) | `modules.list`/`modules.get` queries; `modules.install` (archive text), `approve`, `reject`, `disable`, `enable`, `rollback`, `remove`, `purge` and `call` commands. |
| Fixture | `tests/fixtures/modules/counter.mjs` builds the `fixture.counter` archive at run time (random nonce); it is never in the XPI. |
| CI | `firefox.yml` runs `test:p031` in `pinned-firefox` and `firefox:packaged:p031` in its own `p031-packaged` job, uploading `firefox-packaged-p031`. The claim took the `ci-workflows` resource after P034 released it. |

## Acceptance mapping

| Gate | Evidence |
|---|---|
| **A031-01** | `lifecycle.test.mjs` (archive installs, awaits approval, runs in one background frame; dashboard drives it only through UI client commands; unsupported Firefox reports `UNAVAILABLE` and Core keeps working; reject admits nothing), `boundary.test.mjs`. PKG: `runtimeArchiveInstalledApprovedAndRunningInBackgroundFrame`. |
| **A031-02** | `schedules.test.mjs` (fires with no UI; lazy rehydration after unload; interrupted occurrence delivered once; restart days later catches up once; failing activation backs off, raises Attention and recovers; no catch-up loop without a runtime; disable stops schedules), `capabilities.test.mjs` (ungranted denied; storage scoping, CAS and bounds; recovery hold; timer/Attention/audit bounds; secret redaction with no secret in any durable row; bounded secret-free projections; provider via ProviderGate, fenced generation cannot dispatch). PKG: `onlyApprovedCapabilitiesNoAmbientAuthority`, `scheduleRunsWithZeroTabsAfterEventPageUnload`, `profileRestartLazyRehydrationAndZeroTabSchedule`. |
| **A031-03** | `lifecycle.test.mjs` (update is a new generation with the old frame removed and its writes stopped; new authority waits for approval while the current version runs; disable/enable/rollback/remove/reinstall/purge live; a fenced generation's context fails `STALE_GENERATION` for writes). PKG: `updateNewGenerationWithoutReloadOldGenerationFenced`, `disableEnableLive`, `rollbackRemovePurgeLive`. |

## Verification

Local: P031 **27/27**; P028 29/29 and P030 19/19 unchanged; `verify:repo`, `verify:views` and `verify:claims` pass. The full
Node suite has the same three failures as `main` (two P023 and one P025 static assertions already superseded; none runs in
required CI). The packaged run cannot execute in this container (Mozilla archive blocked), so FDE/PKG evidence comes from
required CI. No live provider, Mullvad, secrets, operator profiles or routing inputs are used.

## Independent CI checkpoint

CI_VERIFIED on head `ba4f83dc89de9d1dc0163829c94d0048abb7e979` ([PR #51](https://github.com/Neb963/persona-monkey-pcms/pull/51),
tested merge commit `22ece519a53c9fce37c0c7603a6e9cc9013fcbad`):

- `verify` run [37712220816](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37712220816), job `repository`: success.
- `firefox-developer-edition` run [37712220827](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37712220827):
  `pinned-firefox` (including `test:p031`), `p031-packaged` (job 113100499053), `p032-packaged` and `p034-packaged` all
  success; artifact `firefox-packaged-p031` (id 11522670587).

Packaged report (Firefox `154.0b10`, product XPI sha256 `adbdaf26cbaeb979c424dcafd2de41e10a564304673d2f5fc036f6b604c4cfdc`):
all seven checks true. The module ran its first tick at `01:19:26.554Z` with the event page suspended by the Firefox test hook
and no PCMS tab, before the tab was reopened at `01:19:29.393Z`; the update moved generation 2 → 3 and the v1 beat stayed
frozen at 2; after the profile restart the module was `READY` and not running, and its tick ran with zero tabs at
`01:20:32.248Z`; purge deleted 2 data keys. The verbatim report is [`packaged-report.json`](packaged-report.json).

This commit only records evidence; CI on it re-confirms the same tree. Acceptance follows merged-main CI.

## Final PR verification and merge

Final head `e78924bab1b97cb8922619850baf5cb0520bad62` passed both independent workflows on
[PR #51](https://github.com/Neb963/persona-monkey-pcms/pull/51): `verify` run
[37712620249](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37712620249) and `firefox-developer-edition` run
[37712620293](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37712620293). The PR was merged at the operator's
instruction as `370131a9c337cd9f5272f6f8e4c6b732ed1992ff`.

## Merged-main verification and acceptance

Exact merged-main commit `370131a9c337cd9f5272f6f8e4c6b732ed1992ff` passed:

- [verify 37712978593](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37712978593);
- [firefox-developer-edition 37712978574](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37712978574):
  `pinned-firefox` (including `test:p031`), `p031-packaged` (job 113102923988), `p032-packaged` and `p034-packaged`.

**A031-01 PASS · A031-02 PASS · A031-03 PASS.** Phase P031 and claim CLM-P031-001, epoch 1, are **ACCEPTED**. The plan's
P031 ownership is reconciled with the claim (`package.json`, `firefox.yml`, `ci-workflows`), releasing them with the claim.
No successor phase was started.
