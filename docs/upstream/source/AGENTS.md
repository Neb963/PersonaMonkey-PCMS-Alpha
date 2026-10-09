# Repository agent contract

This file is enforceable guidance for automated and human coding agents working in this repository.

## Ownership and boundaries

- **PersonaMonkey** owns this repository, the Firefox/LibreWolf extension, Persona OS, the bundled **PersonaMonkey Management API/console**, and the narrow Mullvad native bridge.
- **PCMS** means **Perchance Central Management System**, a separate product. PersonaMonkey exposes only the restricted, disabled-by-default Integration API v1 to explicitly trusted external extension IDs.
- The cross-product dependency direction is: `PCMS -> documented PersonaMonkey Integration API -> typed PersonaMonkey / Persona OS services -> platform services -> Firefox/native primitives`.
- Do not expose or forward raw `SAVE_STATE`, raw `PERSONA_API`, arbitrary `browser.*` access, raw persisted state, or generic native-host RPC to an external caller. The Mullvad native host must remain narrowly scoped.

## Preflight and commits

Before changing the repository, inspect current `main`, the working branch/status, recent history, relevant diffs, repository instructions, and affected contracts. Preserve unrelated user work. Prefer a short-lived branch from current `main`.

Work in coherent increments: change -> focused test -> review diff -> commit. Use conventional commit messages. Do not reset, rebase, force-push, delete branches/tags, or rewrite history without explicit authorization. Never commit credentials, cookies, backups, private configs, logs, generated release archives, or unrelated cleanup.

## Security invariants

- Managed Personas with the kill switch enabled fail closed when a protected route is unavailable; Block remains the safe/default route.
- Direct routing always requires explicit authority/opt-in.
- Cookie operations stay scoped to the exact Persona `cookieStoreId`, including Firefox isolation/partition selectors.
- Management/integration responses, events, diagnostics, command catalogs, and route inventory remain secret-safe.
- Full wipe remains contextual-identity rotation; never replace it with broad browsing-data deletion.
- Userscript grants/assignment and workflow execution must continue through existing validation/runtime enforcement.
- The native bridge must not become a generic management server.

## Compatibility authority

Read and preserve [`docs/reference/compatibility.md`](docs/reference/compatibility.md). In particular, do not silently rename or reinterpret legacy management v1 wire names such as `PCMS_REQUEST`, `PCMS_EVENTS`, `PCMS_PROTOCOL_VERSION = 1`, existing `PCMS_*` errors, or `pcms.batch.completed`. Management v1 `profileId` / batch `personaId` continue to mean the current Firefox `cookieStoreId`.

Persisted/package/backup formats and installed extension/native IDs require explicit versioned migration plus regression coverage before compatibility can change.

## Documentation and test authority

Current architecture authority starts at [`docs/architecture/overview.md`](docs/architecture/overview.md). Use [`docs/api/management-v1.md`](docs/api/management-v1.md), [`docs/api/persona-os.md`](docs/api/persona-os.md), [`docs/api/integration-v1.md`](docs/api/integration-v1.md), and [`docs/reference/compatibility.md`](docs/reference/compatibility.md) for current contracts. Historical v0.x design/handoff/release documents are evidence for their time; do not rewrite them to pretend modern terminology existed then.

Run the smallest relevant tests while working. Repository-contract changes require `npm run test:repository`; management registry/schema changes require `npm run test:extension`; source/module-structure changes require `npm run validate`. Run broader gates when the change warrants them, and record unavailable environment-specific gates honestly.

## Non-obvious invariants

Add short comments next to non-obvious security invariants, race-avoidance logic, optimistic-concurrency behavior, destructive sequencing, recovery ordering, or compatibility shims. Explain **why** the ordering/guard exists; do not add comments that merely restate obvious code.
