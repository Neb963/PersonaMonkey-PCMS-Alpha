# Alpha phase acceptance matrix (design)

Three acceptance IDs are allocated per phase: domain correctness, faults/recovery/scale, and reproducible verification. The phase and gate must replace these acceptance summaries with actual mapped reproducible cases without changing IDs.

## P101 — Pinned Firefox and PersonaMonkey regression harness
- AP101-01: Preserve donor PersonaMonkey functionality; establish exact pinned Firefox Developer Edition packaged-XPI browser regression and isolated smoke harness. Do not modify PCMS Alpha feature implementation.
- AP101-02: packaged XPI install/restart and baseline Persona/routing/broker contracts.
- AP101-03: reproducible exact Firefox artifact with actual command/commit/CI evidence.

## P102 — Generator/domain persistence and durability
- AP102-01: Implement frozen Account/Generator/Release/Operation record normalization and isolated Alpha storage with migration tests, CAS and atomic journal semantics. No provider mutations or UI.
- AP102-02: schema/CAS/revision collision and storage reopen and corruption.
- AP102-03: no credentials in normal records with actual command/commit/CI evidence.

## P103 — Perchance contract adapter and emulator
- AP103-01: Build a narrow Perchance capability adapter, deterministic fixtures using discovery-v3 evidence, safe read/write classification, and unknown-capability fail-closed handling; do not assume Brave behavior is Firefox-tested.
- AP103-02: emulated saved/stale/challenge outcomes and ownership/listing/AI source observations.
- AP103-03: no unapproved direct network authority with actual command/commit/CI evidence.

## P104 — GitHub private-repo adapter and safe paths
- AP104-01: Implement configured `per-gens` Contents read/write adapter, strict literal path templates, commit-pinned blobs, conditional atomic source commit and GitHub rate-limit/conflict fixtures. No source-status business logic.
- AP104-02: traversal/ambiguous filename rejection and branch-head conflict no overwrite.
- AP104-03: read/write token redaction with actual command/commit/CI evidence.

## P105 — Static Alpha UI shell and visual foundation
- AP105-01: Create consistent native-feeling visual tokens, static accessible shell, layout and standard UI primitives; no dynamic module contribution system, business state or backend mutations.
- AP105-02: static navigation and keyboard focus and dark/light readable density.
- AP105-03: loading/empty/error state primitives with actual command/commit/CI evidence.

## P201 — Background Core and durable alarms
- AP201-01: Implement one idempotent background Alpha Core, UI request validation, durable timers and operation/tab budget primitives using PersonaMonkey broker semantics. Wire a minimal Alpha background entry into the existing manifest/bootstrap now and disable legacy PCMS Core activation so the packaged browser can exercise Alpha early; P601 later removes unused legacy code.
- AP201-02: two clients one core and idle unload/cold warm wake.
- AP201-03: UNCERTAIN+RECOVERY_HOLD and bounded alarms with actual command/commit/CI evidence.

## P202 — Accounts and Persona enrollment
- AP202-01: Implement manual login enrollment, dedicated Persona binding, route retry, session confirmation, account inventory metadata and safe rebinding previews using only typed Persona broker.
- AP202-02: account↔personaUid epoch and rotation and manual challenge route retry without bypass.
- AP202-03: import existing account-owned generators excluded with actual command/commit/CI evidence.

## P203 — GitHub source catalog and READY interpreter
- AP203-01: Implement commit-pinned `DEPLOYMENT.md` status interpreter, configurable folder/slug mappings, deployable-file availability and canonical release hashing; missing/invalid status blocks.
- AP203-02: READY/BLOCKED/IN_DEVELOPMENT and no redeploy on docs-only edits.
- AP203-03: different folder/slug mappings with actual command/commit/CI evidence.

## P204 — Generator inventory and drift facts
- AP204-01: Implement durable inventory of all account-owned generators, explicit public/unlisted and managed/excluded intent, source versions, unexpected drift evidence and indexed filtering for 1k entries.
- AP204-02: 1k inventory pagination and indexing and non-public discovery not conflated with feed.
- AP204-03: drift and ownership revisions with actual command/commit/CI evidence.

## P205 — Unified backup schema and safe exporter
- AP205-01: Design/implement one explicitly unencrypted local backup container with integrity manifest, PersonaMonkey+Alpha eligible data collection, secrets exportability truth table, staged restore preview and no provider mutation.
- AP205-02: schema/checksum and recovery preview and honest exportable vs unavailable inventory.
- AP205-03: no backup content in CI logs with actual command/commit/CI evidence.

## P301 — Bulk reservations and account balancing
- AP301-01: Implement pasted-slug validation, distributed account selection for new reservations, durable two-system Perchance creation/GitHub folder journal, collision and partial-success reconciliation.
- AP301-02: even allocation of new slots and existing slug collision.
- AP301-03: GitHub failure after remote create no duplicate with actual command/commit/CI evidence.

## P302 — Sleep-only Deployer and rollback
- AP302-01: Implement source-commit-pinned unlisted saves, readback/hash verification, sleeping update gate, last-good snapshot, bounded rollback and failed-revision quarantine. AI approval orchestration comes in P402.
- AP302-02: reject writes to active generators and save/readback and source drift.
- AP302-03: failed update rollback unlisted sleeping with actual command/commit/CI evidence.

## P303 — Native Perchance AI session and editor overlay
- AP303-01: Implement Perchance AI-helper session controller and compact #edit overlay with durable task state, per-account slots, session recovery and approval intent interface. No new AI provider.
- AP303-02: one running AI per account by default and pending review releases concurrency slot.
- AP303-03: tab reload/reconnect/stale editor with actual command/commit/CI evidence.

## P304 — Individual Refresher scheduler and healthy clock
- AP304-01: Implement per-generator active/sleep timing, ±30-minute bounded jitter, downtime/outage-paused healthy clock, automatic cap from eligible population and observed capacity, manual override and longest-waiting selection. No provider refresh mutations here.
- AP304-02: 24/72 population and cap maths and shutdown/outage but not idle unload pause.
- AP304-03: pull-in/pull-out and fairness with actual command/commit/CI evidence.

## P305 — Recent visibility and adaptive metrics
- AP305-01: Implement global 10-minute feed observation, rendered position/filter fixture, adaptive per-generator stats and bounded retry classification; do not dispatch source edit here.
- AP305-02: pinned/filtered/missing classification and 1k request budget.
- AP305-03: daily/weekly views with staleness with actual command/commit/CI evidence.

## P401 — Supply flow and two-sided reconciliation
- AP401-01: Compose reservation, Perchance ownership confirmation, GitHub folder creation, and READY GitHub-first import through concrete durable supply flow; no generic workflow framework.
- AP401-02: paste 200/1k candidates with bounded tasks and GitHub-first mapping.
- AP401-03: resume partially completed reservation with actual command/commit/CI evidence.

## P402 — Release, approval, publication and GitHub writeback
- AP402-01: Compose sleep-only Deployer with AI task, human Mark ready save/readback, branch-head CAS live fixes, public switch, managed enrolment and failed-update quarantine.
- AP402-02: READY update waits for sleep and atomic conditional live-fix commit.
- AP402-03: unlist before update and re-publication after approval with actual command/commit/CI evidence.

## P403 — Refresh execution and visibility feedback
- AP403-01: Compose scheduler, visibility observer, Persona browser execution and transient exact-comment ledger with controlled reload/retry, staggered saves, suspension and attention.
- AP403-02: no source hash drift from trailing comment and bounded retries/reload/suspension.
- AP403-03: top-target position not guaranteed with actual command/commit/CI evidence.

## P404 — Notifications, attention, and tab ownership
- AP404-01: Implement central action-required inbox, deduplicated desktop+in-app notifications and bounded Alpha-owned-tab allocation; never close operator-owned tabs.
- AP404-02: multi-job tab ceiling and desktop warning dedup and user attention.
- AP404-03: pending AI approval reopens editor on demand with actual command/commit/CI evidence.

## P405 — Full backup restore and downloads retention
- AP405-01: Complete backup export/restore integration across PersonaMonkey and Alpha, download to a subfolder with tracked retention, integrity preview and recovery hold. State unsupported export gaps explicitly.
- AP405-02: one unencrypted local file with allowed secrets and successful restore and reconcile.
- AP405-03: known-download retention and unknown-file warning with actual command/commit/CI evidence.

## P501 — Bulk-first Overview and Supply UI
- AP501-01: Build dashboard Overview and bulk reservation/deployment queues using Core projections and fixed UI route contract. No provider state authority inside UI.
- AP501-02: bulk 200 slug input and queue receipts and action-needed summary.
- AP501-03: keyboard and clear partial-error messaging with actual command/commit/CI evidence.

## P502 — Accounts and generator management UI
- AP502-01: Build searchable Account wizard/list and Generator Manager detail/table with 1k rows, managed/excluded/public actions, source-drift ignore scoped per revision, delete confirmation typed yes.
- AP502-02: no manual account IDs on normal flow and 1k rows with fast search.
- AP502-03: safe delete and source-drift impact with actual command/commit/CI evidence.

## P503 — AI approval and deployment review UI
- AP503-01: Build review-queue and deployment detail pages with native Perchance editor deep link, source/provenance, failed-update/quarantined states, human approval receipts and no irreversible guessing.
- AP503-02: AI review queue separate from live slot and reopen #edit with correct Persona.
- AP503-03: explicit failure/UNCERTAIN states with actual command/commit/CI evidence.

## P504 — Refresher, settings and backup UI
- AP504-01: Build simple A/S/cap/margin Refresher settings, live pool/stats, integrated backup export/restore, GitHub token/paths and diagnostics; do not expose scheduler jitter.
- AP504-02: cap auto/manual validation and explanatory state and unencrypted-backup consent and restore preview.
- AP504-03: stats timestamp and failure hints with actual command/commit/CI evidence.

## P505 — Attention and toolbar popup UI
- AP505-01: Build action-required/notifications panel and concise toolbar PCMS status, with fixed validated UI client messages and user-facing error texts. No dynamic module UI.
- AP505-02: notification actions/deep links and popup no Core creation.
- AP505-03: accessible status/keyboard controls with actual command/commit/CI evidence.

## P601 — Production bootstrap and legacy runtime retirement
- AP601-01: Audit and finalize the already-wired Alpha background authority; retire verified unused dynamic module runtime and legacy PCMS product entry without touching PersonaMonkey internals. Preserve full packaged Firefox startup.
- AP601-02: one Core no dormant legacy activation and pinned Firefox packaged boot+restart.
- AP601-03: PersonaMonkey regression still passes with actual command/commit/CI evidence.

## P602 — Fault injection and lifecycle verification
- AP602-01: Add adversarial cross-feature tests for provider uncertainty, crash mid mutation, shutdown and alarm wake, Perchance outages, Cloudflare/session and stale Persona binding; file repair issues/claims for bugs outside owned paths.
- AP602-02: uncertain never blindly retried and healthy-active clock under outages.
- AP602-03: safe manual challenge handling with actual command/commit/CI evidence.

## P603 — Security and GitHub concurrency verification
- AP603-01: Add exact regression/security tests for private-repo branch races, revision conflicts, secret leakage and unencrypted backup handling, content-hash separation, path traversal, update ownership and source drift ignore.
- AP603-02: CAS writeback race and no force and no sensitive data in normal logs or evidence.
- AP603-03: source changes ignored only for exact revision with actual command/commit/CI evidence.

## P604 — Packaged restore and fleet-scale acceptance
- AP604-01: Add deterministic packaged Firefox recovery and scale tests for backup/restore, 50+ Accounts and 1k Generators, no 1k tabs, known download deletion/unknown warnings and multi-dashboard concurrency.
- AP604-02: 50 accounts and 1k generator state and restore hold and no replay.
- AP604-03: bounded browser tabs and downloads with actual command/commit/CI evidence.

## P605 — End-to-end UI, accessibility and release artifacts
- AP605-01: Add native-feeling UI workflow e2e tests, cross-view status consistency, operator manual acceptance runbook, reproducible unsigned/private-use XPI packaging and provenance/checksum report.
- AP605-02: keyboard/focus on 1k searchable list and bulk-to-approval round trip.
- AP605-03: reproducible XPI and truthful live-test checklist with actual command/commit/CI evidence.

