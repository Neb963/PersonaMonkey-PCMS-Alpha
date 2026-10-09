# Development

This is the engineering entry point for PersonaMonkey v1. It summarizes repository ownership, architecture boundaries, invariants, and the validation path. Detailed behavior belongs in the linked architecture, API, compatibility, testing, and release documents.

## Repository source and ownership

`main` is the canonical current source. Work on short-lived branches based on current `main`, and merge normally. The Firefox/LibreWolf extension lives in `extension/`; the narrowly scoped Mullvad native bridge lives in `native/`; repository scripts and tests live in `scripts/` and `tests/`; supported workflow examples live in `examples/`.

PersonaMonkey owns the extension, Persona OS, bundled PersonaMonkey Management console/API, and native bridge. **PCMS** means **Perchance Central Management System**, a separate product that may use the restricted PersonaMonkey Integration API. The dependency direction is:

```text
PCMS → PersonaMonkey Integration API → typed PersonaMonkey services → Firefox/native primitives
```

PersonaMonkey Management is an internal same-extension consumer. Its historical `PCMS_*` protocol names are frozen compatibility identifiers; they do not identify the separate PCMS product or define the external Integration API. See [the architecture overview](docs/architecture/overview.md) and [Management API v1](docs/api/management-v1.md).

## Architecture and contract authorities

- [Architecture overview](docs/architecture/overview.md) describes component boundaries and trust zones.
- [Persona model](docs/architecture/persona-model.md) owns identity, lifecycle, rotation, and persistence concepts.
- [Persona OS API](docs/api/persona-os.md) documents the typed internal service facade.
- [Management API v1](docs/api/management-v1.md) documents the bundled management surface.
- [Integration API v1](docs/api/integration-v1.md) is the external extension contract.
- [Compatibility register](docs/reference/compatibility.md) is the canonical list of compatibility-sensitive identifiers and formats.
- [Security policy](SECURITY.md) governs vulnerability reports and private-data handling.

Do not duplicate API schemas or wire contracts in this entry point. If implementation and documentation disagree, resolve the issue against the relevant canonical contract and add regression coverage where needed.

## Engineering invariants

- Managed Personas with the kill switch enabled fail closed when a protected route is unavailable. Direct routing requires explicit authority and user policy.
- Cookie operations remain scoped to the exact current Firefox `cookieStoreId`, including Firefox isolation and partition selectors.
- Management and Integration API responses, events, diagnostics, and command catalogs remain secret-safe.
- Full wipe remains contextual-identity rotation with recoverable ordering; it is not broad browsing-data deletion.
- Userscript grants and workflow authoring/execution remain subject to existing validation and runtime enforcement.
- Native messaging remains a narrow Mullvad transport. Do not turn it into a general management RPC service.
- Persisted/package formats and installed extension/native IDs require an explicit migration and regression coverage before changing.

These are boundaries for change, not a complete contract. Consult the linked authority documents before modifying related behavior.

## Development checks

Use Node.js 22 or newer and Python 3.12 for the repository's CI-equivalent environment. From the repository root:

```bash
npm test
npm run test:browser
npm run validate
npm run build
npm run release:check
```

`npm run release:check` runs all preceding local gates in sequence. [Testing](docs/development/testing.md) explains the boundary and evidence for each gate. [Branching](docs/development/branching.md) and [Release](docs/development/release.md) describe candidate and tag discipline.

## Change discipline

Read [`AGENTS.md`](AGENTS.md) and the applicable contract before editing. Inspect the current branch, status, recent history, and relevant diff; keep changes focused and preserve unrelated work. For behavior changes, add or identify regression coverage for the affected invariant, then run the smallest relevant checks and review the complete diff. Use conventional commit messages for coherent commits. Do not commit credentials, cookies, browser exports, private backups, WireGuard material, generated release artifacts, logs, or temporary debugging output.

Keep established UI element IDs used by controllers and browser smokes stable. Prefer targeted changes to the owning module over broad observer/controller layers. For security-sensitive or compatibility-sensitive work, include the relevant review and migration implications in the change description.
