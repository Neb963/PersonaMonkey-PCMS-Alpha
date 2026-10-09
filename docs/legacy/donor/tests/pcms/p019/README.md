# P019 — Account Provisioning module evidence

Phase state: **ACCEPTED**.

## Implemented scope

P019 introduces a module-owned, finite Account Provisioning state machine. It deliberately does not introduce a generic workflow engine, browser automation authority, login endpoint assumptions, or CAPTCHA solver.

- provisioning attempts are bounded durable module state and reference credentials only through opaque P006 `SecretRef` values;
- guarded provider-session identity is fenced by module-visible session key/generation while the transient session handle is never persisted;
- P012 HumanTask is the only CAPTCHA/operator-intervention path; CAPTCHA is never solved or bypassed automatically;
- remote account creation uses a stable `account.provision` operation identity and a RemoteControl boundary that requires durable RemoteOperation state before external dispatch;
- ambiguous outcomes transition to `UNCERTAIN` and cannot be replayed until reconciliation proves `NOT_APPLIED` or `APPLIED`;
- proven pre-dispatch/no-apply retries reuse the same operation identity where possible, while a terminal proven `NOT_APPLIED` retry receives a new operation epoch;
- successful remote provisioning enters idempotent local finalization into the accepted P014 Accounts service; recovery can finish local state without redispatching a successful remote mutation;
- stale guarded sessions invalidate HumanTask progress for mutation purposes and require a fresh guarded session/preflight before provisioning continues;
- module code has no raw `browser.*`, native RPC, IndexedDB, direct network/DOM authority, secret resolution, or CAPTCHA-bypass path.

Implementation files:

- `pcms-modules/p019/errors.js`
- `pcms-modules/p019/schema.js`
- `pcms-modules/p019/provisioning.js`
- `pcms-modules/p019/provider.js`

Focused tests:

- `tests/pcms/p019/schema.test.mjs`
- `tests/pcms/p019/provisioning.test.mjs`
- `tests/pcms/p019/provider.test.mjs`
- `tests/pcms/p019/boundary.test.mjs`
- `tests/pcms/p019/harness.mjs`

## Acceptance mapping

### A019-01 — provisioning state machine

Covers bounded attempt schema, Account/Persona reservation checks, guarded session acquisition, provider preflight, durable remote mutation identity, successful account finalization, retry identity fencing, Core-compatible derived ID bounds, opaque SecretRef-only durable credentials, and compatibility with the broader accepted Accounts service surface.

### A019-02 — HumanTask / session guard

Covers explicit CAPTCHA/operator HumanTask creation, no provider mutation while human action is pending, task cancellation on attempt cancellation, guarded-session release, stale-session invalidation after a resolved HumanTask, mandatory reacquisition/preflight, and compatibility with the broader accepted HumanTask/provider service surfaces.

### A019-03 — uncertain / CAPTCHA-safe behavior

Covers ambiguous dispatch entering `UNCERTAIN`, blocked replay, `UNKNOWN` reconciliation remaining uncertain, proven `APPLIED` reconciliation finalizing exactly once, proven `NOT_APPLIED` allowing a new operation epoch, pre-dispatch ambiguity reusing stable operation identity, interrupted finalization without redispatch, fail-closed provider protocol validation, and static checks excluding CAPTCHA solver/bypass and privileged browser/native/storage/network authority.

## Focused verification actually run

The available execution environment does not provide a local repository checkout, so no local Node command is claimed.

Instead, the exact P019 product and committed test sources from PR head `454ce60fa7166eab3bbe7c9402f6c9827ea801c4` were fetched through the GitHub connector and executed in its JavaScript isolate:

- the 15 committed schema/provider/provisioning test bodies passed **15/15**;
- the isolate lacks Node's global `structuredClone`, so a deterministic JSON clone shim was supplied only to the test harness/test bodies; product code was not modified;
- the three committed static boundary assertions were executed separately against the exact product sources and passed **3/3**;
- combined focused U/I/C result: **18 checks passed, 0 failed**.

The exact accepted dependency files imported by P019 were also fetched from the same repository head:

- P006 `extension/pcms/secrets/errors.js`;
- P006 `extension/pcms/secrets/secret-ref.js`;
- P014 `pcms-modules/p014/errors.js`;
- P014 `pcms-modules/p014/schema.js`.

The P019 harness emulates the accepted behavioral surfaces for Accounts, HumanTask, guarded provider sessions, and RemoteControl/RemoteOperation state so deterministic ambiguity/recovery scenarios can be injected without live provider/browser access. No P025/P026 LIVE evidence is claimed here.

Repository Actions `npm run verify` does not auto-discover `tests/pcms/p019/*.test.mjs`; its green result is therefore independent repository/claim/upstream/Firefox harness evidence, not the focused P019 behavioral test run.

## Pull request / merged integration

Final PR head `aaf5c9e7cb7387120665f4796cb437e44f181441` passed:

- push `verify`, run **546** / run id **37300078087** — **success**;
- push `firefox-developer-edition`, run **541** / run id **37300078064** — **success**;
- pull-request `verify`, run **547** / run id **37300084144** — **success**;
- pull-request `firefox-developer-edition`, run **542** / run id **37300084318** — **success**.

Pull request #19 merged as `627113f3456b5ea90746e6b8f6792feb86f6c437`.

The exact merged main commit passed:

- `verify`, run **548** / run id **37300207231** — **success**;
- `firefox-developer-edition`, run **543** / run id **37300207217** — **success**.

## Acceptance decision

The MERGED governance checkpoint `6f3745b9be069c835e4d7eaa23edf5a0d1756a6b` passed:

- repository `verify`, run **549** / run id **37300387707** — **success**;
- pinned Firefox Developer Edition, run **544** / run id **37300387696** — **success**.

Together with the 18 exact-product-source focused U/I/C checks, accepted P006/P012/P013/P014 dependencies, final PR-head CI, and exact merged-main CI, this satisfies **A019-01**, **A019-02**, and **A019-03**. P019 is **ACCEPTED**.
