> **Historical record.** Preserved for release history; it is not current product authority.

# PersonaMonkey Route Manager v0.6.0

v0.6.0 makes PersonaMonkey workflows useful, portable and easier to debug without changing the established fail-closed routing architecture.

## Workflow authoring

- Duplicate an existing workflow with fresh workflow and step IDs.
- Reorder steps explicitly with up/down controls.
- Steps execute sequentially; URLs within one step may still run concurrently.
- Pre-run validation reports all actionable problems at once instead of failing one issue at a time.
- Validation now catches missing/blocked personas, missing/disabled routes, invalid URLs, userscript assignment issues, invalid completion configuration and invalid retry settings before Run.
- Retry delay is configurable per step.

## Portable workflow packages

Workflows can now be exported and imported as `*.personamonkey.zip` packages.

A package contains a versioned `manifest.json` plus every userscript referenced by the workflow under `userscripts/*.user.js`. Packages use portable persona slots rather than local Firefox container IDs, which makes them suitable for creation by another user or a coding agent.

Import is review-first:

1. PersonaMonkey validates the ZIP and manifest.
2. Required userscripts, grants and hashes are inspected.
3. Compatible local persona mappings are shown.
4. The user confirms the mapping/import.
5. Identical installed userscripts are reused; otherwise conflict-safe copies are imported.
6. Required userscripts are automatically assigned to the personas whose steps use them.

Package import never starts the workflow automatically.

The format is documented in `docs/WORKFLOW_PACKAGES.md` and `docs/personamonkey-workflow-package.schema.json` so an agent can generate packages without knowing local Firefox container IDs.

## Package security

Workflow packages do not include route credentials, WireGuard keys, cookies, GM storage or other browser/persona data.

The ZIP importer rejects traversal/absolute paths, duplicate archive paths, encrypted entries, unsupported compression methods, CRC/size mismatches and oversized archives. Declared userscript SHA-256 hashes are verified and unsupported userscript grants are rejected.

Userscripts are still executable code: package integrity/grant validation does not replace reviewing whether you trust the package author.

## Reliable userscript completion

`Persona.complete()` signal mode no longer waits for a later page-load-complete event after navigation starts. Once a valid signal from an allowed userscript arrives, the task can finish immediately.

Coverage includes the generated MAIN-world `Persona.complete()` bridge, token forwarding/validation, early-signal buffering and a signal-mode task whose page never emits a later load-complete event.

## Progress, retries and cancellation

Activity now persists and displays:

- workflow step progress and task totals;
- current step / total steps;
- historical persona and effective route snapshot for new jobs;
- completion mode;
- per-task attempts and attempt history;
- retry delay / next retry time;
- task/job errors and userscript results;
- responsive Stop / stopping state.

Retry waits are cancellation-aware, and cancellation continues to close only automation-owned tabs.

## Real workflow package example

The repository includes and CI builds `mullvad-signal-check.personamonkey.zip`.

It demonstrates the intended package workflow with:

- one portable `protected` persona slot;
- an included `@grant none` userscript;
- two sequential checks: `https://am.i.mullvad.net/` and `https://ipv4.am.i.mullvad.net/`;
- completion through `Persona.complete()` rather than an `example.com` page-load smoke test.

## Compatibility and security

- Gecko extension ID remains `persona-route-manager@local`.
- Persisted state schema remains version 2.
- Existing v0.3/v0.4/v0.5 profiles, routes, userscripts and workflows remain readable.
- Protected personas remain fail-closed; no direct fallback is added.
- Strict proxy verification, proxy-side DNS, browser privacy controls, speculative/local-network blocking, Mullvad Native Messaging transport and GM grant/routed-network protections remain in place.
- No new daemon/database or Perchance-specific production workflow is introduced.

## Release verification

A v0.6.0 artifact is eligible for handoff only after the exact release head passes:

- the complete extension regression suite;
- the expanded real-browser Automations/package/diagnostics smoke test;
- release metadata validation;
- deterministic XPI build;
- workflow example package validation/build;
- artifact upload followed by independent checksum and package-content verification.
