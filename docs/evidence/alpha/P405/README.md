# P405 — merged R4 acceptance evidence (not gate acceptance)

**Product implementation:** [PR #98](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/98); authorized repairs [#102](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/102), [#107](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/107), [#109](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/109), [#110](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/110) and [#114](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/114). **Claim:** `CLM-P405-001`, epoch 1, still ACTIVE pending independent GATE-R4.

**Exact integrated main verified:** `2071e5dffdf4d8506425a1a921e266713c29e063`. Independently verified successful GitHub Actions push runs:

| Suite | Run | Conclusion |
|---|---|---|
| alpha-governance | [38159397613](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/38159397613) | SUCCESS |
| alpha-firefox | [38159397614](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/38159397614) | SUCCESS |
| firefox-developer-edition | [38159397608](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/38159397608) | SUCCESS |

Acceptance coverage (exact mapped suites/cases in `acceptance.json`):

- **AP405-01:** P205 consent-gated one-file unencrypted bundle, SHA-256 integrity preview and explicit unavailable-section ledger; typed PersonaMonkey state export; successful real packaged Firefox download. See `tests/alpha/backup/integration/bundle.test.mjs`, `tests/alpha/backup/bundle.test.mjs`, `tests/alpha/core/packaged.test.mjs`.
- **AP405-02:** real P102 IndexedDB atomic restore of records plus operation journal; P201 durable recovery hold and restart; independently persisted P204 inventory facts, P403 execution ledger and P404 attention state; nonempty fleet requires fresh trusted P103/Persona authenticated session and unchanged provider source, with denial for stale binding, lost session, interrupted cross-store commit and ambiguous mutation. See `tests/alpha/domain/storage-cases.js`, `tests/alpha/backup/integration/restore.test.mjs`.
- **AP405-03:** exact known Firefox download IDs and bounded retention; unknown/untracked files left untouched; interrupted/incomplete never evicted; warnings rather than blind deletion. Packaged download/manifest check in `tests/alpha/core/packaged.test.mjs` and deterministic faults in `tests/alpha/backup/integration/downloads.test.mjs`.

**Limits:** P201 holds during uncertain cross-database restoration. No global cross-IndexedDB atomicity is claimed. AI task state, Refresher policy configuration, visibility observations and non-exportable/native/provider data are explicitly marked unavailable (not secretly dropped and not falsely restored). A restored fleet lacking current authenticated Persona/P103 session and exact provider source readback is not released. No live Perchance, Mullvad, credentials, real account or operator-native acceptance was run: `providerLive:false`. Later R6 operator-validated live provider admission remains a separate gate.

**Status:** Phase proof `MERGED` with AP405-01/02/03 evidence; *neither P405 ACCEPTED nor GATE-R4 ACCEPTED is asserted*. The independent GATE-R4 checker must evaluate combined CI, ownership and all R4 phases before setting acceptance.
