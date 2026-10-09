# PersonaMonkey Management API

This is the canonical current documentation for PersonaMonkey's bundled management protocol and console. The API is internal to the PersonaMonkey extension. **PCMS** means the separate **Perchance Central Management System**; its external access uses the separately named [PersonaMonkey Integration API v1](integration-v1.md), not this legacy management protocol.

## Compatibility naming

Management protocol v1 predates the current product naming and retains legacy wire identifiers: `PCMS_REQUEST`, `PCMS_EVENTS`, `PCMS_PROTOCOL_VERSION = 1`, existing `PCMS_*` errors, and `pcms.batch.completed`. They are frozen compatibility names. These identifiers belong to PersonaMonkey Management v1; they are not the separate PCMS product’s external interface.

See the [compatibility register](../reference/compatibility.md).

## Boundary

The bundled console communicates through the Management API control plane, which consumes typed Persona OS services and does not expose raw Firefox APIs, raw state mutation, or generic native RPC. Management messages and the legacy `PCMS_EVENTS` port are accepted only from same-extension contexts. External PCMS traffic is handled through the separate Integration API boundary and is never forwarded into Management API v1.

## Protocol v1 and identifiers

A request has `type: "PCMS_REQUEST"`, `version: 1`, a non-empty `requestId` of at most 256 characters, a command, and a parameter object. The request is limited to 1 MiB. Responses include protocol version, request ID, runtime `bootId`, runtime state `revision`, and a bounded secret-safe result or structured error. Management API v1 is for same-extension PersonaMonkey contexts; the PCMS product must use the separately authorized Integration API.

The five list commands (`persona.list`, `route.list`, `userscript.list`, `workflow.list`, `workflow.jobs.list`) accept optional `params.page: { size?: number, cursor?: string }`. With `page`, the result is `{ items, hasMore, nextCursor }`. The default page size is 50, maximum 100; `size` is an upper bound and a page may be smaller to fit the 256 KiB response budget. The sanitized collection snapshot used for pagination is limited to 8 MiB; an oversized snapshot returns `PCMS_RESULT_TOO_LARGE`. Continue with the returned cursor and the same command, size, and options. Ordering is by public ID (stable source order breaks ties). A cursor is bound to the runtime boot ID, revision, and public collection snapshot: `PCMS_PAGE_STALE` means restart from page one; `PCMS_PAGE_INVALID` means the cursor or size is malformed or mismatched. An empty collection returns `{ items: [], hasMore: false, nextCursor: null }`. Without `page`, the legacy array result includes *all* items when it fits the 256 KiB ordinary result budget; an oversized result returns `PCMS_RESULT_TOO_LARGE` instead of an incomplete success. The bundled console follows all pages before rendering.

Successful results never silently discard the 101st collection entry, object field, or workflow step. The ordinary result budget is 256 KiB; batches use 2 MiB and project each row independently. A batch validates its size and child command before executing. It returns one row for each distinct requested Persona ID, including cancelled rows under `failFast`. A row with `applied: true` and `PCMS_RESULT_TOO_LARGE` means the handler returned successfully but its individual result could not be represented within the 4 KiB row budget; requery before retrying. A row with `applied: false` means the handler threw, which does not by itself prove whether an underlying operation took effect.

For mutating commands, `requestId` identifies one logical operation per control-plane runtime. Concurrent identical retries share work and completed identical retries replay the original response for five minutes after completion, including errors and batches. Reusing the ID for different command/params returns `PCMS_REQUEST_ID_CONFLICT`. At 32 retained IDs, a new mutation returns retryable `PCMS_REPLAY_CAPACITY` before execution until entries expire; in-flight entries stay retained. The cache is memory-only: background restart or elapsed retention loses this guarantee, so requery authoritative state before retrying destructive operations across boot changes or expiry. This is a bounded retry mechanism, not durable exactly-once execution.

`workflow.get` keeps the secret-safe management projection: URL values and completion selectors are omitted. `workflow.update` preserves stored URLs for an unchanged existing step whose submitted `urls` field is absent and whose `urlCount` still matches; it also preserves omitted completion values. To replace or remove URLs, send an explicit `urls` array. A new step requires explicit URLs. This permits a read/unchanged-update round-trip without exposing URL query parameters.

Management v1 Persona `id`, request `profileId`, and batch `personaId` continue to mean the **current Firefox `cookieStoreId`**. This v1 contract does not reinterpret those fields. Persona projections add explicit `personaUid` and `cookieStoreId` fields so current internal consumers can distinguish logical and browser identity. Workflow `profileId` and userscript `profileIds` remain current container IDs on this internal v1 surface; only the external Integration API uses UID-first authoring payloads.

## Optimistic concurrency

Mutating commands may supply `expectedRevision` and/or `expectedBootId`. Existing clients that send only `expectedRevision` remain valid. A supplied stale boot ID is a `STATE_CONFLICT` even when the numeric revision matches; callers must requery authoritative state rather than guessing the next revision.

For `batch.execute`, the optional precondition belongs on the batch request itself. Nested child `expectedRevision` or `expectedBootId` fields, including under child `options`, are rejected. This keeps one precondition for the whole batch instead of applying the same revision to multiple sequential mutations.

## Commands

- system: `system.describe`, `system.status`
- Persona: `persona.list`, `persona.get`, `persona.create`, `persona.open`, `persona.updateIdentity`, `persona.clone`, `persona.archive`, `persona.destroy`
- storage: `storage.inspect`, `storage.clearCookies`, `storage.clearSiteData`, `storage.fullWipe`
- route: `route.list`, `route.get`, `route.assign`, `route.test`
- userscript: `userscript.list`, `userscript.get`, `userscript.assign`, `userscript.unassign`
- workflow/jobs: `workflow.list`, `workflow.get`, `workflow.create`, `workflow.update`, `workflow.delete`, `workflow.run`, `workflow.jobs.list`, `workflow.jobs.get`, `workflow.jobs.stop`, `workflow.jobs.clearFinished`
- batch: `batch.execute`

Only `persona.open`, `route.assign`, and `route.test` are batchable in v1. Destructive single-target commands, including `workflow.delete`, require explicit confirmation. Direct routing remains explicit. The management userscript surface manages only existing scripts and never accepts executable source; workflow authoring persists only definitions that pass the shared run validator.

## Events and security

The advisory event stream uses legacy `PCMS_EVENTS`. Events carry protocol version, `bootId`, runtime sequence, revision, `at` timestamp, type, entity, entity ID, and bounded data. Queries remain authoritative; reconnect, sequence gaps, or changed boot IDs require refresh. Event types include `state.changed`, `persona.changed`, `persona.removed`, `persona.container.rotated`, `route.assignment.changed`, `route.test.completed`, `userscript.assignment.changed`, `workflow.changed`, `workflow.removed`, `workflow.job.changed`, `workflow.job.finished`, and `pcms.batch.completed`. `persona.container.rotated` identifies the stable `personaUid` and old and new `cookieStoreId` values. Batch completion events report only command, total, and failed counts; the batch response carries the per-item outcomes. Event delivery does not replace querying authoritative state.

Responses/events/diagnostics/route projections must not expose cookie values, passwords, tokens, credentials, WireGuard/private-key material, private logs, or URL secrets. When `enforcePrivacyControls` is enabled, unsafe required browser privacy controls block protected proxy routing. Explicit Direct routing bypasses that protected-route readiness gate because it has no proxy privacy boundary; global browser privacy controls are still applied where possible and reported, and strict proxy verification can still reject traffic that is not actually direct. Direct is an unprotected route, is never represented as protected, and still requires explicit intent and local authority. A protected-route failure never silently falls back to Direct. Block remains safe/default; full wipe remains container rotation.

### Stable error codes

The following structured `error.code` values are defined by Management API v1. Unknown internal failures are returned as `INTERNAL_ERROR`; clients should branch on codes and treat human-readable messages as display text.

| Code | Meaning |
| --- | --- |
| `PCMS_PROTOCOL_UNSUPPORTED` | Request protocol version is unsupported. |
| `PCMS_BAD_REQUEST` | Envelope or parameter shape is invalid, required values are missing, or a request exceeds a limit. |
| `PCMS_VALIDATION_FAILED` | Shared semantic validation rejected input. |
| `PCMS_UNKNOWN_COMMAND` | Command is not in the management command set. |
| `PCMS_CAPABILITY_UNAVAILABLE` | Required service capability is unavailable. |
| `STATE_CONFLICT` | Supplied boot/revision precondition conflicts with current state. |
| `PERSONA_NOT_FOUND` | Persona was not found. |
| `PERSONA_UNMANAGED` | Operation requires a managed Persona. |
| `ROUTE_NOT_FOUND` | Route was not found. |
| `ROUTE_DISABLED` | Route exists but is disabled. |
| `DIRECT_ROUTE_REQUIRES_OPT_IN` | Direct routing requires explicit local opt-in. |
| `SECURITY_AUTHORIZATION_REQUIRED` | A state change would widen authority or weaken routing/privacy and lacks a reviewed service authorization. |
| `USERSCRIPT_NOT_FOUND` | Userscript was not found. |
| `USERSCRIPT_DISABLED` | Userscript is disabled. |
| `USERSCRIPT_INCOMPATIBLE` | Userscript uses unsupported grants. |
| `WORKFLOW_NOT_FOUND` | Workflow was not found. |
| `JOB_NOT_FOUND` | Workflow job was not found. |
| `BATCH_COMMAND_NOT_ALLOWED` | Command is not allowed inside a batch. |
| `BATCH_LIMIT_EXCEEDED` | Batch size or concurrency exceeds a limit. |
| `BATCH_CANCELLED` | Item was not started after an earlier fail-fast error. |
| `PCMS_RESULT_TOO_LARGE` | A result or individual batch projection exceeds its limit; a batch row may have applied. |
| `PCMS_RESULT_NOT_SERIALIZABLE` | A successful result contains unsafe or overly deep structure. |
| `PCMS_PAGE_INVALID` | Page size or cursor is malformed or mismatched. |
| `PCMS_PAGE_STALE` | Collection, revision, or runtime changed between pages. |
| `PCMS_REQUEST_ID_CONFLICT` | Mutating request ID was reused for different command/parameters. |
| `PCMS_REPLAY_CAPACITY` | Retained mutation IDs reached the runtime cap; retry later. |
| `DESTRUCTIVE_CONFIRMATION_REQUIRED` | Destructive operation lacks explicit confirmation. |
| `INTERNAL_ERROR` | Unclassified internal failure. |

`route.list` includes virtual routes `__block__` and `__direct__` as well as configured routes. Use `route.list` as the current inventory and use returned route IDs; do not assume a configured route remains enabled or available. `__direct__` still requires explicit authority.
