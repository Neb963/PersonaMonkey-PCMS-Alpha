> **Historical terminology notice.** This v0.8.0 document records the original internal-control-plane terminology. In current documentation, **PCMS** means the separate **Perchance Central Management System** and the shipped internal surface is the **PersonaMonkey Management API**. The legacy `PCMS_*` wire identifiers described below remain frozen compatibility names. Use [MANAGEMENT_API.md](../../../api/management-v1.md) for the current contract.

# PersonaMonkey management API — protocol v1

PersonaMonkey v0.8.0 exposes a versioned, extension-internal management API.
**PCMS** names the separate Perchance Central Management System, which this
extension does not ship. The v1 `PCMS_REQUEST`, `PCMS_EVENTS`, error/event
names and `extension/pcms/` path remain compatibility identifiers. The
management console uses this facade. Options and popup continue to use named
internal messages, and some views edit revision-aware state snapshots. The
PersonaMonkey domain facade is documented in [`PERSONA_OS_API.md`](../../../api/persona-os.md).

## Transport and discovery

v0.8.0 supports **extension-internal WebExtension runtime messaging only**.
Send a `PCMS_REQUEST` message to the background and use the `PCMS_EVENTS`
runtime Port for advisory events. There is no TCP, HTTP, WebSocket, Internet,
cloud, or generic native-host endpoint. In particular, `native/native_host.py`
remains the narrow Mullvad bridge and is not a management RPC server.

Start with `system.describe`; it returns the installed capability set rather
than requiring a client to assume optional services exist.

```js
{
  type: "PCMS_REQUEST",
  version: 1,
  requestId: "client-correlation-id",
  command: "system.describe",
  params: {}
}
```

```js
{
  version: 1,
  requestId: "client-correlation-id",
  ok: true,
  bootId: "runtime-unique-id",
  revision: 42,
  result: {
    product: "PersonaMonkey Route Manager",
    productVersion: "0.8.0",
    protocolVersion: 1,
    personaApiVersion: "0.7",
    stateSchemaVersion: 2,
    bootId: "runtime-unique-id",
    revision: 42,
    capabilities: ["personas", "persona-storage", "routes", "workflows", "workflow-jobs", "batch", "events", "diagnostics"]
  }
}
```

`bootId` identifies one extension runtime. `revision` is a monotonic,
runtime-local committed-state revision; it resets on a new boot. Clients must
refresh after a changed `bootId` and may use `expectedRevision` on supported
mutating commands to reject stale writes.

## Commands

The registry is explicit. There is no `api.call`, arbitrary namespace/method
dispatch, raw `SAVE_STATE`, browser API pass-through, or arbitrary code
execution command.

| Capability | Commands |
| --- | --- |
| System | `system.describe`, `system.status` |
| Personas | `persona.list`, `persona.get`, `persona.create`, `persona.open`, `persona.updateIdentity`, `persona.clone`, `persona.archive`, `persona.destroy` |
| Persona storage | `storage.inspect`, `storage.clearCookies`, `storage.clearSiteData`, `storage.fullWipe` |
| Routes | `route.list`, `route.get`, `route.assign`, `route.test` |
| Workflows | `workflow.list`, `workflow.get`, `workflow.run` |
| Workflow jobs | `workflow.jobs.list`, `workflow.jobs.get`, `workflow.jobs.stop`, `workflow.jobs.clearFinished` |
| Batch | `batch.execute` |

Persona and route targets use `profileId`; route lookup uses `routeId`; job and
workflow targets use `jobId` and `workflowId`. `persona.open` additionally
accepts optional `url` and `active` fields. `route.assign` accepts `{ profileId,
routeId, options }`; `options.allowDirect` must be exactly `true` to select
Direct. Block remains allowed and is the safe default. Missing or disabled
routes fail safely.

### Identifiers and parameters

| Name | Meaning in v1 | Example |
| --- | --- | --- |
| `profileId` | Persona command target: browser-profile-local Firefox contextual identity store ID | `firefox-container-2` |
| `containerId` | The same store ID on a stored profile and in create/clone results | `firefox-container-2` |
| `cookieStoreId` | Firefox's tab/cookie API field for that container | `firefox-container-2` |
| `personaIds` / `personaId` | Batch input list / result-row field carrying a `profileId` | `firefox-container-2` |
| Logical persona UID | Proposed durable identity; absent from schema 2 and protocol v1 | No v1 value |

Container IDs can change after full wipe, import or restore. They are not
durable across Firefox profiles or machines. Events are advisory; query the
current state after a reconnect, sequence gap or changed `bootId`.

Commands reject unknown fields and wrong types with `PCMS_BAD_REQUEST`,
including nested `options`. Required target IDs are marked with `*` below.

| Command family | Accepted fields |
| --- | --- |
| `system.describe`, `system.status`, `workflow.list` | Empty params |
| `persona.list`, `persona.get` | Optional `options.includeStorage` boolean; get requires `profileId*` |
| `persona.create` | `input` object or top-level name/color/icon/description/routeId/temporary/ttlHours/expiresAt/allowDirect/settings/profile; optional `options.expectedRevision`, `options.allowDirect`, top-level `expectedRevision` |
| `persona.open` | `profileId*`, optional string `url` and boolean `active` |
| `persona.updateIdentity` | `profileId*`, `changes*` with name/color/icon/description; optional `options.expectedRevision` or top-level `expectedRevision` |
| `persona.clone` | `profileId*`; optional `options` with copy flags, name/color/icon, allowDirect and expectedRevision; optional top-level `expectedRevision` |
| `persona.archive` | `profileId*`; optional `options.expectedRevision` or top-level `expectedRevision` |
| `persona.destroy`, `storage.clearCookies`, `storage.clearSiteData`, `storage.fullWipe` | `profileId*`, `confirm: true`; optional `options.expectedRevision` or top-level `expectedRevision` |
| `storage.inspect`, `route.test` | `profileId*` |
| `route.list`, `route.get`, `route.assign` | List: optional `options.includeVirtual`; get: `routeId*`; assign: `profileId*`, `routeId*`, optional `options.allowDirect`, `options.expectedRevision` or top-level `expectedRevision` |
| `workflow.get`, `workflow.run`, `workflow.jobs.get`, `workflow.jobs.stop` | Required `workflowId*` or `jobId*` |
| `workflow.jobs.list`, `workflow.jobs.clearFinished` | List: optional empty `options` object; clear: `confirm: true` |
| `batch.execute` | `command*`, `personaIds*`; optional `params`, `concurrency`, `failurePolicy`; top-level `expectedRevision` is rejected |

Multi-persona batches also reject shared `params.expectedRevision` and
`params.options.expectedRevision`; use a single target when providing an
expected revision.

Create `settings`/`profile` objects accept the persisted profile attributes
defined by the state schema, including privacy flags, domain lists, script IDs
and statistics. Clone flags include `copyIdentity`/`identity`,
`copySettings`/`settings`, `copyRoute`/`route`, `copyScripts`/`userscripts`,
`copyWorkflows`/`workflows`, `copyCookies`/`cookies`, `copyStorage`/`storage`,
`copySessionState`/`history`, `copyTabs`/`openTabs`, and `copyName`, `copyColor`,
`copyIcon`. Persona list/get results project the public card fields; URL
userinfo, queries and fragments are stripped in free-form response text.

Commands marked destructive require `params.confirm === true` when invoked
for one target: `persona.destroy`, `storage.clearCookies`,
`storage.clearSiteData`, `storage.fullWipe`, and
`workflow.jobs.clearFinished`. The latter accepts no other parameter. Portable
Persona import/export remains on the Persona OS facade in protocol v1; binary
transport and sensitive-cookie handling are not exposed as management commands.

## Responses and errors

Every result is a bounded, secret-safe JSON value:

```js
{
  version: 1,
  requestId: "client-correlation-id",
  ok: false,
  bootId: "runtime-unique-id",
  revision: 42,
  error: {
    code: "PERSONA_NOT_FOUND",
    message: "Managed persona not found",
    retryable: false,
    details: null
  }
}
```

Clients branch on `error.code`, not free-form messages. Expected errors use:

`PCMS_PROTOCOL_UNSUPPORTED`, `PCMS_BAD_REQUEST`,
`PCMS_UNKNOWN_COMMAND`, `PCMS_CAPABILITY_UNAVAILABLE`, `STATE_CONFLICT`,
`PERSONA_NOT_FOUND`, `PERSONA_UNMANAGED`, `ROUTE_NOT_FOUND`,
`ROUTE_DISABLED`, `DIRECT_ROUTE_REQUIRES_OPT_IN`, `WORKFLOW_NOT_FOUND`,
`JOB_NOT_FOUND`, `BATCH_COMMAND_NOT_ALLOWED`, `BATCH_LIMIT_EXCEEDED`,
`BATCH_CANCELLED`, `DESTRUCTIVE_CONFIRMATION_REQUIRED`, and `INTERNAL_ERROR`.

Within a successful batch response only, an unscheduled `failFast` item uses
`BATCH_CANCELLED`; it is an item outcome, not a top-level request error.

Malformed envelopes, unknown commands, invalid parameters, unsupported
versions, and requests larger than the limit are rejected before service
dispatch. Stack traces and raw exception objects are never serialized.

## Batch execution

`batch.execute` is intentionally narrow:

```js
{
  command: "route.test",
  personaIds: ["persona-a", "persona-b"],
  params: {},
  concurrency: 4,
  failurePolicy: "continue"
}
```

Only `persona.open`, `route.assign`, and `route.test` are batchable. A batch
uses an explicit persona list, deduplicates first occurrences, preserves that
order in its result, and returns per-item `{ personaId, ok, result|error }`
rows. Missing or unmanaged personas fail only their own row. `continue` runs
remaining items; `failFast` stops scheduling new items after the first failed
row and reports unscheduled rows as cancelled. There is no destructive bulk
operation in v0.8.0.

Hard limits are: **1 MiB** serialized request JSON, **200** selected personas,
**4** default batch concurrency, and **16** maximum batch concurrency.

## Events

Events are advisory. Query commands remain the source of truth; reconnect,
sequence gaps, and changed boot IDs require a client refresh. Subscribe using a
runtime Port named `PCMS_EVENTS`:

```js
{
  version: 1,
  bootId: "runtime-unique-id",
  sequence: 18,
  revision: 42,
  at: "2026-09-15T00:00:00.000Z",
  type: "route.assignment.changed",
  entity: "persona",
  entityId: "persona-a",
  data: {}
}
```

Sequences strictly increase for one runtime. Events are bounded to **32 KiB**
after sanitization; broken subscribers are isolated and disconnect cleanup
removes their listener. Emitted families are `state.changed`, `persona.changed`,
`persona.removed`, `route.assignment.changed`, `route.test.completed`,
`workflow.job.changed`, `workflow.job.finished`, and `pcms.batch.completed`.
The management console retains at most **500** in-memory activity rows and does not
create a second event-history database.

## Security and compatibility

Management response, event, route inventory, and diagnostics serialization redact or
omit cookie values, session tokens, passwords, credentials, WireGuard/private
key material, and other secrets. Routing remains fail-closed: Block is the
default and Direct is always explicit. Existing strict proxy verification,
privacy controls, First Party Isolation, partitioned-cookie behavior,
cookie-store scoping, contextual-identity full wipe, backup/package security,
and workflow/userscript boundaries remain intact.

The Gecko extension ID stays `persona-route-manager@local`; persisted state
schema stays **2**. A future local adapter, if introduced, must be a separate,
opt-in, authenticated or OS-permission-controlled local component that exposes
only this command registry with strict limits and secret-free responses.

Deferred beyond v0.8.0: external control transport, groups/tags, scheduling,
destructive bulk confirmation, batch cancellation, route credential management
extraction, a second workflow engine, plugins/arbitrary JavaScript, and a
wholesale options-page rewrite.
