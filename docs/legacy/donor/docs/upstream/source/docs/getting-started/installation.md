# Installation

PersonaMonkey's manifest requires Firefox 153.0 or newer. A LibreWolf release must provide compatible Firefox extension APIs at that version. The optional Linux native bridge connects the extension to a locally installed Mullvad WireGuard configuration. The bridge is only needed for that routing integration; the extension and its management features do not require it. Public source and release artifacts never include WireGuard credentials.

## Install the extension

Build a v1.2.0 XPI from a source checkout, or use the GitHub release artifact for source/checksum-matched testing. Unless a release asset is explicitly identified as Mozilla-signed, treat it as an unsigned development XPI suitable only for temporary loading. To build from source, use Node.js 22 or newer:

```bash
npm run validate
npm run build
```

The build writes `dist/persona-route-manager-v1.2.0.xpi` and its SHA-256 checksum. The archive contains the extension only; it excludes tests and routing credentials.

Firefox and LibreWolf require a Mozilla-signed XPI for persistent installation. `npm run build` produces an unsigned XPI, so it is suitable for temporary development loading only. The Linux installer accepts a signed release XPI only when you also supply its SHA-256 digest from an independent, trusted release channel. It checks the digest, manifest version and ID, and Mozilla signature-container member names before making system changes, then pins those exact bytes for deployment. The member-name check is structural: it does not cryptographically verify Mozilla's signature. The digest must identify a genuinely Mozilla-signed artifact, and the browser's signature enforcement remains enabled. The extension ID is `persona-route-manager@local` and is kept stable for upgrades.

## Optional Linux Mullvad bridge

The installer needs a Linux system using systemd and root access (it invokes `sudo` when run as a regular user). A fresh install needs a Mullvad WireGuard ZIP, `.conf` file, or directory. An existing installation does not: running `./install.sh` with no config argument reuses `/etc/persona-mullvad-router/configs/*.conf` (or the active `prm-mv.conf` fallback), creates a private backup ZIP in the desktop user's home, validates the replacement config, snapshots the installed runtime and service state, replaces the old bridge, and starts the new one. If a later upgrade step fails after replacement begins, the installer restores the previous runtime snapshot instead of leaving a half-upgraded bridge. It checks for `python3`, `wg`, `ip`, and `systemctl`; it can install missing Python/WireGuard/IP tools through apt, dnf, pacman, zypper, apk, or xbps. Install the dependencies yourself on other distributions. The service installation requires systemd regardless of package manager.

Download a WireGuard configuration from Mullvad and keep it private and outside the repository. To install the bridge and deploy a signed release XPI, run:

```bash
./install.sh /path/to/mullvad-wireguard.zip \
  --xpi /path/to/persona-route-manager-v1.2.0-signed.xpi \
  --xpi-sha256 TRUSTED_64_CHARACTER_SHA256
```

The default XPI path is `dist/persona-route-manager-v1.2.0.xpi`, which is an unsigned build and will be rejected for browser installation. Pass `--xpi` and `--xpi-sha256` with the signed release artifact and its independently obtained digest. A `.sha256` file downloaded alongside an untrusted XPI does not establish a trusted digest by itself. If no verified signed release is available yet, `--no-browser-install` allows installation of the native bridge without deploying an XPI. When browser deployment is enabled, the installer performs XPI preflight before dependency installation, config staging, service stop, or other system changes. It installs the native service and configuration, enables the service, and starts the selected WireGuard entry unless `--no-start` is given. It prefers a Warsaw entry when present; use `--entry TEXT` to select a different exact ID or substring.

The installer deploys the XPI and writes a marked `extensions.installDistroAddons` override only for detected native-package LibreWolf layouts. It does not change `xpinstall.signatures.required`. Uninstall removes only the exact managed preference block and preserves user edits outside it. It does not configure Firefox or Flatpak LibreWolf. If it cannot find a supported LibreWolf installation, the native bridge still installs and XPI deployment is skipped; install the extension separately. Use `--no-browser-install` to skip XPI preflight, deployment, and all LibreWolf preference changes, and `--no-librewolf-config` to skip LibreWolf preference changes. `--user USER` selects the desktop user when automatic detection is unsuitable.

The extension requires native bridge version `0.3.0` or newer. This version added per-route SOCKS authentication for Mullvad exits. An older bridge can report its WireGuard entry and base SOCKS as ready while the protected exit path is incompatible. To update an existing bridge without reinstalling the browser extension, use the one-command upgrade:

```bash
./install.sh
```

The installer auto-discovers the installed private configuration, writes a `persona-mullvad-router-private-backup-*.zip` file with mode `0600` into the desktop user's home, validates/sanitizes the configuration before stopping the old bridge, snapshots the existing bridge/service/browser deployment, and then installs the current bridge. If any subsequent install step fails, the EXIT rollback restores the previous runtime, service enable/active state, tunnel state, native manifests, managed browser XPI, configuration tree, and LibreWolf override. The backup contains the WireGuard configuration and therefore the private key; keep it private and never commit or upload it publicly. If no installed configuration exists, supply a Mullvad WireGuard ZIP, `.conf`, or directory explicitly and use `--no-browser-install` for a bridge-only first install.

Refresh bridge status in PersonaMonkey after the installer finishes.

Fully restart LibreWolf after installation. Then open PersonaMonkey and configure personas and routes. The native bridge uses the supplied WireGuard configuration locally; keep the original archive and installed configuration private.

## Diagnostics and removal

```bash
./diagnose.sh
./uninstall.sh
```

Never attach the WireGuard archive, installed configuration, PersonaMonkey backup, or cookie export to a public issue. Follow [`../../SECURITY.md`](../../SECURITY.md) if private data enters Git history.

Uninstall restores LibreWolf preferences before stopping services or removing files. If Python 3 or the preference helper is unavailable, uninstall aborts and keeps its restoration metadata so it can be retried after restoring the dependency or helper.
