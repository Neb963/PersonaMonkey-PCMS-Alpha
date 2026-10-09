# P037 evidence — repository provider, manual scan, assisted deployments

Claim: CLM-P037-001, epoch 1. Dependency P036 accepted. Claim base: 14c58d1201cd8cd65ea82a71e1e8a5ff8f02fb7a. Published acquisition on main: d6fd3bbe1168d3c268f429b6daf25a3da43b329e.
Implementation head: da8dc6d7386cb3c98c33a2eeccb853b3e8b3a5f3. [PR #60](https://github.com/Neb963/persona-monkey-pcms/pull/60). State: ACCEPTED after merged-main verification.

## Implementation

- T037.1: Typed pcms.repository-provider/v1 boundary, bounded read-only GitHub REST requests, deterministic fixture provider. SecretRef tokens resolve only via the dedicated privileged secret host.
- T037.2: pcms.generator-repository/v1 validation, commit-pinned release hashes and snapshots, immutable 20-version ledger, duplicate and invalid release blocking. No release content retained in state.
- T037.3: Durable bounded manual scan checkpoints, error-safe snapshot preservation, Deployer desired preparation and identity-fenced folder/account mapping; adoption and assisted deployment through existing RemoteOps and ProviderGate; P033 module page.

## Acceptance evidence

| Gate | Test evidence |
| --- | --- |
| A037-01 | Deterministic pinned snapshots, canonical content hashes, typed provider projections, rate-limit classification |
| A037-02 | Changed/unchanged release handling, immutability rejection, duplicate slug isolation and JPEG fingerprint |
| A037-03 | Failed scans preserve previous snapshot; no duplicate preparation; busy-target retry, account rebinding, held release, bounded HTTP |

- tests/pcms/p037/repository.test.mjs: 14/14 PASS at da8dc6d7386c.
- [Verify CI #37778624796](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37778624796): SUCCESS (npm run verify including P037).
- [Pinned Firefox CI #37778624837](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37778624837): SUCCESS; seven jobs, including packaged extension regression checks.

## Scope boundary and integration

P038 owns timers/cadence/restart scheduling; P039 owns drift observation; P042 owns unattended dispatch; P043-P044 own final live checks. None are included. No live Perchance testing occurred.

**Merged main and acceptance:** PR #60 merged at `9b5b2ad89f2616221397d6beb9349d28793d6cd5`.
- [Merged-main verify run 37780053251](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37780053251): SUCCESS.
- [Merged-main Firefox run 37780053264](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37780053264): SUCCESS; all seven jobs green.
Phase and claim accepted on this independent merged-main evidence. Final operator-environment Perchance live acceptance remains in the later designated phases.
