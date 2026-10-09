# P014 — Accounts module + Account↔personaUid binding evidence

Phase state: **ACCEPTED**.

## Implemented scope

P014 introduces the first concrete feature-module state service under `pcms-modules/p014/**`.

- durable account identity is `AccountId`;
- every active account has exactly one dedicated `personaUid`;
- a `personaUid` can belong to at most one account;
- `cookieStoreId` is never durable account identity and appears only in transient reconciliation projections;
- binding and rebinding are revision fenced;
- rebinding also requires the caller's expected old `personaUid`;
- same-`personaUid` rebinding is idempotent so PersonaMonkey container rotation requires no account-state rewrite;
- Persona lookup is read-only and fail closed;
- the module stores no credentials, SecretRefs, browser state, native state, or PersonaMonkey internals.

The state interface is intentionally bounded to `read()` and `compareAndSwap()`; P014 does not directly access PCMS IndexedDB. Persona access is intentionally bounded to a read-only `get(personaUid)` resolver supplied by Core/Persona Broker integration.

## Acceptance mapping

### A014-01 — account model

Covers bounded non-secret account schema, canonical UUID-shaped `personaUid`, provider-ID parity with accepted P013, one-to-one Account↔Persona uniqueness, revision fencing, existing/current Persona validation, additive Persona projection compatibility, and accessor rejection without invoking getters.

### A014-02 — Persona binding / rebind

Covers expected-old-binding fencing, unused replacement Persona enforcement, binding epoch advancement, state CAS fencing, and same-`personaUid` idempotence.

### A014-03 — rotation continuity

Covers unchanged durable account state across `cookieStoreId` rotation, transient current-container projection, fail-closed reconciliation for missing/mismatched/unavailable Persona state, and stale concurrent-write rejection.

## Focused verification actually run

Node: **v22.16.0**

Commands:

```text
node --check pcms-modules/p014/errors.js
node --check pcms-modules/p014/schema.js
node --check pcms-modules/p014/accounts.js
node --test tests/pcms/p014/accounts.test.mjs tests/pcms/p014/boundary.test.mjs
```

Result: **12 tests passed, 0 failed, exit 0**.

The exact implementation/test Git blobs published at checkpoint `bfb1328656cd78768d51c20ea1d3d9ee0ddd0b79` match the locally executed files:

- `pcms-modules/p014/errors.js` — `fb40b889f578ccfd61c7c4846424cae2780985dd`;
- `pcms-modules/p014/schema.js` — `d3be9b6425a5679494d8a18c6949762234badc18`;
- `pcms-modules/p014/accounts.js` — `7f0d4972b6f6ca7b80eb92a8cec2706324d46f1a`;
- `tests/pcms/p014/harness.mjs` — `a83aaeac216242cea8be033d1c0b9a28d19963aa`;
- `tests/pcms/p014/accounts.test.mjs` — `2a0383f08f6d09a938d8a7dce1ce29debc3abd10`;
- `tests/pcms/p014/boundary.test.mjs` — `92922bc41a6386c1597af29c3b7557a6d8a2a165`.

The local focused tree used a one-line stub for the already-accepted P013 `PERCHANCE_PROVIDER_ID` constant because a full repository clone was unavailable in the execution container. The actual repository P013 contract was independently inspected before implementation; the committed test imports that real repository contract. No other accepted dependency behavior was replaced by the focused harness.

No live provider, Firefox DevTools MCP, credential, or browser-automation acceptance is claimed for P014.

## Pull request / merged integration

Final reconciled PR head `722414d9cdaa1e0618a6cf2fe6e796063b8b5cdd` passed:

- GitHub Actions `verify`, run **423** / run id **37263125196** — **success**;
- GitHub Actions `firefox-developer-edition`, run **418** / run id **37263125216** — **success**.

Pull request #14 merged as `82a13d0c4ae061edde9b52ce8bdb927f3e9db3cd`.

The exact merged main commit passed:

- GitHub Actions `verify`, run **424** / run id **37263239221** — **success**;
- GitHub Actions `firefox-developer-edition`, run **419** / run id **37263239220** — **success**.

Acceptance still requires the MERGED governance checkpoint to pass.

## Acceptance decision

The MERGED governance checkpoint `453e6ce9a55828bbb22eaeaf739df4d05e7a1b44` passed:

- repository verification run **429** / run id **37263362097** — **success**;
- pinned Firefox Developer Edition run **424** / run id **37263362141** — **success**.

Together with the exact-source 12-test focused U/I/C suite, final PR-head CI, exact merged-main CI, and accepted P011/P013 dependencies, this satisfies **A014-01**, **A014-02**, and **A014-03**. P014 is **ACCEPTED**.
