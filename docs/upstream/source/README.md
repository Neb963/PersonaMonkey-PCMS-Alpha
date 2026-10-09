# PersonaMonkey Route Manager

PersonaMonkey is a Firefox and LibreWolf extension for managing persistent browser personas and controlling the routes their traffic uses. It combines Firefox contextual identities with per-persona network policy, userscripts, workflows, and data portability.

## Capabilities

- Create and manage personas backed by Firefox contextual identities, with separate cookies and configurable routing.
- Route personas through configured proxies or the optional Linux Mullvad bridge. With the kill switch enabled, unavailable protected routes fail closed; Block is the safe default and Direct routing requires explicit opt-in.
- Run userscripts with a supported Violentmonkey/Tampermonkey-compatible subset of metadata and GM APIs, per-script persona assignment, and enforced grants.
- Create sequential multi-tab workflows, inspect their progress, and exchange portable workflow packages.
- Inspect and manage persona cookies, and export or import persona packages and backups. Complete backups can contain sensitive data and require encryption; cookie-only exports are plaintext.
- Optionally store an explicitly approved recovery snapshot in Firefox Sync after reinstall; the snapshot can contain sensitive notes, URLs, and userscript source.

## Requirements and installation

The extension requires Firefox 153 or newer, or a compatible LibreWolf release. Building from source requires Node.js 22 or newer and the `zip` utility. Installing the optional Mullvad bridge requires Linux with Python 3, WireGuard tools, iproute, and systemd; the installer can install missing distribution packages on supported Linux systems. Mullvad configuration is supplied locally and is not included in this repository or release packages.

See the [installation guide](docs/getting-started/installation.md) for build, install, diagnostics, and removal instructions. The extension can also be loaded as a temporary add-on for development.

## Security model

PersonaMonkey keeps routing and browser-data operations within the extension and its typed Persona OS services. With the kill switch enabled, a managed Persona does not fall back to direct networking when its protected route is unavailable. Cookie operations are scoped to the selected Firefox `cookieStoreId`, including Firefox isolation and partition metadata. Management responses and diagnostics use secret-safe projections. The optional native bridge has a narrow Mullvad-routing role; it is not a general management server.

Treat backup files and cookie exports as private data. Never commit WireGuard configuration, browser profiles, credentials, backups, or cookie exports. See [SECURITY.md](SECURITY.md) for handling and reporting guidance.

## Management and external integration

**PersonaMonkey Management API v1** is the bundled, same-extension interface used by the PersonaMonkey Management console. Its legacy `PCMS_*` wire names are compatibility identifiers; they do not refer to the separate PCMS product.

**PersonaMonkey Integration API v1** is a restricted, disabled-by-default cross-extension interface for explicitly trusted extension IDs. **PCMS means Perchance Central Management System**, a separate product that may consume this API. The Integration API exposes validated PersonaMonkey operations, not raw browser APIs, persisted state, or generic native-host RPC.

See [Management API v1](docs/api/management-v1.md), [Integration API v1](docs/api/integration-v1.md), and the [compatibility register](docs/reference/compatibility.md) for their contracts.

## Documentation and development

The [documentation index](docs/README.md) links to current product, architecture, API, and engineering references. Release history is kept under [`docs/history/`](docs/history/); those records describe earlier releases and do not override current contracts.

The main project areas are `extension/` (Firefox/LibreWolf add-on), `native/` (optional Mullvad bridge), `scripts/` (build and checks), `tests/` (native and repository checks), `examples/` (workflow packages), and `docs/`.

To run the full local validation and build suite, install Node.js 22+, Python 3, `zip`, and Chrome/Chromium, then run:

```bash
npm run release:check
```

Set `CHROME_BIN` if Chrome/Chromium is not available under a standard executable name. See [CONTRIBUTING.md](CONTRIBUTING.md), [DEVELOPMENT.md](DEVELOPMENT.md), and the [testing guide](docs/development/testing.md) for contributor setup and test scope.

## License

PersonaMonkey is distributed under the [MIT License](LICENSE).
