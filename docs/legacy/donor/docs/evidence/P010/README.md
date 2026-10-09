# P010 — RemoteOps + ProviderGate + recovery hold

Status: **ACCEPTED**

Source/test checkpoint: `a3212a009a495114b9c63ff5bac1586d8ee97cc4`.

## Scope

P010 implements the shared durable mutation-safety mechanisms required by the accepted architecture:

- durable RemoteOperation identity/state;
- ProviderGate dispatch/reconciliation admission;
- persistent `RECOVERY_HOLD`.

P010 has no migration slot. It reuses the accepted P005 namespaced record store under `core.remoteops` and `core.recovery`; no IndexedDB schema change is introduced.

The implementation does not create a workflow engine, scheduler, generic resource manager, browser automation authority, PersonaMonkey service path, raw browser/native API path, or provider-specific Perchance policy.

## A010-01 — durable RemoteOps

Added:

- `extension/pcms/remoteops/errors.js`;
- `extension/pcms/remoteops/schema.js`;
- `extension/pcms/remoteops/remote-ops.js`.

A RemoteOperation persists only bounded non-secret operation identity metadata:

- `operationId`;
- `providerId`;
- mutation `action`;
- stable `targetRef: {kind, id}`;
- `intentFingerprint`;
- state/attempt/timestamps/resolution metadata.

Transient provider dispatch input is not stored by RemoteOps.

The state machine is explicitly fenced:

`PREPARED -> DISPATCHING -> SUCCEEDED | FAILED | UNCERTAIN`

An `UNCERTAIN` operation cannot dispatch again. Reconciliation has only three accepted outcomes:

- `APPLIED` -> `SUCCEEDED`;
- `NOT_APPLIED` -> `RETRYABLE`;
- `UNKNOWN` -> remains `UNCERTAIN`.

Only the proven `NOT_APPLIED` path permits the same durable operation to enter a subsequent `DISPATCHING` attempt.

A crash/restart while `DISPATCHING` is handled conservatively: `recoverInterruptedDispatches()` converts it to `UNCERTAIN / INTERRUPTED`; it is never blindly replayed.

Operation-ID reuse is idempotent only when provider/action/stable target/fingerprint all match. Conflicting reuse fails closed. Stored key/operation identity, state/resolution combinations, revision fencing, and persisted-state corruption are validated before use.

## A010-02 — ProviderGate

Added `extension/pcms/remoteops/provider-gate.js`.

Providers and mutating actions must have explicit registered behavior containing both:

- `dispatch()`;
- `reconcile()`.

Unknown provider or action behavior fails closed before RemoteOperation creation or external dispatch.

For a known mutation, ProviderGate:

1. checks that recovery hold permits mutation;
2. validates known provider/action behavior;
3. durably creates/loads the RemoteOperation;
4. durably advances it to `DISPATCHING`;
5. only then invokes provider `dispatch()`.

Provider dispatch may report exactly `APPLIED` or `NOT_APPLIED`. A thrown exception or malformed/unknown outcome is treated as ambiguous and moved to `UNCERTAIN`. ProviderGate contains no automatic retry loop.

Reconciliation is permitted for `UNCERTAIN` operations, including during recovery hold. A reconciliation exception or malformed response is treated as `UNKNOWN` and remains fenced.

Focused tests inspect durable storage from inside the dispatch callback and prove `DISPATCHING` already exists before the external call. They also prove transient dispatch input containing a test secret never enters P010 persistence.

## A010-03 — durable recovery hold

Added `extension/pcms/remoteops/recovery-hold.js`.

`enterRecoveryHold()` first persists `RECOVERY_HOLD`, then converts any interrupted `DISPATCHING` operations to `UNCERTAIN`. The hold survives reconstruction against the same persistent storage.

ProviderGate blocks all new mutation dispatch while the hold is active. Reconciliation remains available.

Release is revision fenced and requires all architectural reconciliation classes to be explicitly complete:

- module generations;
- Persona bindings;
- provider capabilities;
- zero unresolved RemoteOperations.

Any missing check or unresolved `PREPARED`, `DISPATCHING`, `UNCERTAIN`, or `RETRYABLE` operation keeps the hold active.

Later restore/account/runtime phases provide the concrete reconciliation evidence for those named checks; P010 supplies the shared fail-closed mechanism only.

## Focused verification actually run

Exact Git blob identities at the source/test checkpoint:

- `extension/pcms/remoteops/errors.js` — `bee36fdbefcb48bb2358d3eef21f986d354300fc`;
- `extension/pcms/remoteops/schema.js` — `55b66d5de2ded664cc012abe199be1d7f6a6ad8c`;
- `extension/pcms/remoteops/remote-ops.js` — `6a4b8e221a8aab99c684cdd1a16dc7496fd246fc`;
- `extension/pcms/remoteops/recovery-hold.js` — `0e33f659d5f001b24c9e0207654fa55bb3ad0881`;
- `extension/pcms/remoteops/provider-gate.js` — `025f80fed85caa5d95c483c522e6c9da09238626`;
- `tests/pcms/p010-harness.mjs` — `c4580e9c928046dd464dbbad040cddaf0e383567`;
- `tests/pcms/p010-remoteops.test.mjs` — `7d2b5ea15f874ad9290e13015ab5994858cfb65e`;
- `tests/pcms/p010-provider-gate.test.mjs` — `f7fd23f5b2272a9d5f1b0a35907d4ff88e4492a5`;
- `tests/pcms/p010-recovery.test.mjs` — `9b1267f4ee1ee6c8417f95065037e4b15440e463`;
- `tests/pcms/p010-boundary.test.mjs` — `02ec098ed181feda327e0befc1ee618eab3818ce`.

The local focused workspace used Node **v22.16.0**. Commands actually run:

```text
node --check extension/pcms/remoteops/*.js
node --test tests/pcms/p010-*.test.mjs
```

Final result: **16 tests passed, 0 failed**.

The focused workspace injected a narrow storage-broker stub only to satisfy the production module import; every behavior test supplied its deterministic transactional storage seam. P005 storage/CAS behavior is already accepted independently.

During publication, byte verification detected that an intermediate write had interpreted JavaScript escape sequences in three test files. Those three blobs were replaced with byte-exact text and rechecked against the local Git hashes before this checkpoint. No product-source blob was affected.

The repository's root Actions workflows do not discover `tests/pcms/**`; the focused suite above is the direct P010 U/I/C evidence.

## Independent branch CI

Exact source/test checkpoint `a3212a009a495114b9c63ff5bac1586d8ee97cc4` passed:

- repository verification push run **37251750583** — success;
- pinned Firefox Developer Edition push run **37251750502** — success.

These root workflows are independent repository/FDE regressions, not substitutes for the focused P010 suite.

## Scope review

Compared with claim-governance base `403a11f1a6e68327d9089a5cf0448f361d66a307`, the source/test checkpoint is ahead only by P010 implementation/test commits and changes exactly:

- five files under `extension/pcms/remoteops/**`;
- five P010 files under `tests/pcms/**`.

No PersonaMonkey-owned source, raw browser/native authority, provider-specific adapter, storage migration, root package/workflow configuration, or successor-phase implementation is changed.

No Firefox DevTools MCP or P025/P026 live acceptance is claimed.

## Pull request / merged integration

Final PR head `9b8c6662c04f2a880fdd249bd018051101c9e4f1` passed:

- push repository verification run **37251888710** — success;
- push pinned Firefox Developer Edition run **37251888709** — success;
- PR repository verification run **37251902738** — success;
- PR pinned Firefox Developer Edition run **37251902744** — success.

Pull request #10 merged as `0737b3105dca25783d77256cf753234b4af66990`.

The exact merged source passed:

- repository verification run **37251970911** — success;
- pinned Firefox Developer Edition run **37251970921** — success.

The root workflows are repository regression/FDE smoke checks. The focused 16-test P010 suite remains the direct U/I/C behavior evidence.

## Acceptance decision

The MERGED governance checkpoint `22b40dc6fc5236db122d54d7ec26a30720838045` passed:

- repository verification run **37252090716** — success;
- pinned Firefox Developer Edition run **37252090847** — success.

Together with the exact-source 16-test U/I/C suite, branch/PR CI, and exact merged-source CI, this satisfies **A010-01**, **A010-02**, and **A010-03**. P010 is **ACCEPTED**.
