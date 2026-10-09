> **Historical record.** Preserved for release history; it is not current product authority.

# PersonaMonkey Route Manager v0.7.4

v0.7.4 completes the v0.7.1–v0.7.4 Persona OS expansion. It is the final Persona foundation milestone before the v0.8 PCMS integration layer.

## Delivered

- Persona-first dashboard with identity, description, last-used time, statistics, protection, cached route health, tab/cookie counts, and storage signals.
- Stable lifecycle services for list/get/create/clone/archive/destroy, including disposable personas with automatic expiry.
- Safe clone defaults that exclude cookies, site storage, tabs, history, and session state.
- Persona-scoped cookie-domain inventory, open-origin storage inspection, cookie/site-data clears, and true full wipe through contextual-identity rotation.
- `.personamonkey` package v2 with separate identity/settings/route/metadata records, userscripts, and workflows.
- v1 package import compatibility plus preview warnings and explicit cookie/Direct-route import choices.
- Frozen PersonaManager, StorageManager, WorkflowRunner, and Diagnostics namespaces for v0.8 consumers.

## Security properties

- Default persona exports contain no cookies or session tokens.
- Portable routes are serialized from a non-secret allowlist; proxy passwords, usernames, WireGuard keys, and private credentials are absent.
- Every cookie and site-data operation is asserted against a managed persona and scoped by `cookieStoreId`.
- Archive and unmatched imports select Block. Existing proxy verification and fail-closed policy remain unchanged.
- Unsafe arbitrary cross-container storage cloning is rejected explicitly.

## Verification

The release gate runs all extension unit/security tests, both browser interaction suites, manifest/source validation, XPI construction, and workflow-package construction. Browser suites require a Chrome/Chromium executable in the test environment.
