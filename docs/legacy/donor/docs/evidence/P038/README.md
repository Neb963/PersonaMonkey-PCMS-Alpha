# P038 evidence — scheduled background repository synchronization

Claim: CLM-P038-001, epoch 1; dependencies P037 and P029 accepted. Claim base: `a65139971beb415242ecd88f2ca0c26557467ab4`; acquisition: `3816f9c0e7392bc279cf2d78d656b0f7edb922b3`.
Implementation tested head: `cb6a8798bd6a0f3e8d98a3be7d7fe874741ebc89`. [PR #62](https://github.com/Neb963/persona-monkey-pcms/pull/62). State: **ACCEPTED after independent merged-main verification**.

## Implementation

- T038.1: Core-owned `core.deployer-repository-sync` registered with P029 durable timers. Exactly one pending logical scan schedule; scheduler state persisted under `module.deployer.repository.sync`. Each alarm executes one bounded P037 `scanStep` (8 items max); short continuations resume checkpoints.
- T038.2: Configurable 5–1440 minute cadence (60 minute default); bounded exponential retry, reset-aware GitHub rate limiting, failure-safe preservation of repository snapshots/Deployer desired records, and one coalesced check after prolonged offline time.
- T038.3: Alternating durable timer IDs fence in-flight callbacks; interrupted and missed deliveries are re-declared; already completed repository scan checkpoints are recognized rather than replayed. P037's provider-facing reconciliation and existing RemoteOps remain authoritative. No unattended Perchance dispatch.

## Acceptance evidence

| Gate | Test evidence |
| --- | --- |
| A038-01 | Zero-UI declared timer check; bounded scan continuations; no duplicate wakes, single pending schedule; multi-day catch-up |
| A038-02 | Consecutive offline failures, bounded exponential retry, rate-limit reset deadline, retained repository snapshot and Deployer intent |
| A038-03 | Recovered interrupted timer resumes durable cursor; committed final checkpoint cannot replay; MISSED delivery repaired; packaged Firefox unload/restart |

- `tests/pcms/p038/sync.test.mjs`: 7 deterministic tests, PASS in repository verification.
- [Repository verification run #37785056487](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37785056487): SUCCESS (`npm run verify` and inherited suites).
- [Pinned Firefox run #37785056472](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37785056472): SUCCESS; all eight jobs, including isolated P038 packaged acceptance.
- P038 packaged proof on exact pinned Firefox Developer Edition `154.0b10`; report artifact `firefox-packaged-p038`; PASS for zero-PCMS-tab background alarm wake, offline `REPO_UNAVAILABLE` with durable retry, and restart preserving scan sequence 1 and the same retry due time. Product XPI SHA-256 `86fe657e58cd6481c41d78cf22a8456b28ad912556a53b4ccf79c625fbe6734b`.
- P038 branch checkpoints: `6401f422` scheduler, `3031273d` Core registration, `ba69e3f8` regression tests, `385d22ed` portable source/package loader, `048dd4a4` delivery recovery, `cb6a8798` final packaged probe.

## Scope and acceptance limits

P037 manual deployment remains operator-confirmed. P039 drift observation, P042 unattended dispatch and final P043–P044 live acceptance remain separate. No live Perchance mutation, CAPTCHA automation or Firefox DevTools MCP used.

**Merged-main acceptance:** PR #62 merged at `274a28b814c723295ff995777e38c19d0d76f8cd`.
- [Merged-main verify #37786384369](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37786384369): SUCCESS.
- [Merged-main pinned Firefox #37786384367](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37786384367): SUCCESS; all eight jobs, including P038 packaged offline and restart acceptance.
This independent merged-main evidence justifies P038/claim `ACCEPTED`. No successor phase has been started.
