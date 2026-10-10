# P205 issue #46 — P204 observation ledger backup completeness

**Claim:** CLM-P205-001, slot-five-p205, epoch 1, ACTIVE; no reassignment.
**Contract:** alpha.contracts.v1, revision 2, unchanged hash `8ef33e48ae5b16037f31f93a8da64146bc6d34829390a3db16616991e345bd7e`.
**Issue:** https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/issues/46
**Repair PR:** https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/51
**Product head:** `1d3d0edd33dfd7cbe890347a75546f24a0c96699`
**Serialized merge:** `0c6b68e307ff2c555b82d85c870ad72f6c0d6208`
**Status:** Product MERGED and independently CI_VERIFIED; not GATE_VERIFIED/ACCEPTED.

### Minimum guarantee and implementation
- Mandatory P102 records+journal are snapshot-exported as before. P204 fact rows are separate authoritative IndexedDB data; they are **not** in P102 snapshots.
- BackupBundle version 1 retains original-v1 decode compatibility. New `coverageRevision=2` includes a validated P204 facts section with SHA-256 (only from injected read-only `inventoryFactsStore.list()`) **or** explicit `alpha.inventoryFacts UNAVAILABLE` in absentItems.
- Source drift, accepted provider/source revision, ignored revision, binding epoch, ownership and observation revision fields roundtrip intact. Cross-store reads are not atomic and are never presented as such.
- Strict coverage matching rejects false present/absent claims, missing sections, corrupt section/manifest checksums, duplicate fact keys, invalid P204 fact schemas and unsupported coverage versions. Previous v1 archives are still verified but the preview adds facts to missing inventory.
- Staged restore is read-only, exposes counts, `integrityVerified=true`, `recoveryCompleteness=PARTIAL`, `crossStoreAtomic=false`, unavailable components and proposed `RECOVERY_HOLD`. No restoration authority is asserted.
- Neither P204 nor P405 nor contracts, plan, registry or gate evidence is edited.

### Actual verification
- Independent PR CI on `1d3d0edd33dfd7cbe890347a75546f24a0c96699`: alpha-governance `38052537248`, alpha-firefox `38052537276`, firefox-developer-edition `38052537288` — all SUCCESS.
- Independent merged-main CI on `0c6b68e307ff2c555b82d85c870ad72f6c0d6208`: alpha-governance `38052820411`, alpha-firefox `38052820389`, firefox-developer-edition `38052820398` — all SUCCESS.
- Hosted Node Alpha suite: **162/162 passed**, including **8/8 P205 tests** (four new tests for nonempty drift/ignored facts, old-v1/absence, corruption/metadata, failed reads).
- Exact merged governance job `114215247229` logs checked: synthetic sensitive marker **absent**, serialized archive **absent**. The tests do not emit private fixture bytes.
- No local test execution was possible in this isolated repair session; the exact commit was executed in independent hosted CI.

### Explicit remaining boundaries
P204 read-only source wiring is optional until approved by future integration; absent ledger prevents silent coverage claims. Cross-store snapshot time consistency is not guaranteed and requires recovery hold reconciliation. Actual restore application/download retention are P405; GATE-R2 remains for its independent checker. No Perchance/Mullvad/provider-live acceptance.
