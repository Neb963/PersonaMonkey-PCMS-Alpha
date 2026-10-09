# Changelog

This changelog records notable product changes. Versions follow semantic versioning. The `1.0.0` entry records the first stable source release; the GitHub Release notes state its environment-dependent verification limits.

## Unreleased

## [1.2.0] - 2026-09-28

v1.2.0 adds the PCMS-facing External Automation extension to Integration API v1 and hardens the browser-execution boundary for exact artifact identity, Persona control, transient inputs/secrets, and owner-scoped execution recovery.

### Added

- Extended Integration API v1 with independent, default-off External Automation and executable-install authorities, immutable sender-owned userscript artifacts, short Persona control leases, transient scoped input and secrets, and owner-scoped ephemeral executions, status, structured results/failures, cancellation, focus, and acknowledgement.
- Added the `Persona.input` userscript grant for bounded input reads, one-time secrets, and same-task human continuation waits. `system.describe` reports authority, Firefox runtime readiness, supported commands, and current execution/input/result/control limits.
- Added local lease visibility and explicit override controls, an external artifact marker and local clone action, and recovery/backup rules that preserve portable artifact identity while excluding transient inputs, secrets, and external execution detail from ordinary exports/history.

### Security and correctness

- External artifacts are scoped to the authenticated Integration sender. Portable backup/import retains artifact metadata as unverified; exact authenticated reinstall is required before Integration lookup or execution can reclaim it.
- External execution admission binds the owning sender, operation ID, exact plan/ref contract, and Direct intent. Retries reconcile the already-admitted execution instead of silently changing the request or creating a duplicate browser job.
- Transient normal input is bounded, hash-verified, execution/step/artifact scoped, and memory-only. Secret input uses a separate memory-only path with discoverable per-value/per-sender limits, one-time consumption, and best-effort clearing on discard, expiry, revocation, or shutdown.
- Owner-scoped detailed results preserve valid structured provider data while rejecting unsafe/non-JSON structures; structured failures and acknowledgement remain bounded and separate from ordinary workflow/job/history projections.
- Persona control projections distinguish self-owned from another authorized integration without exposing a foreign lease ID or purpose. Control loss, expiry, local override, restart, and authority changes remain fail-closed and owner-scoped.
- Corrected Integration error normalization for external execution conflicts/not-found/not-active/result-not-ready cases, aligned the 256-character external operation-ID contract, and rejected ignored nested execution input/secret references.
- Cookie editing now treats Firefox first-party isolation and dynamic partition top-level-site metadata as mutually exclusive and reports conflicts inline instead of silently dropping partition metadata.
- Integration settings tolerate transient MV3 background-startup receiver gaps, and deterministic browser-smoke fixtures no longer depend on headless Chrome completing `Blob.text()` during process teardown.
- Release XPI generation now fixes ZIP timezone/locale metadata and archive ordering, with a UTC-vs-Europe/Warsaw reproducibility regression, so identical source does not produce different XPI hashes solely because CI and developer machines use different local time zones.

### Compatibility

- Integration protocol remains v1, Management protocol remains v1, persisted-state schema remains 3, Gecko ID remains `persona-route-manager@local`, and the native bridge minimum protocol remains `0.3.0`.
- Existing ordinary userscript, workflow, job, Direct, destructive, package, and management semantics retain their documented gates. External artifacts remain inert outside explicit owned execution and are excluded from ordinary userscript/workflow surfaces.
- Persona `personaUid` remains the durable logical identity; Firefox `cookieStoreId` remains an operational identity that may rotate during full wipe.

### Verification

- Release-gate, installed-browser, native-egress, and artifact-identity evidence are recorded separately; no environment-dependent check is considered passed merely because unit/stubbed browser tests pass.
- Repository-built XPI artifacts are unsigned development artifacts unless a separate Mozilla-signed artifact is explicitly obtained and authenticated.

## [1.1.0] - 2026-09-26

v1.1.0 is a remediation and hardening release based on the 2026-09-24 audit. It preserves the v1 compatibility surface while strengthening fail-closed routing, state authority, management/integration contracts, package handling, userscript boundaries, and the native Mullvad path.

### Security and correctness

- Hardened routing initialization and recovery so protected Personas remain fail-closed while routing authority is unavailable.
- Corrected Direct route verification, stale-result handling, native forwarder-token recovery, proxy-error cache invalidation, and MV3 idle-stop persistence.
- Hardened state/import authorization, management and Integration API pagination/correlation/idempotency, userscript scope, cookie/container isolation, recovery, and bounded package processing.
- Added authenticated per-route Mullvad SOCKS forwarders and transactional native bridge upgrade rollback.
- Reconciled workflow timeout behavior, Options semantics/focus, diagnostics, browser-smoke fixtures, and release documentation.

### Verification

- The post-hardening repository/CI release gate passed.
- Real Firefox testing verified Direct egress, protected Mullvad egress with clean DNS evidence, fail-closed behavior in exercised failure paths, Direct-to-protected switching, request-triggered native recovery, explicit tunnel restart recovery, and unchanged-route recovery with no observed Direct escape.
- By owner release decision, real MV3 event-page suspend/wake acceptance, destructive supported-host native install/update/uninstall/service lifecycle acceptance, and Mozilla-signed artifact provenance are **not release blockers for v1.1.0**. They remain unverified and are not recorded as passing.
- The repository-built XPI is unsigned. Standard persistent Firefox/LibreWolf installation still requires a genuinely Mozilla-signed XPI; the installer continues to enforce its signed-artifact/digest requirements.

### Compatibility

- Management protocol v1, Integration API v1, persisted-state schema 3, Gecko ID `persona-route-manager@local`, and native bridge minimum protocol `0.3.0` remain compatible.

## [1.0.0] - 2026-09-24

This first stable release formalizes capabilities delivered across the v0.x series. The features listed under Stable baseline were available before 1.0.0; they are summarized here to define the supported product.

### Added

- Published a v1 compatibility policy and canonical product, API, testing, contribution, and release documentation.

### Changed

- Current product and engineering documentation now separates stable contracts from historical release and planning records.

### Fixed

- Preserved the full accepted external `storage.fullWipe` operation ID through persisted rotation recovery and the `persona.container.rotated` event, distinct from the internal rotation ID.

### Stable baseline

- Persona OS manages persistent contextual identities, durable `personaUid` identity, fail-closed protected routing with the kill switch enabled, and explicit Direct routing.
- The bundled Management API v1 and console support persona, route, workflow, job, and diagnostic operations. The restricted Integration API v1 gives explicitly trusted extensions typed Persona, existing-userscript assignment, and workflow operations.
- Full wipe rotates a contextual identity with restart recovery. Persona packages, workflow packages, encrypted complete backups, selective exports, cookie-only transfer, and non-sensitive Firefox Sync recovery remain supported.
- Cookie management respects the exact Firefox container, first-party isolation, and dynamic partitioning. Management and Integration projections omit private credentials and browser data; the native Mullvad bridge remains narrow in purpose.

### Compatibility

- Existing Management protocol v1 `PCMS_*` wire identifiers and documented error codes remain compatibility names; they identify PersonaMonkey Management and do not mean that the separate PCMS product is shipped here.
- Persisted-state schema 3 and documented persona, workflow, backup, and cookie package formats retain explicit migration/readability contracts.
- The Gecko extension ID remains `persona-route-manager@local`.

### Verification limits

- The release XPI was installed in Firefox and its version, identity, UI, and read-only Integration API boundaries were checked. Mutation-heavy userscript, workflow, and full-wipe lifecycles were not exercised on that existing user profile.
- Live Mullvad routed egress was not verified in this environment because the private WireGuard configuration and native test host were unavailable. Local native tests and browser smokes are separate evidence.

## Historical evolution

The following summaries capture significant shipped capabilities from the v0.x line. They are concise history, not additional compatibility promises.

### v0.8.0

- Added PersonaMonkey Management: a same-extension command protocol and console for persona, route, workflow, job, and diagnostic operations.

### v0.7.x

- Established the Persona OS facade and first-class persona dashboard, with lifecycle actions, identity and health details, and persona package import/export.

### v0.6.x

- Added workflow package portability, persona-scoped cookie management, encrypted and selective backup/import, and non-sensitive reinstall recovery. Corrected cookie enumeration for Firefox first-party and dynamic partition isolation.

### v0.5.0

- Hardened workflow execution and diagnostics, including serialized editor mutations, job progress and cancellation, and secret-safe diagnostic exports.

### v0.4.x

- Split the extension background implementation into subsystem modules and stabilized workflow authoring and execution.
