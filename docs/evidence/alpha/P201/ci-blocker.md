# Separate CI maintenance required

Main: `c2a86420488e9cab7a8c162b75f6698e47dd71fc`. The published P201 claim is CLM-P201-001, slot-one-r2, epoch 1. No governance or workflow file is changed by P201.

PR #44 introduced three governance regressions which assume the mutable current derivative remains pre-P201:

- `the real derivative PersonaMonkey regression detects missing routing authority` copies the current extension without the required P201 tests, then expects NOT_IMPLEMENTED.
- `active Alpha Core cannot coexist with reachable legacy Core authority` assumes the copied bootstrap still imports legacy PCMS. After P201 it already imports Alpha, so `keepLegacy` adds no legacy authority.
- `Core introduction requires packaged P201 acceptance; deleting implementation cannot downgrade verification` deletes the fixture Alpha bootstrap and then copies the current Alpha bootstrap, leaving its import unresolved instead of restoring the intended historical bootstrap.

Local `npm run verify` reaches 49 governance tests: 46 pass, these three fail. Historical donor verification and the mandatory P201 packaged policy are separate and unchanged. No failing check is bypassed or relabeled as success.

The narrow repair is one ordinary, separately authorized MAINTENANCE transaction owning only `tests/alpha/governance/ci-migration.test.mjs` and its fresh context. No workflow or validator expansion is necessary. Make the disposable pre-P201 fixture explicitly remove copied Core/bootstrap directories and restore bootstrap/manifest bytes from the exact pinned donor; restore that same historical bootstrap in the deletion test. Preserve every assertion, the donor test bytes, actual derivative policy, production XPI checks and fail/skip/TODO rejection. Add a fixture assertion proving it is pre-P201 even when the actual derivative has Core files.

This is a concrete repair proposal, not authorization to edit that file. `docs/implementation/alpha/GOVERNANCE.md` requires a fresh explicitly authorized maintenance ID and a repository-owner GitHub comment approving the final exact base and candidate SHA. The P201 PHASE token has no maintenance privileges. The already consumed MAINT-P201-CI-MIGRATION-005 context cannot be reused. Only trusted-main validation, independent checks, a serialized exact-main merge and merged-main verification can integrate that repair. P201 cannot merge while a required governance check fails.
