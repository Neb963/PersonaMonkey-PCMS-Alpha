> **Historical record.** Preserved for release history; it is not current product authority.

# PersonaMonkey Route Manager v0.5.0

v0.5.0 is a stability and observability release focused on making workflow automation dependable before adding more workflow features.

## Highlights

- Replaces the observer-based Automations compatibility layer with one deterministic workflow controller.
- Removes the mutation-observer code path that caused the v0.4.3 Automations freeze.
- Serializes workflow mutations so rapid Create/Add/Remove/Save actions cannot overwrite one another.
- Expands Activity into a read-only diagnostics view with job/task status, persona/container, configured route/provider, completion mode, attempts, tab ID, timestamps, elapsed time, results, terminal errors, last proxy error, and last fail-closed block.
- Adds downloadable diagnostics JSON with tested redaction of proxy credentials and key material.
- Strengthens the browser release gate to exercise no-persona workflow editing, completion-mode switching, delay persistence, Add/Remove, rapid New workflow -> Add step, and diagnostics rendering.

## Reliability fixes discovered by the new release gate

The stronger browser smoke test found a real async race during v0.5 development: creating a workflow and immediately adding a step could allow the pending create-save to overwrite the added step. Workflow mutations are now serialized and that fast-click sequence is covered by regression testing.

## Compatibility and security

- Gecko extension ID remains `persona-route-manager@local`.
- Persisted state schema remains version 2.
- Protected personas remain fail-closed; no direct fallback was introduced.
- Strict proxy verification, proxy-side DNS, browser privacy controls, speculative-request blocking, local-network policy, Mullvad Native Messaging transport, and GM grant/routed-network behavior are unchanged.
- Existing v0.3/v0.4 workflows and userscripts remain readable.

## Verification

Release head `768d71ca51f47977a4c3d51efd95e3bab3ed6b69` passed:

- all extension regression tests;
- the expanded real-browser Automations/diagnostics smoke test;
- release metadata validation;
- deterministic XPI build;
- artifact upload and post-download checksum verification.

Verified XPI SHA-256:

`12777b570403fda2451c7608495f3f77ffe7cff484bcff7c0ed6acaaa9ad0346`

## Known limitation

Historical job state, timestamps, errors, results and tab IDs are persisted historically. Human-readable persona/route labels in diagnostics are resolved from the currently saved configuration, so renaming a route later can change the descriptive label shown for an older job.
