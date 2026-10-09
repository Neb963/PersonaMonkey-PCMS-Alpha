# P003 — PCMS namespace/UI entry + internal Persona Broker contract

Status: **ACCEPTED**

Implementation checkpoint: `7da922a84e8393d303ddd40a3570f7d6be55a23e`.

## A003-01 — Persona Broker contract

P003 defines a transport-neutral Persona Broker contract at
`extension/pcms/core/persona-broker-contract.js`.

The contract preserves the authoritative PersonaMonkey Integration API v1 semantics without importing PersonaMonkey service objects:

- contract version: **1**;
- durable Persona identity: **`personaUid`**;
- command catalog: **55 commands**;
- stable error vocabulary: **43 codes**;
- callable broker shape: `request(request) -> Promise<response>` plus `subscribe(listener) -> { disconnect() }`;
- versioned request/response/event envelopes with request/operation correlation and boot/revision metadata;
- mutation/side-effect fencing: operation ID plus exact boot/revision precondition;
- fail-closed response/error/event validation at the PCMS boundary;
- Direct, destructive, External Automation and executable-install authority metadata retained per command;
- retry semantics retained per command;
- prototype-inherited command names are rejected.

Direct verification against the checked-in
`extension/lib/management-integration-protocol.js` at the implementation checkpoint passed all 55 command semantic comparisons and all 43 stable error-code comparisons.

## A003-02 — PCMS namespace and UI entry

P003 adds a derivative PCMS Core surface without modifying the frozen PersonaMonkey Management compatibility UI:

- `extension/pcms/core/bootstrap.js` installs an immutable `PCMS` namespace;
- repeated installation is idempotent;
- namespace collisions fail closed;
- the namespace exposes the broker contract/version/counts but marks its implementation **`pending-P009`** rather than pretending browser authority exists;
- `extension/pcms/app/index.html` is the new PCMS product entry page and loads only the PCMS bootstrap.

Boundary verification passed for the new PCMS JavaScript surface:

- no raw `browser.*`;
- no native messaging;
- no IndexedDB access;
- no PersonaMonkey service/module imports;
- no legacy `PCMS_REQUEST` / `PCMS_EVENTS` management transport.

The imported `extension/pcms/index.html`, `pcms.js`, and `pcms.css` remain untouched PersonaMonkey compatibility files.

## A003-03 — contract parity and regression coverage

Added:

- `tests/pcms/p003-contract-parity.test.mjs`;
- `tests/pcms/p003-bootstrap.test.mjs`;
- `tests/pcms/p003-boundary.test.mjs`.

The committed tests cover Integration-v1 semantic parity, request fencing, stable error codes, immutable namespace/bootstrap behavior, fail-closed namespace collision handling, authority-boundary restrictions, and separation from the frozen P002 upstream blob set.

A direct verification harness executed the committed P003 source at
`7da922a84e8393d303ddd40a3570f7d6be55a23e` and passed:

- **55/55** command semantic parity checks;
- **43/43** error-code parity checks;
- side-effect request fencing;
- request/response/event correlation and fail-closed validation;
- callable broker interface validation;
- namespace/bootstrap invariants;
- raw-authority boundary checks;
- P002 frozen-upstream separation;
- acceptance coverage for **A003-01, A003-02, A003-03**.

The current repository workflows do not discover `tests/pcms/**`; therefore this evidence does **not** claim that those three phase-specific test files ran inside GitHub Actions. P003 does not own `.github/**` or `package.json`, so CI wiring was not widened outside the claim.

## Independent regression CI

The exact implementation checkpoint passed the repository's existing independent workflows:

- `verify` push run **37235034885** — **success**;
- pinned Firefox Developer Edition push run **37235034855** — **success**.

The same code checkpoint also passed pull-request runs:
- `verify` PR run **37235038610** — **success**;
- pinned Firefox Developer Edition PR run **37235038607** — **success**.

These workflows independently verify repository governance, frozen PersonaMonkey baseline integrity, and pinned Firefox regression. They are recorded separately from the direct P003 phase verification above.

## Scope review

Diff from the durable P003 claim checkpoint
`7a7e877862485d2d5b3fa607da645f58d33b6877` to implementation checkpoint
`7da922a84e8393d303ddd40a3570f7d6be55a23e`:

- **8** product/test files under `extension/pcms/**` and `tests/pcms/**`;
- required P003 evidence plus plan/claim/generated-roadmap governance records;
- **0** frozen PersonaMonkey blobs modified;
- **0** product/test paths outside P003 ownership.

No live provider, Mullvad, Perchance, or Firefox DevTools MCP testing is claimed for P003.

## Pull request and merged-main verification

Pull request #3 final head `a97719c22d462f91a2b5bb4f23de9e55edb3490d` passed:
- PR repository verification run **37235172758**;
- PR pinned Firefox Developer Edition run **37235172738**.

PR #3 merged as `1a26c6dfceecee96fbc0d38b414a128b15f849e1`.

The exact merged `main` commit passed:
- repository verification run **37235284783**;
- pinned Firefox Developer Edition run **37235284784**;
- Firefox smoke artifact **11314774985**, digest `sha256:7cc3a3fc42eb9ba041675465b8adbe827f06cf96a6ca31fd16c25aec528728a1`.

This establishes integration evidence for the exact merged source. P003 is not marked ACCEPTED until this MERGED governance checkpoint itself is repository-verified.

## Acceptance decision

The durable MERGED governance checkpoint `834fa2d48e0d3080eab75a409ff09a0700076493` passed:
- repository verification run **37235419785**;
- pinned Firefox Developer Edition run **37235419806**;
- Firefox smoke artifact **11315715373**, digest `sha256:f5c03a8240bb9b27e55ba75e26cd14c5c5e02e97673a8dd073b74f7e0e1504e4`.

Together with the direct P003 contract/bootstrap/boundary verification recorded above, this satisfies A003-01, A003-02 and A003-03. P003 is ACCEPTED.

P009 becomes READY by dependency resolution only. No P009 implementation is started in this session.
