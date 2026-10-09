# External Automation implementation plan

## Baseline and compatibility boundary

This plan began from PersonaMonkey 1.1.0 at commit
`5bfe6950ca01d88fa0b3b97c9f3339aff7f8b350`. The External Automation work is
an additive Integration API v1 extension prepared for PersonaMonkey 1.2.0.
Integration API v1 and its existing commands, projections, errors, retry
behavior, workflow packages, backups, and routing rules remain compatibility
surfaces. The historical PCMS-readiness documents describe the earlier
milestone; they are not rewritten as current authority.

The former unreleased/version-freeze instruction for this work is complete.
Release/version authority now comes from the manifest, package metadata,
changelog, compatibility register, and release procedure rather than this
implementation plan. The plan remains an engineering rationale and acceptance
record for the External Automation feature.

The local test baseline passed npm test (repository, extension, and native
suites) and npm run validate. The initial validation of the downloaded source
snapshot required restoring executable modes from the Git tree; those modes
match the source branch.

## Current implementation seams

- management-integration-protocol.js owns strict v1 schemas, command
  descriptors, stable errors, policy normalization, and exact-sender auth.
- management-integration.js owns authorization, preconditions, operation
  correlation, system.describe, typed dispatch, safe projections, and
  external event delivery.
- persona-api.js is the typed facade. background.js constructs it and wires
  the external message/event listeners, state manager, and runtime.
- state.scripts plus UserscriptManager own userscript source, grants,
  compatibility, and Persona assignment. userscript-runtime.js applies
  assignment/match policy and currently skips execution when optional
  userScripts permission is absent.
- orchestrator.js owns workflow validation, readiness, concurrency, tabs,
  Firefox session ownership tags, completion signals, cancellation, bounded
  job persistence, and restart-to-interrupted recovery.
- gm-compat.js exposes the isolated-world bridge and Persona.complete /
  Persona.fail; this is the only script input bridge to extend.
- constants.js, storage.js, and security-delta.js own default and normalized
  integration authority and privilege-escalation review.
- options/integration-settings.js and its section in options.html own the
  local authority controls. options.js edits userscript source.
- Transient input and secrets will live only in a bounded in-memory broker.
  They will not enter state, automation history, operation fingerprints,
  exports, Sync, logs, or events. Immutable artifact code remains in the
  existing userscript registry so assignment, grants, backup, and runtime
  enforcement keep using established paths.

## Cross-cutting safeguards

- Keep this as a post-v1.1 feature. Do not describe it as closing the earlier
  remediation audit. Retain historical scope records, while updating current
  documentation to explain that this feature adds the previously excluded
  artifact-install authority.
- Artifact identity must survive portable backup, import, and Recovery Sync.
  Normalize the external marker explicitly, verify SHA-256 over exact UTF-8
  source bytes on import/restore and before injection, and reject mismatches
  or same-ID/different-hash conflicts. Never silently strip the marker or
  mutate an external artifact into an ordinary script. A source hash verifies
  bytes; it does not authenticate the caller or guarantee provider behavior.
- For external artifacts only, reject `@require`, remote `@resource`,
  `@updateURL`, and `@downloadURL` so execution does not depend on changing
  remote code. Preserve these features for ordinary userscripts.
- Fence local Persona actions against active leases. Route changes, archive,
  wipe, rotation, and destruction must revoke/fence or cancel the affected
  external work before mutation; record a stable lease-lost outcome. Disabling
  integration or removing a trusted sender discards only that sender's
  transient data and active work; inert installed artifacts remain.
- Persist a bounded operation admission record before job/tab side effects.
  Bind the authenticated sender, operation ID, canonical plan and input-ref
  fingerprint, execution ID, and state. Reconcile retries against this record
  and persisted external job ownership; reject the same operation ID with a
  different plan or input references. Never fingerprint payload bytes or
  secrets.
- Filter external jobs from every ordinary workflow view and control path,
  including list/get/stop/clear, options history, events, diagnostics, and
  backup history. Detailed results remain owner-only and separate from public
  workflow projections.
- Security preview must name each authority separately, especially permission
  to install executable code. Provide a local lease status/override path so
  the human remains the final Persona authority.

## Implementation order

1. Add a short-lived feature branch from current main; keep a plan and baseline
   evidence.
2. Add independent, default-off allowExternalAutomation and
   allowExecutableInstall authorities. Preserve exact-sender authorization,
   local security-preview review, and Direct/destructive authority separation.
3. Add immutable artifact commands and metadata. Hash source in PersonaMonkey,
   reject mismatches and same-ID/different-hash replacement, force autoRun
   false, reject remote runtime dependencies, verify the hash before
   execution and after backup/import/recovery, and make the normal editor
   read-only with an explicit clone path.
4. Add sender-scoped Persona control leases and bounded, memory-only input,
   secret, and continuation brokers. Serialize admission against lease checks;
   revoke/fence local conflicting operations before they mutate a controlled
   Persona; drop transient state on expiry, cancellation, authorization
   revocation, or restart.
5. Add ephemeral execution entrypoints to the existing orchestrator. Stamp
   persisted jobs with authenticated owner and operation identity, reconcile
   persist admission before side effects, reconcile ambiguous starts from both
   the operation journal and persisted job metadata, retain bounded
   results/failures, and implement owner-only status/result/ack/cancel/focus.
   Hide these jobs from ordinary workflow APIs, events, history, diagnostics,
   and backups.
6. Add Persona.input to the existing isolated userscript bridge. Advertise
   execution only when the optional Firefox permission and tab-ownership
   primitives are available; fail closed before starting work otherwise.
7. Update Integration API and compatibility docs, settings/help, schema and
   lifecycle tests, then run repository, extension, native, validation, build,
   and available Firefox browser checks. Record blocked live scenarios
   explicitly.

## Acceptance focus

Test the authority matrix and capability discovery; immutable artifact identity
and non-autorun behavior across backup/import/recovery; exact Persona UID/lease ownership; duplicate-start
reconciliation; input and secret scope/expiry/restart loss; owner-only control
and result access; unchanged ordinary workflow projections/events; route
enforcement and exact tab cleanup; same-tab human continuation; and the full
existing compatibility suite. Do not claim browser behavior that was not
exercised in Firefox.
