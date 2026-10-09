> **Historical record.** Preserved for release history; it is not current product authority.

# PersonaMonkey Route Manager v0.6.1

v0.6.1 is the data-portability and UI-polish release before PCMS v0.7. It keeps the v0.6 workflow/runtime contracts intact while adding universal persona data management that is useful independently of PCMS.

## Added

- Persona-scoped cookie manager under **Profiles → Edit**.
- Cookie filtering, editing, single-cookie deletion, persona-only clear-all, and persona-only domain/subdomain clearing.
- Versioned `*.personamonkey-backup.json` backup format.
- Password-encrypted complete backups covering settings, routes/credentials, personas, userscripts, workflows, cookies, persistent GM values, and automation history.
- Selective export for settings, personas, userscripts, workflows, cookies, GM values, history, and route credentials with automatic dependency closure.
- Portable import preview with persona/container mapping and collision-safe local ID remapping.
- Merge and component-scoped replace import modes.
- Individual `.user.js` export from the userscript editor.
- Quota-aware, integrity-checked Firefox Sync recovery for the non-sensitive control plane on fresh/reinstalled copies.
- Dedicated documentation in `docs/DATA_PORTABILITY.md`.
- Dedicated data-management browser CI gate in addition to the existing Automations/package/diagnostics browser gate.

## UI improvements

The entire options surface received a consistent visual pass:

- clearer section headings and context;
- stronger primary/secondary/destructive action hierarchy;
- responsive navigation and narrow-window layouts;
- improved focus states and form surfaces;
- cleaner profile, route, userscript, workflow, diagnostics, and security layouts;
- dedicated visual hierarchy for complete backup, selective export, inspected import, Sync recovery, and legacy JSON compatibility;
- improved persona cookie table/editor presentation;
- refined extension popup with clearer persona status and primary egress-test action.

The UI refactor preserves existing controller element IDs and does not introduce an additional observer/controller layer.

## Security and recovery behavior

- Cookie operations always target the selected contextual identity's exact cookie store.
- Complete backups use PBKDF2-HMAC-SHA-256 key derivation with AES-256-GCM authenticated encryption.
- WireGuard private configuration is never included in PersonaMonkey backups.
- Workflow packages remain intentionally separate from backups and continue to exclude browser session/private persona data.
- Sync recovery excludes cookies, proxy credentials, persistent GM values, automation history, and WireGuard private material.
- Recovery refuses to publish a partial control-plane graph merely to fit Firefox Sync quota.
- Existing local state wins during ordinary updates; reinstall recovery is only considered when healthy local extension state is absent.
- Protected imported personas remain fail-closed rather than silently falling back to Direct networking.

## Compatibility

- Gecko extension ID remains `persona-route-manager@local`.
- Persisted PersonaMonkey state schema remains version 2.
- Native Mullvad routing protocol is unchanged.
- v0.6 workflow/package formats and existing workflows/userscripts remain readable.
- Legacy flat JSON import/export remains available under **Data & backup → Legacy compatibility**.

## Verification

The v0.6.1 branch is gated by the extension regression suite, two browser interaction smokes, release metadata validation, deterministic XPI packaging, and workflow-example packaging. Installed LibreWolf validation is still recommended for the final real-browser export/reinstall/restore cycle because CI uses deterministic WebExtension stubs rather than a signed/installed LibreWolf profile.
