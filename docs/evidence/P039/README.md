# P039 — Perchance observation, verification and drift

P039 is **ACCEPTED** after independent PR and merged-main verification. Claim
`CLM-P039-001`, epoch 1, owns A039-01/02/03. Product [PR #66](https://github.com/Neb963/persona-monkey-pcms/pull/66)
merged as `4d2d4a2a40bfea8cd6b11874c3a35c00102ba455`; the delayed-alarm regression
[PR #67](https://github.com/Neb963/persona-monkey-pcms/pull/67) merged as
`29f2fcec3a19a661abf871d779e57634650dfba1`. Production Perchance observation
remains disabled until final live compatibility acceptance. No successor phase
has been started.

## Implemented scope

- T039.1: capability-gated `generator.observe` through immutable PersonaMonkey
  execution artifacts, the Persona Broker, a short control lease, bounded result
  polling and acknowledgement. Exact target, capability, result and content
  validation fail closed. Production has no enabled Perchance read profile.
- T039.2: confirmed applies establish a hash-only provider baseline when reads
  are available. Unavailable reads stay explicitly unverified; a materially
  mismatched first read enters reconciliation. Repository scan cycles enqueue a
  durable, oldest-first verification sweep (default 20, configurable 1–100), with
  one read per timer occurrence and at least 10 seconds between reservations.
- T039.3: drift is compared against the confirmed provider baseline, including
  listing, thumbnail and missing-generator changes. `UNKNOWN` listing is never
  a mismatch. Drift pauses the affected target and blocks ordinary deployment.
  Compare and download are ephemeral; typed Keep and Overwrite commands are
  revision- and observation-fenced. Keep adopts the provider baseline and stays
  paused; explicit resume and a changed repository release prepare fresh work.
- Restart repairs an interrupted observation-to-domain transition without a
  provider mutation. Account rebinds and newer deployment identities fence late
  reads. Keep metadata is effective only after its exact domain CAS succeeds.
  Reads preserve the adopted listing/thumbnail baseline. Repository intent and
  release-triggered resume commit atomically, including identical-content releases;
  a fresh drift remains paused.
- A challenge produces one durable HumanTask, retains queued work and cancels
  automatic observation schedules until the task is resolved. Recovery hold
  likewise retains work without executing it.

## Acceptance mapping

| Gate | Deterministic coverage | Browser coverage |
| --- | --- | --- |
| A039-01 | Capability denial, no guessed live profile, immutable artifact, lease cleanup, malformed/foreign/omitted results, canonical content identity, unverified operator confirmation, static authority and content boundaries | Actual PersonaMonkey execution reads byte-exact fixture panels; production remains gated |
| A039-02 | Confirmed baseline, failed-baseline reconciliation, repository change versus drift, UNKNOWN listing, content/listing/thumbnail/missing drift, typed current choices, in-memory comparison, Keep/resume, atomic same-content release handling, account fencing and crash/CAS recovery | Changed loopback fixture pauses the target without overwrite |
| A039-03 | Oldest-first bounded sweep, durable spacing and timer continuation, recovery hold, single challenge episode and reconstruction | Alarm wakes a stopped event page with zero PCMS tabs; two spaced reads; challenge stops the sweep and survives another unload without duplicate work |

## Verification actually run

- `npm run verify`: PASS on `eedc258b1910cb329085ad9fbb49226c54594d61`,
  including upstream baseline, repository authority, generated views, claims and
  inherited phase suites. The upstream-integrity suite's optional packaged popup
  test (`A035-01/A035-03`) was skipped locally; it is not reported as passed.
  Subsequent source commits only change the P039 packaged test's network isolation.
- `npm run test:p039`: **29/29 PASS** on final source `9996f36`.
- P028/P029 background and timer regressions: **42/42 PASS** on `eedc258`.
- `node --check tests/pcms/p039/packaged.mjs` and `git diff --check`: PASS.
- `npm run firefox:packaged:p039`: **local diagnostic PASS** on clean source
  `9996f36`, exact pinned Firefox Developer Edition **154.0b10**. See
  `packaged-local-diagnostic.json`. The product XPI digest is
  `a9bf90b68126cfb0973eb38b301c94556ddd730ba6fb643264a8093996f356e3`.


## Independent evidence

- Product head `60dda591709c963aea2b38623de586c8e66eaff5`, integration candidate
  `cee02bb32090b0b7cb46b0eaf16eb1b98158f9ae`: [repository verification](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37809086388)
  and [pinned Firefox](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37809086414)
  SUCCESS; all ten Firefox jobs passed.
- Final test head `c91f8961e9af0d1359a487d016813e91b94a42af`, integration candidate
  `f2816d6412815b035ea97bfacc1a7228103200ad`: [repository verification](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37810887281)
  and [pinned Firefox](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37810887573)
  SUCCESS; all ten Firefox jobs passed, including the deliberately delayed alarm.
- Final merged-main SHA `29f2fcec3a19a661abf871d779e57634650dfba1`:
  [repository verification](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37811636044)
  and [pinned Firefox](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37811636104)
  SUCCESS; all ten Firefox jobs passed.

Machine-readable evidence separates COMMITTED, CI_VERIFIED, INTEGRATION_VERIFIED,
MERGED and ACCEPTED and records exact source SHAs, run/job IDs, artifacts and
browser reports. Firefox Developer Edition is exactly **154.0b10**, archive SHA-256
`681913108bba655d7ec6fadfac2731141b23e48dca88d1988a4d95a6bdaff164`. The product
XPI SHA-256 remains `a9bf90b68126cfb0973eb38b301c94556ddd730ba6fb643264a8093996f356e3`.
Hosted browser reports use the normal content sandbox and clean Actions checkouts.

## Timing regression

The initial merged-main [Firefox run](https://github.com/Neb963/persona-monkey-pcms/actions/runs/37809824252)
failed its strict zero-tab assertion: inspection opened at the nominal deadline
plus 12.5 seconds, while a delayed alarm's second read began just afterward. The
failed report is retained. This was corrected in a separate reviewed test commit.
The fixture now emits a content-free loopback receipt only after the timer handler
and durable challenge writes settle. Inspection waits for that receipt. Every
alarm handoff deliberately waits three seconds to exercise the timing case; the
strict read/start timing, ten-second spacing, drift, challenge and hash-only
assertions remain enforced. The receipt endpoint and exact loopback host permission
belong only to the separate fixture add-on. Product source and XPI are unchanged.

## Scope and verification limits

The historical local browser report used `MOZ_DISABLE_CONTENT_SANDBOX=1` because
the container could not create content namespaces. It is retained as a local
diagnostic, and does not establish independent browser acceptance. The Actions
job rejects that override; independent hosted reports establish the browser gates.

Publication used the authorized connected GitHub Git Data API because local Git
push had no HTTPS credentials. All seven checkpoint trees and the timing fix tree
were checked against their local Git object hashes. The original local commits are
preserved, and publication mappings record their corresponding durable GitHub
commits. Existing branch history was advanced without force.

The packaged fixture uses a fresh disposable profile, a startup rejecting proxy
and a parent HTTP observer allowing only its exact loopback origin. Product files
are copied byte-for-byte from the built XPI into the separate test add-on; provider
reads use the real installed PersonaMonkey broker and execution artifacts. This is
deterministic hosted browser evidence. Real provider compatibility remains gated
for the final live phases.

`independent-ci.json` is the acceptance ledger. The three successful hosted reports,
the initial failed merged-main report and `api-publication.json` preserve the exact
source/run/artifact provenance. The claim and generated roadmap/status are ACCEPTED.
