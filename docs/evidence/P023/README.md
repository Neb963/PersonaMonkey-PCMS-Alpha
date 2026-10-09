# P023 — Full module integration wave evidence

Phase state: **ACCEPTED**.

## Implemented scope

P023 adds a narrow PCMS Core integration layer under `extension/pcms/integration/**`. It composes accepted mechanisms and module factories without moving feature policy into Core.

- shared P005 storage is adapted into bounded singleton/keyed state-store contracts used by P014–P019;
- Persona lookup is adapted only through P009 `persona.get`, preserving `personaUid` as the durable identity;
- account-scoped ProviderGate and RemoteOperation-reader adapters are supplied to Deployer/Refresher;
- Provisioning receives a bounded RemoteControl composed only from ProviderGate mutation/reconciliation plus RemoteOps read;
- real module factories remain injected; Core does not import `pcms-modules/**` or duplicate their policy;
- P012 HumanTask and P014 Accounts instances are wired directly into the accepted P021 UI projection;
- P016 Explorer reservations are materialized into P015 Deployments through an idempotent, fail-closed bridge;
- P018 Statistics consumes the same P007 Audit Journal instance used by shared services;
- P019 Provisioning receives the same Accounts/HumanTask authority surfaces as the rest of the composition;
- P022 module lifecycle is exposed over the accepted package registry/runtime;
- P020 backup/restore is instantiated with recovery checks derived from integrated Account↔Persona reconciliation and provider compatibility probes;
- no raw `browser.*`, native RPC, raw IndexedDB, PersonaMonkey internals, provider transport, or global workflow/scheduler authority is introduced.

Implementation files:

- `extension/pcms/integration/errors.js`
- `extension/pcms/integration/adapters.js`
- `extension/pcms/integration/explorer-deployer.js`
- `extension/pcms/integration/recovery-checks.js`
- `extension/pcms/integration/composition.js`

Focused tests:

- `tests/pcms/p023/harness.mjs`
- `tests/pcms/p023/contracts.test.mjs`
- `tests/pcms/p023/integration.test.mjs`
- `tests/pcms/p023/boundary.test.mjs`

## Acceptance mapping

### A023-01 — cross-module contracts

Covers the shared state-store/CAS adapters, Persona Broker read boundary, construction of the real accepted P014–P019 factories, live Accounts/HumanTask→P021 UI projection wiring, P018 journal sharing, Refresher account integration, and the idempotent Explorer→Deployer materialization contract.

### A023-02 — integration-wave verification

The committed integration suite imports the real accepted P014–P019 factories together with P005/P007/P010/P011/P020/P021/P022 Core surfaces. Static guards prove Core composition does not import feature-policy source or gain browser/native/raw-storage authority.

### A023-03 — combined recovery acceptance

Covers backup of shared Accounts, HumanTask/Audit, Explorer, and Deployer state; post-backup divergence; staged restore under RECOVERY_HOLD; restoration of the shared module/UI projection state; module-generation reconciliation; Account↔Persona reconciliation; provider compatibility checks; hold release only after all checks clear; and Statistics replay from the restored journal tail.

## Focused verification actually run

The available execution environment does not provide a local repository checkout, so no local Node command or direct execution of `tests/pcms/p023/*.test.mjs` is claimed.

The exact P023 product sources and committed integration-suite source at checkpoint `0076a5feabf9c43d95a3e058f1edc29fe1cff112` were fetched through the GitHub connector and exercised in its JavaScript isolate.

Result: **14 checks passed, 0 failed**.

The executed checks cover:

- singleton and keyed P005-facing CAS adapters, including conflict projection;
- read-only `persona.get` mapping and PERSONA_NOT_FOUND handling;
- account-scoped ProviderGate resolution and bounded Provisioning RemoteControl;
- Explorer→Deployer idempotent materialization and fail-closed conflict handling;
- integrated Account↔Persona/provider recovery checks, including fail-closed probe failures;
- construction of all six accepted P014–P019 feature-factory contract slots;
- sharing of Accounts, HumanTask, Audit Journal, runtime, module registry, and recovery authorities across the composition;
- injection of the integrated reconciliation checks into P020 backup/restore;
- absence of raw browser/native/IndexedDB/network authority in P023 Core;
- absence of direct `pcms-modules/**` feature-policy imports in the Core composition root;
- committed integration-suite binding to the real P014–P019 factories and the combined RECOVERY_HOLD restore/release scenario.

The isolate does not provide `structuredClone`; a deterministic JSON clone shim was used only by the verification harness. Product code was not modified.

Independent branch checkpoint `0076a5feabf9c43d95a3e058f1edc29fe1cff112` passed:

- repository `verify`, run **595** / run id **37349672706** — **success**;
- pinned Firefox Developer Edition, run **590** / run id **37349672700** — **success**.

The root `npm run verify` workflow does not auto-discover `tests/pcms/p023/*.test.mjs`; root Actions remain independent repository/claim/upstream/Firefox evidence.

## Pull request / merged integration

Final PR head `c9679653fb4b58cbd1b6df27f86ced811ecb7f6b` passed:

- push repository `verify`, run **600** / run id **37350869411** — **success**;
- push pinned Firefox Developer Edition, run **595** / run id **37350869446** — **success**;
- pull-request repository `verify`, run **601** / run id **37350939424** — **success**;
- pull-request pinned Firefox Developer Edition, run **596** / run id **37350939400** — **success**.

Pull request #23 merged as `25e6a8c01973341d97b1dcbedc0f75e668b1755f`.

The exact merged main commit passed:

- repository `verify`, run **602** / run id **37352319276** — **success**;
- pinned Firefox Developer Edition, run **597** / run id **37352319423** — **success**.

## Acceptance decision

The MERGED governance checkpoint `cb7254402fba6ade5c26c0c72b2a3eb0bf7ffe1b` passed:

- repository `verify`, run **603** / run id **37352617133** — **success**;
- pinned Firefox Developer Edition, run **598** / run id **37352617102** — **success**.

Together with the **14/14** exact-source focused integration checks, the committed real-factory P014–P019 integration/recovery suite, final PR-head CI, exact merged-main CI, and accepted P005/P007/P009/P010/P011/P012/P014–P022 dependencies, this satisfies **A023-01**, **A023-02**, and **A023-03**. P023 is **ACCEPTED**.

No P025/P026 LIVE evidence is claimed.
