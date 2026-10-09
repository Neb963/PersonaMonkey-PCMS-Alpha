# P017 — Refresher module evidence

Phase state: **ACCEPTED**.

## Implemented scope

P017 adds a bounded Refresher feature module under `pcms-modules/p017/**`.

- cohorts are module-owned and bind to durable P014 `AccountId` plus accepted P013 Perchance generator target identity;
- durable state stores generator IDs and SHA-256 source hashes, never generator source bytes, Persona IDs, container IDs, credentials, or secrets;
- `AUTO_RECENT` deterministically selects never-confirmed/oldest-confirmed members while `MANUAL` disables automatic selection;
- daily cohort budget is configurable up to the module bound, uses a configurable offset 24-hour accounting window, and is reserved durably at prepare time so unresolved work cannot oversubscribe it;
- active-hours plus sleep-days cycles are anchored deterministically and remain module-owned policy rather than creating another Core scheduler;
- refresh dispatch uses only accepted P013 `generator.update` through an account-scoped ProviderGate;
- confirmed-effect accounting advances only after the durable RemoteOperation is known `SUCCEEDED`;
- ambiguous provider outcomes enter reconciliation before retry, direct `NOT_APPLIED` releases the reservation and requires a new operation identity, while reconciled retryable work reuses the same durable identity;
- account/provider loss fails closed before dispatch, unresolved work fences policy/source changes, and restart-style ACTIVE state without a RemoteOperation returns to PENDING without replay.

## Acceptance mapping

### A017-01 — cohort/eligibility

Covers durable cohort/member schema, AccountId/provider/target identity, global target ownership, revision fencing, deterministic AUTO_RECENT eligibility, bounded member/cohort capacity, and sensitive/source-byte exclusion.

### A017-02 — schedules/budgets

Covers configurable daily budgets, durable budget reservation, offset 24-hour windows, anchored active-hours/sleep-days cycles, MANUAL mode, deterministic projections, and module-owned schedule policy without a second scheduler.

### A017-03 — isolation/confirmed-effect tests

Covers ProviderGate-only mutation, source hash verification, account/provider failure isolation, direct failure/retry identity, ambiguity reconciliation, restart recovery, unresolved-operation fencing, and confirmed-effect accounting only after SUCCEEDED.

## Focused verification actually run

Node v22.16.0. The focused slice used the exact P017 product source blobs plus the accepted P013 contract surface/stubs needed to execute the module in isolation.

```text
node --check pcms-modules/p017/errors.js
node --check pcms-modules/p017/schema-input.js
node --check pcms-modules/p017/schema.js
node --check pcms-modules/p017/refresher-helpers.js
node --check pcms-modules/p017/refresher-store.js
node --check pcms-modules/p017/refresher-operations.js
node --check pcms-modules/p017/refresher.js
node --test tests/pcms/p017/*.test.mjs
```

Result: **19 tests passed, 0 failed**.

Exact locally verified product blobs now committed on the claim branch:

- `errors.js` — `2c5de8efa2023ea8f1d2899fd951cf5b242abaa4`
- `schema-input.js` — `39ef551aa6134e75c41d329b6faa8df27003a5a9`
- `schema.js` — `5c0760ff7439c21a5b8220f7509a9a03ebda2aa9`
- `refresher-helpers.js` — `84cfe5a6507238b5d4fa6dcad78d9612a49eff0d`
- `refresher-store.js` — `26ce98ee40b6a9bea9fe3214220277376f9a3fcb`
- `refresher-operations.js` — `d3a6df30eeebaae79518533912e20fc3e48ef4e6`
- `refresher.js` — `a69e0d7550eeefb6c10fb3689be0059255b422b9`

The pre-evidence implementation head `6e0d5ade2d9635d4399d3bcc774fb4ecc7e51d23` passed:
- GitHub Actions `verify`, run **508** / run id **37285931999** — **success**;
- GitHub Actions `firefox-developer-edition`, run **503** / run id **37285932035** — **success**.

## Independent final branch / PR / merged-main CI

Final synchronized PR head `7b8e2db379c2f1d80b5c4e49c11d0f3c91c9d3be` passed:
- push `verify`, run **514** / run id **37286600582** — **success**;
- push `firefox-developer-edition`, run **509** / run id **37286600584** — **success**;
- pull-request `verify`, run **515** / run id **37286606938** — **success**;
- pull-request `firefox-developer-edition`, run **510** / run id **37286607113** — **success**.

Pull request #17 merged as `2fc1b30369ef1625029b41f06fa29366230f68be`.

The exact merged main commit passed:
- GitHub Actions `verify`, run **516** / run id **37286746054** — **success**;
- GitHub Actions `firefox-developer-edition`, run **511** / run id **37286745925** — **success**.

## Acceptance decision

The MERGED governance checkpoint `8e0c0a2da5f515fc388eb411121bcf0e545107cd` passed:
- repository verification run **517** / run id **37286935173** — **success**;
- pinned Firefox Developer Edition run **512** / run id **37286935119** — **success**.

Together with the exact-product-source focused U/I/C suite, accepted P013/P014 dependencies, branch/PR CI, and exact merged-main CI, this satisfies **A017-01**, **A017-02**, and **A017-03**. P017 is **ACCEPTED**.
