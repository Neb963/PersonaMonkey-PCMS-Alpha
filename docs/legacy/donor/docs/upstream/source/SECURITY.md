# Security policy

This document is the security authority for the current PersonaMonkey product. The supported product is the Firefox/LibreWolf extension and its narrow local Mullvad routing bridge. The separate Perchance Central Management System (PCMS) can use only the documented PersonaMonkey Integration API v1 when a user explicitly enables and authorizes it.

## Trust boundaries

### Local extension surfaces

Privileged internal management requests are accepted from PersonaMonkey's own extension pages. Content scripts receive only their purpose-built automation signals; they do not receive the management API. Website origin is not a credential and does not authorize a caller.

The external Integration API is disabled by default. Enabling it is a local user action. Each caller must also match an exact extension ID in the bounded local trusted-ID list. Only trusted PersonaMonkey pages can edit that policy; an external caller cannot add itself or change global safety policy. Authorization is checked on each request and external event connection. A same-extension caller must use the internal management surface.

The Integration API exposes only its documented typed commands and least-privilege projections. It does not expose raw state mutation (`SAVE_STATE`), the internal `PERSONA_API`, arbitrary Firefox APIs, arbitrary executable source or package import, or generic native-host RPC. PCMS-owned account credentials, account identifiers, and business data belong in PCMS storage, not PersonaMonkey userscript values.

PersonaMonkey Management API v1 is an internal same-extension protocol. Its legacy `PCMS_*` wire names are compatibility identifiers; they do not grant access to the separate PCMS product. See the [Management API contract](docs/api/management-v1.md) and [Integration API contract](docs/api/integration-v1.md).

### Routing and authority

- Managed Personas using a protected route fail closed when that route is missing, disabled, or unavailable while the Persona's kill switch is enabled. Block is the safe/default route for new or transitional identities. Unmanaged Personas follow the user's configured unmanaged policy.
- Direct routing bypasses protected routing. It requires explicit authority and opt-in; the Integration API requires both the request's `allowDirect` intent and local `allowDirect` policy. The API rejects attempts to weaken policy through fields such as `killSwitch: false` or `unmanagedPolicy`.
- Destructive Integration API operations require both per-request confirmation and local `allowDestructive` authority. Internal management surfaces retain their documented explicit confirmation behavior. Full wipe is contextual-identity rotation; it is not broad Firefox browsing-data deletion.
- New mutating Integration API work requires a current boot/revision precondition. An already-completed correlation or matching active full-wipe recovery may resolve without repeating that side effect; see the [Integration API contract](docs/api/integration-v1.md). Conflicts require requerying authoritative state; callers must not guess a revision. Events are advisory, not a durable audit or replay stream.

### Browser data and native routing

Cookie, storage, and contextual-identity operations must remain scoped to the selected Persona's exact Firefox `cookieStoreId`. Cookie enumeration includes Firefox first-party and partition selectors inside that store; it must not read or change another Persona's cookie store. `personaUid` is the durable logical identity; `cookieStoreId` is the current browser container identity.

The native messaging host is a narrow local Mullvad routing bridge, not a general management server. Its installed manifest and daemon access controls must retain the intended extension and local-user boundary. Do not add arbitrary commands, expose generic privileged RPC, or use this bridge to bypass the typed PersonaMonkey APIs.

## Secrets and private data

Never commit, attach to a public issue or pull request, or include in CI output:

- Mullvad/WireGuard configurations, private keys, credential-bearing bundles, or other VPN secrets;
- browser profiles, cookies, session data, cookie exports, GM storage, or PersonaMonkey backups;
- proxy credentials, access tokens, passwords, private account data, or diagnostic output that contains them;
- generated release archives before they have been inspected for private data.

Keep private installation inputs and test fixtures local. Keep generated release artifacts in the ignored `dist/` directory until inspected. Public release artifacts may include the extension XPI, supported workflow examples, and checksums; they must not include private routing material or browser data.

PersonaMonkey backups can contain active website sessions and proxy credentials. Sensitive backup payloads require password-based encryption; treat the resulting file like a password-manager export and store it accordingly. Cookie-only packages are intentionally plaintext and may contain active authentication cookies. Share neither kind of file as a security report attachment. WireGuard private configuration is outside the PersonaMonkey backup format.

Management and Integration API projections, events, diagnostics, and route inventory must remain secret-safe. External Integration API results use explicit least-privilege projections; they must not expose route credentials, cookie values, authentication headers, WireGuard private material, userscript source, GM values, cached dependency bodies, private diagnostics, or stack traces. Do not forward complete internal event or state objects across an external boundary. See [Data portability](docs/guides/data-portability.md) for the backup and cookie handling contract.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's **Report a vulnerability** feature for this repository when it is enabled. If private reporting is unavailable, contact the maintainers through a private contact channel published by the repository or organization and request a secure reporting route. Do not publish exploit details, credentials, personal data, or proof-of-concept material in a public issue, discussion, pull request, or release comment.

Include the affected PersonaMonkey version and browser/OS, the impact and conditions required to reproduce the issue, and a minimal reproduction that contains no real credentials or user data. Send only the information needed to assess the report. The maintainers can coordinate remediation and disclosure after a fix is available.

## If private data or a credential is exposed

Treat a committed or publicly shared credential as compromised even if the file is later deleted. Revoke or rotate it with the provider first, then privately notify the maintainers and remove it from active branches and release artifacts. Preserve incident details privately. Removing a secret from Git history requires a coordinated incident plan because rewriting shared history affects collaborators; do not force-push a rewritten history without that plan. Deleting the file in a later commit does not revoke a credential or erase copies already fetched.
