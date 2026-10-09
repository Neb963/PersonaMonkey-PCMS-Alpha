# Phase 06 — F-07, F-08, and Native Framing Closure Record

- Date: 2026-09-25
- Audit baseline: `main` at `e33272a7d4ff49623d613d11fbb65da806d7f869`
- Phase 06 base: `phase-05-userscript-sync-integration-hardening` at `0a7eed6d571ab59d601ec83c7ed1e793e28c7da9`
- Implementation head before this record: `483ee4e78844741354b9c175b0b7c3387f1a47ef`

Scope is Phase 06 only: F-07 native boundary and service hardening, F-08 distribution integrity/signature posture, and the oversized native-message framing observation from F-16. F-01 is excluded. This record does not close the remaining F-16 observations or declare the v1.1.0 release complete.

## F-07 — Native forwarder and service hardening

- **Status:** Remediated in code and covered by deterministic tests; supported-host installation and route acceptance remain open.
- **Root cause:** Loopback SOCKS forwarders accepted unauthenticated clients; service isolation and key-bearing file writes needed stronger guarantees; native fetch policy fields could be omitted.
- **Remediation:** Each extension forwarder uses a 256-bit random SOCKS5 username/password credential with a one-hour acceptance lease. The daemon checks credentials before opening a relay connection, rejects expired/replayed credentials, rotates them without closing established TCP sessions, and omits them from status and native responses. Stop, release, restart, and entry-switch paths revoke credentials and close both socket ends; cleanup attempts every route and takes the WireGuard interface down before reporting errors. Daemon-side `network_policy` and `connect_policy` validation is required before fetch networking, and redirects are checked before new connections. Key-bearing configuration/state files are created as mode `0600` temporary files and atomically replaced. The systemd unit limits capabilities, filesystem writes, home access, and address families while retaining IPv4/IPv6 and netlink support.
- **Regression coverage:** `tests/test_forwarder_auth.py` covers unauthorized and authorized clients, token expiry/rotation, socket cleanup during relay setup, stop races, error-isolated multi-forwarder cleanup, secret non-disclosure, and policy rejection before network effects. `tests/test_native.py`, `tests/test_native_service_hardening.py`, and `extension/tests/mullvad-runtime.test.mjs` cover policy, private file creation, unit directives, and matching extension token lifecycle.
- **Native/Firefox evidence:** `systemd-analyze verify` accepted the rendered unit after replacing the not-yet-installed `ExecStart`/`ExecStop` commands with `/usr/bin/true`; this establishes unit syntax only. The container has no `wg` command and systemd is not running, so live service startup, WireGuard routing, install/update/uninstall, and permission checks were not possible. In Firefox 157, BiDi `archivePath` installation returned `INVALID_ARGUMENT` / “unknown error”; sending the same local unsigned XPI through BiDi's base64 install path succeeded as a temporary add-on (`persona-route-manager@local`, v1.0.0, MV3, active). Its popup rendered the expected “Not a persona” state on the default tab, with no console errors. The temporary add-on and test tabs were removed; Firefox was not restarted or closed.
- **Compatibility impact:** The native `prepare_exit` request now requires a forwarder token, and the Firefox proxy configuration supplies SOCKS5 username/password fields. The extension and native host must be upgraded together. Ordinary requests continue to use the same loopback proxy behavior after authentication.
- **Residual uncertainty:** Real service operation and route behavior under the hardened unit remain unverified on a supported Linux host. The static unit check and deterministic socket tests do not establish WireGuard/kernel compatibility.

## F-08 — Distribution integrity and signature posture

- **Status:** Local integrity work is implemented; the finding remains open and release-blocking pending Mozilla signing and independently authenticated release provenance.
- **Root cause:** The supported installer disabled browser-wide signature enforcement and checked only XPI metadata; the release workflow builds an unsigned XPI and does not provide a Mozilla-signed artifact with independent digest provenance.
- **Remediation:** Browser deployment requires an explicit SHA-256 digest, verifies the exact XPI bytes, manifest version and ID, and expected Mozilla signature-container member names before dependency installation or system mutation. The verified bytes are pinned in a private `0600` file and reused for deployment. New installs never set `xpinstall.signatures.required=false`; LibreWolf changes only a marked distribution-add-on preference block. Restore state is persisted before preferences change, edits outside the managed block are preserved, and uninstall aborts before destructive cleanup if preference restoration state is invalid or unavailable. `--no-browser-install` skips XPI validation/deployment and browser preference changes while still permitting native-only installation.
- **Regression coverage:** `tests/test_release.py` covers digest match/mismatch, malformed and missing-member XPIs, manifest ID/version checks, exact-byte pinning and mode, preflight-before-mutation ordering, extension/native ID consistency, legacy preference migration, preservation of existing and later user settings, state-write failure, and uninstall abort/retry-state preservation.
- **Firefox/install evidence:** Firefox 157 loaded the local unsigned XPI as a temporary add-on and rendered its popup, confirming that the built MV3 package loads in this browser. This does not test persistent installation or Mozilla signature acceptance. No genuinely Mozilla-signed XPI or independently authenticated digest was available, so those release gates remain unverified.
- **Compatibility impact:** Browser deployment now fails closed without the signed release artifact and trusted digest. Users can install the native bridge alone with `--no-browser-install`; existing signature-enforcement settings are preserved.
- **Residual uncertainty:** The validator checks marker filenames, not Mozilla cryptographic signatures. A trusted digest must identify a genuinely Mozilla-signed artifact, and browser acceptance evidence is still required before F-08 can close.

## F-16 — Native messaging framing observation

- **Status:** Oversized-frame observation fixed and verified; overall F-16 remains open for its other phase-scoped observations.
- **Root cause:** Continuing after an oversized declared body risks parsing subsequent bytes from a desynchronized native-messaging stream.
- **Remediation:** The host terminates immediately after reading a frame header that declares more than 1 MiB, without reading the body or attempting a response. Complete malformed frames still produce an error response and preserve alignment.
- **Regression coverage:** `tests/test_native_framing.py` exercises the 1 MiB boundary, an over-limit frame, `0xffffffff`, malformed and empty complete frames followed by a sentinel, and truncated EOF.
- **Compatibility impact:** Valid messages up to the existing 1 MiB limit are unchanged. An oversized frame now closes the host connection immediately.
- **Residual uncertainty:** The framing behavior is unit-tested; no real Firefox native-messaging session was available in this phase.

## Phase 06 implementation commits

| Commit | Purpose |
| --- | --- |
| `a1b87663847a3476cbbe710236c6949ee3c96580` | Authenticate and lease Mullvad exit forwarders; require policy and add regressions. |
| `82e5b6cd24d9cc159475d519882eb00645d63e4b` | Harden the native service and atomic private-file writes. |
| `28ffacd485a2f497018a3bc5e4023a104aa73a1f` | Reject oversized native-messaging frames safely. |
| `483ee4e78844741354b9c175b0b7c3387f1a47ef` | Verify and pin browser distribution artifacts; preserve signature enforcement. |

## Deterministic verification

Passed on the final Phase 06 source:

- `npm test` — repository checks passed; all 56 extension test files passed; 51 native/release tests passed.
- `npm run validate` — passed; 128 source files validated.
- `npm run build` — passed. Local unsigned XPI SHA-256: `c93e4bbc3319bb30d34beb6c507e21d1ffa89c80bfd77d49db7ad6a83dbf74ac`. Workflow example ZIP SHA-256: `c8a85b9698b71d4e330e0909ccf8d0f9cce1ded7701028c90d949fc73e602901`.
- `bash -n install.sh uninstall.sh` and `git diff --check` — passed.
- `systemd-analyze verify` — passed on a rendered unit with installed service commands replaced by `/usr/bin/true`; no live service was started.

Chromium-dependent tests, `npm run test:browser`, and `npm run release:check` were not run under the Phase 06 constraints. No GitHub Actions workflow was dispatched or rerun.

## Release and repository boundary

The product version remains 1.0.0 on this remediation branch; this is not a v1.1.0 release. Phase 08 remains responsible for final Firefox lifecycle acceptance and the overall release gate. Main was not modified. The verification directory was assembled from GitHub file APIs rather than a Git clone, so its synthetic local `git status` is not a meaningful remote branch status. Generated `dist/` artifacts were not committed.
