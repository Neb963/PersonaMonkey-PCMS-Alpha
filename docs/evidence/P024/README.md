# P024 — Adversarial/security/fault/release-candidate hardening evidence

Phase state: **ACCEPTED**.

## Implemented scope

P024 adds a deterministic hardening/acceptance layer without adding a second browser, workflow, scheduler, packaging, or provider authority.

Focused tests:

- `tests/pcms/p024/fault-security.test.mjs`
- `tests/pcms/p024/release-candidate.test.mjs`
- `tests/pcms/p024/restart.test.mjs`
- `tests/pcms/p024/boundary.test.mjs`
- `tests/pcms/p024/README.md`

No product-code change was required: adversarial inspection did not identify a defect in the accepted P006/P008/P010/P011/P020/P022 mechanisms exercised by this phase.

## Acceptance mapping

### A024-01 — adversarial/security/fault matrix

Injected checks cover ambiguous provider dispatch, durable UNCERTAIN state, no blind replay after restart, interrupted DISPATCHING recovery, RECOVERY_HOLD fencing, explicit reconciliation/cancellation before release, and secret-error redaction/opaque references.

### A024-02 — reproducible release package

The focused release test executes the repository's current `scripts/test-build-reproducibility.mjs`, validates the SHA-256 sidecar, inspects the XPI, proves required PCMS members are present, and rejects test-source leakage.

The current branch retains the exact frozen upstream packaging implementation:

- `scripts/build-extension.mjs` blob `512c437e4a07400e8553340ccfb12e5c7adfae53`;
- `scripts/test-build-reproducibility.mjs` blob `f5d2d104935e9a36934d3d464ceadf510ae4d105`.

Those are exactly the blob identities recorded by `docs/upstream/import-manifest.json` for the upstream release builder/reproducibility test. The frozen upstream package run concluded success and recorded expected XPI SHA-256 `928b94a871d70455e42c2a8269a7adec27c59b3c5937e7618f80da218fb126e1`.

At checkpoint `116cf4bfac99679d72ed9d2fa4f3de09c53aca72`, the repository tree contains 218 `extension/**` blob/tree entries, including 75 `extension/pcms/**` entries, with no symlink/submodule/special Git entries. The unchanged builder sorts archive paths, normalizes mtimes, fixes timezone/locale, uses `zip -X`, and hashes the resulting XPI, so the added ordinary PCMS files do not introduce a nondeterministic archive input class.

### A024-03 — clean install/update/restart

The committed restart test composes the accepted module lifecycle, immutable package registry, sandbox runtime, generation fencing, and recovery hold. It covers first install, update to a distinct package hash, abrupt restart recovery, stale-runtime rejection, activation blocking during RECOVERY_HOLD, and reactivation of the same admitted package after hold release.

## Focused verification actually run

The available shell has no repository checkout and cannot resolve GitHub, so no local Node command or direct execution of `tests/pcms/p024/*.test.mjs` is claimed.

Exact product sources from checkpoint `116cf4bfac99679d72ed9d2fa4f3de09c53aca72` were fetched through the GitHub connector and exercised in its JavaScript isolate:

- RemoteOps / ProviderGate / RECOVERY_HOLD fault injection: **13/13 checks passed**.
- Secret mutation ambiguity/redaction: **5/5 checks passed**. The isolate lacks `TextEncoder`; an ASCII encoder shim was used only for the bounded ASCII test value.
- Module runtime restart/generation recovery: **9/9 checks passed** using a deterministic in-memory storage and sandbox-host stub around the exact committed runtime broker.

Total exact-source focused checks: **27 passed, 0 failed**.

The isolate does not provide a filesystem/process environment, so the committed current-checkout XPI test is not represented as directly executed there. Package evidence instead combines the immutable current builder identities, frozen real upstream reproducibility/build evidence, current regular-file tree inspection, and root CI's independent upstream baseline replay. The committed test remains the executable clean-checkout acceptance command when a repository checkout is available.

Independent branch checkpoint `116cf4bfac99679d72ed9d2fa4f3de09c53aca72` passed:

- repository `verify`, run **612** / run id **37355786490** — **success**;
- pinned Firefox Developer Edition, run **607** / run id **37355786044** — **success**.

The root workflow does not auto-discover `tests/pcms/p024/*.test.mjs`; these Actions results are independent repository/claim/upstream/Firefox evidence.

## Scope / live boundary

No Firefox DevTools MCP, live Perchance, Mullvad, real provider mutation, CAPTCHA flow, or P025/P026 evidence is used. P025 and P026 remain the final live acceptance phases.

## Pull request / merged integration

Final PR head `e7fb1c003dce0751c3d5a3bfbe4a86bd6945481f` passed:

- push repository `verify`, run **621** / run id **37357497859** — **success**;
- push pinned Firefox Developer Edition, run **616** / run id **37357497879** — **success**;
- pull-request repository `verify`, run **622** / run id **37357504724** — **success**;
- pull-request pinned Firefox Developer Edition, run **617** / run id **37357504830** — **success**.

Pull request #25 merged as `ab5cd97eb8cf15fb503b2fca5a6b49acafbc203a`.

The exact merged main commit passed:

- repository `verify`, run **623** / run id **37357728002** — **success**;
- pinned Firefox Developer Edition, run **618** / run id **37357727595** — **success**.

## Acceptance decision

The MERGED governance checkpoint `8ffbd5ffc1f900911808bfe029514ce6042dbbf7` passed:

- repository `verify`, run **624** / run id **37358069776** — **success**;
- pinned Firefox Developer Edition, run **619** / run id **37358069828** — **success**.

Together with the **27/27** exact-source focused fault/redaction/restart checks, the committed deterministic P024 suite, immutable release-builder provenance and regular-file archive-input proof, final PR-head CI, exact merged-main CI, and accepted P006/P008/P010/P011/P020/P022 dependencies, this satisfies **A024-01**, **A024-02**, and **A024-03**. P024 is **ACCEPTED**.
