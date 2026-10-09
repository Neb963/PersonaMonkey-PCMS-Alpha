# Contributing

Contributions should preserve PersonaMonkey's documented security and compatibility contracts. Start with [DEVELOPMENT.md](DEVELOPMENT.md), the [documentation index](docs/README.md), and [AGENTS.md](AGENTS.md) for architecture, API authority, and repository invariants.

## Requirements and setup

- Node.js 22 or newer and npm for extension, repository, browser-smoke, and build commands.
- Python 3 for native and release tests; these use the Python standard library.
- `zip` for building the XPI.
- Chrome or Chromium for browser-smoke checks. Set `CHROME_BIN` when its executable is not found under a standard name.

Clone the repository, install a supported Node.js version, and run the checks for the area you change. The project currently uses Node.js built-ins rather than requiring an npm dependency installation.

## Branches and changes

Work from current `main` on a short-lived branch. Keep each change focused and use a clear commit message. Do not rewrite shared history, force-push, or alter release tags. Follow the branching and release rules in [the branching guide](docs/development/branching.md).

Before changing a public contract, persisted data, package format, installed extension/native ID, routing behavior, or a security boundary, identify the governing document and add or update regression coverage. Preserve compatibility identifiers unless an explicit versioned migration is approved and tested. Keep the native bridge limited to its documented Mullvad routing role.

For documentation changes, update the canonical source for the contract and check relative links. Keep current product documentation free of milestone-specific implementation narration; historical records belong under `docs/history/` and must remain clearly historical.

## Tests

Run the narrowest relevant checks while developing. Before proposing a complete change, run:

```bash
npm run release:check
```

This runs repository, extension, native, deterministic browser-smoke, validation, and build checks. The browser smokes require Chrome/Chromium. If an environment-specific check cannot run, state which check was unavailable and why; do not present a partial run as a complete release check. See the [testing guide](docs/development/testing.md) for scope and limitations.

## Security and pull requests

Never commit or attach credentials, Mullvad/WireGuard configuration or keys, browser profiles, PersonaMonkey backups, cookie exports, session data, or private diagnostic output. Do not put secrets in fixtures, screenshots, logs, or documentation examples. Report suspected vulnerabilities through the repository's private security reporting channel; see [SECURITY.md](SECURITY.md).

Pull requests should describe the user-visible or contract change, list tests actually run, identify compatibility or security impact, and update relevant documentation. Keep unrelated cleanup out of security or release-blocking fixes.
