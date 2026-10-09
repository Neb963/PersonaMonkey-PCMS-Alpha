# D. Module UI contribution contract (`pcms.ui-contribution/v1`)

## 1. Goal and non-goals

Goal: an ACTIVE module can appear in navigation, Overview, Search, Attention, Activity, and on Account and Generator
pages. Its actions can be invoked with consistent confirmation and feedback. None of this requires redesigning the
shell or editing unrelated Core files.

Non-goals:

- Generic form or layout engine. No JSON-schema-to-UI renderer.
- Any module (built-in or runtime) touching dashboard DOM outside its own page container or frame.
- Raw browser, PersonaMonkey or network APIs for runtime modules. Browser/page automation stays PersonaMonkey-owned.
- Core owning or interpreting module business rules (cohort policy, deployment state machine, provisioning steps).
- A workflow engine (see 05 §H).

## 2. Two kinds of module, one contract

Both kinds of module are first-class product modules (ADR-003). Both run in the **background Core**, and both
contribute to dashboards that are pure UI clients (ADR-002).

| | Built-in module (Accounts, Deployer, Explorer, Refresher, Statistics, Provisioning) | Runtime-installed module |
|---|---|---|
| Code location | `pcms-modules/<id>/**`, shipped in the XPI | Immutable package admitted through PCMS (P008), never compiled into the XPI |
| Business logic runs in | Background Core, in process (privileged, reviewed) | Sandbox controller frame in the background page; bounded capability RPC (P004/P011/ADR-003) |
| Lifecycle | Ships with the extension | Live install / update / disable / enable / rollback / remove / purge, with no reload (P031) |
| Background / scheduled work | Declared schedules via Core timers | Same, via `module.timers.ensure` capability; runs with zero tabs open |
| Declarative contributions (§4) | `createUiContribution(api)` in `pcms-modules/<id>/ui.js` | Published through `core.ui.publish` (cached by Core) plus on-demand controller methods (`listRows`, `getDetail`, `invokeUi`) |
| Module page | Trusted `renderPage(container, api)` with Core primitives in the dashboard | **Sandboxed module-UI frame** in the dashboard (`pcms/sandbox/module-ui.html`): package `ui` entry + Core UI kit + primitives, private `MessagePort`, no extension APIs, no network |
| Risky-action confirmation | Core-rendered | Core-rendered, outside the frame; the frame can only request |
| Trust boundary | Code review | Authority envelope + approval + Core validation of every value crossing the boundary |

Everything shown outside a module's own page goes through the same narrow, validated data path for both kinds:
nav, summary, facets, search, conditions, activity and actions. The difference between the kinds is execution
isolation, not product capability.

## 3. What Core owns vs what a module owns

| Core owns | Module owns |
|---|---|
| Shell, sidebar, header, routing grammar, global banners | Its domain records, state machines, policies |
| Status tokens → visuals; text-only rendering | The *wording* and the *token choice* for its states |
| `EntityRef` kinds `account`, `generator`, `persona`, `module`, `module-object` and how they route | Which generators/accounts it knows about, and its facets' content |
| Generator index (rebuildable projection) and EntityPicker | Its module-object kinds and their resolution |
| Search box, ranking merge, result rendering | Its search matches (bounded) |
| Attention list merge, HumanTask service | Its condition rules; its HumanTask kinds and the action that settles each |
| ActionTracker, receipts, action tray, confirm dialogs by risk | Action semantics, impact summary text, preconditions |
| Activity feed rendering from the Audit Journal | Formatting of its own event types |
| Settings frame and persistence of module setting values (module namespace) | Setting definitions, validation, meaning |
| Module management page and lifecycle UX | Nothing (lifecycle is Core, P022) |
| Diagnostics page | Optional extra diagnostics rows (§4.9) |

## 4. Descriptor v1

All strings are bounded. All arrays are capped. Unknown keys are rejected. Text is rendered with `textContent` only.

```js
{
  contractVersion: 1,
  moduleId: "deployer",                 // must equal registry/bundled moduleId
  title: "Deployer",                    // ≤ 40 chars
  description: "Deploys generator releases from the repository to Perchance.", // ≤ 200
  icon: "upload",                       // from a fixed Core icon set (~24 names)

  nav: { label: "Deployer", order: 10, statusFrom: "summary" } | null,

  summary:      async (ctx) => Summary,                        // §4.2
  search:       async (ctx, query, limit) => SearchHit[],      // §4.3 (limit ≤ 20)
  facets: {                                                    // §4.4
    generator?: async (ctx, generatorRef) => Facet | null,
    account?:   async (ctx, accountId)    => Facet | null
  },
  listGenerators?: async (ctx, cursor) => GeneratorListingPage,// §4.5 feeds the Core index
  conditions:   async (ctx) => Condition[],                    // §4.6 (≤ 200)
  actions:      ActionSpec[],                                  // §4.7 (≤ 32)
  invoke:       async (ctx, actionId, target, input, options) => Receipt,
  settings:     SettingSpec[],                                 // §4.8 (≤ 20)
  formatActivity: (event) => ActivityLine | null,              // §4.9
  humanTaskActions: { [taskKind]: actionId },                  // binds HumanTask kinds to actions
  page?:        PageSpec                                       // §5: declarative views, built-in renderPage, or runtime module-UI frame
}
```

`ctx` is a Core-provided read-only context: `{ asOf, recovery: "NORMAL"|"RECOVERY_HOLD", generation, locale }`. A
module must not hold references across generations, because Core recreates the contribution after an update.

For **runtime modules** the function-valued members map onto controller methods called over the bounded RPC.
`summary`, `conditions` and search entries are normally *pushed* with `core.ui.publish` whenever the module's state
changes. Core stores the latest validated publish durably and serves it to dashboards even while the module is not
activated, so opening the dashboard does not wake every module. `facets`, `listRows`, `getDetail` and `invoke`
are pulled on demand and lazily activate the module (ADR-003 §3).

### 4.1 Status token

`OK | INFO | ACTIVE | WAITING_HUMAN | WARNING | ERROR | UNCERTAIN | HELD | UNAVAILABLE` (see 02 §3). A module
supplies `{ token, label }`. Core renders both. Core may *escalate* the display (for example, show `HELD` during
recovery hold) but never rewrites the label.

### 4.2 Summary

```js
{ status: {token, label}, headline: "9 updates ready",          // ≤ 80
  facts: [{label:"Last check", value:"12:04"}, …],              // ≤ 4
  href: "#/m/deployer" | "#/generators?f=status:update" }
```

Used by: the Overview module card and the sidebar status dot (`nav.statusFrom:"summary"` → the dot shows WARNING,
ERROR or UNCERTAIN only).

### 4.3 Search

```js
SearchHit = { entity: EntityRef, title, subtitle, status?: {token,label}, score: 0..100 }
```

Core merges hits from Accounts, the generator index and modules. It ranks by score and kind, and caps at 50. Modules
must not index secrets or HumanTask instructions; this is inherited from the P021 rules.

### 4.4 Facets (how modules appear on Account and Generator pages)

```js
Facet = {
  title: "Refresher",                           // section heading
  status?: {token,label},
  facts: [{label, value, href?}],               // ≤ 8
  columns?: { [columnId]: {label, value, token?} }, // ≤ 3; for the Generators table (§4.5)
  actions: [actionId…],                         // subset of declared actions applicable to this target
  history?: [{at, text, token?}]                // ≤ 10; module's recent events for this target
}
```

Core renders facets in nav order beneath the object header. If a facet call throws or times out (bounded at
1.5 s), Core shows a compact "Refresher information unavailable · Retry". The page never breaks because of one
facet.

### 4.5 Generator index participation

Generators are not owned by Core. Core keeps a **rebuildable index**: an in-memory projection that is cached
non-authoritatively and dropped on any schema mismatch. It is built from modules that implement `listGenerators`:

```js
GeneratorListingPage = { items: [{ ref:"perchance:tavern-names", accountId:"alice", title?:"Tavern Names",
                                   columns:{status:{…}, repo:{…}, perchance:{…}} }],
                         next: cursor|null }
```

- Union by `ref`. If two modules disagree on `accountId`, the row shows "Account mismatch" (`WARNING`) and a
  diagnostics entry. Core never picks a winner.
- **Columns** are a module-declared, bounded set (each module ≤ 3, typed text/status/time/count). Filter chips are
  derived from status tokens and labels.
- Each module also provides the generator *picker* source implicitly: every Core EntityPicker for generators
  searches this index. Refresher's "Add generator to cohort" no longer types IDs.

This is the "shared generator context" without a universal Generator aggregate. Modules keep their own records, and
Core only joins them for display.

### 4.6 Conditions (derived Attention)

```js
Condition = { key:"deployer:uncertain:fantasy-names", priority:"HIGH",
              status:{token:"UNCERTAIN", label:"Outcome unknown"},
              title:"Outcome unknown · fantasy-names (Alice)", subject: EntityRef,
              since: iso, actionId:"reconcile" }
```

Conditions are recomputed on refresh and never stored. Durable needs-a-human items stay HumanTasks (P012).

### 4.7 Actions

```js
ActionSpec = {
  id: "deploy", label: "Deploy",
  appliesTo: "generator" | "account" | "module" | "module-object:<kind>",
  risk: "READ" | "LOCAL" | "EXTERNAL_MUTATION" | "BINDING" | "DESTRUCTIVE" | "RESOLUTION",
  bulk: false | { max: 50 },
  input: null | InputSpec,              // §4.7.1
  preview: true | false                 // if true Core calls invoke(..., {mode:"preview"}) first
}

invoke(ctx, actionId, target, input, { mode: "preview"|"execute", idempotencyKey, receiptId }) → Receipt
Receipt = {
  status: {token,label},                // ACTIVE / OK / ERROR / UNCERTAIN / WAITING_HUMAN
  subject: EntityRef, message,          // human
  impact?: { title, consequences:[…], confirmLabel, excluded:[{subject, reason}] },   // preview only
  followUp?: { href, label },
  operationRef?: { kind:"remote-operation", id }   // diagnostics only
}
```

Rules:

- `preview` must be side-effect-free. Core shows `impact` in the risk-appropriate dialog, then calls `execute` with
  the same `idempotencyKey`.
- `execute` returns as soon as the operation is durably recorded or done. Long-running provider steps continue and
  report through the receipt (polling `receipt(receiptId)` in v1; no event bus).
- Modules perform their own orchestration. For example, Deployer's `deploy` does reconcile-before-retry and
  setDesired/prepareRetry internally, which fixes audit #19.
- Core blocks `EXTERNAL_MUTATION`/`BINDING`/`DESTRUCTIVE` actions during `RECOVERY_HOLD` before calling the module.
  The module still enforces this itself through ProviderGate, so Core is only the first line.

#### 4.7.1 InputSpec

There are six field kinds. A new kind is added only when a second real consumer needs it.

| kind | Renders as | Value |
|---|---|---|
| `text` | `<input>` (bounded length, optional pattern) | string |
| `integer` | `<input type=number>` with min/max | number |
| `choice` | `<select>` / radio (≤ 12 options) | option id |
| `boolean` | checkbox | boolean |
| `entity` | Core EntityPicker filtered to `account` / `generator` / `persona` | EntityRef id |
| `file` | file picker (bounded bytes, accepted types), read by Core, passed as text | string |

No conditional fields, no nesting, no layouts. If an input needs more, the module renders it on its own page: a
built-in module through `renderPage`, a runtime module inside its module-UI frame. The frame then submits through a
declared action, so Core still validates and confirms it.

### 4.8 Settings

```js
SettingSpec = { key:"scanIntervalMinutes", label:"Check repository every", kind:"integer", min:15, max:240,
                unit:"minutes", default:30, help:"Runs in the background whether or not PCMS is open." }
```

The kinds are those of InputSpec except `file`, plus `duration` (rendered as integer + unit). Core persists values in
the module's own storage namespace (`module.<id>.settings`), audited. The module validates on read. The values are
exposed to the module through `ctx.settings`. Secrets are never settings. Settings that need credentials use a
`secretRef` field kind that opens Settings → Connections; only the SecretRef string is stored.

### 4.9 Activity formatting and diagnostics

```js
formatActivity(event) → { text:"Deployed fantasy-names 1.4.0 (Alice) — applied", subject: EntityRef,
                          token:"OK" } | null
diagnostics?: async (ctx) => [{label, value}]   // ≤ 30, shown only in Settings → Diagnostics
```

## 5. Module pages

- **Declarative views** (any module): `page: { views: [ListView | DetailView] }`, rendered by Core.
  - `ListView = { id, title, columns ≤ 8 (text|status|time|count|entity), rowsFrom:"listRows", rowHref?, actions }`.
  - `DetailView = { id, title, sections:[{title, facts ≤ 12}], actions }`.

  These views suffice for many modules and need no module UI code.
- **Built-in custom page:** `renderPage(container, api, route)`, running in the dashboard with Core primitives
  (`table`, `picker`, `statusPill`, `confirm`, `track(action)`, `link(entityRef)`) and the UI-client facade for its
  own service. It must not touch DOM outside its container. A static boundary test enforces this.
- **Runtime custom page:** the package's `ui` entry (module manifest v2, additive) runs in a sandboxed iframe
  (`pcms/sandbox/module-ui.html`) inside the dashboard.
  - The frame receives:
    - the module UI source;
    - the Core UI kit stylesheet and primitives library (same look as built-ins, light/dark aware);
    - a private `MessagePort`.
  - It can request:
    - reads of the module's own projections;
    - invocation of the module's declared actions;
    - navigation to `EntityRef`s;
    - size changes.
  - Core relays these requests to the background as the module's **UI-scoped** capabilities.
  - Every `EXTERNAL_MUTATION`, `BINDING`, `DESTRUCTIVE` or `RESOLUTION` action is confirmed in a Core dialog outside
    the frame.
  - The frame has no extension APIs, no network and no access to other modules.

## 6. Lifecycle behaviour

Core computes a *presentation state* for every module from P022 lifecycle + P011 runtime + contract validation:

| Underlying state | Nav | Facets / search / conditions / columns | Module page | Settings → Modules |
|---|---|---|---|---|
| Active, contract valid | shown | included | normal | "Active" |
| Installing / update awaiting approval | unchanged (old version) | from active generation | normal + banner "Update 0.4.0 awaits approval" | "Review update" |
| Update activating (draining) | shown | omitted for ≤ a few seconds; facets show "Updating…" | banner | "Updating…" |
| Failed activation → rolled back | shown | from last-known-good | banner "Update failed; running 0.9.2" | error detail |
| Disabled | **hidden** | omitted, and dependent generator columns and filters removed | `#/m/<id>` shows "Module disabled · Enable in Settings" | "Enable" |
| Removed (retained for restore) | hidden | omitted | "Module removed" | "Reinstall / Purge" |
| Purged / never installed | hidden | omitted | "This module isn't installed" (deep link stays safe) | absent |
| Incompatible (`contractVersion` unsupported, or descriptor fails validation) | shown greyed | omitted | "Needs a newer PCMS (contract v2)" or "Module UI is invalid" + Diagnostics | "Incompatible" |
| Runtime error (summary/facet throws) | shown with ERROR dot | that call shows "unavailable"; others continue | error card + Retry | "Errors (3) · Details" |
| Recovery hold | shown | shown; mutating actions rendered `HELD` | banner | unchanged |
| Background context unloaded (normal idle) | shown | served from Core's durable published cache; module activated lazily on demand (ADR-003 §3) | normal | unchanged |
| Firefox < 154 (runtime modules only) | hidden | omitted | "Requires Firefox 154+" | "Unavailable on this Firefox" |

Other cases:

- **Generation change** (update, disable, enable): Core discards cached contributions and pending previews. A receipt
  whose module generation is no longer current shows "Module was updated — check the result" and links to the
  subject. Durable state is the module's, so nothing is lost.
- **Authority change on update:** handled by P008/P022 approval. The contract adds only human descriptions of
  capabilities, a Core-owned table that maps capability names to plain-language text.
- **HumanTasks of a disabled module** remain in Attention (they are Core records). They are shown with "Deployer is
  disabled — enable it to act", and their action buttons are disabled.

## 7. Adding a module: the edit list

**Runtime module (the normal path for new modules):** build a package (controller, optional `ui` entry, authority
capabilities), then install it from Settings → Modules or the UI-client install command. There are **no edits to
the extension, no XPI rebuild and no reload** (ADR-003).

**Built-in module (only for modules that need privileged in-process integration):**

1. `pcms-modules/<id>/**`: service, plus `ui.js` exporting `createUiContribution`.
2. `extension/pcms/integration/bundled-modules.js` (P033): one entry `{ moduleId, factory, uiContribution,
   dependsOn }`. This replaces the hard-coded `FACTORY_NAMES`. Cross-module service wiring stays explicit in
   `composition.js`.
3. Tests in `tests/pcms/<phase>/`.

Neither path edits `app.js`, `index.html`, the route grammar, Overview, Attention, Search or Activity.

## 8. Initial contribution plan for existing modules

| Module | nav | summary | listGenerators | facets | conditions | actions (examples) | humanTaskActions |
|---|---|---|---|---|---|---|---|
| Accounts | (primary, Core page) | — | — | account header data | Persona missing, binding mismatch | `rebind` (BINDING), `openPersona` (READ), `rename` (LOCAL) | — |
| Deployer | ✓ | ✓ | ✓ (status, repo, perchance) | generator, account | uncertain, drift, blocked, unmapped folder, failed | `deploy`, `deployFromFile`, `verify`, `compare`, `overwriteDrift`, `acceptPerchance`, `reconcile`, `scanNow`, `pauseTarget`, `setListing` | `deployer.create-generator` → `markCreated` |
| Refresher | ✓ | ✓ | ✓ (cohort) | generator, account | uncertain refresh, budget exhausted | `addToCohort` (bulk), `refreshNow`, `reconcile` | — |
| Explorer | ✓ | ✓ | ✓ (candidate) | generator | stale reservation | `reserve`, `release` | — |
| Statistics | ✓ | ✓ | — | generator, account | — | `export` (READ) | — |
| Provisioning | ✓ | ✓ | — | account | waiting for human, uncertain | `start`, `continue`, `cancel`, `reconcile` | `provisioning.captcha` → `continue` |

Initial modules stay built-in. A future runtime module (for example a workflow or reporting module) uses the same table. Accounts uses Core-owned pages because Account is a Core shared identity (`01-system-architecture.md`). It still
contributes conditions and actions through the same contract, which keeps its actions available to future workflows.
