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
