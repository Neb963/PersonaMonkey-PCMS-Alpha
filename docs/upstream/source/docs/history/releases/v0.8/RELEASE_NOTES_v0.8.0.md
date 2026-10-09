> **Historical record.** Preserved for release history; it is not current product authority.

# PersonaMonkey Route Manager v0.8.0

v0.8.0 completes the PersonaMonkey management and PCMS-integration foundation on top of the v0.7 Persona OS. PersonaMonkey Management remains the bundled same-extension control plane; **PCMS** is the separate Perchance Central Management System and reaches PersonaMonkey only through the restricted Integration API v1.

## Delivered

- PersonaMonkey Management protocol v1 and responsive bundled management console, retaining legacy `PCMS_*` wire names for compatibility.
- Serialized state mutations with runtime `bootId` + revision optimistic concurrency.
- Persisted state schema 3 with durable logical `personaUid` while preserving management-v1 `profileId`/Persona `id` container semantics.
- Restart-repairable full-wipe/container rotation that preserves `personaUid`, remaps script/workflow/job references, and avoids an unmanaged Direct-fallback window.
- Restricted external `PERSONAMONKEY_INTEGRATION_*` transport: disabled by default, exact extension-ID authorization, UID-first addressing, local Direct/destructive authority, secret-safe projections/errors/events, and bounded operation correlation.
- Existing-userscript management through safe metadata plus assign/unassign only; no external executable-source installation.
- Validated workflow create/update/delete using external `personaUid` references translated to the current container only at the trusted adapter boundary. Authoring reuses the same normalization/run validation used by PersonaMonkey automation.
- Bounded retry correlation for Persona creation, full wipe, and workflow run; execution-local workflow job IDs remain distinct from PCMS business identifiers.
- Contract-parity coverage tying external descriptor validation, discovery, handler availability, flags, capability metadata, and stable error names to one command descriptor source.
- Deterministic integration lifecycle coverage across create, safe route/script assignment, workflow create/run, UID-preserving rotation, reconnect/requery, remapped bindings, rerun, and denied policy paths.

## Identifier and compatibility model

Persisted state is schema **3**. `personaUid` is the stable logical Persona identity. Firefox `cookieStoreId` is the current contextual-identity/container ID and may change during a full wipe. Legacy PersonaMonkey Management v1 `id`, `profileId`, and batch `personaId` continue to mean the current container ID.

Schema-2 state migrates managed Personas to stable UIDs once. A pre-schema-3 build may discard those UIDs when it rewrites state; downgrade therefore requires a pre-upgrade backup or external mapping rebind.

GM values intentionally remain shared by userscript ID across assigned Personas. Page cookies and `GM_cookie` remain container-scoped. Per-Persona GM-value scope is deferred and would require an explicit migration.

## Security boundaries

Routing remains fail-closed; Block is the safe/default route and Direct requires explicit request intent plus local authority. Destructive external commands require request confirmation plus local destructive authority.

The Integration API does not expose raw `SAVE_STATE`, `PERSONA_API`, arbitrary browser APIs, route credentials/private keys, cookie values/auth data, userscript source, GM values, cached dependency bodies, arbitrary executable package import, or generic Mullvad-native RPC.

PCMS owns account credentials, domain/account state, and business identifiers in PCMS storage. PersonaMonkey exposes only the typed browser/persona operations required to bind and execute them.

Events are advisory with no replay guarantee. Reconnects, boot changes, sequence gaps, projection recovery signals, and ambiguous transport outcomes require authoritative requery.

## Deferred

The automatic userscript updater, external userscript-source installation, per-Persona GM-value scope/migration, generic workflow-package authoring/import with new executable source, cosmetic `pcms-*`/legacy-module renames, hidden-DOM cleanup, and broader repository cleanup remain outside this milestone.

## Verification

Current dated verification evidence is recorded in [V0.8.0_CURRENT_RELEASE_GATES.md](V0.8.0_CURRENT_RELEASE_GATES.md). Browser/native environment-dependent checks are recorded as not run unless they actually execute successfully.
