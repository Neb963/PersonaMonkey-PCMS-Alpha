# P020 — Backup/restore + retention evidence

Phase state: **ACCEPTED**.

## Implemented scope

P020 adds privileged PCMS Core backup/restore mechanics without exposing raw IndexedDB to modules.

- storage broker gains a Core-only administrative surface for canonical all-record snapshot validation and atomic full replacement;
- IndexedDB replacement clears and rewrites the PCMS record store inside one readwrite transaction;
- backup envelopes are bounded, deterministic, SHA-256 integrity protected, and exclude `core.recovery` plus `core.backups` so restore cannot overwrite its active recovery hold or recursively capture retention metadata;
- staged restore verifies integrity before mutation;
- restore enters durable `RECOVERY_HOLD` before quiescing active module runtimes or replacing state;
- active/DRAINING runtimes are drained/fenced through the accepted P011 runtime broker before replacement;
- restored ACTIVE/DRAINING generations are recovered/fenced after replacement;
- restored DISPATCHING RemoteOperations become UNCERTAIN/INTERRUPTED and are never blindly replayed;
- reconciliation cancels PREPARED/RETRYABLE work, reconciles UNCERTAIN work through ProviderGate, and releases the hold only when module generations, Persona bindings, provider capabilities, and unresolved RemoteOperations are all clear;
- UNKNOWN provider reconciliation remains held;
- retention planning deterministically keeps the newest bounded set of backups;
- secret values remain outside ordinary PCMS storage and therefore outside these snapshots; opaque SecretRefs may remain as ordinary references.

Implementation files:

- `extension/pcms/storage/indexeddb-backend.js`
- `extension/pcms/storage/storage-broker.js`
- `extension/pcms/recovery/errors.js`
- `extension/pcms/recovery/schema.js`
- `extension/pcms/recovery/retention.js`
- `extension/pcms/recovery/backup-restore.js`

Focused tests:

- `tests/pcms/p020/backup-restore.test.mjs`
- `tests/pcms/p020/retention.test.mjs`
- `tests/pcms/p020/storage-admin.test.mjs`
- `tests/pcms/p020/boundary.test.mjs`
- `tests/pcms/p020/harness.mjs`

## Acceptance mapping

### A020-01 — snapshot / backup / retention

Covers canonical full-state snapshotting, excluded recovery namespaces, SHA-256 integrity, tamper rejection, durable revision/timestamp preservation, storage-record validation, and deterministic bounded retention.

### A020-02 — staged restore

Covers integrity verification before mutation, RECOVERY_HOLD before runtime quiescing/replacement, accepted runtime lifecycle fencing, preservation of excluded recovery metadata, atomic storage replacement, and failure remaining held.

### A020-03 — RECOVERY_HOLD reconciliation

Covers restored DISPATCHING → UNCERTAIN recovery, cancellation of safe PREPARED/RETRYABLE operations instead of replay, ProviderGate reconciliation for UNCERTAIN operations, UNKNOWN remaining held, module-generation reconciliation, Persona-binding/provider-capability gates, and release only after zero unresolved RemoteOperations.

## Focused verification actually run

The available execution environment does not provide a local repository checkout, so no local Node command is claimed.

The exact P020 product and committed test sources from checkpoint `612c47b9a6ec055e89aee0d2416b9fe89acfa6cc` were fetched through the GitHub connector and executed in its JavaScript isolate:

- **11/11** committed backup/restore, retention, and storage-admin test bodies passed;
- **3/3** static boundary/transaction checks passed against the exact product sources;
- combined focused U/I/C result: **14 checks passed, 0 failed**.

The isolate does not provide Node's `structuredClone` or `node:crypto`; deterministic test-only clone and 64-hex digest shims were supplied to the committed test bodies. Product code was not modified, and the production default remains Web Crypto SHA-256.

Independent branch checkpoint `612c47b9a6ec055e89aee0d2416b9fe89acfa6cc` passed:

- repository `verify`, run **554** / run id **37302213386** — **success**;
- pinned Firefox Developer Edition, run **549** / run id **37302213470** — **success**.

The repository root `npm run verify` does not auto-discover `tests/pcms/p020/*.test.mjs`; root Actions are independent repository/claim/upstream/Firefox evidence rather than the focused P020 behavior run.

No P025/P026 LIVE evidence is claimed.

## Pull request / merged integration

Final PR head `7d1a10266c97b199fa5299df75fc7cbf8cd3b567` passed:

- push repository `verify`, run **559** / run id **37302743116** — **success**;
- push pinned Firefox Developer Edition, run **554** / run id **37302742995** — **success**;
- pull-request repository `verify`, run **560** / run id **37302776794** — **success**;
- pull-request pinned Firefox Developer Edition, run **555** / run id **37302776791** — **success**.

Pull request #20 merged as `446219e8b09c726b1c732a7e2326ec03045b1167`.

The exact merged main commit passed:

- repository `verify`, run **561** / run id **37302921674** — **success**;
- pinned Firefox Developer Edition, run **556** / run id **37302921719** — **success**.

## Acceptance decision

The MERGED governance checkpoint `9fc176b4338903530cc2969f149e7eb381627f51` passed:

- repository `verify`, run **562** / run id **37303121927** — **success**;
- pinned Firefox Developer Edition, run **557** / run id **37303121953** — **success**.

Together with the 14 exact-source focused U/I/C checks, accepted P007/P010/P011 dependencies, final PR-head CI, and exact merged-main CI, this satisfies **A020-01**, **A020-02**, and **A020-03**. P020 is **ACCEPTED**.
