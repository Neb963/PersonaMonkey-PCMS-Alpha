# PCMS UX v2 — product-refinement design package (revision 2)

## What has authority

- **Accepted** architecture decisions are in [ADR-002](../../adr/ADR-002-background-authoritative-pcms-runtime.md)
  (background-authoritative Core; dashboards are UI clients) and
  [ADR-003](../../adr/ADR-003-production-runtime-installable-modules.md) (runtime-installable modules in production).
  The architecture documents `docs/architecture/00`–`03` were amended to match.
- The **phase sequence** is authoritative in `docs/implementation/v1/plan.json` (P027–P044) and
  `acceptance.json`. `ROADMAP.md` is the generated readable view.
- **This directory** is UX and domain design input for those phases. It is not itself accepted authority. Each phase
  turns the parts it implements into code, tests and evidence.

Revision 2 replaces the first draft, which wrongly assumed a tab-hosted Core with a single-host `navigator.locks`
lock, a UI timer pump, "checks paused while PCMS is closed", and declarative-only, future runtime modules.

## Contents

| File | Deliverable |
|---|---|
| [01-ux-audit.md](01-ux-audit.md) | A. Audit of the P026 UI |
| [02-information-architecture.md](02-information-architecture.md) | B. Information architecture, C. Screen designs, common states, confirmations, diagnostics, popup |
| [03-module-ui-contract.md](03-module-ui-contract.md) | D. Module UI contribution contract (built-in and runtime modules) |
| [04-deployer-repository-sync.md](04-deployer-repository-sync.md) | E. Deployer ↔ generator repository, F. Perchance listing model |
| [05-migration-and-roadmap.md](05-migration-and-roadmap.md) | G. Migration, H. Workflow compatibility, I. Roadmap rationale (mirrors `plan.json`) |

## Repository facts behind revision 2

1. **Core runs only in the dashboard tab today.** `pcms/app/app.js` starts `startPcmsLiveRuntime()`, and the
   background hosts only PersonaMonkey. Closing the tab stops PCMS. Two tabs means two authoritative Cores, and a
   second tab can force `UNCERTAIN` and `RECOVERY_HOLD` on the first. **Fixed by ADR-002 (P028).**
2. **The runtime-module path is unwired in production.**
   - The manifest lacks the sandbox page.
   - `live-core.js` builds the module runtime with no frame factory and no capability handlers.
   - Nothing calls `activate()`.
   - Firefox supports the `sandbox` manifest key only from **154**, and the CI pin is **153.0b10**.

   **Fixed by ADR-003 (P027 pin, P030 sandbox wiring, P031 lifecycle).**
3. **The assisted Perchance step waits on an in-memory `<dialog>` in one tab.** That cannot survive in the
   background. It becomes a durable HumanTask handoff reconciled through the existing RemoteOps path
   (ADR-002 §9, P028).
4. **The existing Firefox CI only screenshots a static page.** No packaged-XPI extension harness exists. One is
   added first (P027), because every background and module guarantee must be proven on the packaged XPI in the
   pinned build.
5. **PersonaMonkey already registers a 1-minute `persona-mullvad-idle` alarm**, but inside the dynamically imported
   `background.js`. PCMS listeners will be registered synchronously from the static bootstrap entry, as MDN requires
   for event pages. P027 records whether the existing asynchronous registration behaves correctly in the pinned
   build.
6. The following findings from revision 1 still hold:
   - P026 forms put orchestration in the UI;
   - typed IDs everywhere;
   - Deployer `observed` actually means "confirmed";
   - nothing reads Perchance back;
   - the provider contract has a single `source` string and no listing.

## Decision summary

| # | Decision | Where |
|---|---|---|
| D1 | Sidebar app: Overview · Attention · Accounts · Generators · module pages · Activity · Settings; global search | 02 |
| D2 | Generator is a Core *view* (rebuildable index from module listings), not an aggregate. Modules contribute facets. | 02, 03 |
| D3 | **One** contribution contract for built-in and runtime modules: declarative contributions rendered by Core, plus a module page surface. Built-ins render with trusted primitives; runtime modules use a sandboxed module-UI frame. Risky confirmations are always Core-rendered. | 03, ADR-003 |
| D4 | Three state layers per generator (repository desired / PCMS confirmed / Perchance observed). One pure status derivation with a "what happens next" sentence. | 04 |
| D5 | Plain-file, explicitly pointed, immutable releases. Identity = SHA-256 of the canonical payload. | 04 |
| D6 | `GeneratorListing = PUBLICLY_LISTED \| UNLISTED` (+ `UNKNOWN` observed). `isPrivate` exists only in the adapter. | 04 |
| D7 | Drift is compared against the confirmed Perchance baseline and never auto-overwritten. | 04 |
| D8 | Deployment modes Paused / Assisted / Automatic. **All modes run in the background regardless of open tabs.** Automatic is gated only on provider-safety capabilities (P039 observe, P042 unattended driver), never on a dashboard. | 04 |
| D9 | Scans and every scheduled task use durable Core timers woken by `browser.alarms` (ADR-002 §6). Schedules are declared idempotently on start, with bounded catch-up. | 04, ADR-002 |
| D10 | The popup stays 370 px. It shows Core running / idle / unavailable from a `storage.session` summary. | 02 |
| D11 | Incremental migration: rehost the P026 views over the UI-client facade (P028), replace area by area, remove last (P040). | 05 |

## Decisions still open (genuine product choices)

| ID | Question | Affects | Default until decided |
|---|---|---|---|
| Q1 | Generator repository owner/name, public/private, branch. *The repository does not exist; no URL is assumed.* | P037 live use, P043 | "Not configured" |
| Q2 | Accept plain-file releases instead of zips? | P037 | Plain files |
| Q3 | Map account folders to PCMS Accounts through a UI-chosen mapping (no IDs in the repository)? | P037 | Proposed mapping |
| Q5 | GitHub reads over Firefox's default network or a designated Persona route? | P037 | Default network, disclosed |
| Q7 | Is Perchance generator *creation* required, and may it be automated? | P036/P042 | Creation is an operator HumanTask |
| Q8 | **Firefox ESR 153:** raise `strict_min_version` to 154 (drop ESR 153), or keep 153 with runtime modules `UNAVAILABLE` there? | P027/P030 | Keep 153, degraded |

Q4 (the Perchance read path) is no longer an open design question. Observation is capability-gated and fails closed
(P039). The live confirmation and fixture capture happen in P043.

Q6 (where Core runs) is **decided** by ADR-002.

## Adversarial review (revision 2)

| Question | Answer |
|---|---|
| Does closing every PCMS tab stop anything? | No. Core, timers, module work, scans, reconciliation and recovery live in the background (ADR-002). P028/P029/P031/P038 gates prove it with the packaged XPI and zero tabs. |
| Can two tabs conflict? | No. Tabs are clients and construct no Core (static boundary test + FDE multi-tab gate A028-03). |
| Does correctness depend on a resident event page? | No. Durable state, idempotent init, alarms recreated from durable timers, bounded steps, and fault-injected unloads at every step boundary (A029-02, A038-03). |
| Does a warm wake weaken recovery? | No. Cold start keeps P026 semantics. Any interrupted `DISPATCHING` still becomes `UNCERTAIN` + `RECOVERY_HOLD`. Only operations that were already unresolved under normal operation skip the redundant global hold on wake. |
| Are runtime modules real product modules? | Yes. They install, update and roll back live; get scheduled background work, a capability set and full UI contributions including a page; and survive unload and restart (A031, A033, A041). |
| Did safety get weaker to allow runtime code? | No. Package hashing, authority approval, bounded RPC, generation fencing, ProviderGate/RemoteOps, the Broker boundary and SecretRef isolation are unchanged. The sandbox CSP still has no network and no `allow-same-origin`. |
| Generic plugin framework? | No. There is a bounded capability list and a bounded contribution contract, extended only for real module needs. Browser automation stays PersonaMonkey-owned. |
| A second scheduler or browser authority? | No. There is one durable timer service and one alarm-wake mechanism. Unattended Perchance work uses PersonaMonkey execution artifacts under control leases. |
| Is live testing only in the final two phases? | Yes. P043 and P044 only (validator-enforced). Unknown provider behaviour stays capability-gated until then. |
| Is background hosting conflated with automatic mutation? | No. Background operation lands in P028–P031. Automatic mutation has its own safety gates (P039 + P042), proven on fixtures, and live-confirmed in P044. |
