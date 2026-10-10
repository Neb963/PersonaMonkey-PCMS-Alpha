# P205 implementation evidence

Claim: `CLM-P205-001` (epoch 1, `slot-five-p205`); source contract revision 2 and hash `8ef33e48ae5b16037f31f93a8da64146bc6d34829390a3db16616991e345bd7e`. Phase depends only on accepted P102. No successor, shared contracts, provider mutation or privileged PersonaMonkey internals are changed.

## AP205-01 — schema/checksum and recovery preview

- `extension/alpha/backup/bundle.js` implements the fixed v1 unencrypted container, canonical SHA-256 section and manifest verification, binary-preserving Alpha snapshot encoding, bounded/malformed-file rejection, and read-only `stageRestore` yielding `RECOVERY_HOLD` as a *proposed* state. No restore apply method exists.
- Explicit consent is required before constructing the archive. Inability to read a requested authoritative export source aborts generation, never produces a silently partial success.
- Regression: `tests/alpha/backup/bundle.test.mjs` covers byte roundtrip, checksum and format corruption, consent and staged preview.

## AP205-02 — exportability inventory

- `extension/alpha/backup/README.md` has an exportability truth table.
- Alpha records and journal are read from the verified P102 storage snapshot; all unprovided PersonaMonkey exports are represented in an absent-items ledger. Optional PersonaMonkey and sensitive data require explicit independently authorized read-only callbacks; they are never inferred from a Persona Broker command. Sessions, native credentials, and Perchance passwords are not advertised as recoverable.

## AP205-03 — secret-safe reproducibility

Local equivalent implementation and regressions were tested in a detached temporary Node workspace (Node `v22.16.0`) with:
```text
node --test tests/alpha/backup/*.test.mjs
# 4 tests, 4 passed, 0 failed
```
No fixture bytes, decoded archive, secret content or exceptions are printed by P205 runtime or tests. GitHub CI independently executed `node tools/alpha/run-tests.mjs` and the governed pinned Firefox workflows against the exact PR head and merged main. See `acceptance.json` for verified run IDs, SHAs, and outcomes.

**Boundary:** P405 owns actual restore application, download/retention and wired PersonaMonkey export provision. This phase provides no live/provider acceptance and does not assert that missing session material can be restored.

## Verified merge handoff

Product PR #36 was merged with a non-forced, serialized expected-main update at `7cace06a658729e0a68b744598c83ded9b8d1258` from independently tested head `573531ca791c68b3d7b6905ccc264a4d84ee3aba`. All three PR workflows and all three exact merged-main workflows passed. The hosted governance log was inspected for serialized backup archive content and the synthetic sensitive fixture; neither was present.

The claim remains ACTIVE and the phase plan remains CLAIMED. `acceptance.json` records MERGED only; GATE_VERIFIED and ACCEPTED require independently invoked GATE-R2.

## Issue #46 — P204 observation facts integration repair (2026-10-10)

Follow-up repair [PR #51](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/51) was merged at `0c6b68e307ff2c555b82d85c870ad72f6c0d6208` from exact product commit `1d3d0edd33dfd7cbe890347a75546f24a0c96699`, under the **same P205 claim** `CLM-P205-001` (epoch 1, `slot-five-p205`). No new claim or shared-contract change.

The version-1 backup format now distinguishes original v1 archives from `coverageRevision: 2`. New exports include a separately SHA-256-checked P204 facts section only through an authorized, read-only `list()` source; otherwise `alpha.inventoryFacts` is explicitly `UNAVAILABLE` in the manifest and preview. Original v1 archives are accepted for integrity validation but shown as missing P204 facts. Inconsistent or forged hashes, inclusion metadata, coverage versions and fact revisions fail closed. Nonempty source drift and exact ignored revisions are tested.

An integrity-valid archive **is not** a complete recovery: preview explicitly reports `recoveryCompleteness: PARTIAL`, `crossStoreAtomic: false`, counts, unavailable items and proposed `RECOVERY_HOLD`. P102 and P204 have distinct transactional snapshots. No actual restore, downloader, provider mutation, P204 implementation edit or GATE-R2 acceptance occurred.

Hosted independent PR CI: [governance #38052537248](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/38052537248), [alpha-firefox #38052537276](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/38052537276), [pinned Firefox #38052537288](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/38052537288) — all passed. On exact merged main: [governance #38052820411](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/38052820411), [alpha-firefox #38052820389](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/38052820389), [pinned Firefox #38052820398](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/38052820398) — all passed. Hosted full suite **162/162**; P205 regressions **8/8**. The merged governance log was independently inspected (job `114215247229`): neither the sensitive synthetic marker nor a serialized backup archive appeared. No local exact-checkout test was run in this repair session.

R2 independent gate verification and any actual provider-live acceptance remain **unclaimed**. See `acceptance.json.repair46`.
