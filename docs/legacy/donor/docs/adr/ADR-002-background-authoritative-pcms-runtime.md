# ADR-002 — PCMS Core is background-authoritative; dashboards are UI clients

Status: **ACCEPTED** (product decision by the operator, 2026-10-07). Implementation: P027–P031 in
`docs/implementation/v1/plan.json`.

## Context

How the accepted v1 product (P000–P026) is actually wired:

- `extension/pcms/app/app.js` boots `startPcmsLiveRuntime()` inside the PCMS dashboard tab.
- That runtime creates storage, Audit Journal, RemoteOps, recovery hold, ProviderGate, module registry, module
  runtime and all feature modules (`extension/pcms/integration/live-core.js`).
- Startup recovery (`recoverPcmsLiveStartup`) runs once per dashboard tab.
- The background context (`extension/lib/recovery-bootstrap.js` → `extension/background.js`) hosts only
  PersonaMonkey and its Integration-v1 dispatcher. PCMS reaches that dispatcher over `runtime.sendMessage`
  (`PCMS_PERSONA_BROKER_REQUEST`).

Consequences of this wiring:

1. PCMS stops entirely when the last dashboard tab closes. No timers fire, nothing scans, nothing reconciles and no
   module work runs.
2. Each dashboard tab is a separate authoritative Core over the same IndexedDB. A second tab's startup recovery can
   turn the first tab's in-flight `DISPATCHING` operation into `UNCERTAIN` and enter `RECOVERY_HOLD`.
3. The assisted Perchance driver (`live-mutations.js` + `app/operator-bridge.js`) holds a provider dispatch open on
   an in-memory `<dialog>` promise inside one tab.

**Product requirement (operator decision):** PCMS operational lifetime is tied to the Firefox extension, not to a
dashboard tab. Closing every PCMS tab must not stop schedules, timers, module work, repository scans,
Refresher/Explorer work, background projections, RemoteOperation reconciliation, recovery handling, or eligible
unattended provider work. Any number of dashboard tabs must be safe at the same time.

## Platform facts (Firefox, not Chromium)

Checked on 2026-10-07 against `mdn/content` and `mdn/browser-compat-data`. Every item marked *(verify)* must be
re-proved in the exact pinned Firefox Developer Edition build by P027/P028 before an implementation relies on it.

| Fact | Source / note |
|---|---|
| MV3 Firefox supports only non-persistent background scripts or pages (event pages). This extension uses `background.scripts` + `type: "module"` (Firefox ≥ 112). | MDN *Background scripts*; BCD `background.type` = 112 |
| The background runs in a background *page* with a `window` and DOM. | MDN *Background scripts → DOM APIs* |
| Event pages unload after a short idle period. The idle timer is reset when extension events arrive. The default is 30 s (`extensions.background.idle.timeout`). | MDN; Mozilla bug discussion. *(verify default in pin)* |
| "Message ports cannot prevent an event page from shutting down". The same page also states that open views and ports delay unload. The docs contradict each other, so **PCMS must not rely on ports for liveness**. | MDN *Background scripts* *(verify)* |
| Listeners must be registered synchronously at the top level. Asynchronously registered listeners do not restart the event page. | MDN *Background scripts → Add listeners* |
| DOM timers (`setTimeout` / `setInterval`) do not survive event-page idling. Use `browser.alarms` to wake. | MDN *Convert to non-persistent → Change timers into alarms* |
| Alarms do not persist across browser sessions. Creating an alarm with an existing name replaces it. | MDN `alarms`, `alarms.create` |
| `storage.session` is in memory and cleared when the extension or browser shuts down. It survives event-page unloads. | MDN *Convert to non-persistent → Record state changes* |
| An event page that crashed is restarted when one of its event listeners is triggered. | MDN note on extension-process crashes |
| The `sandbox` manifest key and `content_security_policy.sandbox` are supported from **Firefox 154**. The current CI pin is 153.0b10. | BCD `webextensions.manifest.sandbox` (see ADR-003) |

Keep-alive tricks (staggered alarms, synthetic event loops) are explicitly **not** used. Mozilla describes them as an
anti-pattern, and correctness must not depend on resident memory anyway.

## Decision

### 1. One logical authority

- **The PCMS Core lives in the extension background context.** It is created at most once per background context
  by an idempotent `ensurePcmsCore()` that returns the same promise to every caller.
- Firefox runs at most one background page per extension, so this gives one logical authority per extension per
  profile.
- Dashboard pages (`pcms/app/**`), the popup and any other extension page **never** construct storage, the Audit
  Journal, RemoteOps, recovery hold, ProviderGate, the module runtime or feature services. A static boundary test
  enforces this.

### 2. Background entry and startup ordering

- The PCMS background entry module is imported **statically** by `extension/lib/recovery-bootstrap.js`, after the
  existing fail-closed routing-gate import, so PersonaMonkey's static ordering is unchanged.
- During top-level evaluation the entry synchronously registers its own listeners:
  - `alarms.onAlarm` (names prefixed `pcms.`);
  - `runtime.onMessage` (answers only PCMS UI message types; returns `undefined` for every other message so
    PersonaMonkey handlers are unaffected);
  - `runtime.onStartup`;
  - `runtime.onInstalled`.
- Listeners only enqueue work. Work begins after `ensurePcmsCore()` resolves.
- `ensurePcmsCore()` first awaits PersonaMonkey bootstrap completion. That is the existing `bootstrap()` promise
  and `initialize()` with the routing gate ready. The Persona Broker is therefore never used before PersonaMonkey
  has finished fail-closed recovery.
- A PersonaMonkey bootstrap failure leaves PCMS in `UNAVAILABLE` (reported to UI clients). Core does not start.

### 3. Persona Broker inside the background

- PCMS keeps the Integration-v1 semantic boundary. A new **in-process internal broker endpoint**
  (`extension/lib/pcms-internal-broker-endpoint.js`) carries the same request envelope that
  `managementIntegration.handleInternalRequest` accepts today, plus the event subscription.
- PersonaMonkey's `background.js` registers its handler into that endpoint. PCMS's background transport calls the
  endpoint instead of `runtime.sendMessage`.
- PCMS modules still never receive PersonaMonkey service objects.
- The existing `PCMS_PERSONA_BROKER_REQUEST` message path is retained only while dashboards still need it during
  migration, and is removed once no extension page uses it.
- Parity tests prove identical envelopes, errors and revision/bootId preconditions on both transports.

### 4. Durable versus ephemeral state

| Durable (PCMS IndexedDB, CAS + audit) | Session (`storage.session`) | Ephemeral (JS memory, lost on unload) |
|---|---|---|
| All domain records; RemoteOperations; recovery hold; HumanTasks; timers; module registry, lifecycle and runtime records; settings; repository snapshots | `pcms.core.session` marker `{sessionId, startedAt}`; `pcms.ui.revision` change signal; `pcms.status.v1` popup summary | Core object graph; in-flight promises; sandbox frames; caches; per-request receipts |

Rule: **no correctness decision may depend on ephemeral state surviving an unload.** Each unit of background work
commits durable progress before it ends. An unload at any instruction boundary must lead to one of three outcomes:

- the work repeats idempotently;
- it is reconciled (RemoteOps);
- it is skipped and rescheduled once (timers).

### 5. Wake classification and recovery

`ensurePcmsCore()` reads `storage.session.pcms.core.session`:

- **Cold start:** the marker is absent. This covers browser start, extension install/update/reload, and recovery
  after an extension-process crash that cleared session storage. P026 startup recovery runs **unchanged**: unresolved
  RemoteOperations or an existing hold → `RECOVERY_HOLD`; interrupted `DISPATCHING` → `UNCERTAIN`; then module
  recovery. Afterwards the marker is written.
- **Warm wake:** the marker is present, meaning the event page was unloaded and woken within the same browser
  session. Any `DISPATCHING` RemoteOperation found at init was necessarily interrupted, because no dispatch can
  have started in this new context yet. Each one becomes `UNCERTAIN` and PCMS enters `RECOVERY_HOLD`, which is
  identical to the cold-start outcome for interrupted dispatches.
  - Unresolved operations in `PREPARED`, `RETRYABLE` or `UNCERTAIN` existed while the previous context was
    operating normally. Their per-target fail-closed rules already apply, so they do **not** by themselves put PCMS
    into global hold on a warm wake.
  - Without this distinction a normal idle unload would put PCMS into global hold every few minutes.
- **Restore** still always enters `RECOVERY_HOLD` (P020, unchanged).
- Release from hold requires the existing reconciliation checks. No path blindly retries or replays.

### 6. Timers and wakeups

- The durable P012 timer service is the **logical timer authority**. `browser.alarms` is only a wake mechanism.
- Core owns two alarm names:
  - `pcms.timers.next`: a one-shot alarm at the earliest `SCHEDULED` `dueAt`. It is re-armed after every timer
    commit and at the end of every run.
  - `pcms.core.heartbeat`: periodic, 5 min. It is the safety net for a lost or skipped alarm or a clock change.
- On any wake, Core initialises and then runs the **due pass**:
  1. `timers.recoverInterrupted()` (stale `DISPATCHING` → `MISSED`);
  2. `timers.runDue({limit})` (bounded; CAS claim makes duplicate wakes harmless);
  3. re-arm `pcms.timers.next`.
- Alarms are recreated from durable timers on every cold start, because they do not persist across browser
  sessions.
- No backlog replay: the timer service marks overdue (> 24 h) or interrupted timers `MISSED`.
- **Schedules are declared, not remembered.** Each built-in service and each runtime module (via capability, see
  ADR-003) re-declares its schedules idempotently on start (`timers.ensure(name, dueAt)`), computing `dueAt` from
  its own durable state (for example `lastScanCompletedAt + interval`). If the declared time has already passed, the
  result is exactly one catch-up run.
- Dashboard visibility, focus, `setInterval` and `online`/`visibilitychange` events never drive operational
  scheduling. They may only trigger a UI projection refresh.

### 7. Work budget

- Background work is executed as **bounded steps**. The target is ≤ 10 s each, well under the idle timeout.
- Each step commits progress before returning. Longer jobs schedule an immediate continuation timer, so the job
  continues through alarm wakes even if the page unloads between steps.
- Examples:
  - a repository scan step = resolve ref + list tree + validate up to N generators;
  - a provider dispatch step = prepare durable RemoteOperation → dispatch → record outcome.
- A dispatch interrupted by unload becomes `UNCERTAIN` (§5). Dispatch windows are therefore kept short.
  Long-running provider effects are modelled as handoff + reconcile, not as one long dispatch (§9).

### 8. UI ↔ Core communication

- **Requests:** `runtime.sendMessage({type:"PCMS_UI_REQUEST", version:1, requestId, kind:"query"|"command", name,
  params, idempotencyKey?})`. This wakes the event page if it is suspended.
  - The background validates the sender with the existing `/pcms/` extension-page rule and validates the request
    with an exact-keys schema.
  - Queries return bounded projections. Commands return a receipt `{receiptId, subject, status}` once the command is
    durably recorded.
- **Change signal:** after committing state that affects projections, Core writes `storage.session.pcms.ui.revision`
  as `{seq, topics[]}`. Dashboards subscribe with `storage.onChanged` and re-query the topics they show. This needs
  no long-lived port and survives background unloads. Ports may be used as an optimisation only, never for liveness
  or correctness.
- **Commands are idempotent per `idempotencyKey`.** Concurrent commands from different tabs are serialised by
  module CAS. The loser gets a revision conflict, which the UI shows as "Changed elsewhere — refreshed".

### 9. HumanTasks outlive the dashboard (assisted provider steps)

The in-memory `operator.choose()` dialog cannot exist in a background context. The assisted Perchance driver becomes
a **durable handoff**:

1. **Dispatch** = open the target in the bound Persona (Broker `persona.open`) and record the handoff. The adapter
   returns an *unknown* outcome, so ProviderGate records the operation as `UNCERTAIN`, the same as any ambiguous
   dispatch today.
2. A HumanTask (`provider.confirm-apply`) is opened with `subjectRef` = the target. Its text shows the desired
   content reference and the human-checkable evidence.
3. The operator's answer, given from any dashboard tab, the Attention list or later from the popup deep link, is
   submitted as **reconciliation** (`APPLIED` / `NOT_APPLIED` / `UNKNOWN`). This is the existing reconcile path.
   `UNKNOWN` keeps the target `UNCERTAIN`. Nothing is replayed.

UI wording distinguishes "Waiting for your confirmation" (handoff, recorded in the live operation context) from
"Outcome unknown". The underlying fail-closed state is the same. Provisioning HumanTasks are durable already.

### 10. Multi-tab behaviour

Any number of dashboard tabs and windows are pure clients:

- opening or closing one never starts, stops or recovers Core;
- each re-queries on the revision signal;
- action receipts are durable records, so every tab shows the same progress.

The P026 single-dialog constraint disappears because HumanTasks are durable. A tab-local lock is **not** part of
the runtime ownership model. If one is ever used, it can only serve a narrow UI concern such as de-duplicating
desktop notifications.

### 11. Module lifecycle on wake

Module identity, admitted packages, lifecycle and desired enabled state are durable (P008/P011/P022).

- On wake, `moduleRuntime.recoverAll()` fences every previously `ACTIVE`/`DRAINING` generation, because that
  context is gone.
- The **module supervisor** then reconstructs execution contexts:
  - Built-in modules are re-created in process.
  - Runtime modules are activated **lazily, but before any work is delivered to them**. Activation happens at the
    first due timer for that module, the first UI query or command that targets it, or an event subscription it
    holds.
  - Every activation creates a new generation, so a stale context can never write.
- Module timers survive generation changes because modules re-declare schedules on start (§6). Timers owned by a
  fenced generation become `MISSED` and the re-declaration replaces them with exactly one schedule.

Details are in ADR-003.

### 12. Status for clients and popup

While Core is up, it publishes a non-secret summary to `storage.session.pcms.status.v1`:

- counts;
- recovery state;
- `asOf`;
- Persona → account display map.

The popup reads only this summary. "PCMS not open" no longer exists as a state. Possible states are:

- Core running;
- Core idle (unloaded, last summary shown with its time);
- Core unavailable (PersonaMonkey bootstrap failed or initialisation error).

## Consequences

- **Frozen PersonaMonkey-derivative paths are touched:** `extension/lib/recovery-bootstrap.js` (one static import),
  `extension/background.js` (endpoint registration) and `extension/manifest.json` (ADR-003). Each change follows the
  P025/P026 derivative-override bookkeeping (`docs/upstream/import-manifest.json`, import-integrity test) with
  regression evidence.
- The dashboard loses direct service objects. P026 views are first rehosted over a request facade (P028), then
  replaced (P032+).
- Each wake costs a Core initialisation (IndexedDB open, recovery read, due pass). Runtime modules are activated
  lazily to bound this cost.
- The assisted apply path always passes through `UNCERTAIN` → reconcile. This makes every assisted save explicitly
  reconciled, which is the accepted fail-closed posture.

## Test strategy

| Layer | Evidence |
|---|---|
| Unit / integration (Node) | wake classification table; due-pass idempotence under duplicate alarms; interrupted dispatch → UNCERTAIN + hold; schedule re-declaration after generation fencing; UI request validation; concurrent idempotent commands |
| Fault injection | unload simulated at every step boundary of scan, timer dispatch and provider dispatch, with deterministic recovery asserted |
| Packaged XPI in exact pinned FDE (CI) | install the XPI once; open and close dashboards; force short idle timeout via test-profile pref; assert: (a) a background-scheduled job runs with **zero** PCMS tabs open; (b) work continues across forced event-page unloads; (c) two dashboard tabs never trigger recovery or hold; (d) a profile restart recreates alarms from durable timers with one bounded catch-up |
| LIVE (final two phases only) | operator ESR/FDE continuity checks with real PersonaMonkey/Perchance |

Firefox DevTools MCP is not used. CI drives the packaged extension through the repository's Firefox harness
(WebDriver/Marionette is acceptable for deterministic CI). Live acceptance stays manual without Marionette.

## Rejected alternatives

- **Tab-hosted Core with a single-host lock** (earlier UX-v2 draft). It stops all operation when the dashboard
  closes, and it makes the dashboard the operational authority.
- **Hybrid "scan-only" background writer with the Core still in the tab.** This gives two writers and recreates the
  two-Core hazard.
- **Keep-alive loops or ports to emulate a persistent background.** This is unsupported and fragile, and it hides
  missing durability.
