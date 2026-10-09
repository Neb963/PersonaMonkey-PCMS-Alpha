# ROADMAP

> Generated from docs/implementation/v1/plan.json. Do not hand-edit.

## P000 — Repository bootstrap / architecture freeze
Status: **ACCEPTED**  
Depends on: none  
Merge wave: 0

- [x] T000.1 — T000.1 Bootstrap authority and provenance
- [x] T000.2 — T000.2 Establish claim/CI governance
- [x] T000.3 — T000.3 Verify generated views

## P001 — Hosted CI + pinned Firefox Developer Edition harness
Status: **ACCEPTED**  
Depends on: P000  
Merge wave: 1

- [x] T001.1 — T001.1 Pin exact Mozilla FDE artifact
- [x] T001.2 — T001.2 Build isolated profile/install harness
- [x] T001.3 — T001.3 Prove browser CI evidence

## P002 — Import and preserve PersonaMonkey baseline
Status: **ACCEPTED**  
Depends on: P001  
Merge wave: 1

- [x] T002.1 — T002.1 Import exact upstream tree
- [x] T002.2 — T002.2 Reconcile public-repo provenance
- [x] T002.3 — T002.3 Prove inherited release baseline

## P003 — PCMS namespace/UI entry + internal Persona Broker contract
Status: **ACCEPTED**  
Depends on: P002  
Merge wave: 2

- [x] T003.1 — T003.1 Define broker contract
- [x] T003.2 — T003.2 Add PCMS namespace/bootstrap
- [x] T003.3 — T003.3 Contract parity tests

## P004 — Firefox sandbox dynamic-controller capability spike
Status: **ACCEPTED**  
Depends on: P002  
Merge wave: 2

- [x] T004.1 — T004.1 Sandbox runtime probe
- [x] T004.2 — T004.2 Authenticated bounded RPC
- [x] T004.3 — T004.3 Lifecycle/isolation acceptance

## P005 — PCMS IndexedDB storage broker + migrations
Status: **ACCEPTED**  
Depends on: P002  
Merge wave: 2

- [x] T005.1 — T005.1 DB/migration authority
- [x] T005.2 — T005.2 Namespaced storage/CAS
- [x] T005.3 — T005.3 restart/failure tests

## P006 — PCMS SecretStore host + SecretRef abstraction
Status: **ACCEPTED**  
Depends on: P002  
Merge wave: 2

- [x] T006.1 — T006.1 SecretRef contract
- [x] T006.2 — T006.2 narrow native host/backend
- [x] T006.3 — T006.3 redaction/failure tests

## P007 — Minimal Audit Journal
Status: **ACCEPTED**  
Depends on: P005  
Merge wave: 3

- [x] T007.1 — T007.1 Event schema/atomic append
- [x] T007.2 — T007.2 read/projection API
- [x] T007.3 — T007.3 replay tests

## P008 — Module archive/package/authority model
Status: **ACCEPTED**  
Depends on: P004, P005  
Merge wave: 3

- [x] T008.1 — T008.1 bounded parser/hash identity
- [x] T008.2 — T008.2 authority envelope/delta
- [x] T008.3 — T008.3 immutable candidate lifecycle

## P009 — Persona Broker implementation
Status: **ACCEPTED**  
Depends on: P003  
Merge wave: 3

- [x] T009.1 — T009.1 Integration-semantic facade
- [x] T009.2 — T009.2 capability/lease/execution mapping
- [x] T009.3 — T009.3 parity/failure tests

## P010 — RemoteOps + ProviderGate + recovery hold
Status: **ACCEPTED**  
Depends on: P005, P009  
Merge wave: 4

- [x] T010.1 — T010.1 durable RemoteOps
- [x] T010.2 — T010.2 ProviderGate
- [x] T010.3 — T010.3 uncertain/recovery tests

## P011 — Module runtime / capability RPC / generation fencing
Status: **ACCEPTED**  
Depends on: P008, P010  
Merge wave: 4

- [x] T011.1 — T011.1 runtime broker/mailboxes
- [x] T011.2 — T011.2 capability RPC
- [x] T011.3 — T011.3 draining/update/recovery

## P012 — HumanTask/Attention + timers/services
Status: **ACCEPTED**  
Depends on: P007, P011  
Merge wave: 4

- [x] T012.1 — T012.1 HumanTask/Attention
- [x] T012.2 — T012.2 timers
- [x] T012.3 — T012.3 service registry/restart tests

## P013 — Perchance provider adapter + emulator
Status: **ACCEPTED**  
Depends on: P009, P010  
Merge wave: 4

- [x] T013.1 — T013.1 compatibility probe
- [x] T013.2 — T013.2 deterministic emulator
- [x] T013.3 — T013.3 fail-closed adapter tests

## P014 — Accounts module + Account↔personaUid binding
Status: **ACCEPTED**  
Depends on: P011, P013  
Merge wave: 5

- [x] T014.1 — T014.1 account model
- [x] T014.2 — T014.2 Persona binding/rebind
- [x] T014.3 — T014.3 rotation continuity

## P015 — Deployer module
Status: **ACCEPTED**  
Depends on: P014, P013  
Merge wave: 5

- [x] T015.1 — T015.1 desired/observed model
- [x] T015.2 — T015.2 stable target mutation
- [x] T015.3 — T015.3 reconciliation/UI

## P016 — Explorer module
Status: **ACCEPTED**  
Depends on: P014, P013  
Merge wave: 5

- [x] T016.1 — T016.1 discovery/candidates
- [x] T016.2 — T016.2 durable claim/reconciliation
- [x] T016.3 — T016.3 module UI/integration

## P017 — Refresher module
Status: **ACCEPTED**  
Depends on: P014, P013  
Merge wave: 5

- [x] T017.1 — T017.1 cohort/eligibility
- [x] T017.2 — T017.2 schedules/budgets
- [x] T017.3 — T017.3 isolation/confirmed-effect tests

## P018 — Statistics module
Status: **ACCEPTED**  
Depends on: P007, P011  
Merge wave: 5

- [x] T018.1 — T018.1 metric projection model
- [x] T018.2 — T018.2 replay/late-event handling
- [x] T018.3 — T018.3 UI/export

## P019 — Account Provisioning module
Status: **ACCEPTED**  
Depends on: P006, P012, P014, P013  
Merge wave: 5

- [x] T019.1 — T019.1 provisioning state machine
- [x] T019.2 — T019.2 HumanTask/session guard
- [x] T019.3 — T019.3 uncertain/CAPTCHA-safe tests

## P020 — Backup/restore + retention
Status: **ACCEPTED**  
Depends on: P007, P010, P011  
Merge wave: 6

- [x] T020.1 — T020.1 snapshot/backup
- [x] T020.2 — T020.2 staged restore
- [x] T020.3 — T020.3 RECOVERY_HOLD reconciliation

## P021 — PCMS UI shell / notifications / search
Status: **ACCEPTED**  
Depends on: P012, P014  
Merge wave: 6

- [x] T021.1 — T021.1 navigation/attention shell
- [x] T021.2 — T021.2 search/projections
- [x] T021.3 — T021.3 deep-link safety

## P022 — Module lifecycle end-to-end
Status: **ACCEPTED**  
Depends on: P011, P020  
Merge wave: 6

- [x] T022.1 — T022.1 install/update
- [x] T022.2 — T022.2 disable/remove/purge
- [x] T022.3 — T022.3 rollback/retention acceptance

## P023 — Full module integration wave
Status: **ACCEPTED**  
Depends on: P015, P016, P017, P018, P019, P020, P021, P022  
Merge wave: 7

- [x] T023.1 — T023.1 cross-module contracts
- [x] T023.2 — T023.2 integration-wave CI
- [x] T023.3 — T023.3 combined recovery acceptance

## P024 — Adversarial/security/fault/release-candidate hardening
Status: **ACCEPTED**  
Depends on: P023  
Merge wave: 8

- [x] T024.1 — T024.1 fault/security matrix
- [x] T024.2 — T024.2 reproducible package
- [x] T024.3 — T024.3 clean install/update/restart

## P025 — Live acceptance 1 — installed FDE + PersonaMonkey/Mullvad/Perchance
Status: **ACCEPTED**  
Depends on: P024  
Merge wave: 9

- [x] T025.1 — T025.1 clean live install
- [x] T025.2 — T025.2 protected routing/Persona continuity
- [x] T025.3 — T025.3 provider/session compatibility

## P026 — Live acceptance 2 — representative mutations + recovery + final acceptance
Status: **ACCEPTED**  
Depends on: P025  
Merge wave: 10

- [x] T026.1 — T026.1 representative feature mutations
- [x] T026.2 — T026.2 restore/update/recovery
- [x] T026.3 — T026.3 final human acceptance

## P027 — Packaged-XPI Firefox harness + browser pin >=154
Status: **ACCEPTED**  
Depends on: P026  
Merge wave: 11

- [x] T027.1 — T027.1 Pin exact Firefox Developer Edition build >=154
- [x] T027.2 — T027.2 Packaged-XPI install/drive harness (tabs, idle unload, profile restart)
- [x] T027.3 — T027.3 Baseline packaged regression and pinned-build platform facts

## P028 — Background-authoritative PCMS Core + UI client protocol
Status: **ACCEPTED**  
Depends on: P027  
Merge wave: 12

- [x] T028.1 — T028.1 Background entry, PersonaMonkey-ready ordering, idempotent Core, in-process broker endpoint
- [x] T028.2 — T028.2 Cold-start/warm-wake recovery and durable HumanTask handoff for assisted provider steps
- [x] T028.3 — T028.3 UI client protocol, revision signal, status summary; dashboard becomes a client

## P029 — Durable PCMS timers woken by extension alarms
Status: **ACCEPTED**  
Depends on: P028  
Merge wave: 13

- [x] T029.1 — T029.1 Alarm mapping (next-due + heartbeat) and cold-start recreation
- [x] T029.2 — T029.2 Due pass, interrupted-timer recovery, declared schedules (timers.ensure), bounded work steps
- [x] T029.3 — T029.3 Background continuity proof with zero PCMS tabs and forced unloads

## P030 — Production sandbox pages + background-hosted controller frames
Status: **ACCEPTED**  
Depends on: P028  
Merge wave: 13

- [x] T030.1 — T030.1 Declare sandbox pages/CSP in the production manifest; browser-floor detection
- [x] T030.2 — T030.2 Background frame factory and frame lifecycle bound to generations
- [x] T030.3 — T030.3 Packaged proof that runtime-supplied controller source executes in a real sandbox page

## P031 — Runtime module lifecycle live in production
Status: **ACCEPTED**  
Depends on: P029, P030  
Merge wave: 14

- [x] T031.1 — T031.1 Install/approve/admit/activate via UI client commands; module supervisor with lazy rehydration
- [x] T031.2 — T031.2 Capability set v1 (module storage, timers, attention, audit, read projections, provider via ProviderGate)
- [x] T031.3 — T031.3 Live update/disable/enable/rollback/remove/purge and packaged end-to-end proof

## P032 — PCMS dashboard shell v2 as UI client
Status: **ACCEPTED**  
Depends on: P028  
Merge wave: 13

- [x] T032.1 — T032.1 Shell, tokens, primitives, router v2 with legacy routes
- [x] T032.2 — T032.2 Core status, durable receipts and Attention v2 over durable HumanTasks
- [x] T032.3 — T032.3 Diagnostics page and multi-tab behaviour

## P033 — Module UI contribution contract v1 for built-in and runtime modules
Status: **ACCEPTED**  
Depends on: P031, P032  
Merge wave: 15

- [x] T033.1 — T033.1 Contribution validator and Core merge points (nav, overview, search, conditions, settings, activity)
- [x] T033.2 — T033.2 Runtime-module contributions via core.ui.publish and the sandboxed module page surface
- [x] T033.3 — T033.3 Statistics pilot and fixture runtime-module UI proof, including lifecycle presentation states

## P034 — Accounts UX with Persona/account pickers
Status: **ACCEPTED**  
Depends on: P032  
Merge wave: 14

- [x] T034.1 — T034.1 Accounts table and detail
- [x] T034.2 — T034.2 Add-account dialog with generated IDs and shared EntityPicker
- [x] T034.3 — T034.3 Guarded rebind and visible-row route/session state

## P035 — Toolbar popup PCMS status block
Status: **ACCEPTED**  
Depends on: P028, P032  
Merge wave: 14

- [x] T035.1 — T035.1 Read the non-secret storage.session status summary
- [x] T035.2 — T035.2 PCMS line and account-for-active-Persona deep link
- [x] T035.3 — T035.3 ESR sizing regression extension

## P036 — Deployer v2 domain, Perchance contract v2 and Generators views
Status: **ACCEPTED**  
Depends on: P033, P034  
Merge wave: 16

- [x] T036.1 — T036.1 Deployer state v2 migration and status derivation
- [x] T036.2 — T036.2 Perchance driver v2 (code/HTML/thumbnail/listing) with GeneratorListing adapter mapping and emulator
- [x] T036.3 — T036.3 Generator index, Generators list/detail and assisted manual deploy

## P037 — Generator repository provider, manual scan and assisted repository deployments
Status: **ACCEPTED**  
Depends on: P036  
Merge wave: 17

- [x] T037.1 — T037.1 Repository provider boundary, GitHub implementation and fixture provider
- [x] T037.2 — T037.2 Repository format validation, payload identity, release ledger and snapshot
- [x] T037.3 — T037.3 Snapshot application to Deployer, account-folder linking, adoption and Deployer page

## P038 — Scheduled background repository synchronization
Status: **ACCEPTED**  
Depends on: P037, P029  
Merge wave: 18

- [x] T038.1 — T038.1 Deployer repository-sync service on declared schedules
- [x] T038.2 — T038.2 Cadence, backoff, rate-limit and offline handling
- [x] T038.3 — T038.3 Interrupted-scan recovery and packaged continuity proof

## P039 — Perchance observation, verification and drift (capability-gated)
Status: **ACCEPTED**  
Depends on: P038  
Merge wave: 19

- [x] T039.1 — T039.1 generator.observe contract and PersonaMonkey execution-artifact read driver (fixture page)
- [x] T039.2 — T039.2 Post-apply baseline, bounded background verification sweep
- [x] T039.3 — T039.3 Drift detection, comparison and operator choices

## P040 — Refresher, Explorer and Provisioning background services and UI migration
Status: **ACCEPTED**  
Depends on: P033, P036, P029  
Merge wave: 17

- [x] T040.1 — T040.1 Refresher background schedules and content from Deployer confirmed release
- [x] T040.2 — T040.2 Explorer and Provisioning contribution UIs with pickers and SecretRef creation
- [x] T040.3 — T040.3 Removal of P026 legacy operator forms with superseding assertions

## P041 — Backup/restore and module management UX
Status: **ACCEPTED**  
Depends on: P033, P031  
Merge wave: 16

- [x] T041.1 — T041.1 File-based backup and previewed restore with typed confirmation
- [x] T041.2 — T041.2 Recovery checklist with per-item reconciliation
- [x] T041.3 — T041.3 Modules page driving live install/review/update/rollback/remove/purge

## P042 — Unattended Perchance automation via PersonaMonkey execution artifacts (gated)
Status: **ACCEPTED**  
Depends on: P039  
Merge wave: 20

- [x] T042.1 — T042.1 Unattended generator.update v2 (and optional create) as PersonaMonkey execution artifacts under control lease
- [x] T042.2 — T042.2 Automatic-mode gates, eligibility and bounded serial background pass
- [x] T042.3 — T042.3 Emulator/FDE fixture end-to-end deploy-verify proof

## P043 — Live acceptance 3 — background continuity, runtime modules, repository/provider compatibility
Status: **BLOCKED**  
Depends on: P035, P038, P040, P041, P042  
Merge wave: 21

- [ ] T043.1 — T043.1 Operator-installed background continuity
- [ ] T043.2 — T043.2 Live runtime-module lifecycle without reload
- [ ] T043.3 — T043.3 Real repository and Perchance read/listing compatibility capture

## P044 — Live acceptance 4 — representative mutations, drift, unattended operation, recovery, final human acceptance
Status: **BLOCKED**  
Depends on: P043  
Merge wave: 22

- [ ] T044.1 — T044.1 Assisted and unattended deployments verified on real Perchance
- [ ] T044.2 — T044.2 Induced drift, uncertain reconciliation, restore/hold/release
- [ ] T044.3 — T044.3 Final human acceptance

