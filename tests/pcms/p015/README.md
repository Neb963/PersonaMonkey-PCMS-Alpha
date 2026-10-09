# P015 — Deployer module evidence

Phase state: **ACCEPTED**.

## Implemented scope

P015 adds a bounded Deployer feature module under `pcms-modules/p015/**`.

- durable Deployment identity owns exactly one stable Perchance generator target;
- desired state stores a monotonic desired revision and SHA-256 source hash, never source bytes;
- observed state advances only after a confirmed applied RemoteOperation;
- account identity is durable `AccountId`; provider execution is resolved through an account-scoped ProviderGate;
- mutation intent uses the accepted P013 `generator.update` action and stable generator target identity;
- module state is moved to ACTIVE before ProviderGate dispatch, preventing concurrent desired-state changes from racing an in-flight mutation;
- ambiguous outcomes enter RECONCILE and cannot be retried until RemoteOps reconciliation proves the outcome;
- reconciled NOT_APPLIED reuses the same RETRYABLE RemoteOperation; direct NOT_APPLIED requires a new durable operation identity before another dispatch;
- restart-style ACTIVE state can be recovered from authoritative RemoteOperation state;
- the module exposes a read-only UI projection with sync state and permitted actions, without adding DOM/browser authority.

## Acceptance mapping

### A015-01 — desired/observed model

Covers durable target ownership, desired revision/hash, confirmed observation, source-byte exclusion, account/provider validation, target uniqueness and CAS fencing.

### A015-02 — stable target mutation

Covers account-scoped ProviderGate execution, accepted Perchance `generator.update` contract use, stable target/intent fingerprinting, transient source hash verification, durable RemoteOperation identity and safe retry identity.

### A015-03 — reconciliation/UI

Covers post-apply and pre-apply ambiguity, reconcile-before-retry, restart recovery, blocked desired changes while outcome is unresolved, and deterministic UI-ready status/action projection.

## Focused verification actually run

Node: **v22.16.0**.

Commands executed against a reconstructed local slice:

```text
node --check pcms-modules/p015/errors.js
node --check pcms-modules/p015/schema.js
node --check pcms-modules/p015/deployer.js
node --test focused.test.mjs
```

Result: **9 tests passed, 0 failed, exit 0**.

The three product-source files in that local slice were byte-checked with `git hash-object` against the GitHub blobs at implementation checkpoint `32bd01420f22bfc19710aaab4cef1b175929f386`:

- `pcms-modules/p015/errors.js` — `ef045beba5ebd6340fc9b1b009098f6884ac5167`;
- `pcms-modules/p015/schema.js` — `b2f1b1bd3231f8358bf879c2e3ac85f8980455fa`;
- `pcms-modules/p015/deployer.js` — `8b534f6d3769c014d9527c483b3a71bb4565065e`.

The local container could not resolve GitHub hosts, so a repository clone was unavailable. The focused harness therefore supplied deterministic accepted-contract test doubles for P010/P013 dependencies while executing the exact P015 product blobs. It covered desired/observed state, target fencing, source mismatch before mutation identity, successful stable-target application, fresh operation identity after direct NOT_APPLIED, pre/post-apply ambiguity, reconcile-before-retry, restart-style ACTIVE recovery, UI projection, and static privileged-authority exclusions. The committed `tests/pcms/p015/deployer.test.mjs` separately binds the same scenarios to the real accepted P010 RemoteOps/ProviderGate and P013 adapter/emulator imports for repository execution/review.

## Independent branch CI

Implementation/test checkpoint `32bd01420f22bfc19710aaab4cef1b175929f386` passed:

- GitHub Actions `verify`, run **446** / run id **37265066464** — **success**;
- GitHub Actions `firefox-developer-edition`, run **441** / run id **37265066400** — **success**.

The root workflows are independent repository/FDE regressions; they do not substitute for the focused P015 behavior slice described above.

No live provider, Firefox DevTools MCP, raw browser/native API, guessed Perchance selector, or successor-phase behavior is included.


## Pull request / merged integration

Final PR head `f3eb2563c988ec022f9d1eebef2d87944520ba06` passed:

- GitHub Actions `verify`, run **461** / run id **37266041294** — **success**;
- GitHub Actions `firefox-developer-edition`, run **456** / run id **37266041303** — **success**.

Pull request #15 merged as `9c7af7dbbf2657998300dee6112827a5cfef63bf`.

The exact merged main commit passed:

- GitHub Actions `verify`, run **462** / run id **37266124247** — **success**;
- GitHub Actions `firefox-developer-edition`, run **457** / run id **37266124100** — **success**.

Acceptance still requires the MERGED governance checkpoint to pass.

## Acceptance decision

The MERGED governance checkpoint `da6244da6942faf322be95ea191a921cab8aaab5` passed:

- repository verification run **467** / run id **37266374987** — **success**;
- pinned Firefox Developer Edition run **462** / run id **37266374976** — **success**.

Together with the exact-source focused U/I/C slice, final PR-head CI, exact merged-main CI, and accepted P010/P013/P014 dependencies, this satisfies **A015-01**, **A015-02**, and **A015-03**. P015 is **ACCEPTED**.
