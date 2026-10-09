> **Historical record.** Preserved for release history; it is not current product authority.

# PersonaMonkey Route Manager v0.7.0

v0.7.0 is the Persona Intelligence & Management Foundation release—the final universal extension milestone before PCMS.

## Added

- Persona OS dashboard with real Firefox identity, last-used time, open tabs, cookie/storage signals, route health, protection state, and quick actions.
- Component-selective persona cloning with safe non-sensitive defaults.
- Persona storage inspection, scoped clear controls, and full container-rotation wipe.
- Direct `.persona.personamonkey` export, inspected import, and cookie-bearing persona backup.
- Route-test caching and actionable card status without changing fail-closed decisions.
- Frozen PersonaManager, WorkflowRunner, and Diagnostics service contracts for PCMS.
- v0.7 unit/integration regressions and browser-smoke coverage for the dashboard lifecycle.

## Compatibility and security

- Gecko ID remains `persona-route-manager@local` and persisted state schema remains version 2.
- Firefox First Party Isolation, dynamic partition metadata, and `storeId` boundaries remain intact.
- Missing/disabled imported routes resolve to Block; Direct import is opt-in.
- Route credentials are excluded from persona packages.
- Routing, native Mullvad transport, userscript grants, workflows, and recovery behavior are otherwise unchanged.

## Verification

Release eligibility requires the full extension regression suite, both Chromium UI smokes, metadata validation, deterministic XPI build, and workflow-example build. Installed Firefox/LibreWolf testing remains required for final contextual-identity storage and native Mullvad behavior.
