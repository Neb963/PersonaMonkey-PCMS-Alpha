# P101 Firefox artifact-integrity repair

This is a repair under the existing `CLM-P101-001`, `slot-one`, epoch 1 claim,
against main `2c877f598e95119ff4616c1289bae03b6be4a006`. G0 is ACCEPTED;
the claim remains ACTIVE. The current revision-2 `alpha.contracts.v1` hash is
`8ef33e48ae5b16037f31f93a8da64146bc6d34829390a3db16616991e345bd7e`.
Earlier P101 evidence describes its historical revisions; it is not relabeled
as evidence for this repair. No feature code or shared governance is changed.

## Root cause and bounded reproduction

[Failed alpha-firefox run 37949414269](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/37949414269)
installed the exact pin and passed smoke, then failed `persistent-install` on
the next extracted-tree verification. That historical runner retained no path
inventory, so its exact changed paths cannot be recovered retrospectively.
A diagnostic-only candidate passed once without the mutation; that passing run
was not taken as proof of a repair or used to bypass the intermittent failure.

The exact pinned Mozilla runtime provides a deterministic reproduction.
Its bundled `UpdateService.sys.mjs` obtains `nsIUpdateMutex` and calls `tryLock`
for update capability/state access. On this Linux pin, `UpdRootD` is the Firefox
installation directory. The native mutex creates the two root entries below,
even with automatic updates disabled, without an update check or download.

| Stage | Added entry | Exact observed metadata |
| --- | --- | --- |
| Installation | none | All 64 baseline entries match. |
| Mutex held | `.parentlock` | Regular file, mode 0644, size 0, one hardlink, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. |
| Mutex held | `lock` | Symlink, mode 0777, target IPv4 address plus `:+PID`; the bounded report records the actual target. |
| Mutex released / Firefox stopped | `.parentlock` | The same empty file persists; the `lock` symlink is removed. |

The original all-entry digest then changes from
`56fd1ac4a9c8b099fefe82ef43fd58ca1b9fe97e75a3bd5b84170f847dd0615c` to
`7e10a8761ae6a450cb9e9e6537a233c173d31f118c53bbbdcd9b949bfc8f3372`,
solely because of the empty added file. All original entry contents, modes and
targets remain identical. `reproduction.json` records the old verifier's
expected rejection; `local-mutex.json` records real acquisition, release and
shutdown with the repaired verifier. This is legitimate runtime mutex metadata,
not an installer defect, downloaded update or corruption of an archive member.

## Repair and regressions

The version-2 manifest stores the pristine sorted inventory. Verification still
checks the exact Mozilla archive SHA-256, exact version, original immutable tree
digest, build and channel. It separately validates only newly added root
`.parentlock` and `lock` entries with their documented narrow shapes. It never
refreshes a baseline, ignores arbitrary paths, restores changed binaries or
retries a failed verification. Original entries are protected even if named
like a mutex. Full comparisons additionally protect directory/symlink modes,
special permission bits and hardlink counts.

Smoke exercises the actual native mutex on every run and retains deterministic,
sorted deltas bounded to 16 changed paths with total/truncation indicators.
The same installation is verified after smoke, before and after packaged
restart, and after packaged shutdown. Filesystem regressions accept the observed
mutex lifecycle and reject changed binary/pref bytes, ordinary/special/directory
modes, hardlinks, missing/retargeted entries, unrecognized additions, nested
lookalike locks, nonempty/writable/executable/hardlinked `.parentlock` entries,
and malformed or path-like `lock` targets.

## Commands actually executed locally

From the repository root:

```sh
node --test tests/alpha/browser-baseline/*.test.mjs tests/firefox/*.test.mjs tests/pcms/p008-*.test.mjs tests/pcms/p009-*.test.mjs
node tools/alpha/run-tests.mjs
npm run verify
node extension/tests/persona-identity.test.mjs
node extension/tests/management-integration.test.mjs
node extension/tests/integration-lifecycle.test.mjs
node extension/tests/integration-contract-parity.test.mjs
node extension/tests/background-routing-init.test.mjs
FIREFOX_INSTALL_ROOT=/tmp/p101-integrity-investigation node tools/alpha/firefox/install-pinned.mjs
```

Focused tests passed 65/65 (including 37 P101 tests/subtests). The Alpha test
runner passed 74, with its unrelated AP102 browser test explicitly skipped
outside hosted browser CI. `npm run verify` passed all repository/governance
checks, 36 governance regressions, reconstruction of all 726 frozen donor
blobs, donor verification and reproducible donor build. All five direct donor
regression commands passed. A test-fixture mode initially inherited the process
umask; explicitly applying its unsafe mode corrected the regression fixture
before publication, with no relaxation of the verifier.

The local parent-process probe used `IsolatedFirefox.create`, `h.start`,
`exerciseUpdaterMutex(h)`, `h.dispose`, and `verifyInstallation` with the exact
installed pin and manifest above, saving `local-mutex.json`. It passed with the
content-sandbox-disable flag absent. It establishes the native mutex lifecycle,
not local DOM/XPI acceptance: the local container cannot support sandboxed
content pages. Hosted Actions must independently pass the complete smoke and
packaged suites with the content sandbox enabled. No sandbox workaround was
used for this repair. Provider-live remains false.

Final candidate/merge/run proofs are recorded separately after independent CI.
P101 does not assert GATE_VERIFIED, ACCEPTED or provider-live acceptance.

## Independently verified delivery

Repair [PR #24](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/24)
candidate `14f0bd6797f3bb2f304f2fdb41e5ec3e0b9a84b5` passed all three workflows
against main `2c877f598e95119ff4616c1289bae03b6be4a006`. The tested tree
`3294110cdcf00c9d2e2ab0b8209b8100a8272c0f` was merged unchanged as
`3c927d682cadba40c7a7994074b383fa259c072b`, with those exact main/head parents
and a non-forced expected-main update. GitHub marks PR #24 merged.

| Workflow | Exact candidate run | Exact merged-main run |
| --- | --- | --- |
| alpha-governance | [37954279622](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/37954279622) | [37954923475](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/37954923475) |
| alpha-firefox | [37954279627](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/37954279627) | [37954923535](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/37954923535) |
| firefox-developer-edition | [37954279539](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/37954279539) | [37954923550](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/37954923550) |

All six completed successfully on their first attempt. The retained hosted
reports show clean exact merged-main provenance, the enabled content sandbox,
3/3 smoke checks and 13/13 packaged checks. They record only the two native mutex
entries while held and only `.parentlock` after release, smoke, packaged restart
and shutdown; every immutable digest remains the original accepted digest.
`verification.json` contains exact run coordinates and local command results.
The earlier `acceptance.json` is preserved byte-for-byte as
`historical-acceptance.json`; the current phase evidence names this verified
repair. The claim remains ACTIVE, delivery is MERGED, and gate acceptance is
pending the separately assigned checker.
