# Testing and validation

Run commands from the repository root. The local gates are deterministic checks over repository code and controlled fixtures; they do not replace installed-browser acceptance or live native-route egress verification.

## Local gates

| Command | What it checks |
| --- | --- |
| `npm run test:repository` | Repository layout and metadata, required contracts, local Markdown links, installer syntax/help, example script hashes, and excluded private/generated files. |
| `npm run test:extension` | Every `extension/tests/*.test.mjs` test in sorted order, including API, persistence, routing policy, cookies, userscripts, workflows, and recovery behavior. |
| `npm run test:native` | Python unit tests discovered from `tests/test_*.py`. These exercise native bridge logic with test fixtures. |
| `npm test` | Repository, extension, and native unit gates above. |
| `npm run test:browser` | The four deterministic UI browser smokes listed below, using a stubbed WebExtension runtime. |
| `npm run validate` | Manifest requirements, required source paths, JavaScript syntax, and checks for credential-bearing names in extension source. |
| `npm run build` | Extension validation and deterministic XPI build, then validation and build of the supported workflow example. Requires the system `zip` command. |
| `npm run release:check` | `npm test`, browser smokes, validation, and both build steps in sequence. |

These commands are local gates. They can establish that code, contracts, test fixtures, and artifacts pass their implemented checks; they cannot establish behavior in a real Firefox profile, availability of a native WireGuard tunnel, or successful public egress through that tunnel.

## Stubbed browser smokes

`npm run test:browser` runs:

- `scripts/test-popup-browser.mjs` — popup routing and responsive interaction cases;
- `scripts/test-options-browser.mjs` — options and automation controls;
- `scripts/test-data-management-browser.mjs` — cookie, backup, and recovery UI using deterministic browser/storage stubs;
- `scripts/test-pcms-browser.mjs` — bundled PersonaMonkey Management console interaction using its runtime command client and event-port stubs.

These scripts exercise UI behavior and layout against controlled WebExtension APIs. They are not Firefox/LibreWolf installations and do not test a live browser's contextual-identity implementation, native messaging registration, or network routing. Set `UI_SCREENSHOT_DIR` when running a smoke to capture successful-state screenshots for visual review; screenshots are supplemental evidence, not the assertion source.

## Installed Firefox/LibreWolf acceptance

Before release, install the exact candidate XPI into a test Firefox or LibreWolf profile and record the browser/version and candidate commit. Verify that the package installs with the expected extension ID and version, existing state loads, Personas appear, protected routes remain protected, the Management UI loads, and Integration API authorization remains restricted to explicitly trusted extension IDs. Exercise representative Persona, workflow, and userscript behavior, and verify that container rotation preserves durable Persona identity semantics.

This acceptance gate is separate from `npm run test:browser`. Do not report it as passing unless the exact candidate was installed and exercised. The detailed API guarantees live in [`Integration API v1`](../api/integration-v1.md) and [`Compatibility`](../reference/compatibility.md).

## Native egress acceptance

Native unit tests do not prove live Mullvad tunnel operation or egress. Test native routing with the exact release candidate in an authorized Linux environment that has the required system services, WireGuard tooling, Mullvad configuration, and network access. Verify the route and externally observed egress using the project's approved private test setup.

WireGuard configuration and other private prerequisites must be supplied outside the repository. Never include them in test output, issue attachments, artifacts, or commits. If the private environment or credentials are unavailable, record the native egress gate as **unverified** with the missing prerequisite; do not infer a pass from unit tests or stubbed browser tests. Resolve the release decision according to the advertised native capability and [`Release`](release.md).

## Reporting evidence

Record the exact commands run, candidate commit, generated artifact names/checksums, and results of installed-browser and native egress acceptance separately. Mark environment-dependent checks `unverified` when they were unavailable. Never claim a gate passed because it was planned, partly exercised, or covered only by a stub.
