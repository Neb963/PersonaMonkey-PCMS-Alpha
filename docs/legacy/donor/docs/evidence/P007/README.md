# P007 — Minimal Audit Journal

Status: **ACCEPTED**

Final implementation checkpoint before evidence: `11a5ebd438c12ba33ff97d4d0feb5dae8cc335c8`.

## Scope

P007 implements the minimal append/read/projection Audit Journal required by the accepted architecture.

Implemented under `extension/pcms/audit/**`:

- bounded data-only audit event schema with journal-owned monotonic identity;
- append-only journal records stored in the accepted P005 `records` object store under the internal `core.audit` namespace;
- transactionally atomic PCMS state transition + audit append when both are in PCMS storage;
- paged journal reads with corruption/gap detection;
- synchronous deterministic projection/replay API;
- fixed safe audit error vocabulary and stale-connection fencing.

P007 deliberately does **not** allocate an IndexedDB migration. Its claim has no migration slot, so it reuses the P005 schema exactly. The journal is append/read/projection infrastructure only; it is not an event-sourced domain store, workflow bus, scheduler, or second automation runtime.

## A007-01 — Event schema / atomic append

Audit events are versioned and bounded:

- `schemaVersion: 1`;
- monotonic `sequence` and derived immutable `eventId`;
- normalized ISO timestamp;
- constrained event type and optional subject identity;
- bounded data-only payloads rejecting accessors, symbols, cycles, exotic prototypes, unsafe prototype keys, excessive depth/node count, and non-finite/non-data values.

`transitionAndAppend()` performs the authoritative PCMS record revision check, state write, audit event append, and audit metadata advance in one IndexedDB `readwrite` transaction on the P005 record store.

Focused fault injection proves an audit-event write failure aborts the complete transaction: the domain record, journal metadata, and next sequence remain unchanged. A stale expected state revision also aborts without consuming a journal sequence.

## A007-02 — Read / projection API

`read({ afterSequence, limit })` returns bounded pages plus the durable journal high-water mark and `hasMore`.

Persisted journal reads validate:

- metadata identity/revision;
- event record identity;
- event schema and derived ID;
- sequence/key parity;
- contiguous sequence coverage.

Missing or corrupt event coverage fails closed as `PCMS_AUDIT_CORRUPT`.

`project()` is a synchronous reducer over ordered audit pages. Promise-returning reducers and non-data projection state fail as `PCMS_AUDIT_PROJECTION_FAILED`. The public journal surface does not expose raw IndexedDB or messaging/event-bus primitives.

## A007-03 — Replay / restart

A close/reopen replay regression reconstructs the same ordered projection from durable journal events. The replay result is a derived projection only; no domain state is reconstructed into the authoritative state store.

## Focused verification

Outbound DNS is unavailable in the execution container, so the public GitHub branch could not be cloned directly. The four P007 production source files were reconstructed from GitHub contents and verified byte-for-byte by Git blob identity:

- `extension/pcms/audit/errors.js` — `c2f3363957a8309cd9f087caffb079d6e8ab062a`;
- `extension/pcms/audit/schema.js` — `b6f8b0c5a5818372d8632a0647c056c403d12239`;
- `extension/pcms/audit/indexeddb-journal.js` — `ed3470c5c6742464fb000a255ae4273d3839945c`;
- `extension/pcms/audit/journal.js` — `7127cfc7205ba844346d05956e9a59ffb3451648`.

The focused harness uses the accepted P005 record-store/index names and injects a deterministic transactional IndexedDB emulator through the production backend's supported `openDatabase` seam. The unused default database opener is not exercised by this harness.

Commands actually run:

```text
node --version
node --check extension/pcms/audit/errors.js
node --check extension/pcms/audit/schema.js
node --check extension/pcms/audit/indexeddb-journal.js
node --check extension/pcms/audit/journal.js
node --test focused-harness.test.mjs
```

Runtime: **Node v22.16.0**.

Result: **6 tests passed, 0 failed**.

Covered behaviors:

1. bounded schema / monotonic identity;
2. atomic state+audit commit and injected rollback;
3. stale revision without sequence consumption;
4. persisted reads plus sequence-gap/corruption rejection;
5. paged deterministic projection and fixed failure vocabulary;
6. restart replay without turning the journal into domain authority.

## Independent GitHub Actions at final implementation checkpoint

Exact checkpoint `11a5ebd438c12ba33ff97d4d0feb5dae8cc335c8` passed:

- repository verification run **37244743233** — success;
- pinned Firefox Developer Edition run **37244743258** — success.

The repository workflow does not discover `tests/pcms/**`; these Actions runs are repository/inherited-browser regression evidence, not a claim that the focused P007 suite ran in Actions. The focused harness above supplies the phase-specific U/I/C evidence.

## Scope review

Compared with the durable P007 claim checkpoint `19ccf77ff73f9cb5e07a7f8f911e1babe321efd9`, the implementation changes exactly:

- four files under `extension/pcms/audit/**`;
- two P007 tests under `tests/pcms/**`.

No P008/P009 or successor work is included. No migration, PersonaMonkey internals, raw native RPC, raw browser authority, provider mutation, or live acceptance is introduced.


## Final PR and merged-source integration verification

Final PR head `362b67dc040f26d336b0883b78c87b70284e0a6a` passed:

- repository verification push run **37246747717** — success;
- pinned Firefox Developer Edition push run **37246747687** — success;
- repository verification PR run **37246780633** — success;
- pinned Firefox Developer Edition PR run **37246780606** — success.

PR #7 merged as `573bfc5b7322bb9da1954dd31cee6d1609438ce4`. The exact merged source passed:

- repository verification run **37246873442** — success;
- pinned Firefox Developer Edition run **37246873397** — success.

The exact four production-source Git blob identities remained unchanged from the focused Node 22 verification recorded above, which passed **6 tests, 0 failed**.

P007 remains MERGED until this governance checkpoint itself passes repository verification.


## Acceptance decision

The MERGED governance checkpoint `151c4072cceaad792cd129adc0cbe6ecdfd7ab14` passed:

- repository verification run **37247007532** — success;
- pinned Firefox Developer Edition run **37247007543** — success.

A007-01, A007-02 and A007-03 are satisfied by the exact-source focused Node 22 U/I/C verification, final PR-head CI, exact merged-source CI, and the green MERGED governance checkpoint. P007 is therefore **ACCEPTED**.

No successor phase is claimed or started by this session. P008 and P009 remain READY; later P007 consumers remain dependency-blocked where their other prerequisites are not accepted.
