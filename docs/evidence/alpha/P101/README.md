# P101 — pinned Firefox and PersonaMonkey baseline

Assigned phase only: P101. Claim `CLM-P101-001`, owner `slot-one`, epoch 1,
acquisition base `5ea76924abba1ae04de774e548cd6ac2c9ee745b`.
Dependency G0 is ACCEPTED. Frozen contract `alpha.contracts.v1` SHA-256:
`9b379980e16fdd557e0ea8a7f8273421f4a581c1c1563fe7661308038e29ee12`.
The claim was independently checked and merged in PR #4. This phase changes
only its workflow, harness, tests and evidence. Donor runtime and Alpha feature
implementation are outside its write scope.

## Reproducible cases

| ID | Actual checks |
| --- | --- |
| AP101-01 | Preserved donor verification and PersonaMonkey identity, routing, integration/lifecycle regressions; exact isolated loopback smoke; actual packaged broker modules compared byte-for-byte with their source. |
| AP101-02 | Persistent unsigned XPI installed once, correlated Persona creation and UID/container mapping; default Block and Direct denial; invalid fields and stale revision/boot rejection; create replay; internal sender restriction; event-page unload/wake and full same-profile restart without reinstall. |
| AP101-03 | Exact Mozilla archive checksum and version, full extracted-tree digest and running build/channel checks; two deterministic XPI builds; clean committed browser reports and independent hosted CI on exact PR/main revisions. |

The positive routing control reaches the loopback fixture before installation.
After installation the typed broker opens that same fixture in a Block Persona;
Firefox reports failed navigation and the server receives no new requests.
Broker mutations use the existing typed broker and Firefox transport. No test
enables Direct, writes raw Persona state, invokes native RPC, or contacts a
provider. Unknown fields, correlation mismatch and unsupported messages fail
closed. Readiness retries only read-only `system.describe`; mutations are never
blindly retried.

## Commands actually executed locally

All commands run from the repository root. The initial claim checkpoint passed
`npm run verify`, including frozen-donor reconstruction and its actual tests and
build. The implementation passed:

```sh
node --test tests/alpha/browser-baseline/*.test.mjs tests/firefox/*.test.mjs tests/pcms/p008-*.test.mjs tests/pcms/p009-*.test.mjs
node tools/alpha/run-tests.mjs
node extension/tests/persona-identity.test.mjs
node extension/tests/management-integration.test.mjs
node extension/tests/integration-lifecycle.test.mjs
node extension/tests/integration-contract-parity.test.mjs
node extension/tests/background-routing-init.test.mjs
FIREFOX_INSTALL_ROOT=/tmp/p101-firefox node tools/alpha/firefox/install-pinned.mjs
FIREFOX_BIN=/tmp/p101-firefox/versions/154.0b10/firefox/firefox FIREFOX_INSTALL_MANIFEST=/tmp/p101-firefox/alpha-install-manifest.json FIREFOX_SMOKE_DIR=/tmp/p101-clean-smoke MOZ_DISABLE_CONTENT_SANDBOX=1 node tools/alpha/firefox/smoke.mjs
FIREFOX_BIN=/tmp/p101-firefox/versions/154.0b10/firefox/firefox FIREFOX_INSTALL_MANIFEST=/tmp/p101-firefox/alpha-install-manifest.json FIREFOX_PACKAGED_DIR=/tmp/p101-clean-packaged MOZ_DISABLE_CONTENT_SANDBOX=1 node tests/alpha/browser-baseline/packaged.mjs
```

The focused command passed 35/35 tests; the Alpha runner passed its seven new
regressions. The clean browser runs at commit
`9c40bceba5cde45c56745e2e8cd83ad4f40447b4` passed two smoke and thirteen packaged
checks. Their bounded reports are retained alongside this file. Both XPI builds
produced SHA-256
`c7245eb63cc075e0f5dcdf20d19f96d3aeb4adc4fb8b60a1afe8ce63f0ea991f`.
Later separately owned Alpha changes may change the derivative XPI digest;
each CI run independently builds and compares its own exact candidate twice.

The local container denies Firefox content-sandbox user namespaces
(`/proc/self/uid_map: EPERM`); an initial sandbox-enabled donor smoke failed.
The successful local browser runs explicitly disabled that sandbox and record
the limitation. They are supplemental evidence only. The `alpha-firefox`
workflow rejects this workaround in CI and must pass with the hosted content
sandbox enabled. Early harness failures were corrected before the retained clean
reports; failed attempts are not counted as passing acceptance.

## Delivery state

COMMITTED is distinct from CI_VERIFIED, MERGED, GATE_VERIFIED and ACCEPTED.
`acceptance.json` records only the supported delivery state and exact independent
run proofs. The phase owner does not change the shared plan or claim state and
does not declare GATE-R1 verification or acceptance. Provider-live remains false.
The separately assigned integration checker owns combined-round acceptance.
