# P022 — Module lifecycle end-to-end evidence

Phase state: **ACCEPTED**.

## Implemented scope

P022 composes the accepted P008 immutable module registry and P011 generation-fenced runtime into the end-to-end lifecycle authority required by V1.

- install/update stages immutable packages through the existing P008 candidate/authority-approval path;
- authority expansion still requires explicit approval and is never inferred from lifecycle intent;
- runtime quiescing happens before active-package replacement;
- update admission can preserve the prior last-known-good package until the replacement actually activates;
- successful activation explicitly marks the new package known-good;
- failed activation rolls registry authority back to the preserved last-known-good package and fences/restarts the old runtime best-effort;
- disabled updates remain disabled and do not become known-good until later successful enable/activation;
- disable fences the runtime generation without uninstalling the admitted package;
- remove disables runtime and deactivates the module while retaining bounded rollback package identities;
- purge is allowed only after remove while the runtime is DISABLED;
- purge uses a durable `PURGING` lifecycle state, deletes the deactivated module record and immutable packages, then records `PURGED`;
- runtime state is intentionally retained as a DISABLED generation tombstone during purge so a future reinstall cannot make stale historical runtime generations current again;
- rollback can only stage package hashes still present in the bounded lifecycle retention set;
- retained rollback history is bounded (default 3, maximum 10); physical package deletion is explicit purge rather than unsafe concurrent background GC.

P022 extends the internal P008 registry with lifecycle-safe operations for stored-package staging, last-known-good confirmation/rollback, module deactivation, reference-checked package deletion, and module deletion. Existing P008 admission behavior remains the default; P022 uses the explicit `preserveLastKnownGood` option.

Implementation files:

- `extension/pcms/modules/errors.js`
- `extension/pcms/modules/registry.js`
- `extension/pcms/modules/lifecycle-errors.js`
- `extension/pcms/modules/lifecycle.js`

Focused tests:

- `tests/pcms/p022/harness.mjs`
- `tests/pcms/p022/lifecycle.test.mjs`
- `tests/pcms/p022/registry-management.test.mjs`
- `tests/pcms/p022/boundary.test.mjs`

## Acceptance mapping

### A022-01 — install / update

Covers first-install authority approval, admitted-package activation, generation fencing before updates, prior-package retention, explicit known-good confirmation, disabled-update semantics, and activation-failure rollback to the prior known-good package/runtime.

### A022-02 — disable / remove / purge

Covers runtime disable without uninstall, enable/reactivation, remove as disable + registry deactivation, retained rollback identity after removal, purge preconditions, durable PURGING fencing, immutable package deletion, and preservation of the DISABLED runtime generation tombstone.

### A022-03 — rollback / retention

Covers bounded rollback history, rejection of versions outside retention, re-staging retained immutable packages through normal authority admission, successful rollback history rotation, and registry-level refusal to delete any active/last-known-good/candidate package reference.

## Focused verification actually run

The available execution environment does not provide a local repository checkout, so no local Node command is claimed.

The exact P022 product and committed test sources from checkpoint `193a530c05b2f1244f8043d511aed0d716f8d3b4` were fetched through the GitHub connector and executed in its JavaScript isolate:

- **9/9** committed lifecycle/registry behavior test bodies passed;
- **3/3** committed authority/fencing boundary assertions passed against the exact product sources;
- combined focused U/I/C result: **12 checks passed, 0 failed**.

The isolate does not provide Node's `TextEncoder`, `TextDecoder`, `structuredClone`, or Web Crypto. Deterministic test-only ASCII codec, clone, and 32-byte digest shims were supplied to execute the committed package/lifecycle test bodies. Product code was not modified; production package identity still uses Web Crypto SHA-256.

Independent branch checkpoint `193a530c05b2f1244f8043d511aed0d716f8d3b4` passed:

- repository `verify`, run **581** / run id **37309013745** — **success**;
- pinned Firefox Developer Edition, run **576** / run id **37309013656** — **success**.

The repository root `npm run verify` does not auto-discover `tests/pcms/p022/*.test.mjs`; root Actions are independent repository/claim/upstream/Firefox evidence rather than the focused P022 lifecycle run.

No P025/P026 LIVE evidence is claimed.

## Pull request / merged integration

Final PR head `0f18960a7fb972cd08506b6cf492fefd29eb0ac5` passed:

- push repository `verify`, run **586** / run id **37309621663** — **success**;
- push pinned Firefox Developer Edition, run **581** / run id **37309621713** — **success**;
- pull-request repository `verify`, run **587** / run id **37309696447** — **success**;
- pull-request pinned Firefox Developer Edition, run **582** / run id **37309696490** — **success**.

Pull request #22 merged as `d84f164c0428c537df1578def862a78b4adf27b3`.

The exact merged main commit passed:

- repository `verify`, run **588** / run id **37309904110** — **success**;
- pinned Firefox Developer Edition, run **583** / run id **37309904085** — **success**.

## Acceptance decision

The MERGED governance checkpoint `c691dd4f4746f7d16692acdf79d63a667f3ca3e0` passed:

- repository `verify`, run **589** / run id **37310153413** — **success**;
- pinned Firefox Developer Edition, run **584** / run id **37310153169** — **success**.

Together with the 12 exact-source focused U/I/C checks, accepted P008/P011/P020 dependencies, final PR-head CI, and exact merged-main CI, this satisfies **A022-01**, **A022-02**, and **A022-03**. P022 is **ACCEPTED**.
