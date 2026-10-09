# Extension source

This directory contains the Firefox/LibreWolf extension source for PersonaMonkey Route Manager. The manifest and extension modules here define the add-on; the repository root contains the build, validation, and installation tooling.

For product capabilities, browser requirements, security boundaries, and links to the canonical API contracts, start with the [project README](../README.md). For build, install, temporary development loading, diagnostics, and removal, follow the [installation guide](../docs/getting-started/installation.md). See the [documentation index](../docs/README.md) for architecture and API references.

Build and validate from the repository root:

```bash
npm run validate
npm run build
```

The generated XPI is written to the root `dist/` directory. See [DEVELOPMENT.md](../DEVELOPMENT.md) and [CONTRIBUTING.md](../CONTRIBUTING.md) for engineering and test guidance.
