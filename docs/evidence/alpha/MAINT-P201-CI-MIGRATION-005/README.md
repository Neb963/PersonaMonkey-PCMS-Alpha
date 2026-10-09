# P201 CI migration prerequisite — maintenance proposal

This is CI/governance correction, not P201 implementation. The separately
owner-attested scope amendment PR #38 merged as
`8277b6eceffc81a856a1bfa5c65928ec3c51a07a`; its exact merged-main governance,
Alpha Firefox and historical Firefox workflows all passed independently.
This candidate is prepared for PR #44 against that exact main, with its own
fresh maintenance context. Its separate owner approval, full independent
migration CI and merged-main verification remain required. No migration
merge, gate or acceptance is claimed. P201 remains READY/unclaimed, R2 IN_PROGRESS; all parallel
claims and frozen contracts/policies remain unchanged. No provider-live
execution or P201 product PASS is claimed.

## Independently reproduced conflict

`tests/pcms/p028/boundary.test.mjs` requires the second static bootstrap import
to be `../pcms/background/entry.js` and requires its legacy bootstrap hook.
P201 AP201-01 explicitly requires disabling that entry while wiring Alpha
early. These requirements cannot both hold on the derivative. The unchanged
historical test passes on the reconstructed donor and fails after removing
that import in a disposable donor copy; its test bytes are unchanged.

The inherited `.github/workflows/firefox.yml` product checks target the old
PCMS background, UI protocol, timers, module lifecycle/dashboard, Accounts,
deployer/refresher, repository cadence, observation and restore services.
Every original command remains intact, with its working directory changed
to the exact donor. Packaged suites preserved are P027, P029, P030, P031,
P032, P033, P034, P036, P038, P039, P040, P041 and P042. Unit suites P012,
P020, P026–P034, P036–P042 and their npm-selected inherited P013/P015/P016/
P017/P019 subsets remain selected by the frozen donor package scripts.
P008/P009 historical package/broker boundary tests formerly selected by
`alpha-firefox` also run on that donor.

`verification.json` inventories direct background/UI/manifest assumptions,
all historical test files (including optional historical suites), all
packaged product programs and the unchanged derivative PersonaMonkey checks.
The original `tools/alpha/donor-baseline.mjs` already preserves full historical
`npm run verify`, including upstream PersonaMonkey regressions. It stays
unchanged. `alpha-governance`, `alpha-maintenance-verification` and the old
amendment workflow do not need workflow edits: they invoke this historical
baseline and current Alpha tests. The trusted CI validator receives one
derivative authority/test-presence check.

## Product targets and trust

The donor is commit `482dc9d9273dcdcd7d2ef4c4b0df8c7c6933d5ca`, tree
`07e005b7b5647215a10dc957c633aae2d76435cc`, exactly 726 verified blobs with
their original modes. Reconstructed packaging must produce SHA256
`bbe084a0f3495a1a505f87f69c5a29cfdfd538bf15ec35afee35d34b9ae6b5f1`.
Trusted-main provenance, per-blob verification, complete Git tree verification
and XPI verification run before any historical product command. A dirty
destination, changed snapshot or alternative donor is rejected. Historical
browser evidence identifies the donor SHA, independently of candidate SHA.

The unchanged exact Firefox Developer Edition 154.0b10 pin applies to both
products. The existing derivative P101 packaged suite remains on the actual
derivative XPI and also runs in the policy-required Firefox workflow,
together with PersonaMonkey identity, management, integration
lifecycle/contract and early-routing regressions. No legacy test is edited,
no browser automation is added to the product, and no legacy facade is built.

Every browser job first executes `ci.mjs` extracted from current main, then
uses infrastructure from that same authority. The first migration may use
new candidate infrastructure only after the predecessor validator verifies
the separately owner-attested exact migration transaction. Branch settings,
claimed phase status and environment flags never select a weaker target.
Each job checks live main again at the end. Normal phases cannot edit any of
these workflows or policy helpers.

## Mandatory P201 verification when implementation appears

Core/bootstrap product files, a production bootstrap change, or Core files
on predecessor main require P201 verification. Claim-only work does not.
Deleting an earlier implementation cannot revert the result to absent.
Before implementation the output is `NOT_IMPLEMENTED`, without acceptance.
The mandatory `alpha-core` job has no conditional or continue-on-error.

The actual manifest background import graph must retain early PersonaMonkey
routing, its background and typed broker authority. Reachable Alpha and
legacy background Core authority together are rejected. New Core bootstrap
imports must be inspectable; product/test discovery rejects symlinks.

P201 must supply `tests/alpha/core/packaged.test.mjs`, using the existing
`tools/alpha/firefox/harness.mjs`, and execute these exact test cases against
the actual derivative XPI with the attested pin:

- `AP201-01 startup and sender/request authorization`
- `AP201-02 two clients one core`
- `AP201-02 idle unload and warm alarm wake`
- `AP201-02 cold browser restart`
- `AP201-03 UNCERTAIN and RECOVERY_HOLD`
- `AP201-03 bounded alarms and operation/tab budgets`

All owned Core tests are discovered and run without name filters. Missing,
failed, skipped, TODO, cancelled, duplicate or wrong-source required cases
fail the independent job. A successful complete Node test summary is
required. These names define CI evidence expectations; they change no frozen
product contract. Scenario semantics still require independent review and
round gate evidence. This prerequisite creates none of those product tests.

## Reproducible local results

- `node --test tests/alpha/governance/ci-migration.test.mjs`: 8 passed,
  0 failures/skips. The donor and derivative fault tests execute real,
  unchanged historical/PersonaMonkey regressions. Disposable no-op case
  fixtures test runner plumbing only; they are not product acceptance.
- `npm run verify`: passed, including governance and full frozen-donor
  verification/reproducible XPI.
- `node tools/alpha/run-tests.mjs`: 132 tests, 131 passed, 1 skipped locally
  (P102 real-browser storage test because local Firefox is absent). Hosted
  CI requires that test; no local browser acceptance is claimed.
- `node scripts/build-extension.mjs`: actual derivative package built;
  SHA256 `becc6ce7794e3723b536c8958e82016478f2a41d8559405fa675c8210c3ecfc8`.
- `node tools/alpha/ci-migration/core.mjs --root . --main-ref origin/main`:
  `NOT_IMPLEMENTED`, `providerLive: false`.
- Parsed workflow YAML locally: 12 unconditional jobs, exact-main authority
  in each, no duplicate step IDs. `git diff --check`: passed.

Independent migration GitHub Actions and merged-main checks are pending at
this verification snapshot. This record captures the candidate at publication;
exact-head and merged-main CI observations will also be published on PR #44.
Obtain a fresh independent owner exact-main/head comment, pass the trusted
predecessor validator and all independent Actions, then
serialize a non-forced expected-main-SHA two-parent merge. Require successful
merged-main CI before reporting this prerequisite complete. No phase gate
state is advanced.
