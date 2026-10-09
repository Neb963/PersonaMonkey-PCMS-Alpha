# A. UX audit of the current PCMS UI (P026 baseline)

Scope: `extension/pcms/app/**` (the PCMS tab), `extension/popup/**` (toolbar popup), and the module services and
integration code those screens call. The P026 forms were acceptance controls. They are audited here as product UX
because operators now use them daily.

Classes: **COR** correctness · **USE** usability · **SCA** scalability · **EXT** extensibility · **COS** cosmetic.

## A.1 Shell, navigation and global state

| # | Finding | Evidence | Class |
|---|---|---|---|
| 1 | Root cause: Core is hosted by the dashboard tab, so PCMS stops when the tab closes (fixed by ADR-002). Also, two PCMS tabs each start a full Core and run startup recovery against the same IndexedDB. A second tab can turn the first tab's in-flight `DISPATCHING` operation into `UNCERTAIN` and enter `RECOVERY_HOLD`. | `app/app.js` `bootPcmsApp()`; `integration/live-core.js:10` `recoverPcmsLiveStartup` | COR |
| 2 | All action feedback goes into one global line under the nav and is overwritten by the next action. While an operation runs it reads just "Working…", with no subject. Concurrent actions are indistinguishable. | `app/live-controls.js:29`; `app/index.html` `#liveActionStatus` | USE |
| 3 | Projections refresh only on `hashchange` or after a local action. Nothing refreshes on a timer or on focus, and changes made by another tab or by background services stay invisible. Staleness is never shown. | `app/app.js` `refresh()` triggers | USE |
| 4 | The navigation is assembled by hand. "Modules" is injected with a hard-coded `badge:5`, and the Overview module count is hard-coded to `"5"`. A disabled or unavailable module still counts. | `app/app.js:105`, `app/app.js:123`, `app/index.html:35` | EXT |
| 5 | The route grammar only knows `overview/modules/attention/accounts/search`. There are no generator, module-page, activity or settings routes, so nothing can deep-link to a deployment or cohort. | `app/deep-links.js` `PCMS_UI_ROUTES` | EXT |
| 6 | Startup failure collapses to "PCMS could not connect to PersonaMonkey Integration v1." There is no retry button and no indication of whether the retry loop is still running. | `app/app.js` `bootPcmsApp` catch; `app/startup-retry.js` | USE |
| 7 | Overview is mostly diagnostics: namespace version, broker contract, *broker command count*, implementation name. None of these help with daily work. | `app/index.html:36-46` | USE |
| 8 | The header ("Perchance Central Management System", large h1) and the architecture footer use space on every view. | `app/index.html` topbar/footer | COS |
| 9 | The PCMS styles (`app/app.css`) and PersonaMonkey styles (`popup.css`, `options/*.css`) define separate palettes and radii. No shared tokens exist, and module cards style themselves. | `app/app.css`, `popup/popup.css` | COS |

## A.2 Accounts

| # | Finding | Evidence | Class |
|---|---|---|---|
| 10 | Creating an account requires typing a durable Account ID, which is then fixed forever and embedded in operation IDs. Nothing generates or suggests one. | `app/index.html:154` | USE |
| 11 | Rebind requires typing the Account ID again instead of starting from the account. | `app/index.html:161` | USE |
| 12 | The Persona option label shows `cookieStoreId`, an internal Firefox identifier the operator should never need. | `app/live-controls.js:12` | USE |
| 13 | The account list shows `accountId · personaUid` as the subtitle. It does not show Persona name, route/protection, session state, generator count or attention. | `app/app.js:209` | USE |
| 14 | Rebind gives no impact preview: unresolved operations, generators affected, or which Persona is replaced. | `app/live-controls.js` `accountRebindForm` | USE |
| 15 | P026 found that create feedback appeared on another route. It was fixed by making the global line visible, but that is still one shared line (see #2). | P026 evidence, "dead button" | USE |
| 16 | The account list is a flat list of links with no sorting, filtering or paging. Projection accepts up to 1024 accounts and renders them all. | `app/projections.js:102`; `app/app.js renderAccounts` | SCA |

## A.3 Feature modules page (Explorer, Deployer, Refresher, Statistics, Provisioning)

| # | Finding | Evidence | Class |
|---|---|---|---|
| 17 | Every module is one card on a single page, with up to 20 rows each (`slice(0,20)`) and no "more". Items beyond 20 cannot be reached. | `app/app.js:139-169` | SCA |
| 18 | Deployer requires typing a Deployment ID, an Account ID, a Generator ID and **pasting the full source**. | `app/index.html:91-94` | USE |
| 19 | Deployer orchestration lives in the UI. The form handler decides between `reconcileDeployment`, `setDesired`, `prepareRetry` and `deploy`, and enforces "uncertain must not replay". A future workflow or a second UI would have to copy this exactly. | `app/live-controls.js` `deployerLiveForm` | EXT / COR-risk |
| 20 | Refresher requires typing a Cohort ID and Account ID and pasting source. A missing cohort is **silently created** with a hard-coded `MANUAL` policy, `dailyBudget:1` and `anchorAt:now`. | `app/live-controls.js` `refresherLiveForm` | COR / USE |
| 21 | Refresher has no access to the content Deployer last confirmed, so the operator must find and paste the same source again. | `app/live-controls.js` `refresherLiveForm` | USE |
| 22 | Explorer requires typing a Discovery ID, Generator ID and a 64-hex **observed SHA-256**. Discovery is meant to be observed, not typed. | `app/index.html:76-81` | USE |
| 23 | Provisioning requires typing an Attempt ID, a Persona UID (with no picker, unlike Accounts) and a raw SecretRef string. Nothing in the UI creates a SecretRef. | `app/index.html:123-127` | USE |
| 24 | The Provisioning "Create / continue" button means different things in different states. After creation the message says "click Continue again". | `app/live-controls.js` `provisioningLiveForm` | USE |
| 25 | Module status reads "Unavailable · PCMS_…" (an error code) or "Live module state connected." Neither says what is wrong or what to do. | `app/app.js:63` | USE |
| 26 | Deployer rows show `generatorId` and `accountId · syncState`. They do not show desired vs observed, versions, time of last deploy, or the next action. | `app/app.js` `renderModules` | USE |
| 27 | Generators appear only as Deployer, Refresher or Explorer rows. Nothing shows one generator across modules. | `app/app.js renderModules` | USE / EXT |

## A.4 Attention, search, activity

| # | Finding | Evidence | Class |
|---|---|---|---|
| 28 | Attention has one generic **Resolve** button that resolves any HumanTask with `resolutionCode:"completed"`, whatever the task kind. Module semantics such as provisioning CAPTCHA/verification are bypassed at the UI layer. The module still has to re-check, so the operator can be misled. | `app/live-controls.js:273`; `app/app.js renderAttention` | COR |
| 29 | Attention lists only HumanTasks. Uncertain operations, recovery hold, unavailable modules and (future) drift are not shown. | `app/projections.js normalizeAttention` | USE |
| 30 | Attention items link to `#/attention/<taskId>`, which is the same list filtered. Only `subjectRef.kind==="account"` gets a subject link, and nothing links to an action. | `app/projections.js` `subjectHref` | USE |
| 31 | Search covers only accounts and attention. Generators, cohorts, deployments and modules are not searchable. | `app/projections.js searchProjection` | SCA / EXT |
| 32 | No Activity or history view exists, although the Audit Journal and RemoteOps hold the data. Operators cannot answer "what did PCMS do yesterday". | n/a | USE |

## A.5 Backup and recovery

| # | Finding | Evidence | Class |
|---|---|---|---|
| 33 | Backup ID defaults to `p026-manual-backup`, so a second backup with the default ID collides. | `app/index.html:52` | USE / COR |
| 34 | The backup is printed as JSON into a textarea, and restore means pasting JSON back. Nothing offers a download or file picker, and nothing previews what a restore will change. | `app/index.html:55`; `live-controls.js:298` | USE |
| 35 | "Apply restore → RECOVERY_HOLD" exposes the internal state name and has no confirmation, even though restore is destructive. | `app/index.html:57` | USE / COR-risk |
| 36 | When release fails, the error lists raw RemoteOperation IDs ("unresolved: deploy:…:1:1"). Nothing links to those operations or offers to reconcile them. | `live-controls.js:308` | USE |
| 37 | Recovery status is a single text line, "NORMAL · unresolved RemoteOperations: N", on Overview only. When held, there is no global banner. | `live-controls.js renderRecovery` | USE |

## A.6 Operator dialog (assisted provider actions)

| # | Finding | Evidence | Class |
|---|---|---|---|
| 38 | Only one in-tab dialog can be active, and it dies with the tab (fixed by ADR-002 §9 durable handoff), and a second request throws "Another PCMS operator action is already active". Nothing queues it or tells the operator which object is waiting. | `app/operator-bridge.js` `pending` | USE |
| 39 | The reconcile dialog asks the operator to compare "the saved source matches the intended SHA-256". A human cannot compute a SHA-256. | `integration/live-mutations.js` `reconcileGeneratorUpdate` instructions | USE |
| 40 | The apply dialog shows one `source` blob. Perchance has separate code and HTML panels, and the planned packages also carry a thumbnail and listing. | `integration/live-mutations.js` `updateGenerator` | USE / EXT |

## A.7 Toolbar popup

| # | Finding | Evidence | Class |
|---|---|---|---|
| 41 | The popup is entirely PersonaMonkey. It shows no PCMS state at all: attention count, recovery hold, or which account the active Persona belongs to. | `popup/popup.html` | USE |
| 42 | ESR sizing is fixed with a stable 370 px body width, and a regression test guards it. This design keeps it. | `popup/popup.css`; `tests/pcms/p026/popup-esr-compat.test.mjs` | — (keep) |
| 43 | "Open PCMS" calls `runtime.openOptionsPage()`. If PCMS is already open this reuses the options tab, which is fine. It does not pass a deep link, though, so it cannot open "this account". | `popup/popup.js` `$("options").onclick` | USE |

## A.8 Classification summary

| Class | Count | Most important |
|---|---|---|
| COR | 6 (+3 risks) | #1 two Cores, #20 silent cohort creation, #28 generic task resolve, #19 UI-owned orchestration |
| USE | 30 | Typed IDs (#10, #11, #18, #20, #22, #23), global "Working…" (#2), no next-action guidance |
| SCA | 4 | 20-row truncation (#17), unpaged account list (#16), narrow search (#31) |
| EXT | 6 | Hard-coded module list and counts (#4), no routes for objects (#5), no generator concept (#27) |
| COS | 3 | Header/footer weight, divergent styling |

## A.9 What to keep

- Bounded, validated deep links that fail closed to Overview (`deep-links.js`, P021).
- Text-only DOM rendering (no `innerHTML` in PCMS app code).
- The managed-Persona selector backed by `persona.list` (P026 correction). It becomes the shared Persona picker.
- The operator-assisted apply and reconcile flow, which never replays an uncertain operation. Its presentation is
  redesigned; its semantics are kept.
- Bounded startup retry (`startup-retry.js`).
- The popup's fixed intrinsic width and its Direct-route confirmation.

## A.10 Runtime-ownership findings (revision 2)

| # | Finding | Evidence | Class | Resolution |
|---|---|---|---|---|
| 44 | PCMS Core lives in the dashboard page. Closing it stops timers, scans, reconciliation and module work. | `app/app.js` `bootPcmsApp()`; `background.js` hosts only PersonaMonkey | COR | ADR-002, P028/P029 |
| 45 | The production module runtime has no sandbox page in the manifest, no frame factory and no capabilities, and nothing activates modules. Admitted runtime modules cannot execute. | `extension/manifest.json`; `integration/live-core.js` `createModuleRuntimeBroker({storageBroker,moduleRegistry,recoveryHold})` | COR / EXT | ADR-003, P030/P031 |
| 46 | The pinned Firefox 153.0b10 predates `sandbox` manifest support (Firefox 154). | `docs/implementation/v1/browser-pin.json`; MDN BCD | COR | P027 pin ≥ 154 |
| 47 | The Firefox CI job loads only a static page. No packaged-XPI extension test exists, so background or lifecycle guarantees cannot be proven in CI. | `tools/firefox/smoke.mjs` | EXT (testability) | P027 harness |
| 48 | PersonaMonkey registers its 1-minute alarm listener inside the dynamically imported `background.js`, not synchronously at the top level. MDN says asynchronously added listeners may not restart an event page. | `extension/background.js:1352`; `lib/recovery-bootstrap.js` dynamic import | COR-risk | Record pinned-build behaviour in P027. PCMS listeners register synchronously from the static entry (P028). |
