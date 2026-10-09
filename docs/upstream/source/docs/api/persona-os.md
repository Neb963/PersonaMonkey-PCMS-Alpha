# Persona OS API

Persona OS is PersonaMonkey’s internal typed service layer. It separates domain operations from Firefox and native platform APIs. The bundled Management API consumes these services through explicit command handlers; external callers use the separately documented PersonaMonkey Integration API v1.

This document describes the service facade used by current internal consumers. It is an engineering contract, not a promise about private module names, helper functions, or storage implementation. **PCMS** means **Perchance Central Management System**, a separate product. Its external contract is [PersonaMonkey Integration API v1](integration-v1.md).

## Stable facade

```js
PersonaManager.list(options?)
PersonaManager.get(id, options?)
PersonaManager.create(input?)
PersonaManager.open(id, url?, active?)
PersonaManager.updateIdentity(id, changes)
PersonaManager.clone(id, options?)
PersonaManager.archive(id)
PersonaManager.destroy(id)
PersonaManager.export(id, include?)
PersonaManager.import(fileOrPreview, options?)

StorageManager.inspect(id)
StorageManager.clear(id)
StorageManager.clearCookies(id)
StorageManager.clearSiteData(id)
StorageManager.fullWipe(id)

Diagnostics.getPersonaStatus(id)
Diagnostics.getRouteStatus(id)
Diagnostics.getSystemStatus()

UserscriptManager.list()
UserscriptManager.get(scriptId)
UserscriptManager.assign(scriptId, profileId, options?)
UserscriptManager.unassign(scriptId, profileId, options?)

WorkflowRunner.list()
WorkflowRunner.get(workflowId)
WorkflowRunner.create(workflow, options?)
WorkflowRunner.update(workflowId, workflow, options?)
WorkflowRunner.delete(workflowId, options?)
WorkflowRunner.run(workflowId)
WorkflowRunner.listJobs(options?)
WorkflowRunner.getJob(jobId)
WorkflowRunner.stopJob(jobId)
WorkflowRunner.clearFinishedJobs()

RouteManager.list(options?)
RouteManager.get(id)
RouteManager.assign(personaId, routeId, options?)
RouteManager.test(personaId)
```

The legacy `duplicate`, `storage`, `clearStorage`, `fullWipe`, and diagnostic
`getStatus` names remain compatibility aliases. `Diagnostics.getStatus()` is
an alias for system status. New internal consumers should use the names above; PersonaMonkey Management
callers should use management commands rather than dynamic namespace/method calls.

All creation and import paths default to the Block route. Import reuses a configured proxy route only when provider, host, and port match; Direct routing requires `allowDirect: true`.

`RouteManager` is intentionally small. Its inventory returns normalized,
redacted connection information only: it never returns route usernames,
passwords, tokens, WireGuard material, or private keys. Block is always
assignable. A missing or disabled configured route fails safely, and Direct
requires an explicit `allowDirect: true` option. Route assignment delegates to
the existing profile-route update behavior; route testing delegates to the
existing route-test behavior. Route credential editing is not part of this
facade.

`UserscriptManager` is deliberately limited to existing-script metadata and assignment. Assignment uses the queued state mutation path, rejects missing/disabled/incompatible scripts when assigning, and preserves the runtime's existing grant/assignment enforcement. It does not install or update executable source.

Userscript import previews the declared `@grant` values, `@connect` destinations, and high-impact grants before installing source. New imports have no persona assignments by default; assigning future imports to every managed persona requires saving that explicit import preference. Privileged bridge calls require a matching declared grant, including `Persona.signal`, `GM_getTabData`, `GM_saveTabData`, and `GM_getTabsData`. `GM_cookie` remains restricted to the calling tab's exact Firefox `cookieStoreId` and to cookie hosts declared through `@match` or an unambiguous URL-shaped `@include`; `@connect` does not extend cookie authority.

`WorkflowRunner` delegates execution to the existing orchestrator rather than creating a
second workflow engine. Create/update normalize through the existing storage model and must pass the same `validateWorkflowForRun` semantic checks used before execution; delete is an ordinary queued state mutation. Job views use the same public/redacted representation
as existing diagnostics and lifecycle UI. Stopping or clearing jobs preserves
the orchestrator's ownership, cancellation, and cleanup behavior.

## Lifecycle and clone defaults

`clone(id)` copies identity, settings, route assignment, userscript assignment, and persona-bound workflows. Cookies, site storage, open tabs, automation history, and session state are excluded unless an explicit supported option enables them.

Firefox does not provide a safe API to copy arbitrary LocalStorage, IndexedDB, and CacheStorage between contextual identities. `copyStorage: true` therefore fails explicitly instead of silently creating a partial or cross-persona copy.

Temporary personas use `status: "temporary"` and an ISO `expiresAt`. The background alarm removes expired contextual identities and their browser-owned data. `archive(id)` closes persona tabs and changes the active route to Block while retaining the previous route ID as archival metadata. `destroy(id)` removes the contextual identity and cleans script/workflow references.

## Storage semantics

`inspect(id)` returns complete cookie counts grouped by domain. Firefox exposes site-storage details per origin rather than a complete container-wide inventory, so LocalStorage, SessionStorage, IndexedDB, CacheStorage, and quota estimates cover origins currently open in that persona and return `complete: false`.

Cookie and site-data clears always include the persona `cookieStoreId`. CacheStorage for open origins is cleared inside those persona tabs. `fullWipe(id)` uses contextual-identity rotation: configuration and references move to a fresh container, old tabs close, and Firefox removes the old container. This is the only supported true wipe that cannot spill into another persona or the default profile.

## Package v2

A `.personamonkey` file is a bounded ZIP archive using the documented Persona package format v2 (v1 remains import-readable). The archive carries Persona identity, settings, route metadata, selected userscript/workflow data, and cookies only when explicitly included. Its internal member layout is an implementation detail of the package version.

Default export excludes cookies, site storage, open tabs, session state, automation history, proxy usernames/passwords, private keys, and other credentials. Route export uses an allowlist of non-secret connection metadata. Import supports package versions 1 and 2, previews inventory and warnings, defaults to Block, and restores cookies only with `importCookies: true`.

Encrypted full backups remain a separate existing backup contract. Persona package v2 is intentionally portable and does not imply credential portability.

## State and management compatibility

Persisted state schema is **3**. Schema-2 managed Personas migrate automatically to a
stable `personaUid`; current projections expose both `personaUid` and the current
`cookieStoreId` while legacy service/management `id` arguments remain container IDs.
The state service also maintains runtime-local revision and `bootId` metadata that is
not persisted. Mutating management-backed service paths use serialized state mutations
and may accept `expectedRevision` plus optional `expectedBootId` for optimistic
conflict detection. Existing `getState`/`setState` behavior remains available for
existing same-extension compatibility consumers.

PersonaMonkey Management transport, command, batch, event, and error semantics
are documented in [Management API v1](management-v1.md). Legacy `PCMS_*` wire
identifiers are compatibility names for that internal surface; see the
[compatibility register](../reference/compatibility.md).
