# P008 — Module archive/package/authority model

Status: **ACCEPTED**

Source/test checkpoint: `6b3027e8ccbdcf3afb8b8d42f4f03e5f7d8403bb`.

## Scope

P008 implements the immutable package and authority-admission model required by the accepted module architecture. It does not execute module code, allocate runtime generations, dispatch browser/provider operations, or add a second automation authority. Those behaviors remain owned by later phases, especially P011.

P008 has no migration slot. The registry therefore reuses the accepted P005 storage broker under the internal namespace `core.modules`; no IndexedDB schema change is introduced.

## A008-01 — bounded parser and exact package identity

Added `extension/pcms/modules/package.js` and `errors.js`.

The package wire format is `pcms.module.archive/v1`: canonical UTF-8 JSON bytes containing a manifest and bounded text files. Admission constraints include:

- maximum archive size: 1 MiB;
- maximum file count: 32;
- maximum file/controller size: 256 KiB;
- maximum path length: 160 characters and maximum path depth: 8 segments;
- relative safe paths only; no `..`, absolute paths, backslashes, NULs, or malformed UTF-8;
- manifest schema version 1 with bounded module ID, version, controller path and authority envelope;
- canonical byte representation required on parse, so alternate/non-canonical encodings are rejected;
- exact package identity is `sha256:<64 lowercase hex>` over the canonical archive bytes;
- every stored package is re-encoded and re-hashed before it is trusted again.

Immutable package records are keyed by the exact hash. A stored record whose content no longer matches its claimed hash fails closed with `PCMS_MODULE_IDENTITY_CONFLICT`.

## A008-02 — bounded authority envelope and delta

Added `extension/pcms/modules/authority.js`.

Authority is an explicit sorted set of bounded capability identifiers. Raw privileged authority roots such as `browser.*`, `chrome.*`, `indexeddb.*`, `native.*`, and `personamonkey.*` are rejected, as are wildcard names.

`diffModuleAuthority()` produces deterministic `added`, `removed`, and `unchanged` sets. Any added capability makes `requiresApproval=true`. This applies to first installation as well as updates, so a package cannot obtain new authority merely by being staged.

Approval is fenced to the exact candidate package hash and exact added-capability set. Removing authority does not require an expansion approval.

## A008-03 — immutable candidate lifecycle

Added `extension/pcms/modules/registry.js`.

The registry stores immutable package records and CAS-fenced per-module state:

`stage -> AWAITING_APPROVAL | READY -> approve when required -> READY -> admit`

A different candidate cannot replace a staged candidate. Rejection removes only the candidate. Until admission, the existing `activePackageHash` and `lastKnownGoodPackageHash` remain unchanged. Admission re-verifies package identity, validates any required approval, then atomically advances only the module state record to the candidate hash.

Module-state mutations require the caller's expected module revision. P005 CAS conflicts are translated to the fixed P008 revision-conflict vocabulary. Restart tests prove staged package/candidate state survives broker reconstruction. Persisted package corruption and persisted candidate-metadata corruption both fail closed before use/admission.

P008 deliberately does **not** implement runtime generation or sandbox execution. Generation fencing and capability RPC remain P011 responsibilities.

## Focused verification actually run

The exact source/test files at the checkpoint were reconstructed in the available Node environment and matched to GitHub blob identities:

- `extension/pcms/modules/errors.js` — `c362dcf4d72a8fa68d54772bc6358b6e78a2e67a`;
- `extension/pcms/modules/authority.js` — `ea5b9dce5c818c6eb9e4c2a2e23c97eccb55074e`;
- `extension/pcms/modules/package.js` — `e4708bcef607d63a23e704bdffa194334c51d453`;
- `extension/pcms/modules/registry.js` — `c188146a65ad597968817b821f3b1e5fb4bd4459`;
- `tests/pcms/p008-package.test.mjs` — `10fc6dc2fd2719f8fdee7ef902714e0b6110442e`;
- `tests/pcms/p008-registry.test.mjs` — `5dac8d947450950a542218f3712b0fffd4a9d4ff`;
- `tests/pcms/p008-boundary.test.mjs` — `2376e47fe464f9fb53ae2d5e9f38be67cdd7cd8c`.

Commands actually run with Node **v22.16.0**:

```text
node --check extension/pcms/modules/*.js
node --test tests/pcms/p008-*.test.mjs
```

Result: **11 tests passed, 0 failed**.

The suite covers canonical hashing, parser bounds, unsafe-path/raw-authority rejection, deterministic authority deltas, first-install approval, update expansion approval, candidate replacement prevention, last-known-good preservation, revision fencing, restart persistence, exact stored-package re-verification, corrupt package rejection, corrupt module-state rejection, and static authority-boundary checks.

The repository's current root `npm run verify` does not discover `tests/pcms/**`; P008 does not own `.github/**` or `package.json`, so this phase does not widen CI wiring outside its claim. The focused P008 suite above is the direct U/I/C evidence required by A008-01 through A008-03.

## Scope review

Compared with the durable claim-governance base `d4532a66dd00749cb66b10865f7c8877c804d350`, source/test checkpoint `6b3027e8ccbdcf3afb8b8d42f4f03e5f7d8403bb` is eight commits ahead, zero behind, and changes exactly:

- four files under `extension/pcms/modules/**`;
- three files under `tests/pcms/**`.

No PersonaMonkey-owned source, root manifest, native component, provider adapter, storage migration, workflow, package script, or successor-phase implementation was changed.

No Firefox DevTools MCP, Perchance live provider, Mullvad live route, or P025/P026 live acceptance is claimed.

## CI / integration

Final PR head `60f1f7f12d140a2f41c254435e11a7ea5e65fbb0` passed both push and pull-request workflows:

- push repository verification run **37248537992** — success;
- push pinned Firefox Developer Edition run **37248538062** — success;
- PR repository verification run **37248549790** — success;
- PR pinned Firefox Developer Edition run **37248549779** — success.

Pull request #8 merged as `71ddfe52f63207f692db38965ce88ba35ac74b38`.

The exact merged source passed:

- repository verification run **37248649885** — success;
- pinned Firefox Developer Edition run **37248649904** — success.

These root workflows are repository regression checks. They do not replace the focused 11-test P008 U/I/C suite recorded above.

## Acceptance decision

The corrected MERGED governance checkpoint `30fb84256631cd6a82c6992e7092dde6797ecac2` passed:

- repository verification run **37248871079** — success;
- pinned Firefox Developer Edition run **37248871109** — success.

An earlier intermediate post-merge governance commit failed repository verification because a generated JSON file contained a literal escaped newline after the closing object. The malformed serialization was corrected and the generated plan/claim/roadmap/status views were revalidated at the green checkpoint above; no P008 product source changed during that repair.

Together with the exact-source 11-test U/I/C suite, PR-head CI, merged-source CI, and corrected governance CI, this satisfies **A008-01**, **A008-02**, and **A008-03**. P008 is **ACCEPTED**.
