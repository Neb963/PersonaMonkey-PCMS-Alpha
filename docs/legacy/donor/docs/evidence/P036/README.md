# P036 evidence — Deployer v2 domain, Perchance contract v2 and Generators views

Claim `CLM-P036-001` (epoch 1), base `b89d5d244dd3a74e81226f82b906bdb81a8650f0`, merged with current `main`
(accepted P041). State: **ACCEPTED** — merged to `main` as `0a2073eaa0543470c7cf16f6bdfab3ff09ab18c8`
([PR #57](https://github.com/Neb963/persona-monkey-pcms/pull/57)) with green merged-main CI.

## What shipped

- **T036.1 Deployer state v2** (`pcms-modules/p015/`): `pcms.deployer.state/v2` record (desired payload intent
  `v1-source | v2-release` with payload/thumbnail hash, listing and origin; `confirmed`; `policy`).
  `MIG-P036-deployer-state-v2` (`migration.js`) is applied on read and persisted by the next write
  (`migrateState()`); deployment id, desired revision and operation sequence are unchanged, so every
  `deploy:<id>:<rev>:<seq>` RemoteOperation and its v1 fingerprint stay linked. `projectDeploymentV1` is the
  exact inverse. `deriveGeneratorStatus` (`status.js`) implements the ordered 04 §E.11 table and the
  recovery-hold / provider overlays; `listing.js` is the Deployer's GeneratorListing. v1 inputs (`sourceHash`,
  `source`) and the v1 projection fields used by legacy forms and capability set v1 keep their meaning.
- **T036.2 `pcms.perchance.driver/v2`** (`extension/pcms/providers/perchance/`): canonical length-prefixed
  payload hash, release fingerprint `perchance:generator-release:v2:…`, JPEG thumbnail checks; v2 probe with
  per-capability fail-closed normalisation (v1 probes still exact); `isPrivate` confined to `listing.js`
  (plus the emulator) with `UNKNOWN` fallback that turns listing capability off; emulator v2; the assisted
  release driver records a durable handoff with code and HTML separate, thumbnail and listing instruction. The
  live driver probes v2 with every unattended/observe/listing capability off.
- **T036.3 `pcms.generator-index/v1` and Generators views**: Core service `generators.list/get/search`
  (union by ref, account-mismatch row, filters/chips/paging); `#/generators` and
  `#/generators/perchance/<slug>` with the three state cards, the handoff panel (copy code/HTML, thumbnail
  download, Applied / Not applied / I'm not sure) and Deploy from file (Perchance address + Account picker,
  generated `gen:<slug>` id, background commands only; UNCERTAIN blocks redeploy until reconciled).
  Additive `pcms.ui-client/v1` operations: `generators.list/get/search`, `deployer.setPaused`.

Not in this phase: repository scan (P037), scheduling (P038), observation/drift (P039), Deployer module page.

## Acceptance mapping

| Gate | Evidence | Where |
|---|---|---|
| A036-01 (U, C) | Every v1 record shape (each status, confirmed/unconfirmed, old confirmations) migrates and projects back identically; ids/sequence/fingerprints unchanged; corrupt v1 fails closed; allocated migration id and contract | `tests/pcms/p036/migration.test.mjs` |
| A036-01 (I) | Stored v1 row with an `UNCERTAIN` v1 RemoteOperation is read by the v2 Deployer and reconciles to `SUCCEEDED` on the same operation; next write persists v2; `migrateState` idempotent | `migration.test.mjs` |
| A036-02 (U) | Exhaustive table: >100 000 reachable combinations checked against the ordered rules (all 13 hit), wording per rule, overlays, fail-closed input | `tests/pcms/p036/status.test.mjs` |
| A036-02 (C, SEC) | Payload/fingerprint vectors, v2 capability fail-closed, listing mapping and UNKNOWN fallback, observe gating; source scan: `isPrivate` only in the adapter, "private" absent from Deployer domain/UI | `perchance-v2.test.mjs`, `index-boundary.test.mjs` |
| A036-03 (U, I, E) | Generated ids and Perchance address parsing; emulator deploy of code/HTML/thumbnail/listing; content mismatch before any RemoteOperation; ambiguous dispatch never replayed; assisted handoff durable across tabs, UNKNOWN keeps it uncertain without re-dispatch, APPLIED settles; NOT_APPLIED needs a new operation; recovery hold; cross-realm upload bytes | `deploy.test.mjs` |
| A036-03 (FDE) | Pinned `154.0b10`, product XPI: Generators list and detail deep link render from the real Core index via the UI client, Deploy dialog types only the address; then the shipped view + modules (copied byte for byte into a fixture add-on page) run Deploy from file with real Files → durable handoff → "I'm not sure" (no re-dispatch) → Applied → "In sync" | `tests/pcms/p036/packaged.mjs`, job `p036-packaged` |

## Independent CI (CI_VERIFIED)

PR head `a0838f5a0c5929b17c1dd1f3056ef8614edd35d6`, `pull_request` merge commit
`f8df8189c1976e425ad149e130f8087f787dbd54`:

- `firefox-developer-edition` run `37763514344`: `pinned-firefox` (incl. `npm run test:p036`), `p031-packaged`,
  `p032-packaged`, `p033-packaged`, `p034-packaged`, `p041-packaged` and the new `p036-packaged` — all success.
- `verify` run (`repository`, `npm run verify` incl. `test:p036`) — success.
- `p036-packaged` report: pinned `154.0b10`, archive sha256 `681913108b…f164`, product XPI sha256
  `26d22ddaf4c49a084b086f34d472d62da3855c766c71344cb346dbc3acfd0fb2`, fixture copied 141 product files
  (digest `09e510c7…f04f0c`), `passed: true`, checks `generatorsRouteRendersCoreIndex`,
  `deployDialogNeedsNoTypedIds`, `generatorDetailDeepLink`, `manualDeployDurableHandoffInFirefox`,
  `unknownAnswerNeverReplayed`, `appliedAnswerSettlesInSync`; `dispatchOpensFinal: 1`.

## Merged-main CI (MERGED → ACCEPTED)

Merge commit `0a2073eaa0543470c7cf16f6bdfab3ff09ab18c8` on `main` (push): `firefox-developer-edition` run
`37764875691` (all jobs incl. `pinned-firefox` with `test:p036` and `p036-packaged`) — success; `verify` run
`37764875653` (`npm run verify` incl. `test:p036`) — success.

## Regressions encoded from the pinned-Firefox run (AGENTS §10)

- Upload bytes from another JS realm failed an `instanceof` check → realm-independent check, `node:vm`
  regression in `deploy.test.mjs`.
- A failed Deploy from file had its reason erased by revalidation → the reason now stays until the form changes.
- The inherited P041 packaged check "nothing runs before approval" ran after Accept (racy) → now runs while the
  review is open (`tests/pcms/p041/packaged.mjs`, owned by this claim; P041 is ACCEPTED).

## Local verification

Node v22.22.0: `npm run verify` passes; `npm run test:p036` 58 pass. Full `tests/pcms/**`: the only failures
are the three that fail identically on base `b89d5d2` (A023-01 ×2, P025 live-wiring; not run by CI). The pinned
Firefox archive host is outside this session's network policy, so FDE evidence comes only from CI.
