# Compatibility register

PersonaMonkey v1 defines supported compatibility surfaces for PersonaMonkey’s own extension, its bundled management console, and authorized integrations. A later 1.x release may add compatible behavior. It must not silently change a documented identifier, field meaning, error code, format, or safety rule; changes that cannot preserve the documented behavior require an explicit version or migration strategy.

The external PCMS product is separate. Its cross-extension contract is [PersonaMonkey Integration API v1](../api/integration-v1.md). Legacy `PCMS_*` names below are internal PersonaMonkey Management API identifiers and do not designate the external PCMS product.

## Supported compatibility surfaces

### PersonaMonkey Management API v1 (same extension)

Management protocol v1 retains these wire identifiers:

- request type `PCMS_REQUEST`;
- event port `PCMS_EVENTS`;
- `PCMS_PROTOCOL_VERSION = 1`;
- these structured error codes: `PCMS_PROTOCOL_UNSUPPORTED`, `PCMS_BAD_REQUEST`, `PCMS_VALIDATION_FAILED`, `PCMS_UNKNOWN_COMMAND`, `PCMS_CAPABILITY_UNAVAILABLE`, `STATE_CONFLICT`, `PERSONA_NOT_FOUND`, `PERSONA_UNMANAGED`, `ROUTE_NOT_FOUND`, `ROUTE_DISABLED`, `DIRECT_ROUTE_REQUIRES_OPT_IN`, `SECURITY_AUTHORIZATION_REQUIRED`, `USERSCRIPT_NOT_FOUND`, `USERSCRIPT_DISABLED`, `USERSCRIPT_INCOMPATIBLE`, `WORKFLOW_NOT_FOUND`, `JOB_NOT_FOUND`, `BATCH_COMMAND_NOT_ALLOWED`, `BATCH_LIMIT_EXCEEDED`, `BATCH_CANCELLED`, `PCMS_RESULT_TOO_LARGE`, `PCMS_RESULT_NOT_SERIALIZABLE`, `PCMS_PAGE_INVALID`, `PCMS_PAGE_STALE`, `PCMS_REQUEST_ID_CONFLICT`, `PCMS_REPLAY_CAPACITY`, `DESTRUCTIVE_CONFIRMATION_REQUIRED`, and `INTERNAL_ERROR`;
- completion event `pcms.batch.completed`.

The [Management API v1 reference](../api/management-v1.md) describes the error meanings.

Management v1 Persona `id`, request `profileId`, batch `personaId`, workflow step `profileId`, and userscript `profileIds` mean the current Firefox `cookieStoreId`. They are not durable Persona identifiers. Persona projections may also contain explicit `personaUid` and `cookieStoreId` fields.

These names and semantics remain internal to the same-extension Management API. External callers use the distinct Integration API envelope, protocol, events port, error identifiers, and UID-first Persona identity.

### PersonaMonkey Integration API v1 (external extension)

The separately authorized external API uses request type `PERSONAMONKEY_INTEGRATION_REQUEST`, protocol version `1`, and event port `PERSONAMONKEY_INTEGRATION_EVENTS`. Its documented commands, fields, stable error codes, preconditions, retry behavior, events, identifier semantics, and least-privilege projections are defined in [Integration API v1](../api/integration-v1.md).

PCMS integrations should use `system.describe` to inspect `integrationProtocolVersion`, the currently advertised command set, and capabilities. `personaApiVersion` and `stateSchemaVersion` are PersonaMonkey implementation metadata, not Integration API compatibility gates.

The External Automation facility adds commands within protocol v1 for separately authorized immutable userscript artifacts, short Persona control leases, transient inputs/secrets, and owner-scoped ephemeral executions and results. `allowExternalAutomation` and `allowExecutableInstall` are independent local authorities, both defaulting to false. Existing Direct and destructive gates remain independent. Runtime readiness and limits are discoverable; a listed `execution.start` command is usable only when `authorized` is true and Firefox userscript execution and owned-tab support are available. Existing Integration commands and normal workflow/job projections retain their v1 meanings. Historical PCMS readiness notes that predate this facility describe the earlier v1 command set; the current API reference is authoritative for the additive commands.

### Persona identity and routes

`personaUid` is the durable logical identity of a managed Persona. `cookieStoreId` is its current Firefox contextual-identity identifier and may change when the Persona is fully wiped. External Integration API requests use `personaUid`; internal Management API and service identifiers described above continue to use current container IDs.

The virtual route IDs `__block__` and `__direct__` identify the built-in Block and Direct routes. Configured route IDs should be obtained from `route.list`. Block remains the safe/default route; Direct requires explicit intent and local authority.

### Installed identifiers

The Gecko extension ID remains `persona-route-manager@local`. The native messaging host ID remains `com.persona.mullvad_router`; the native host allowlist continues to use the Gecko extension ID. These installed identifiers are compatibility-sensitive because browser registration and local integrations refer to them.

### Persisted state and portable data

The current persisted-state schema is **3**. Schema-2 managed Persona records migrate to durable UIDs; normalization preserves valid UIDs and does not assign new logical identities to unmanaged compatibility records. A build predating schema 3 may discard UID metadata when rewriting state. Keep an appropriate pre-upgrade backup before downgrading once external systems depend on `personaUid`; such a downgrade can require restoring that backup or rebinding those mappings.

Supported portable formats are:

- Persona package `persona.personamonkey`, format v2; v1 remains import-readable. Portable export excludes `personaUid`, so importing creates a new logical Persona.
- Workflow package `personamonkey.workflow-package`, format v1.
- Complete backup `personamonkey-backup`, format v1. Replace/restore preserves UIDs; merge preserves non-colliding UIDs and reports or remaps collisions.
- Cookie package `personamonkey-cookies`, format v1.

Existing readable state, workflow, userscript, package, and backup data remains readable unless a later release documents and tests an explicit versioned migration. Portable package internals and backup implementation layout are not additional formats or API contracts.

## Behavior guarantees

- Managed Personas with the kill switch enabled fail closed when a protected route is unavailable; Block is safe/default; Direct requires explicit authority. When required browser privacy controls are unsafe, protected proxy operations are blocked; an explicitly authorized Direct Persona bypasses that protected-route readiness gate and is not treated as protected. Global browser privacy controls are still applied where possible, and protected-route failures never fall back to Direct.
- Cookie and site-data operations stay scoped to the exact Persona `cookieStoreId`, including Firefox isolation and partition selectors.
- Full wipe uses contextual-identity rotation and preserves the durable `personaUid` while replacing the current `cookieStoreId`.
- Management and Integration API projections remain secret-safe; the external Integration API exposes only documented typed operations, not raw state, browser APIs, or generic native RPC.
- Existing persistent GM values remain shared by userscript ID across Personas assigned that script. Per-Persona GM value scope would require an explicit migration or opt-in.
- Ordinary userscript assignment and workflow execution continue through validation and runtime enforcement. The original `userscript.*` Integration commands do not install or expose source. The separately authorized `userscript.artifact.install` accepts exact hashed source for externally managed scripts; artifact IDs are scoped to the authenticated sender, scripts stay non-autorun, and integrity is rechecked during execution. Portable backup imports preserve artifact metadata but mark ownership unverified; the authenticated sender must exactly reinstall/reclaim the artifact before Integration lookup or execution can use it. External jobs and detailed results are excluded from ordinary workflow/job and history surfaces.

## Implementation details outside the compatibility promise

The following are not public compatibility guarantees unless another document explicitly makes them part of a supported surface:

- internal source-file and directory names, module boundaries, private helper functions, and private state-manager APIs;
- the shape of internal command descriptor tables, dispatch registries, or private event-hub payloads;
- internal rotation and operation-correlation storage layout, journal fields, and cleanup strategy;
- CSS classes, DOM structure, and undocumented UI details;
- incidental ordering or metadata not described by a supported API or portable format.

Use the API documents and format guides for supported behavior. Internal implementation details may change without changing a documented v1 contract.
