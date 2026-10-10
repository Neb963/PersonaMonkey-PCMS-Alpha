# P401 supply flow

This Core-only composition uses P301 reservations, P203 READY source catalog, P102 durable records and P103 account-scoped Perchance. No second browser executor or generic workflow framework.

processBatch({text,batchId,offset?,limit?,imports?}) validates arbitrary pasted slugs and processes at most 16 tasks serially. The caller supplies the same input, batch ID and explicit import mappings [{key,folder}] on resumed passes. Deterministic operation IDs and persisted P301/P401 rows prevent duplicate creates. UNCERTAIN and recovery holds stop the pass; no blind replay.

Ordinary reservations use P301 two-system ownership/BLOCKED-folder journal and reconciliation. GitHub-first import requires a commit-pinned READY folder with deployable files and authenticated Perchance ownership. It binds locally and leaves the generator EXCLUDED and not refresh-eligible. If no account owns the slug, a P103 adapter constructed with createSupplyImportJournal(storage) may create it through the same typed Persona executor; P102 PREPARED/DISPATCHING precede any external write. Lost replies reconcile through full account inventory, never overwrite an existing GitHub folder, and never retry a confirmed-absent ambiguous create using its old op ID. Source commit/release, account epoch and CAS remain fenced.

Regression: node --test tests/alpha/flows/supply/*.test.mjs. Provider-live acceptance not established.
