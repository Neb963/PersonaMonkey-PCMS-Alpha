# P204 generator inventory and drift facts

Implementation uses the P102 authoritative GeneratorRecord/CAS storage and P103 account-scoped discovery interface. P204 owns only the auxiliary IndexedDB observation ledger, indexed local queries, and bounded reconciliation; it performs no provider mutation or public-feed inference.

Acceptance mapping:

- AP204-01: 1,001 entries, stable indexed filtering/pagination, bounded 64-row storage transactions and imported EXCLUDED intent.
- AP204-02: authenticated account enumeration across provider pages; duplicate identity, interrupted pages, session failure and missing ownership fail closed, not as public-feed absence.
- AP204-03: independently retained listing, fleet intent, provider/source revisions, binding epoch and recorded drift; ignore is scoped to the exact observed source revision and baseline adoption requires confirmed APPLIED operation evidence.

Local isolated unit run: `node --test /mnt/data/p204/tests/alpha/inventory/inventory.test.mjs` — 5 passed using explicit local P102/P103 test shims; not a full integration verification. On repository checkout run `node --test tests/alpha/inventory/*.test.mjs`, `node tools/alpha/run-tests.mjs`, and `npm run verify`. Independent PR CI and merged-main CI determine verification states. Provider-live verification remains unestablished.
