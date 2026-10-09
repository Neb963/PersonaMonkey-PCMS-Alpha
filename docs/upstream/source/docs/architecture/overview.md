# PersonaMonkey architecture overview

PersonaMonkey is a Firefox/LibreWolf extension for routing browser identities through configured network routes and managing the data, scripts, and workflows associated with those identities. It owns its browser-facing product, including Persona OS and the bundled management console. The Mullvad native host is a narrow routing bridge.

## Product boundaries

- **PersonaMonkey Management API** is the same-extension management protocol and typed command surface used by PersonaMonkey's own management console and compatible internal consumers. It retains legacy `PCMS_*` wire names for compatibility.
- **PCMS** means **Perchance Central Management System**. It is a separate product, not implemented in this repository.
- **PersonaMonkey Integration API v1** is a separate, restricted cross-extension boundary for an explicitly trusted PCMS extension. It exposes allowlisted Persona, route, storage, existing-userscript, workflow, and status operations, plus separately authorized immutable userscript-artifact installation, Persona control leases, transient input/secrets, and owner-scoped executions/results.

External consumers call only the Integration API. They do not call `SAVE_STATE`, `PERSONA_API`, raw `browser.*` APIs, arbitrary userscript-source/package installation, or native commands. The separately gated artifact-install command accepts immutable, hash-verified source for owner-scoped workflow execution; it does not expose general userscript uploads or arbitrary package import. The native host is not a general management RPC service.

## Layers and ownership

```text
PCMS extension
  -> PersonaMonkey Integration API
  -> typed Persona OS services
  -> platform services
  -> Firefox APIs and narrow native primitives
```

PersonaMonkey's internal management console has its own management protocol and client; it does not use the external Integration API as a shortcut. The principal implementation owners are:

- `extension/lib/persona-api.js`: typed Persona OS facade for Personas, storage, routes, userscripts, workflows, and diagnostics.
- `extension/lib/pcms-control-plane.js`, `pcms-protocol.js`, `pcms-events.js`, and `pcms-client.js`: legacy-named internal management command, protocol, event, and client modules.
- `extension/lib/management-integration-protocol.js` and `management-integration.js`: external Integration API validation, local authorization, UID-to-container resolution, bounded operation correlation, and safe projections.
- `extension/background.js`: WebExtension event wiring and subsystem coordination.
- `extension/lib/` platform modules: persistence, routing, browser identity, cookies, userscripts, workflows, backup, and diagnostics services.
- `native/`: the narrowly scoped Mullvad route bridge and its native-messaging support.

These names describe current ownership boundaries, not a promise that every implementation detail or module layout is public API. Public wire, identifier, persistence, and package compatibility commitments are listed in the [compatibility register](../reference/compatibility.md).

## Trust and security boundaries

The external Integration API is disabled by default. PersonaMonkey authorizes a caller only when the local policy is enabled, its exact extension ID is on the trusted list, its request matches the versioned envelope and command allowlist, and the requested authority is permitted. Destructive operations require local destructive authority and request confirmation; Direct routing requires local Direct authority and explicit intent. Website origin is not an authentication factor. External requests are not forwarded through the internal management dispatcher or to the native host.

The policy is configured from trusted PersonaMonkey extension pages. An external caller cannot add itself to the trusted list or grant itself local authority. Management and Integration API responses, errors, events, descriptors, and route inventory use bounded projections and do not forward secrets or raw internal state.

## Runtime invariants

- Managed Personas with the kill switch enabled fail closed when their protected route is unavailable; Block is the safe default for new or transitional identities. Direct routing requires explicit authority and opt-in.
- Firefox registers a blocking proxy/webRequest guard before asynchronous recovery or initialization. Requests that arrive before routing authority is ready, or while an initialization attempt fails, are cancelled or given a fail-closed proxy result. A later request retries a failed initialization without requiring an extension reload.
- Cookie operations remain scoped to the selected Persona's exact Firefox `cookieStoreId`, with Firefox first-party-isolation and partition selectors where applicable.
- Full wipe uses contextual-identity rotation to replace one Persona's browser container. It does not call broad browsing-data deletion.
- Events are advisory. Clients requery authoritative state after reconnect, boot changes, gaps, or ambiguous failures.
- Userscript source execution remains subject to PersonaMonkey's grant, assignment, and runtime validation. External Automation can install immutable, hash-verified artifacts only when its independent local executable-install authority is enabled; ordinary Integration userscript commands remain metadata/assignment operations, and arbitrary source or package installation is not exposed.
- GM values remain shared per script ID. Page and `GM_cookie` cookies remain scoped to the current container; per-Persona GM-value scope and automatic userscript updating are not current capabilities.

## Current architecture documents

- [Persona identity, lifecycle, persistence, and rotation](persona-model.md)
- [Persona OS service API](../api/persona-os.md)
- [PersonaMonkey Management API](../api/management-v1.md)
- [PersonaMonkey Integration API v1](../api/integration-v1.md)
- [Compatibility register](../reference/compatibility.md)
- [Development rules](../../DEVELOPMENT.md)
- [Security policy](../../SECURITY.md)
- [Branch policy](../development/branching.md)
