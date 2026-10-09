# PersonaMonkey data portability

This document defines the user-facing and engineering contract for persona cookies, backups, imports, and reinstall recovery.

## Data layers

PersonaMonkey intentionally separates four portability artifacts instead of treating every export as the same thing.

### Workflow packages

`*.personamonkey.zip` packages are distributable automation bundles. They contain a portable workflow manifest and any userscripts required by that workflow. They do **not** contain browser cookies, route credentials, persistent GM values, WireGuard keys, automation history, or a copy of a Firefox container.

Use workflow packages when sharing or generating reusable automation. See [Workflow packages](workflow-packages.md).

### PersonaMonkey backups

`*.personamonkey-backup.json` files are versioned backup envelopes for extension state and persona data. They support complete and selective exports, portable identity remapping, encrypted sensitive payloads, and inspected import.

Use backups for migration, disaster recovery, moving personas between Firefox/LibreWolf profiles, or preserving a complete PersonaMonkey setup.

### Persona cookie packages

`*.personamonkey-cookies.json` files are small, versioned cookie-only packages for explicitly moving browser cookies between personas or installations. They preserve normalized cookie fields, including first-party-domain and partition metadata when Firefox exposes them.

Cookie packages are intentionally **plaintext** because they are a direct inspection/copy tool. They can contain active authentication/session credentials. PersonaMonkey displays a warning before export. For protected-at-rest cookie portability, use a password-encrypted PersonaMonkey backup instead.

Cookie packages contain descriptive persona name/color/icon metadata but do not use the source Firefox `cookieStoreId` as a portable binding.

### Firefox Sync recovery

Firefox Sync recovery is off by default and requires an explicit opt-in. It stores a quota-limited recovery snapshot through `browser.storage.sync`. The snapshot can contain sensitive information in persona notes, route endpoints, userscript source, or workflow URLs, so review the contents before enabling it. It is not a complete backup and is not a substitute for one.

Ordinary extension updates retain `storage.local` under the stable Gecko extension ID, so Sync recovery is primarily for a fresh/reinstalled copy whose local extension storage no longer exists.

## Persona cookie management

Firefox contextual identities expose cookies as separate cookie stores. PersonaMonkey always supplies the selected persona's exact `cookieStoreId` when listing, setting, removing, copying, or clearing cookies.

Open the dedicated **Cookies** tab, or use **Personas → Cookies** on a persona row. The workspace supports:

- selecting a managed persona without mixing cookie stores;
- filtering by cookie name, domain, path, value, or first-party domain;
- creating new cookies;
- editing values, domain/path, SameSite, Secure, HttpOnly, host-only/session state, expiry, first-party domain, and partition top-level site;
- deleting one cookie or a selected set;
- clearing all cookies in one persona;
- clearing a domain and all subdomains in one persona;
- selecting cookies and copying them explicitly to another managed persona;
- direct plaintext cookie-package export/import with merge or replace behavior.

Domain clearing is intentionally recursive. Clearing `example.com` also matches cookies on `sub.example.com`, but never reads or removes the corresponding cookies from another persona.

### Firefox first-party isolation and storage partitioning

Firefox has two independent cookie-isolation dimensions that matter to WebExtensions:

- **First-party isolation** uses `firstPartyDomain`. For `cookies.getAll()`, `firstPartyDomain: null` means all first-party domains. In configurations where first-party isolation is enabled, omitting the field can make the call fail.
- **Dynamic storage partitioning** uses `partitionKey`. By default, `cookies.getAll()` only enumerates unpartitioned storage. Supplying `partitionKey: {}` asks Firefox for both partitioned and unpartitioned cookies.

PersonaMonkey therefore enumerates one managed persona with:

```js
browser.cookies.getAll({
  storeId: personaCookieStoreId,
  firstPartyDomain: null,
  partitionKey: {}
})
```

The `storeId` still restricts the query to exactly one contextual identity. The two wildcard selectors only widen visibility across Firefox's isolation dimensions *inside that persona's cookie store*.

When setting or removing an individual cookie, PersonaMonkey preserves and supplies that cookie's exact first-party and partition metadata where Firefox exposes it.

## Persona row shortcuts

The Profiles table shows Firefox contextual-identity icon/color metadata when available and exposes four direct actions:

- **Edit** — persona routing/domain policy;
- **Cookies** — opens the dedicated cookie workspace with that persona selected;
- **Test** — tests the persona's configured egress;
- **Export** — creates a portable non-sensitive persona backup including the persona policy and required route/userscript dependencies, with route credentials redacted and cookies excluded.

Use Data & backup when the export needs cookies, credentials, GM values, history, multiple objects, or encryption.

## Complete backups

A complete backup contains the portable representation of:

- global PersonaMonkey settings;
- configured routes, including route credentials;
- all managed personas and persona policies;
- userscript source, metadata, settings, and persona assignments;
- workflows and their userscript/persona relationships;
- persona cookies;
- persistent userscript/GM values;
- automation history.

Complete backups require a password. Sensitive backup payloads are encrypted with PBKDF2-HMAC-SHA-256 key derivation and AES-256-GCM authenticated encryption.

WireGuard private configuration is deliberately outside the backup format. PersonaMonkey backups do not become a second store for Mullvad private keys or the repository's credential-bearing bundles.

Treat an encrypted backup like a password-manager export: it can contain authenticated website sessions and proxy credentials. Store it accordingly and keep the password separately.

## Selective backups

Selective export can include any combination of:

- global settings;
- selected personas;
- selected userscripts;
- selected workflows;
- cookies associated with exported personas;
- persistent userscript values;
- automation history;
- route credentials.

Dependencies are closed automatically. For example, exporting a persona can carry the route definition and userscripts that persona references; exporting a workflow can carry the persona/script objects needed to represent it portably.

The backup encoder refuses sensitive plaintext payloads by default. A selective export containing cookies, persistent GM values, or route credentials therefore requires a password. Non-sensitive persona/workflow/userscript/settings exports may remain plaintext so they are inspectable and agent-friendly.

Individual userscripts can also be exported directly as `.user.js` from the userscript editor.

## Portable identities

Firefox container IDs such as `firefox-container-7` are installation-local identifiers. A backup therefore does not use them as permanent identity keys.

The backup graph uses package-local persona, route, script, and workflow keys. During import PersonaMonkey resolves those keys to the destination installation and rewrites references consistently.

This is what allows a backup made in one Firefox/LibreWolf profile to restore into a different profile whose container IDs are not the same.

## Import workflow

Import is intentionally two-phase:

1. **Inspect** — PersonaMonkey parses/decrypts the backup, validates its format, shows an inventory, and suggests mappings from portable personas to existing Firefox containers.
2. **Review and apply** — PersonaMonkey constructs the proposed state, lists exact security changes (including Direct assignments and proxy endpoints), and requires explicit approval before the revision-bound commit. New containers are cleaned up if authorization or the commit fails.

Backup and legacy JSON imports retain the destination installation's Integration API policy. A backup cannot enable integration, add trusted extension IDs, or grant Direct/destructive integration authority. Use the local Integration API settings to change those controls. A stale review is rejected with `STATE_CONFLICT`; re-inspect and retry.

Persona package imports and clones start with the kill switch and LAN blocking enabled, even when the source Persona had relaxed those controls. Direct on a new Persona still requires its own explicit opt-in.

For each imported persona you can reuse an existing destination container or create a new Firefox contextual identity. Two imported personas cannot map to the same destination container in one import.

### Merge mode

Merge preserves unrelated local objects. Incoming IDs are reused only when safe; conflicts are remapped to new local IDs and dependent workflow/persona/script references are updated.

### Replace mode

Replace resets only the component classes represented by the backup. It does not delete arbitrary Firefox containers. Existing containers outside the imported mapping remain browser objects even when their PersonaMonkey management state is replaced.

If an imported protected route cannot be resolved safely, PersonaMonkey follows the existing fail-closed model rather than silently changing that persona to Direct.

Cookie restoration reports partial failures explicitly. A backup import is not reported as fully successful when Firefox rejected some cookie records.

## Firefox Sync reinstall recovery

When enabled, PersonaMonkey keeps a quota-aware recovery snapshot containing:

- global settings;
- persona definitions and policies, including names, descriptions, and notes;
- route definitions including host and port, with usernames and passwords redacted;
- userscript source, metadata, and assignments;
- workflow definitions, including URLs and steps.

These fields may contain sensitive details if the user places them there. Recovery should be enabled only when storing those details in Firefox Sync is acceptable.

The Sync snapshot excludes:

- cookies;
- proxy usernames/passwords;
- persistent GM values;
- automation history;
- WireGuard private material.
- Integration API authority and trusted extension IDs.

Automatic reinstall recovery restores personas in Block with kill switches enabled. Recovered proxy routes remain disabled until you review and enable the exact endpoint locally, then assign it to a persona. Integration authority, Direct assignments, disabled speculative-request blocking, enabled network prediction, and relaxed WebRTC controls are not automatically reactivated. WebRTC starts disabled. Snapshots written before explicit consent are not restored after migration.

Recovery data is chunked and integrity-checked. Each write uses generation-scoped chunk keys and publishes metadata only after every chunk is present, so overlapping writers cannot mix one snapshot's digest with another snapshot's data. Consent is stored as a versioned Sync control record, and each snapshot is tied to that consent epoch. New writes require both account-level consent and this installation's saved opt-in. Oversized candidates do not replace the last readable snapshot.

When an item is deleted from local state, the next recovery write replaces the snapshot with the reduced state so deleted data is not retained by the recovery channel. **Turn off and clear snapshot** disables recovery with a new consent epoch and removes recovery metadata and chunks from the current Sync view. An offline older device may later upload orphaned chunks, but they do not match the current consent epoch and cannot be read as a snapshot.

On a fresh/reinstalled copy, the recovery bootstrap runs before normal background initialization. Existing local state always wins on ordinary updates; recovery is not allowed to overwrite a healthy current installation.

If local state is missing or malformed and existing Firefox containers cannot be recovered from Sync, PersonaMonkey starts with an unmanaged **Block** policy and marks the recovery status as quarantined. This avoids treating formerly managed containers as Direct after data loss. The temporary quarantine state does not replace the last Sync recovery snapshot automatically. Review or restore the missing Persona configuration before changing the unmanaged policy; an installation with no existing containers still uses the normal first-install defaults. Transient storage read or recovery write failures keep routing blocked and are retried on a later request.

Firefox Sync must be enabled for this recovery channel to be useful. For guaranteed migration or disaster recovery, use an encrypted complete backup.

## Legacy JSON import/export

The old flat JSON controls remain under **Data & backup → Legacy compatibility** so earlier backups are still usable.

They do not provide the same portable identity model, inspected mapping flow, cookie/GM/history coverage, or encrypted envelope semantics. New backups should use the versioned PersonaMonkey format.

## Security and testing invariants

These invariants define the expected behavior of this subsystem:

- cookie list operations must use the selected `cookieStoreId`, `firstPartyDomain: null`, and `partitionKey: {}` so first-party-isolated and partitioned/unpartitioned cookies are all visible inside that persona;
- setting/removing cookies preserves Firefox first-party/partition identity metadata when supplied;
- clearing or deleting persona cookies must not touch another persona;
- direct cookie package import/export validates a versioned format and never treats a source container ID as a portable binding;
- encrypted backup encode/decode must round-trip and reject invalid authentication/passwords;
- import remapping must preserve graph references through ID collisions;
- Sync recovery must round-trip, integrity-check chunks, and refuse unsafe partial snapshots;
- browser smoke must cover real persona icon/color rendering, quick Cookies/Export actions, first-party-domain and dynamically partitioned cookie listing, create/edit/copy/import/export/domain-clear flows, and backup/recovery integration;
- normal Automations/package/diagnostics browser smoke must remain green;
- extension validation and deterministic package build must run after all browser smoke gates.

Browser-backed checks cover these contracts with simulated browser APIs. Installed-browser checks of real cookie behavior, Firefox Sync, and a complete export → reinstall → restore cycle provide additional validation.
