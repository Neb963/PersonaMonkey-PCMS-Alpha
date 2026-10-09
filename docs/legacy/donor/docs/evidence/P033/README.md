# P033 evidence — Module UI contribution contract v1 for built-in and runtime modules

Claim `CLM-P033-001` (epoch 1), base `9717eb215c7485bda84830d4a69c9cb610df0b76`.
State: **ACCEPTED** — merged to `main` as `06cd88c26ecac403eaf9a35adedf30baefcc89ad` (PR #53) with green merged-main CI.

## What shipped

- **`pcms.ui-contribution/v1`** — `extension/pcms/integration/ui-contribution-contract.js`: strict, bounded
  validation of descriptors (nav, actions with InputSpec, settings, page views, facet kinds, HumanTask action
  bindings), summaries, search hits, facets, conditions, list pages, details, receipts (impact only from
  previews, downloads only from READ actions), activity lines and the runtime publish payload (≤ 64 KiB).
  Unknown keys and accessors are rejected; text is plain text; `contractVersion ≠ 1` is reported as
  *unsupported* (shown as "Needs a newer PCMS"), not as corrupt data.
- **Background contribution host** — `extension/pcms/integration/ui-contributions.js`, created in
  `background/core-factory.js` and exposed to UI clients as `ui.*` operations of `pcms.ui-client/v1`
  (`snapshot`, `search`, `facets`, `listRows`, `getDetail`, `preview`, `frame`, `activity`, `getSettings`
  queries; `invoke`, `setSetting` commands with durable receipts). It merges built-in and runtime modules
  and computes every 03 §6 presentation state (active, update awaiting approval, updating, failed with
  last-known-good, installing, disabled, removed, not installed, incompatible, awaiting UI, unsupported
  Firefox, recovery hold).
- **Runtime modules** publish with the new `core.ui.publish` capability (granted through their authority
  envelope like every capability-set-v1 name). Core stores the latest publish durably, keyed to the publishing
  package, re-validates it on every read and serves it while the module is not activated. Facets, rows,
  details and actions are pulled on demand through the P031 supervisor (`uiFacet`, `uiListRows`,
  `uiGetDetail`, `uiInvoke` controller methods), which activates the module lazily.
- **`pcms.module-manifest/v2`** — additive optional `ui` entry naming the package file that runs in the
  module-UI frame. v1 archives keep byte-identical canonical text and hashes; the registry stores v2 manifests.
- **Sandboxed module page surface** — `extension/pcms/sandbox/module-ui.{html,js,css}` (classic script, the
  declared sandbox page under the shared sandbox CSP). The dashboard (`app/module-frame-host.js`) embeds it
  with `sandbox="allow-scripts"`, fails closed if it can reach the frame document, hands it one private
  `MessagePort`, and validates every request: reads of the module's own projections, its declared actions,
  EntityRef navigation and a bounded height. The kit renders text only (no markup, no free attributes).
- **Core-rendered confirmation** — `app/module-actions.js`: preview → Core dialog for
  `EXTERNAL_MUTATION`/`BINDING`/`DESTRUCTIVE`/`RESOLUTION` → execute with the same idempotency key. Core
  repeats the checks: an execute of a confirm-risk action without the dialog's confirmation is refused, and
  recovery hold blocks mutating actions before the module is called. The dialog is non-modal (P028 forbids
  tab-local modal operator state); closing the tab simply cancels.
- **Core merge points in the shell** (`app/app.js`, `app/contributions.js`, `app/module-view.js`): navigation
  (module order, status dot, greyed when incompatible), Overview module cards, Search, derived Attention
  conditions, Account-page facets (1.5 s bound per module), module pages (declarative list/detail views or
  the runtime frame), Activity lines, module settings (persisted in `module.<id>.settings`), and the
  Settings → Modules state list. A disabled module's HumanTasks stay listed with "… is disabled — enable it to
  act" and no action buttons. Module deep links (`#/m/<id>`) resolve for every known module, including
  runtime ids such as `acme.reports`, and explain disabled/removed/never-installed modules.
- **Statistics pilot** — `pcms-modules/p018/ui.js` contributes summary, metric rows and detail, search and a
  READ CSV export; the shipped bundled-module list (`integration/bundled-modules.js`) has exactly this entry.
  Built-in contributions load lazily in the background from the list; no shell file names a module.

Not in this phase: a trusted in-dashboard `renderPage` for built-ins (no consumer yet; built-ins use the
declarative views), `listGenerators` / the Core generator index (P036 Generators), and migrating the other
inherited P026 module cards (their later phases). Those cards keep rendering unchanged.

## Acceptance mapping

| Gate | Evidence | Where |
|---|---|---|
| A033-01 (U, I, C) | Contract validation and manifest v2 (`contract.test.mjs`); built-in + runtime fixtures through the real background Core in nav, Overview, Search, facets and Attention, module pages, Statistics pilot, one-entry bundled list with no fixture named in Core (`merge.test.mjs`) | `npm run test:p033` |
| A033-01 (FDE/PKG) | Statistics and a run-time-built module appear in the packaged dashboard nav, Overview, Search and Attention | `tests/pcms/p033/packaged.mjs` |
| A033-02 (SEC) | Core refuses unconfirmed risky executes, undeclared actions, bad targets/input, held actions; frame requests scoped to the frame's module; module-UI kit refuses markup; page/CSP/host static rules (`actions.test.mjs`, `boundary.test.mjs`) | `npm run test:p033` |
| A033-02 (FDE, PKG) | Packaged module page in the sandboxed frame: opaque origin, no `browser`/`chrome`, no network, no dashboard DOM; its DESTRUCTIVE request opens the Core dialog outside the frame; nothing runs until confirmed; cancel executes nothing | `tests/pcms/p033/packaged.mjs` |
| A033-03 (U, I) | Every presentation state from lifecycle/runtime/validation; disabled/removed/purged/failed/incompatible/unsupported through the real Core; a hanging facet is cut off at 1.5 s; dashboards served from the publish cache after an unload without waking the module (`lifecycle.test.mjs`) | `npm run test:p033` |
| A033-03 (FDE) | Packaged: reopened dashboard after a forced event-page unload shows the module without activating it; failed update banner with last-known-good; disabled, incompatible, removed and purged pages | `tests/pcms/p033/packaged.mjs` |

## Local verification (this commit)

- `npm run test:p033` — 31 tests pass.
- `npm run verify` — passes (now includes `test:p033`).
- `node --test tests/pcms/*.test.mjs tests/pcms/*/*.test.mjs` — 434 pass; the 3 failures
  (`A023-01` ×2, `P025 production runtime composes…`) fail identically on `origin/main` `9717eb2` and are not
  run by CI.
- `tests/pcms/p030/manifest.test.mjs` — the "module-UI page is inert until P033" assertion now checks the
  activated page: no external URL, no iframe/form/object/embed, exactly `module-ui.js` and `module-ui.css`.
- Packaged Firefox could not run in this session (the pinned archive host is outside the session's network
  policy); FDE/PKG evidence comes from the independent `p033-packaged` CI job.

## Independent CI (CI_VERIFIED)

PR head `a4e8d971a34efd67af15d58c4e3f680e7f31f0c4`, `pull_request` merge commit
`9fb64d45d30485cbff1af4339f8789e24abbf851`:

- `firefox-developer-edition` run `37718229436`: `pinned-firefox` (incl. `npm run test:p033` and all
  inherited P026–P034 steps), `p031-packaged`, `p032-packaged`, `p034-packaged` and the new `p033-packaged` — all
  success. `verify` run `37718229399` (`repository`, `npm run verify` incl. `test:p033`) — success.
- `p033-packaged` report (pinned `154.0b10`, archive sha256 `681913108b…f164`, product XPI sha256
  `1d0681dc84df8d8690682dde5501c233b902dc45b68f6227f8172bfe3cfc47b7`), `passed: true`, checks:
  `builtInAndRuntimeInNavOverviewSearch`, `sandboxedModulePageNoExtensionApiNoNetwork`,
  `riskyActionConfirmedByCoreDialog`, `dashboardsWorkWhileModulesUnloaded`, `failedUpdateKeepsLastKnownGood`,
  `cancelledConfirmationExecutesNothing`, `disabledHiddenAndExplained`, `incompatibleGreyedOut`,
  `removedAndPurgedDegradeGracefully`.
- Observed in the module-UI frame (reported through a declared action): `browser`/`chrome` absent, origin
  `null`, dashboard document unreadable, `fetch` → `blocked`, undeclared action rejected; frame
  `sandbox="allow-scripts"`, `contentDocument === null`. After the forced event-page unload the reopened
  dashboard showed the module while `modules.get` reported `running: false` (`READY`).

### Live observations encoded as regressions before fixing (AGENTS §10)

The first packaged runs found three defects; each is now a deterministic Node regression:

1. `ui.frame()` omitted the action `preview` flag, so frame-originated risky actions skipped the preview
   (`merge.test.mjs`, frame action specs).
2. The module page render key read `model.actions`, absent on state pages, so a disabled module kept its old
   page (`lifecycle.test.mjs`, `modulePageRenderKey`).
3. A purged module's deep link was pre-resolved against built-in ids and redirected to Overview
   (`lifecycle.test.mjs`, `routableModuleIds` with the hash).

## Merged-main CI (MERGED → ACCEPTED)

Merge commit `06cd88c26ecac403eaf9a35adedf30baefcc89ad` on `main` (PR #53):

- `firefox-developer-edition` run `37754190065` — success (`pinned-firefox` incl. `test:p033`, `p031`/`p032`/`p033`/`p034` packaged jobs).
- `verify` run `37754190213` — success (`npm run verify` incl. `test:p033`).
