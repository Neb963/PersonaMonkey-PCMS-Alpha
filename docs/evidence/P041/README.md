# P041 evidence — Backup/restore and module management UX

Claim `CLM-P041-001` (epoch 1), base `b89d5d244dd3a74e81226f82b906bdb81a8650f0`.
State: **ACCEPTED** — merged to `main` as `74b7a27b8f48572c62d54162d167484d58a8f499` (PR #55) with green merged-main CI.

## What shipped

- **Previewed, typed-confirmation restore (T041.1, A041-01)** — `extension/pcms/recovery/`:
  - `stageRestore(backup)` stays a read-only query. It verifies the backup and now returns a **preview**
    (`recovery/preview.js`): record counts per namespace (backup vs now), record-level differences
    (added back / changed / removed / unchanged), runtime modules in the backup and installed only now, the
    effects of restoring, and a `previewDigest` that binds to the backup alone (id, sha256, creation time,
    record count, namespace counts).
  - `applyStagedRestore(stage)` now **requires** `confirmation: {phrase: "RESTORE", previewDigest}`. Core
    recomputes the digest from the verified backup and refuses a raw backup, an unconfirmed stage, the old
    P020 stage shape, any other phrase, a forged digest, a confirmed preview carrying a different backup,
    and a preview older than one hour. Nothing changes (no hold, no replacement) on refusal.
  - **Secrets never included**: backup export and restore import fail closed (`PCMS_BACKUP_SECRET_MATERIAL`)
    when a credential-named field (`password`, `apiKey`, `accessToken`, `clientSecret`, `privateKey`,
    `credential`, …) holds anything but a SecretRef, `null`, or a redaction marker (`[REDACTED]`).
  - The inherited P026 "Apply restore" form calls the same command and therefore now fails closed with a
    message pointing to Settings → Backup & restore (its removal stays with P040).
- **Recovery checklist with per-item reconciliation (T041.2, A041-02)** — `backupRestore.recoveryChecklist()`
  (query) returns the hold and one row per check — module generations, each module still running, Account ↔
  Persona bindings, provider compatibility, pending operations, and **one row per unresolved
  RemoteOperation** — each naming its `subject` (`accounts`, `module`, `settings/diagnostics`, the
  operation's `targetRef`). `backupRestore.reconcileOperation(operationId)` (command) settles exactly one
  operation while on hold: prepared/retryable → cancelled, uncertain → reconciled through the ProviderGate
  (an unknown answer stays uncertain). It never dispatches. Release still goes through the accepted
  `reconcileAndRelease`, which refuses while any check fails; the hold controller refuses incomplete checks.
  Both operations are additive `pcms.ui-client/v1` entries.
- **Settings → Backup & restore** (`app/views/settings/`, route `#/settings/backup`): Create backup downloads
  an auto-named `pcms-backup-YYYY-MM-DD-HHMM.json` (backup id `pcms-backup-<UTC timestamp>Z-<random>`, never
  the colliding P026 default); Choose backup file → preview → "Type RESTORE to continue" → Restore (disabled
  until the exact phrase); while on hold, "Checks before changes can resume" lists every check with a link to
  its subject and a Check button per operation; "Resume normal operation" is enabled only when Core reports
  the hold releasable and no row fails.
- **Settings → Modules** (route `#/settings/modules`): built-in modules (Accounts required) with no Remove or
  Purge; installed runtime modules with Version, Source and State; Install from file… → review dialog with
  capabilities in plain language (new ones marked **New:**) → Approve / Reject; Review update; Enable /
  Disable; Roll back… (to the retained previous package); Remove… (says data and retained packages are kept);
  Purge… (DESTRUCTIVE, needs the typed module name). Every step is a `modules.*` command executed live by the
  P031 background supervisor. On Firefox < 154 the page says runtime modules need Firefox 154.

Not in this phase: global recovery banner on every page, Settings → Diagnostics redesign, Connections, and
removal of the inherited P026 recovery form (P040).

## Acceptance mapping

| Gate | Evidence | Where |
|---|---|---|
| A041-01 (U) | Restore gate and typed phrase, file naming/parsing, preview presentation; the view never calls `applyStagedRestore` before preview + `RESTORE`, and sends the preview digest (`settings-view.test.mjs`) | `npm run test:p041` |
| A041-01 (I) | Real integrated Core: preview is read-only, unconfirmed restore refused, confirmed restore enters `RECOVERY_HOLD` and restores (`restore.test.mjs`) | `npm run test:p041` |
| A041-01 (SEC) | Every bypass refused with no change; credential values fail closed on export and import; SecretRefs/redaction markers allowed; views have no Core/recovery/browser/storage authority; recovery code keeps P020 limits and never dispatches (`restore.test.mjs`, `boundary.test.mjs`) | `npm run test:p041` |
| A041-02 (U) | Resume disabled while any row fails; every failing row links to a valid route; per-operation Check (`settings-view.test.mjs`, `checklist.test.mjs`) | `npm run test:p041` |
| A041-02 (I) | Real Core after a restore: missing Persona + prepared + uncertain operations → failing rows with subjects, `reconcileAndRelease` and the hold refuse release; per-item reconciliation settles one operation at a time, unknown stays uncertain; all pass → release (`checklist.test.mjs`) | `npm run test:p041` |
| A041-03 (PKG, FDE) | Packaged XPI in the pinned build: Settings → Modules installs a run-time-built fixture module from file, reviews and approves it, updates it (new capability highlighted) and approves, rolls back, removes and purges it — module frame live in the background, no extension or dashboard reload | `tests/pcms/p041/packaged.mjs` |

## Local verification

- `npm run test:p041` — 18 tests pass; `npm run verify` passes (now includes `test:p041`).
- `test:p027`…`test:p034`, P020, P024, P026, P012 suites pass. `tests/pcms/p020/backup-restore.test.mjs` and
  `tests/pcms/p023/integration.test.mjs` (A023-03) now pass the typed confirmation before applying a restore.
- `node --test tests/pcms/*.test.mjs tests/pcms/*/*.test.mjs` — 452 pass; the 3 failures (`A023-01` ×2,
  `P025 production runtime composes…`) fail identically on `origin/main` and are not run by CI.
- Packaged Firefox could not run in this session (the pinned archive host is outside the session's network
  policy); PKG/FDE evidence comes from the independent `p041-packaged` CI job.

## Independent CI (CI_VERIFIED)

PR head `ec388c601d428cd7fead9a9375da70ddc0f21390` (code identical to the evidence commits on top),
`pull_request` merge commit `6ff902a7fa5ad11faa1cf094d5b9cdbcd78fda8a`:

- `firefox-developer-edition` run `37758463079`: `pinned-firefox` (incl. the new `npm run test:p041` + P020
  step and all inherited P026–P034 steps), `p031-packaged`, `p032-packaged`, `p033-packaged`, `p034-packaged`
  and the new `p041-packaged` — all success. `verify` run `37758463130` (`repository`, `npm run verify` incl.
  `test:p041`) — success.
- `p041-packaged` report (pinned `154.0b10`, archive sha256 `681913108b…f164`, product XPI sha256
  `4982c3381ece0db1e4cb76293a45868a65e1fec6d5cd44044bf3811463468984`), `passed: true`, checks:
  `installFromFileReviewApproveRunsLive`, `updateReviewHighlightsNewCapabilityAndAppliesLive`, `rollbackLive`,
  `removeLive`, `purgeNeedsTypedNameAndDeletes`, `wholeLifecycleWithoutExtensionOrPageReload`,
  `backupDownloadsAutoNamedFileWithoutSecrets`, `restoreNeedsPreviewAndTypedConfirmation`,
  `checklistLinksSubjectsAndGatesResume`.
- Observed: `fixture.counter` installed from file at generation 1 in a `sandbox="allow-scripts"` background
  frame; update to 1.1.0 (generation 2) with `module.attention.open`/`settle` shown as **New**; rollback to
  1.0.0 (generation 3); remove stopped the frame; purge accepted only the typed module id. Backup
  `pcms-backup-2026-10-08-0942.json` (35 records) was saved to disk and contains no module secret value; the
  restore stayed disabled for `restore` and ran for `RESTORE`; after it every check passed (each row linked to
  its subject) and Resume returned PCMS to `NORMAL`. The failing-check paths of A041-02 are covered by the
  U/I suites, as the gate requires.

## Merged-main CI (MERGED → ACCEPTED)

Merge commit `74b7a27b8f48572c62d54162d167484d58a8f499` on `main` (PR #55):

- `firefox-developer-edition` run `37759789178` — success (`pinned-firefox` incl. `test:p041`, and the
  `p031`/`p032`/`p033`/`p034`/`p041` packaged jobs).
- `verify` run `37759789135` — success (`npm run verify` incl. `test:p041`).
