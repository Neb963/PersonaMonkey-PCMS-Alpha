# Persona identity and lifecycle

A Persona is PersonaMonkey's logical identity and policy record associated with a Firefox contextual identity. The logical identity can outlive a particular Firefox container: full wipe replaces the container while preserving the Persona.

## Identifier meanings

| Identifier | Meaning |
| --- | --- |
| `personaUid` | Durable, opaque logical identity for a managed Persona. It is UUID-form; its UUID version and variant bits are not interpreted as identity semantics. |
| `cookieStoreId` | The current Firefox contextual-identity/container ID for that Persona. |
| Management v1 Persona `id` | The current `cookieStoreId`, retained for compatibility. |
| Management v1 `profileId` and batch `personaId` | The current `cookieStoreId`, retained for compatibility. |
| Workflow step `profileId` and userscript `profileIds` | Current internal container IDs. |

The external Integration API v1 accepts and returns `personaUid` as the logical Persona identifier and exposes `cookieStoreId` only as the current container projection. Its trusted adapter resolves the UID to current internal container references. Current internal projections may include both fields while retaining legacy management identifiers.

## Identity lifecycle

- Managed Personas have one unique UID. Creation generates one unless a trusted caller supplies an unused, valid UUID-form UID.
- Normalization preserves valid unique UIDs. It repairs missing, malformed, or duplicate UIDs for current managed Personas; current managed records take precedence over unmanaged compatibility records. Unmanaged records do not receive a newly generated logical identity merely because state is normalized.
- Identity and settings edits, archive, and ordinary reload preserve the UID.
- Clone and portable `.personamonkey` Persona import create a new logical Persona with a new UID. The portable Persona package excludes `personaUid`.
- Destroy removes the managed Persona and its logical identity.
- During a rotation, source/target container records are transitional scaffolding, not additional logical Personas. The UID is associated with the replacement container at cutover and remains the same after the rotation completes.

Persona UID validation accepts a UUID-shaped hexadecimal string, normalizes it to lowercase, and does not require particular version or variant nibbles. Consumers should treat it as opaque: do not parse identity meaning from its bits or derive business data from it.

## Persisted state and startup

The current persisted state schema is **3**. Schema-2 state loads through the current normalizer: each current managed Persona without a valid unique UID receives one. The state manager saves the normalized state during startup initialization, so schema-2 migration and UID repair are persisted on that startup save; they do not wait for a later user edit. Subsequent normalization preserves those valid UIDs. Unmanaged compatibility records are not assigned new logical identities by this process.

The state manager also maintains `bootId` and `revision` metadata for the current runtime. That metadata is not part of persisted schema 3. Mutation and side-effect contracts that use optimistic concurrency require the current boot/revision precondition; clients requery after a conflict or runtime restart. See the [Integration API contract](../api/integration-v1.md) and [Management API contract](../api/management-v1.md).

A build predating schema 3 may discard UID metadata when it rewrites state. Keep a pre-upgrade backup if downgrade compatibility matters. If external mappings already depend on Persona UIDs, reverting to a pre-schema-3 build requires restoring that backup or rebinding those mappings.

## Rotation and reference continuity

Full wipe replaces the selected Persona's Firefox contextual identity rather than deleting browsing data broadly. Rotation is restart-repairable: progress is recorded in persisted rotation state, and startup reconciliation resumes an unfinished operation before ordinary destructive Persona operations proceed. A retry that identifies an existing rotation resumes or reports that operation rather than starting a second rotation against the same Persona.

When rotation completes, the Persona keeps its `personaUid` and receives a new `cookieStoreId`. PersonaMonkey moves the UID to the replacement container and remaps internal userscript, workflow, and automation-history references before retiring the old container. The source's tabs are closed before its contextual identity is removed, and route policy remains managed during this transition. A successful rotation emits an advisory event correlating the UID with the old and new container IDs. The Integration API's external `operationId` and internal `rotationOperationId` are distinct correlation values; events also carry the current boot/revision envelope. Clients use events as hints and query authoritative state after reconnect or uncertain completion.

Workflow step `profileId`, userscript `profileIds`, automation history, and Management API identifiers continue to use current container IDs internally. The Integration API translates between those references and `personaUid`, allowing external Persona bindings to survive container rotation without changing their logical identity.

## Backup and portability

PersonaMonkey backup payloads include Persona UIDs. A backup replace/restore preserves the included UIDs; a merge preserves non-colliding UIDs and allocates a replacement UID where an imported UID collides with an existing Persona. Import reports UID remaps in its diagnostics. Sensitive backups require authenticated encryption; the backup format also allows non-sensitive payloads to be inspectable.

Portable `.personamonkey` Persona packages deliberately omit the UID. Importing one creates a new logical Persona, even if identity and settings resemble the source. PersonaMonkey backup envelopes are the format for preserving logical identity across backup and restore.

See the [data portability guide](../guides/data-portability.md) for backup contents, encryption, import mapping, and recovery behavior, and the [compatibility register](../reference/compatibility.md) for schema and format versions.
