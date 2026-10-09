# ADR-003 — Runtime-installable modules execute in production without extension reload

Status: **ACCEPTED** (product decision by the operator, 2026-10-07). Implementation: P027, P030, P031, P033, P041.

## Context

Principle 10 (`docs/architecture/00-principles.md`) says runtime-installable modules do not require rebuilding the
whole extension. The P004/P008/P011/P022 mechanisms are accepted:

- immutable hashed packages;
- authority envelope and approval of authority expansion;
- sandbox controller protocol with private `MessagePort` RPC;
- generation fencing;
- lifecycle install / update / disable / remove / purge / rollback.

The shipped product cannot execute an admitted runtime module, because three pieces are missing:

1. `extension/manifest.json` does not declare the sandbox page or sandbox CSP from
   `extension/pcms/sandbox/manifest-fragment.json`.
2. `createModuleRuntimeBroker` is constructed in `live-core.js` with no `frameFactory` and no capability handlers.
   Nothing in production calls `activate()`.
3. Firefox supports the `sandbox` manifest key and `content_security_policy.sandbox` only from **Firefox 154**
   (MDN browser-compat-data). The repository CI pin is Developer Edition **153.0b10** and
   `strict_min_version` is `153.0`. The P004 sandbox evidence ran in Node realms, not in a Firefox sandbox page.

**Product requirement (operator decision):** after the base extension is installed once, modules installed through
PCMS execute immediately. The same holds for update, disable, re-enable, rollback, removal and later new installs.
None of these may require an XPI rebuild, manifest edit, extension reload, reinstall or Firefox restart. The
operator accepts the risk of executing runtime-supplied controller code in this private extension. Mozilla store
policy on remote code is therefore not a product constraint here. Internal integrity mechanisms remain mandatory,
because they also protect PCMS from buggy modules.

## Decision

### 1. Execution host

- Runtime module controllers execute in the **existing P004 sandbox page** (`pcms/sandbox/controller.html`), declared
  in the production manifest:

  ```json
  "sandbox": { "pages": ["pcms/sandbox/controller.html", "pcms/sandbox/module-ui.html"] },
  "content_security_policy": {
    "extension_pages": "<unchanged>",
    "sandbox": "<P004 controller CSP; module-ui CSP per §6>"
  }
  ```

  The two pages need different CSPs (controller: no styles or images; module UI: styles and images, no network).
  MV3 supports only one `content_security_policy.sandbox` string, so P030 must choose one of two options:
  - one CSP compatible with both pages, still with no network and no `allow-same-origin`; or
  - meta-CSP tightening inside `controller.html`.

  The choice is proved in the pinned build. Neither option may grant network access, `allow-same-origin` or
  extension APIs.
- **Controller frames live in the background page document** (ADR-002). The background page has a DOM. The runtime
  broker's `frameFactory` creates one `<iframe src="pcms/sandbox/controller.html">` per module activation (one realm
  per module generation) and removes it on dispose or fence.
- The P004 bootstrap rules stay exactly as accepted: one-time window bootstrap, private `MessagePort`, capability-only
  RPC, bounded payloads, intrinsic capture before evaluation, frozen method table.
- **No second plugin execution system** is introduced. There is no privileged `eval`, no `userScripts`, and no
  content-script execution of module code.
- **Browser floor.** Runtime modules require Firefox ≥ 154. The CI pin advances to an exact Developer Edition build
  ≥ 154 (P027).
  - If `strict_min_version` stays below 154 (see the open decision below), the module runtime feature-detects
    sandbox support at startup. Where unsupported, every module reports `UNAVAILABLE · Requires Firefox 154+`, and
    Core and the built-in modules keep working.

### 2. Lifecycle without reload

Every lifecycle transition runs in the background Core while the extension stays loaded:

```
install(file bytes from dashboard → PCMS_UI_REQUEST command, ≤ 1 MiB)
  → parse/validate (P008) → persist immutable package (P008)
  → authority delta → approval HumanTask if expansion (P008/P022)
  → admit → runtime.activate(new generation) → controller start → module.start() re-declares schedules
update: prepareUpdate (drain/fence old generation) → admit candidate (preserve last-known-good) → activate
        → mark known-good | on failure rollbackAdmission + reactivate last-known-good (P022)
disable / enable / rollback / remove / purge: P022 semantics, executed live
```

- Fencing is unchanged and remains authoritative. After `prepareUpdate`/`disable`, the old generation's capability
  calls, writes, timer deliveries and dispatches fail `STALE_GENERATION`. The old iframe is removed.
- Packaged-XPI FDE tests must prove that the old generation cannot write, call services or dispatch, even when the
  old controller keeps calling.

### 3. Rehydration across event-page unload and restart

Durable state:

- registry (packages, active hash, candidate);
- lifecycle (`PRESENT` / `REMOVED` / `PURGED`);
- runtime record (generation, `IDLE` / `ACTIVE` / `DRAINING` / `DISABLED`).

Ephemeral state:

- iframes, hosts, mailboxes.

Rules on each Core init (cold or warm):

1. `recoverAll()` fences every `ACTIVE`/`DRAINING` generation (→ `IDLE`, generation + 1). This is the accepted P011
   behaviour.
2. The **module supervisor** marks every module that is `PRESENT`, has an active package and is not `DISABLED` as
   *desired-running*.
3. **Lazy activation.** A desired-running module is activated just before delivering any of the following, so
   unload/wake cycles do not re-evaluate every controller:
   - its first due timer;
   - a UI query or command addressed to it;
   - an approved event subscription;
   - the post-install / post-update start.
4. **Activation calls the controller's `start()`**, which must be idempotent and must re-declare its schedules through
   `timers.ensure`.
5. Module failures are bounded:
   - **Activation failure** (controller throws or times out) → module `UNAVAILABLE` with a bounded backoff (1 min →
     30 min). An Attention condition is raised.
   - **Repeated activation failure right after an update** → existing P022 rollback to last-known-good.

### 4. Capability set v1 (bounded, PCMS-owned)

Capabilities are granted only through the package authority envelope (P008). Approval is required on expansion.
Names follow the existing `a.b` pattern and reserved roots (`browser`, `chrome`, `indexeddb`, `native`,
`personamonkey`) stay forbidden.

| Capability | Purpose | Bounds |
|---|---|---|
| `module.storage.read` / `module.storage.write` | Module-private KV namespace `module.<id>.data` with CAS | key ≤ 256 B, value ≤ 64 KiB, ≤ 4096 keys |
| `module.timers.ensure` / `module.timers.cancel` / `module.timers.list` | Declare named schedules. Core delivers `onTimer(name)` | ≤ 32 timers per module; minimum interval 1 min |
| `module.attention.open` / `module.attention.settle` | Open/resolve module-kind HumanTasks with `subjectRef` | ≤ 200 open per module |
| `module.audit.append` | Append module events (for Activity and Statistics) | ≤ 4 KiB per event; no secrets (redaction test) |
| `core.accounts.read`, `core.generators.read` | Read-only Account and generator-index projections | bounded pages |
| `core.ui.publish` | Publish summary, conditions and search entries (cached by Core, served to dashboards while the module is unloaded) | ≤ 64 KiB per publish |
| `provider.perchance.<action>` | Request a provider mutation **only through ProviderGate + RemoteOps**, never direct | per-action contract; fails closed when the provider capability is absent |
| `personamonkey.execution.*` | **Not granted.** Browser/page automation stays PersonaMonkey-owned. Provider adapters use PersonaMonkey execution artifacts on the module's behalf. | n/a |

New capabilities are added only for a concrete module requirement, through the same contract versioning.

### 5. Scheduled background work for runtime modules

- `module.timers.ensure` persists through the Core durable timer service, using service name
  `module.<id>.scheduler`.
- The due pass (ADR-002 §6) activates the module lazily and invokes `onTimer` through the mailbox.
- Each invocation is bounded by the sandbox RPC timeout. Longer work re-ensures a continuation.
- The work continues with zero dashboard tabs open, and across event-page unloads and browser restarts.

### 6. UI contributions

Runtime modules are first-class UI participants (see `docs/design/pcms-ux-v2/03-module-ui-contract.md`):

- **Declarative contributions** (nav entry, summary, search, facets, conditions, actions, settings, activity
  formatting, list/detail views) are rendered by Core with Core UI primitives. Cached `core.ui.publish` data means
  most dashboard views do not even need to wake the module.
- **Module page surface.** A package may include a `ui` entry (manifest schema v2, additive, v1 still accepted)
  that runs in a **sandboxed iframe inside the dashboard** (`pcms/sandbox/module-ui.html`). The module UI page:
  - receives the module's UI source, the Core UI kit stylesheet and a primitives library;
  - talks to the dashboard over a private `MessagePort`;
  - has neither extension APIs nor network.

  The dashboard relays its requests to the background as the module's *UI-scoped* capability set: read its own
  projections and invoke its own declared actions. Actions with risk `EXTERNAL_MUTATION`, `BINDING`, `DESTRUCTIVE`
  or `RESOLUTION` are always confirmed by a **Core-rendered** dialog outside the iframe.
- Built-in privileged modules may render richer trusted pages directly with Core primitives.

### 7. Integrity mechanisms retained

Retained unchanged:

- package identity and hashing;
- authority envelope and approval;
- bounded capability RPC;
- generation fencing and stale-runtime rejection;
- RemoteOps and ProviderGate correctness;
- the Persona Broker boundary;
- SecretRef-only secret handling (modules never receive secret values; provider adapters resolve SecretRefs in Core);
- recovery hold (blocks module mutation capabilities exactly as it blocks Core).

## Required end-to-end proof (packaged XPI in the exact pinned FDE, CI)

The base XPI is installed once. A fixture module package that is **not compiled into the XPI** is then put through
the following checks, all with no XPI rebuild, reinstall or reload:

1. Install through PCMS.
2. Its controller starts and executes.
3. It can call only approved capabilities (a denied call fails).
4. It contributes UI and state.
5. It schedules work.
6. With all dashboard tabs closed, the work still runs.
7. Update → new generation activates without reload.
8. The old generation can no longer write, call or dispatch.
9. Disable and enable work.
10. A Firefox (profile) restart reconstructs the admitted module state and resumes declared schedules with bounded
    catch-up.
11. Rollback and remove work.

Acceptance gates: A030-0x, A031-0x, A033-0x.

## Open decision

**Firefox ESR 153.** P026 live acceptance ran in ESR. ESR 153 lacks sandbox-page support, so it cannot execute
runtime modules. The options are:

- **(a)** raise `strict_min_version` to 154, which drops ESR 153 entirely; or
- **(b)** keep 153 with module runtime degraded (`UNAVAILABLE`) on ESR 153.

Default until decided: **(b)**. P027 records the outcome.
