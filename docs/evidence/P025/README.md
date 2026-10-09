# P025 — Live acceptance 1

Phase state: **ACCEPTED**.

## Rejected candidates

Two earlier P025 candidates are rejected and must not be used:

1. SHA-256 `2f54280f96f08013c9499566e3044edfa98a3609966ff1ea734f71b54e8a0cc6` — installed primarily as PersonaMonkey with only a thin PCMS shell.
2. SHA-256 `0ca203d9b63aa98897807efc546810cf6593a1f48e4e3c6ff6e8fe4ff6c07b03` — corrected product identity/modules, but live Firefox remained at `Loading PCMS…` / `Connecting…` and never populated even the synchronous Core fields.

The second failure was reproduced deterministically from the actual XPI module graph.

## Root cause

Accepted P014–P019 sources live in the repository under `pcms-modules/**` and legitimately import accepted Core contracts with repository-relative paths such as:

`../../extension/pcms/providers/perchance/contract.js`

The XPI build flattens the repository's `extension/` directory to the archive root. It copied `pcms-modules/**` unchanged, so those imports resolved inside the XPI to nonexistent `extension/pcms/**` paths. Firefox rejected the ESM graph before `pcms/app/app.js` could execute, which explains why Namespace/Broker fields remained `—` while the static HTML was visible.

## Corrective implementation

The P025 build now:

- preserves accepted repository module sources unchanged;
- relocates only repository-relative `extension/` import specifiers while copying modules into the XPI, e.g. `../../extension/pcms/...` → `../../pcms/...`;
- validates every static/dynamic ESM edge under packaged `pcms/**` and `pcms-modules/**` before producing the archive;
- fails the build on a missing packaged module target or a bare module specifier;
- keeps a single PCMS runtime copy in the archive rather than duplicating `extension/pcms/**`;
- retains the existing Persona Broker / Integration-v1 authority boundary and keeps P025 provider mutations fail-closed.

## Focused verification

Focused release workflow run **37440898249** passed on product checkpoint `def34bf31c9ef7e32416588101f044fcc345b840`:

- **6/6** focused P025 tests;
- **3/3** frozen-upstream integrity tests;
- exact frozen PersonaMonkey baseline XPI SHA-256 `928b94a871d70455e42c2a8269a7adec27c59b3c5937e7618f80da218fb126e1`;
- derivative XPI reproducibility across UTC and Europe/Warsaw;
- ZIP integrity;
- no packaged `pcms-modules/**` source retains `../../extension/pcms/`;
- relocated Deployer import resolves to `../../pcms/providers/perchance/contract.js`;
- relocated Provisioning import resolves to `../../pcms/secrets/secret-ref.js`;
- exact pinned Firefox Developer Edition **153.0b10** loaded the unpacked release graph and reached the `__pcms_booted__` probe, proving `app.js` executed past module loading.

Replacement candidate from that workflow:

- version: **1.2.0**;
- Gecko ID: **persona-route-manager@local**;
- SHA-256: `e316e2fd6d52f359d865b9c396a7af9e47d9ea99337fc9de7330e24bb2e469e8`;
- artifact id: **11401555882**;
- artifact ZIP digest: `sha256:28176f5abbab6bae019838707b55e0a4243fedf48abe881d9c3a69c3080465b9`.

## Merge / merged-main verification

PR #31 merged as `0501b533ab2cddbe135bc3dc0ee8ef3dade0419e`. The final PR-head product tree and merge tree are identical.

Merged main passed:

- repository verification run **726** / run id **37441371432** — **success**;
- pinned Firefox Developer Edition run **721** / run id **37441371555** — **success**.

## LIVE acceptance

Operator LIVE acceptance was supplied on **2026-10-06** for the replacement XPI SHA-256 `e316e2fd6d52f359d865b9c396a7af9e47d9ea99337fc9de7330e24bb2e469e8`.

- **A025-01 — PASS:** operator screenshots show the installed PCMS product booted successfully, all five feature-module projections available, Namespace `v1`, Persona Broker contract `v1`, 55 broker commands, implementation `integration-v1-adapter`, and `Live Integration v1 = Connected · rev 1`.
- **A025-02 — PASS:** operator reports both standard Persona operation and Mullvad-protected Persona operation working correctly in the live Firefox environment.
- **A025-03 — PASS:** operator reports an existing Perchance login/session working correctly in the live setup.

The live screenshots additionally show Explorer, Deployer, Refresher, Statistics and Provisioning all reporting `Live module state connected`.

No representative provider mutation, recovery, restore/update, or final human-acceptance evidence is claimed here. Those behaviors remain exclusively in P026.

These LIVE observations, together with the merged deterministic/FDE evidence above, satisfy **A025-01**, **A025-02**, and **A025-03**. P025 is **ACCEPTED**.

