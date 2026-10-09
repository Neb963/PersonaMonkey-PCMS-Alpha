# P016 — Explorer module evidence

Phase state: **ACCEPTED**.

## Implemented scope

P016 adds a bounded Explorer feature module under `pcms-modules/p016/**`.

- discovery snapshots are scoped to durable P014 `AccountId` and the accepted P013 Perchance provider/Generator target identity;
- module state stores stable generator identifiers and optional observed SHA-256 source hashes, never generator source bytes, Persona IDs, container IDs, or secrets;
- repeated discovery IDs are idempotent only when their normalized content is identical;
- unclaimed stale candidates are pruned, while claimed candidates remain durable when a later discovery no longer contains the target;
- claiming a current candidate creates a local durable reservation for a `deploymentId`; active generator targets and deployment identities are unique;
- local reservations do not dispatch provider mutations and therefore do not create a second browser/provider authority;
- reconciliation fails closed across missing accounts, lookup failures, missing targets, and later recovery without silently dropping a claim;
- release preserves a claim tombstone while clearing or pruning its candidate reservation;
- UI/integration projections expose freshness, claim health, and guarded actions; deployment creation is projected as allowed only for a current, reconciled reservation;
- P016 does not import or invoke P015, preserving the phase dependency graph and deferring cross-module wiring to the integration wave.

## Acceptance mapping

### A016-01 — discovery/candidates

Covers account-scoped normalized discovery, P013 provider/target identity, deterministic candidate identity, replay/conflict handling, revision fencing, bounded storage, stale pruning, P014 Accounts integration, and source/Persona data exclusion.

### A016-02 — durable claim/reconciliation

Covers durable claim and deployment reservation identity, target/deployment uniqueness, idempotent exact replay, claimed-target retention, missing-target status, account failure states, recovery, release, and fail-closed reservation readiness.

### A016-03 — module UI/integration

Covers deterministic candidate/reservation projections and guarded actions without raw browser, native host, DOM, RemoteOps, provider mutation, or P015 authority.

## Focused verification actually run

Node: repository-compatible local runtime.

Commands executed against a reconstructed focused slice containing the exact P016 product source plus a minimal accepted P013 constant stub:

```text
node --check pcms-modules/p016/errors.js
node --check pcms-modules/p016/schema.js
node --check pcms-modules/p016/explorer.js
node --test tests/pcms/p016/*.test.mjs
```

Before the real-P014 integration test was added to the committed repository suite, the focused slice result was **13 tests passed, 0 failed**. The committed suite additionally binds Explorer to the real accepted P014 Accounts implementation for repository execution/review.

## Independent branch / PR / merged-main CI

Implementation checkpoint `1ad66756b1e771f7e88ca715e84f7361d73aebb3` passed:
- GitHub Actions `verify`, run **485** / run id **37268458909** — **success**;
- GitHub Actions `firefox-developer-edition`, run **480** / run id **37268458917** — **success**.

Final PR head `3050eb53dcd365fdf4d37ce4a1bb68021d72d04d` passed:
- pull-request `verify`, run **497** / run id **37268980221** — **success**;
- pull-request `firefox-developer-edition`, run **492** / run id **37268980222** — **success**;
- push `verify`, run **496** / run id **37268976287** — **success**;
- push `firefox-developer-edition`, run **491** / run id **37268976341** — **success**.

Pull request #16 merged as `dc699d55ffed3402e470d6a18c887bba4b38bfdf`.

The exact merged main commit passed:
- GitHub Actions `verify`, run **498** / run id **37269082865** — **success**;
- GitHub Actions `firefox-developer-edition`, run **493** / run id **37269082864** — **success**.

## Acceptance decision

The MERGED governance checkpoint `b40d82d75deba586a4f4cfe4d23cf4045b6ceecb` passed:
- repository verification run **499** / run id **37269315143** — **success**;
- pinned Firefox Developer Edition run **494** / run id **37269315139** — **success**.

Together with the exact-product-source focused U/I/C slice, accepted P013/P014 dependencies, branch/PR CI, and exact merged-main CI, this satisfies **A016-01**, **A016-02**, and **A016-03**. P016 is **ACCEPTED**.
