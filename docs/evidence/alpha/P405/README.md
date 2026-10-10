# P405 interim implementation evidence

Product branch changes only P405-owned integration, tests, and evidence. No direct P102 IndexedDB replacement, P201 control-store edits or PersonaMonkey internals.

Locally executed (Node v22): `node --test /mnt/data/p405/tests/alpha/backup/integration/downloads.test.mjs /mnt/data/p405/tests/alpha/backup/integration/index.test.mjs /mnt/data/p405/tests/alpha/backup/integration/restore.test.mjs` — 10 PASS, 0 FAIL. Syntax checks of integration modules PASS. `bundle.test.mjs` imports the real P205 codec; it was not executed locally and must be verified in independent GitHub CI.

AP405-01: PARTIAL — P205 unencrypted consent-gated export wired to Firefox downloads and explicit absent-items ledger; no packaged export proven.
AP405-02: BLOCKED — simulated authorized restore port handles staged preview, durable hold and reconciliation without replay. Production P102/P201/typed PersonaMonkey restorer is absent; real apply stays UNSUPPORTED_CAPABILITY. No real successful restore or provider reconciliation is claimed.
AP405-03: LOCAL PASS — known successful download ID retention, interrupted/pending exclusion, unknown-file warning, delete-failure warning. Actual packaged Firefox coverage is unverified.

Evidence status remains below MERGED and GATE_VERIFIED. No provider live testing. Real P405 acceptance requires separately authorized owner-boundary repair plus integrated tests.
