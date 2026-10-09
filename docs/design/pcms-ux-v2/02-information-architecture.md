# B. Information architecture and C. Screen designs

## 1. Operator jobs (what the IA is built around)

Ordered by how often they happen, based on P025/P026 operation and the module set:

1. "Is anything wrong or waiting for me?" → Overview, Attention, popup line.
2. "Ship the generator changes I pushed." → Generators, Deployer.
3. "What is happening with *this* generator or account?" → object pages, Search.
4. "Open the right Persona for this account." → account row action, popup.
5. "Add or rebind an account." → Accounts.
6. "Was that save really applied?" → reconciliation from Attention or the object page.
7. "Keep generators fresh / find candidates / see numbers." → Refresher, Explorer, Statistics module pages.
8. "Back up, restore, update modules." → Settings (rare, deliberate).

## 2. Information architecture (B)

### 2.1 Navigation map

```
┌ Header ───────────────────────────────────────────────────────────────────────────────┐
│ PCMS   [Search accounts, generators, modules…  ⌘K / "/"]   ● Connected   PersonaMonkey ↗ │
├───────────────┬───────────────────────────────────────────────────────────────────────┤
│ Overview      │  Global banners (recovery hold · Integration lost · other tab hosts)  │
│ Attention (4) │                                                                       │
│ Accounts      │  <route view>                                                         │
│ Generators    │                                                                       │
│ ── Modules ── │                                                                       │
│ Deployer   •  │  (• = module status dot: none/warn/error; contributed by module)       │
│ Refresher     │                                                                       │
│ Explorer      │                                                                       │
│ Statistics    │                                                                       │
│ Provisioning  │                                                                       │
│ ───────────── │                                                                       │
│ Activity      │                                                                       │
│ Settings      │                                                                       │
├───────────────┴───────────────────────────────────────────────────────────────────────┤
│ Action tray (bottom-right, aria-live): running / failed / uncertain receipts           │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- **Primary (Core-owned, fixed):** Overview, Attention, Accounts, Generators.
- **Modules group (contributed):** one entry per ACTIVE module that declares a `nav` contribution, sorted by
  `nav.order` and then title. Disabled or removed modules are omitted. Unavailable or incompatible modules stay
  listed, greyed, with an explanatory page (see 03 §6).
- **Secondary (Core-owned):** Activity, Settings. Settings contains: Modules (management), Backup & restore,
  Diagnostics, Connections (repository credentials and other SecretRefs), About.
- **Search** is a header control, not a nav item. Results page: `#/search?q=`.
- **Below 900 px** the sidebar collapses into a top bar with a "Menu" disclosure. Below 600 px tables reflow into
  stacked rows. A Firefox tab is rarely that narrow, but sidebar and split-view panels are.

### 2.2 Object model and relationships

```
Persona (PersonaMonkey-owned; read via Broker)
   ▲ bound by (personaUid, bindingEpoch)
Account (Accounts module)
   ▲ belongs to (accountId)
GeneratorRef  perchance:<slug>   ← Core *view*: index rebuilt from module listings
   ├─ Deployer facet   (desired / confirmed / observed, history)      [Deployer-owned]
   ├─ Refresher facet  (cohort membership, last refresh, budget)      [Refresher-owned]
   ├─ Explorer facet   (discovered candidate / reservation provenance)[Explorer-owned]
   └─ Statistics facet (metrics filtered to subject)                   [Statistics-owned]
Module-specific objects (Cohort, Candidate, Provisioning attempt, Repository scan)
   → live under their module page: #/m/<moduleId>/<view>/<id>
HumanTask (Core) ─ subjectRef → any EntityRef above
RemoteOperation (Core) ─ shown only as "operation" rows inside object history; IDs in Technical details
```

`EntityRef` kinds that Core can route: `account`, `generator`, `persona` (opens PersonaMonkey or the account that
uses it), `module`, and `module-object` (`{moduleId, kind, id}`, which the owning module resolves).

### 2.3 Route grammar v2

This extends `deep-links.js` and keeps its validation style: bounded, canonical, and fail-closed to Overview with
a visible "That item is no longer available" notice.

| Route | Meaning |
|---|---|
| `#/overview` | Overview |
| `#/attention` · `#/attention/<itemKey>` | Attention list, optional focused item |
| `#/accounts?f=<filter>` · `#/accounts/<accountId>` | Accounts list and detail |
| `#/generators?f=<filter>&p=<page>` · `#/generators/perchance/<slug>` | Generators list and detail |
| `#/m/<moduleId>` · `#/m/<moduleId>/<view>` · `#/m/<moduleId>/<view>/<id>` | Module pages (view and id validated by the module) |
| `#/activity?f=<filter>` | Activity |
| `#/settings/<section>` | Settings sections |
| `#/search?q=<query>` | Search results |

`f` is a compact, validated filter string (for example `status:drift,account:alice`) with a closed key set per
list. Unknown keys are rejected. Filters live in the URL so a filtered view can be bookmarked or opened from
Overview cards.

### 2.4 Where things live

| Concern | Home | Also surfaced in |
|---|---|---|
| Accounts | Accounts list/detail | Generator header, popup |
| Generators | Generators list/detail | Account detail (filtered list), module pages |
| Repository sync | Deployer page → "Repository" | Overview card, generator detail Deployer facet |
| Attention | Attention | Overview "Needs you", nav badge, popup line, object pages (inline banner) |
| Recovery hold | Settings → Backup & restore | **Global banner** on every page, Overview, Attention |
| Diagnostics | Settings → Diagnostics | "Technical details" disclosure on each object page |
| Module management | Settings → Modules | Unavailable-module pages link here |

## 3. Shared UX states (§16)

One vocabulary across Core and modules. A module chooses a **token**; Core picks the icon, colour and ARIA
treatment. The text is always human wording supplied by the owner.

| Token | Meaning | Visual | Example wording |
|---|---|---|---|
| `OK` | Healthy, nothing to do | green check | "In sync", "Signed in" |
| `INFO` | Neutral fact | grey dot | "Not in a cohort" |
| `ACTIVE` | Work in progress, PCMS acting | spinner + subject | "Deploying fantasy-names…" |
| `WAITING_HUMAN` | Blocked on the operator | hand icon, amber | "Save it in Perchance, then confirm" |
| `WARNING` | Needs a decision soon, not unsafe | amber triangle | "Update ready", "Changed on Perchance" |
| `ERROR` | Failed and stays failed until acted on or superseded | red | "Deployment failed" |
| `UNCERTAIN` | Outcome unknown; reconcile before retry | purple "?" | "Outcome unknown — check needed" |
| `HELD` | Blocked by recovery hold or policy | lock | "On hold (recovery)" |
| `UNAVAILABLE` | Dependency missing or unreachable, or module disabled/incompatible | grey slash | "Perchance unavailable", "Module disabled" |

Freshness is a separate dimension. Every projection carries `asOf`. Views older than their refresh budget get a
subtle "Updated 6 min ago · Refresh" line instead of a different status, so stale data never looks like failure.

Page-level loading states:

| State | Rendering |
|---|---|
| Loading (first) | Skeleton rows in the target region only. The shell and nav render immediately. No full-page spinner. |
| Refreshing | Data stays visible and the region header shows a small "Refreshing…" marker. |
| Core status (ADR-002) | The header pill reflects the **background** Core, not the tab: `● Running`; `◌ Starting (waiting for PersonaMonkey)…`; `✕ Unavailable · Details`. A tab never "hosts" PCMS, so there is no per-tab disconnect. A request that wakes an idle background simply takes a moment, and the region shows Refreshing. Mutating buttons are disabled only while Core is Starting or Unavailable. |
| Empty | One sentence explaining why it is empty, plus the primary next step ("No accounts yet. **Add account**"). |
| Error (region) | Inline error card in that region with plain wording, a Retry button and "Technical details" (code). Other regions keep working. |
| Unavailable (module) | The module page shows the reason ("Disabled in Settings → Modules", "Failed to start after update; rolled back to 1.2.0", "Needs a newer PCMS"). Its facets are omitted elsewhere. |
| Recovery hold | Global banner: "PCMS is on hold after a restore. 2 operations need checking before changes can resume. **Review**". Every mutating action shows `HELD` and is disabled. |

### 3.1 Action receipts: replacing "Working…"

Every action goes through Core's **ActionTracker**. A receipt names:

- the subject ("fantasy-names · Alice");
- the verb ("Deploying 1.4.0");
- the phase ("Waiting for your confirmation" / "Verifying" / "Done");
- for uncertain or failed outcomes, a link to the object and the next action.

Receipts appear in the **action tray** and inline on the subject's row or page. Successful receipts fade after 6 s.
Failures and uncertain outcomes stay until the operator dismisses them or a later receipt for the same subject
replaces them. Receipts are **durable Core records** (ADR-002 §8), so every open tab shows the same progress, and
closing all tabs and reopening later shows the same outcome. Unacknowledged failures also appear in Attention as
Core conditions.

There is no in-tab operator dialog. Every assisted provider step is a **durable HumanTask handoff** (ADR-002 §9).
Any number can be pending at once. Each one appears in Attention, on its subject page and in the popup count. It
can be answered from any tab, at any time, including after every tab was closed.

## 4. Confirmations (§17)

Confirmation is driven by an action's declared `risk`. Reads and navigation never confirm.

| Risk | Examples | Confirmation |
|---|---|---|
| `READ` | Scan now, Verify now, Compare, Open in Persona | None |
| `LOCAL` | Rename account, change scan interval, pause auto-deploy | None. Undo is offered in the receipt where cheap. |
| `EXTERNAL_MUTATION` | Deploy, set listing, refresh, provision | Dialog naming target, account, Persona, what changes and how it is verified. |
| `BINDING` | Persona rebind | Dialog with current → new Persona, affected generators count; **blocked** while operations are unresolved |
| `DESTRUCTIVE` | Restore, module purge | Dialog plus typing the object name ("RESTORE" / module name). States what is lost and that a backup is recommended first. |
| `RESOLUTION` | Resolve an uncertain outcome | Dedicated reconcile dialog (§5.3); never a yes/no box |

Bulk actions show the count, the first 10 subjects, and **which selected items were excluded and why** ("2 skipped:
changed on Perchance"). Bulk external mutation is still processed one subject at a time with individual receipts.

## 5. Screen designs (C)

Examples use realistic but fictional data.

### 5.1 Overview

```
Overview                                                         Updated just now · ↻
┌ Needs you (3) ─────────────────────────────────────────────────────────────────────┐
│ ? Outcome unknown  fantasy-names · Alice      Deployed 1.4.0 at 11:52     [Check]   │
│ ⚠ Changed on Perchance  rpg-loot-table · Bob  Perchance differs from 1.2.0 [Compare]│
│ ✋ Provisioning  New account "Carol"  Complete email verification     [Continue]   │
│                                                              View all in Attention →│
└────────────────────────────────────────────────────────────────────────────────────┘
┌ In progress ─────────────────────────────┐ ┌ Repository sync ──────────────────────┐
│ ◌ Deploying weather-gen 2.0.1 · Dana     │ │ ✓ Checked 12:04 (commit 9f3c2a1)      │
│   Waiting for you in the Perchance tab   │ │ Next check ≈ 12:34 · Mode: Assisted   │
└──────────────────────────────────────────┘ │ 9 updates ready · 1 blocked  [Open]   │
┌ Accounts ────────────┐ ┌ Generators ─────────────────────────────────────────────┐
│ 52 accounts          │ │ 412 managed · 398 in sync · 9 update ready ·             │
│ 1 needs attention    │ │ 2 changed on Perchance · 1 unknown · 2 not verified 7d+  │
│ 3 on Direct route    │ │ [Open generators]                                        │
└──────────────────────┘ └─────────────────────────────────────────────────────────┘
┌ Modules ────────────────────────────────────────────────────────────────────────────┐
│ Refresher  ✓ 14 cohorts · 23 refreshes today (budget 40)                            │
│ Explorer   ✓ 6 candidates · 1 reserved                                              │
│ Statistics ✓ 1,204 deployments recorded                                             │
└────────────────────────────────────────────────────────────────────────────────────┘
Recent activity: 12:04 Repository checked — 2 changes · 11:52 Deployed fantasy-names…  →
```

The cards link to filtered list URLs (for example `#/generators?f=status:update`). Module cards come from module
`summary` contributions. The diagnostics fields that are on Overview today move to Settings → Diagnostics.

### 5.2 Accounts list

At 50+ accounts a table works better than cards. Cards are used only for the empty or first-run state.

```
Accounts (52)                                      [Search accounts…]   [+ Add account]
[All 52] [Needs attention 1] [Direct route 3] [Persona missing 0] [Signed out 2]
┌──────────────────┬───────────────────────┬────────────────────┬───────────┬──────┬──────┬────────┐
│ Account ▲        │ Persona               │ Route              │ Perchance │ Gens │ ⚑    │        │
├──────────────────┼───────────────────────┼────────────────────┼───────────┼──────┼──────┼────────┤
│ Alice            │ ● Alice (blue)        │ 🔒 Mullvad · SE    │ ✓ Signed in│ 31  │      │ Open ▾ │
│ Bob              │ ● Bob Research (pink) │ ⚠ Direct           │ ? Unknown │ 12   │ 1    │ Open ▾ │
│ Carol (new)      │ ● Carol (green)       │ 🔒 Mullvad · DE    │ ✋ Setup   │ 0    │ 1    │ Open ▾ │
└──────────────────┴───────────────────────┴────────────────────┴───────────┴──────┴──────┴────────┘
                                                     1–50 of 52   ‹ Prev  Next ›
```

- **Open ▾** is a split button. The primary action opens perchance.org in the bound Persona (`persona.open` via the
  Broker). The menu offers: View account, Open Persona settings in PersonaMonkey, Rebind Persona….
- The Route column comes from `route.get` for **visible rows only** (≤ 50), cached with `asOf`.
- The Perchance session column shows the last known state from the latest assisted confirmation or provider probe,
  or "Unknown". It never guesses.
- Rows are sorted by name by default. Clicking a column header sorts it. Filters are written to the URL.

**Add account dialog**

```
Add account
  Name            [ Erin                           ]
  Persona         [ ▾ Search Personas…             ]   ← EntityPicker: name, colour, route;
                    ● Erin (cyan) · Mullvad NL           Personas already bound are shown
                    ● Spare 3 (grey) · Direct            disabled with "used by Bob"
  ▸ Advanced
      Account key  erin            (generated from name; permanent; used in history)
                                                     [Cancel]  [Add account]
```

The Account ID is generated as `slug(name)`, with `-2`, `-3`… added on collision. It is validated against the
existing ID pattern, shown in Advanced, and editable only before creation. Feedback appears in the dialog and the
action tray, and on success the new row is highlighted (fixes audit #15).

"Provision a new Perchance account instead" in the dialog links to the Provisioning flow (§5.9).

**Account detail** (`#/accounts/alice`)

```
Alice                                         [Open in Persona]  [Rebind Persona…]  ⋯
● Persona: Alice (blue) · 🔒 Mullvad · Sweden · exit verified 10:31 · Perchance: ✓ Signed in
┌ Needs attention (0) ┐
Generators (31)  [same table as Generators, pre-filtered account:alice]
Refresher: 2 cohorts · Explorer: 1 candidate        (module summary facets for account)
Recent activity for Alice →
▸ Technical details   accountId alice · personaUid 3f2a…e91c · binding epoch 2 · provider perchance
```

**Rebind dialog** (`BINDING` risk)

```
Rebind Alice to a different Persona
  Current   ● Alice (blue) · Mullvad SE
  New       [ ▾ Search Personas… ]
  What changes: future deployments, refreshes and checks for 31 generators will run in the new Persona.
                The Perchance login must exist in the new Persona.
  ✕ Blocked: 1 operation for Alice has an unknown outcome. Resolve it first. [Review]
                                                        [Cancel]  [Rebind]
```

### 5.3 Generators list

```
Generators (412)                         [Search slug or title…]    Account [All ▾]  ⋯
[All 412] [Update ready 9] [Changed on Perchance 2] [Unknown 1] [Blocked 3] [Not verified 7d+ 2] [Paused 4]
☐ ┌──────────────────────┬──────────┬───────────────────────┬────────┬──────────┬───────────┬──────────┐
  │ Generator            │ Account  │ Status                │ Repo   │ Perchance│ Listing   │ Refresher│
  ├──────────────────────┼──────────┼───────────────────────┼────────┼──────────┼───────────┼──────────┤
☐ │ fantasy-names        │ Alice    │ ? Outcome unknown     │ 1.4.0  │ ?        │ Public    │ Daily A  │
☐ │ rpg-loot-table       │ Bob      │ ⚠ Changed on Perchance│ 1.2.0  │ changed  │ Public    │ —        │
☐ │ weather-gen          │ Dana     │ ◌ Deploying           │ 2.0.1  │ 2.0.0    │ Public    │ Daily B  │
☐ │ tavern-names         │ Alice    │ ⚠ Update ready        │ 1.1.0  │ 1.0.3    │ Public    │ Daily A  │
☐ │ cat-facts            │ Erin     │ ✓ In sync · 3h        │ 0.9.0  │ 0.9.0    │ Unlisted  │ —        │
  └──────────────────────┴──────────┴───────────────────────┴────────┴──────────┴───────────┴──────────┘
  With 2 selected:  [Deploy updates (1 of 2)]  [Verify now]  [Add to Refresher cohort…]
                                                        1–50 of 412   ‹ Prev  Next ›
```

- Rows come from the Core **generator index**. Each column is filled by the module that owns the fact: Status,
  Repo, Perchance and Listing come from Deployer; Refresher from Refresher.
- If a module is disabled, its columns disappear, and so do the filters that depend on it.
- The "Perchance" column shows the version PCMS last confirmed and modifies it with "changed" or "?". It never shows
  a guessed version.
- "✓ In sync · 3h" means verified 3 hours ago. Once verification is older than the configured window it becomes
  "✓ In sync · not verified 7d" (token `OK` plus a staleness note).

**Generator detail** (`#/generators/perchance/rpg-loot-table`)

```
rpg-loot-table                    Bob · ● Bob Research    [Open on Perchance]  [Open in repository ↗]
⚠ Changed on Perchance since the last confirmed deployment. Automatic deployment is paused for this generator.
┌ Repository wants ────────┐┌ PCMS last confirmed ─────┐┌ Perchance now ──────────────┐
│ Release 1.2.0            ││ Release 1.2.0            ││ Differs from 1.2.0          │
│ commit 9f3c2a1 · 12:04   ││ deployed 3 Oct 14:20     ││ checked 12:06               │
│ Listing: Publicly listed ││ Listing: Publicly listed ││ Listing: Publicly listed    │
└──────────────────────────┘└──────────────────────────┘└─────────────────────────────┘
Next: nothing happens automatically. Choose what to keep:
  [Compare changes]  [Overwrite with repository 1.2.0…]  [Keep Perchance version…]
History
  12:06  Checked — Perchance differs from confirmed 1.2.0
  3 Oct  Deployed 1.2.0 — applied, verified
  28 Sep Deployed 1.1.0 — applied, verified
Refresher  Not in a cohort  [Add to cohort…]
Explorer   Discovered 12 Sep in Bob's scan · reservation released
Statistics Deployments 3 · Refreshes 0
▸ Technical details  deploymentId repo:bob/rpg-loot-table · desired rev 3 · contentHash 8c1f…  · baseline
                     5d02… · observed 77ab… · last operation deploy:repo:bob/rpg-loot-table:3:1 SUCCEEDED
```

**Compare** opens a side-by-side or unified diff of the code and HTML panels (repository release vs current
Perchance content). The diff is in memory only and never persisted. For thumbnails the dialog shows both images.

**Confirm / reconcile page** (the HumanTask page for an assisted handoff or an uncertain outcome; opened from Attention, the subject page or the popup; replaces audit #39):

```
Did the save of fantasy-names 1.4.0 reach Perchance?
PCMS opened fantasy-names in Alice's Persona. Check the editor content:
  The first line of the code panel should be:  "// fantasy-names 1.4.0 — 2026-10-07"
  [Copy expected content]   [Compare automatically]  (when Perchance reading is available)
( ) Yes — Perchance shows 1.4.0            → recorded as Applied
( ) No — Perchance still shows the old version → recorded as Not applied; you can deploy again
( ) I'm not sure                          → stays Unknown; nothing will be retried
                                                              [Cancel]  [Record answer]
```

PCMS shows human-checkable evidence (version banner line, changelog head, character counts) instead of a hash. When
`generator.observe` exists, "Compare automatically" fills the answer and the operator only confirms.

### 5.4 Deployer module page (`#/m/deployer`)

Tabs: **Repository** (default) · Ready to deploy · History · Settings.

```
Deployer                                                     Mode: [Assisted ▾]  [Pause]
Repository  github · <owner>/<repo> · branch main · folder /              [Open ↗]
✓ Last checked 12:04 (commit 9f3c2a1, "Update tavern-names to 1.1.0")      [Check now]
Next check ≈ 12:34 (every 30 min, in the background — tabs need not be open)
Found 412 generators in 51 account folders
  ✓ 398 in sync   ⚠ 9 updates ready   ✚ 2 new   ⛔ 3 blocked   ▢ 1 no longer in repository
Problems (4)
  ⛔ zombie-gen        releases/2.0.0/ changed after it was first published (immutable release)  [Details]
  ⛔ dup-name          same slug in folders "alice" and "bob"                                  [Details]
  ⛔ folder "frank"    not linked to a PCMS account                                [Link to account…]
  ⛔ cursed-gen        release 1.0.0: code panel file missing (code.perchance)                [Details]
Ready to deploy (11)                                           [Deploy all ready (11)…]
  tavern-names   Alice  1.0.3 → 1.1.0   "Added dwarf names"        [Deploy]
  space-gen ✚    Dana   new → 1.0.0     needs creation on Perchance [Create & deploy…]
  …
```

- **History** tab: deployments across all generators (from audit and Deployer records), filterable by outcome. Each
  row links to the generator.
- **Settings** tab (module-contributed settings): repository connection (§E), scan interval, default listing
  policy, verification sweep size, automatic mode gates (explained, with unmet gates listed).
- Manual deployment without a repository stays available from the generator page as **"Deploy from file…"**. It
  replaces the P026 paste-source form, so manual and legacy deployments keep working.

### 5.5 Refresher, Explorer, Statistics and Provisioning pages (module-owned)

The functions stay the same. The changes are to how they look and how input is collected:

- **Refresher** (`#/m/refresher`): a cohort table (name, account, mode, today's budget used/limit, next window,
  members, status). Cohort page: members table (from the generator index) and policy editor with human fields
  ("Refresh up to [3] generators per day, between [08:00] and [20:00]"). "New cohort…" is an explicit dialog. A
  cohort is **never auto-created**, which fixes audit #20. Refresh content comes from the Deployer's last confirmed
  release through a read-only cross-module query, so nothing is pasted (fixes audit #21).
- **Explorer** (`#/m/explorer`): candidates table (generator, account, freshness, observed listing) and reservations.
  "Reserve for deployment…" picks the account from a list and generates IDs.
- **Statistics** (`#/m/statistics`): metric cards and a table with CSV export. The generator and account facets show
  filtered metrics.
- **Provisioning** (`#/m/provisioning`): an attempts table and a step-by-step attempt page ("1 Persona session ✓ ·
  2 Sign up ✋ waiting for you · 3 Verify · 4 Bind account"). The single button always names the next step. The
  Persona is chosen with the picker. Credentials use "Add credential…", which stores the secret through the secret
  host and returns a SecretRef the operator never sees.

### 5.6 Attention (`#/attention`)

```
Attention (4)                               [All] [Needs decision] [Waiting for you] [Failures]
CRITICAL
  ⏸ PCMS is on hold after a restore                    2 operations to check    [Review]
HIGH
  ? Outcome unknown · fantasy-names (Alice)             since 11:52              [Check]
  ⚠ Changed on Perchance · rpg-loot-table (Bob)         since 12:06              [Compare]
NORMAL
  ✋ Complete email verification · New account Carol    Provisioning · 10:15     [Continue]
  ✕ Deployment failed · weather-gen (Dana)              Not applied · 09:40      [Retry] [Dismiss]
```

Attention draws on three sources, all shown in one list:

1. **HumanTasks** (Core, durable). The primary button is the action contributed by the module for that `taskKind`.
   The generic "Resolve" is removed (fixes audit #28). A task without a module action shows "Open" (subject page)
   and an explicit "Mark done" that states the module will re-check.
2. **Module conditions** (derived, not stored): uncertain operations, drift, blocked repository items, unmapped
   folders. They vanish when the underlying state resolves.
3. **Core conditions**: recovery hold, Integration disconnected, unacknowledged failed receipts, unavailable modules.

Every item links to its subject *and* a concrete next action.

### 5.7 Activity (`#/activity`)

A human-readable feed built from the Audit Journal and RemoteOps. Each module formats its own event types through
the `formatActivity` contribution; unknown types fall back to "Deployer · deployment.settled".

```
Activity                      [All modules ▾] [All outcomes ▾] [Search…]
Today
12:06  Deployer   Checked rpg-loot-table — Perchance differs from confirmed 1.2.0      ⚠
12:04  Deployer   Repository checked — commit 9f3c2a1, 2 generators changed           ✓
11:52  Deployer   Deployed fantasy-names 1.4.0 (Alice) — outcome unknown              ?
10:15  Provision. Started provisioning "Carol" — waiting for email verification       ✋
09:40  Deployer   Deployed weather-gen 2.0.1 (Dana) — not applied                      ✕
```

Filters go into the URL. Rows link to the subject. "Technical details" on a row shows event ID, operation ID, state
transition and error code.

### 5.8 Settings → Backup & restore

```
Backup & restore
Status  ✓ Normal — changes are allowed
Backups never contain secret values; credentials are kept as references only.
[Create backup]  → downloads "pcms-backup-2026-10-07-1403.json" (auto-named; ID = timestamp)
Restore
[Choose backup file…]
  Preview: created 5 Oct 09:12 · 1,842 records · accounts 51 · generators 401 · modules: 6
           Differences from now: accounts −1, deployments −11, cohorts ±0
  Restoring replaces current PCMS data. PersonaMonkey Personas are not changed.
  PCMS will then hold all changes until pending operations are checked.
  Type RESTORE to continue  [ ______ ]                               [Restore]
While on hold:
  Checks before changes can resume
   ✓ Module versions match
   ✓ Account ↔ Persona bindings resolved
   ? fantasy-names 1.4.0 (Alice) — outcome unknown          [Check]
   ? Provisioning "Carol" — outcome unknown                 [Check]
  [Resume normal operation]  (enabled when all checks pass)
```

### 5.9 Settings → Modules

```
Modules
┌───────────────┬─────────┬───────────┬──────────────────────────────┬───────────────────────┐
│ Module        │ Version │ Source    │ State                        │                       │
├───────────────┼─────────┼───────────┼──────────────────────────────┼───────────────────────┤
│ Accounts      │ 1.2.0   │ Built-in  │ ✓ Active · required          │                       │
│ Deployer      │ 1.2.0   │ Built-in  │ ✓ Active                     │ ⋯                     │
│ Refresher     │ 1.2.0   │ Built-in  │ ⏸ Disabled                   │ [Enable] ⋯            │
│ Name-tools    │ 0.3.1   │ Installed │ ⚠ Update 0.4.0 needs approval│ [Review update]       │
│ Old-reporter  │ 1.0.0   │ Installed │ ✕ Failed to start → rolled back to 0.9.2 │ [Details] │
└───────────────┴─────────┴───────────┴──────────────────────────────┴───────────────────────┘
[Install from file…]   (installs and starts immediately — no rebuild, reload or restart; ADR-003)
On Firefox < 154: "Runtime modules require Firefox 154 or later" and installed modules show Unavailable.
```

- **Review update / install** dialog: name, version, publisher note, *capabilities in plain language*. New
  capabilities are highlighted ("**New:** can request deployments to Perchance"). Approve or Reject.
- Remove: `EXTERNAL`-style confirmation listing what stays (data kept for restore, rollback packages retained).
- Purge: `DESTRUCTIVE`. Type the module name. The dialog says that data and retained packages are deleted
  permanently.
- Built-in modules have no Remove or Purge. "Disable" for built-ins is not scheduled in P027–P044; if it is added later, it needs
  dependency checks: Accounts is required, and Deployer, Refresher and Explorer depend on it.

### 5.10 Settings → Diagnostics (§18)

Everything the normal views hide, in one read-only place with copy buttons:

- Core: namespace version, Broker contract/implementation/command count, boot ID, revision, recovery state, Core
  host tab, storage DB version.
- RemoteOperations: a table of unresolved and recent operations (ID, provider, action, target, state, attempt,
  resolution, timestamps).
- Modules: package hashes, runtime generation, lifecycle state, retained packages, authority capabilities.
- Repository scans: the last 20 scan records (commit, duration, counts, error code).
- Provider: compatibility probe result, contract version, last probe time.
- Error code reference. Every human error message in the app carries its code here and in "Technical details".

## 6. Toolbar popup

The popup keeps its current PersonaMonkey role and adds one PCMS block. It stays at 370 px wide, with no viewport
units, so the ESR fix is preserved.

```
┌──────────────────────────────────────── 370px ┐
│ PERSONAMONKEY PCMS            [Protected route]│
│ ● Alice (blue)                                  │
│   Protection Enforced · Network Mullvad SE      │
│ ┌ PCMS ────────────────────────────────────────┐│
│ │ Account: Alice · 31 generators               ││
│ │ ⚠ 3 items need attention       as of 12:06   ││
│ │ [Open account in PCMS]                       ││
│ └──────────────────────────────────────────────┘│
│ Active route [Mullvad · SE ▾]                   │
│ [Open PCMS]            [Verify route]           │
└─────────────────────────────────────────────────┘
```

- **Data source:** the background Core publishes a small *non-secret* status summary to
  `browser.storage.session` (key `pcms.status.v1`). It contains counts, recovery state, `asOf`, and the
  `personaUid → {accountId, displayName}` map. The popup only reads it and never starts a Core.
- **Core states:**
  - Running.
  - Idle: the background is unloaded between events; the last summary is shown "as of" its time, and work
    continues on schedule.
  - Unavailable: PersonaMonkey bootstrap or Core initialisation failed. The block then shows "PCMS unavailable —
    open for details".

  There is no "PCMS isn't open" state, because PCMS does not depend on its tab.
- **Recovery hold** replaces the attention line: "⏸ PCMS on hold after restore".
- "Open account in PCMS" focuses the existing PCMS tab, or opens one, at `#/accounts/<id>`.
- Height budget is ≤ 560 px. Long names ellipsize. There are no tables or lists in the popup.
- The block is hidden for unmanaged tabs, except the attention line.

## 7. Lessons from P025/P026 and where each is handled

| Live lesson | Design response |
|---|---|
| ESR vs Developer Edition popup sizing differ | Fixed 370 px body kept. No `vw`/`min()`. Height budget. Regression test extended to the new block (P035). |
| Opening PCMS before Integration is ready raced | Shell renders immediately. Connection pill with attempt count and Retry. Core initialisation waits for PersonaMonkey's fail-closed bootstrap in the background (ADR-002 §2), so a dashboard opened early only shows "Starting" (P028). |
| Account creation looked like a dead button | Feedback in the dialog and the per-subject tray. New row highlighted. No single shared status line. |
| Persona selection beats typing `personaUid` | One shared EntityPicker for Persona, Account and Generator, used in every form. |
| Typed Account/generator IDs are poor primary UX | IDs are generated or picked. Typed IDs remain only in Settings → Diagnostics tools. |
| Live mutations need obvious reconciliation state | `UNCERTAIN` is top priority in lists, Attention, Overview and popup, with a durable confirm/reconcile HumanTask page. |
| Marionette triggers Cloudflare independently | Live acceptance stays manual, without Marionette. CI uses the emulator and FDE fixtures. Provider probes are rate-bounded, and a challenge becomes a single HumanTask, not retries. |
