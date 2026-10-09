# G. Migration path · H. Future workflow compatibility · I. Roadmap rationale

The authoritative roadmap is `docs/implementation/v1/plan.json` (phases P027–P044) with acceptance gates in
`acceptance.json`. `ROADMAP.md` is the generated view. This file explains *why* the phases are cut this way. If it
disagrees with `plan.json`, `plan.json` wins.

## G. Migration path from P026

There is no rewrite. Migration happens in this order: **move authority → rehost → replace → remove**.

1. **Move authority (P028).**
   - Core moves into the background (ADR-002).
   - The dashboard keeps its P026 views but talks to Core through a UI-client facade that mirrors the service
     methods those views call, over validated `PCMS_UI_REQUEST` commands and queries.
   - The P026 DOM IDs stay in place, so accepted P021/P026 tests keep passing.
   - The in-memory operator dialog is replaced by the durable HumanTask handoff (ADR-002 §9). The P026
     "no replay of UNCERTAIN" behaviour is preserved and covered by ported tests.
2. **Rehost (P032).** The new shell wraps the existing views. Diagnostics fields move to Settings → Diagnostics.
   Legacy routes resolve.
3. **Replace, one area per phase** (P034 Accounts, P036 Deployer/Generators, P040 Refresher/Explorer/Provisioning,
   P041 Settings). Each phase adds the module-owned command it needs. For example, Deployer `deploy` absorbs the
   reconcile/setDesired/prepareRetry logic that sits in `live-controls.js` today.
4. **Remove (P040).** Legacy operator forms are deleted. Each superseded P026 DOM assertion is replaced with an
   equivalent one. Accepted evidence documents are never edited.

Data and contract migrations allocated in `plan.json`:

| Migration / contract | Phase |
|---|---|
| `MIG-P036-deployer-state-v2` (04 §E.7.1) | P036 |
| `MIG-P040-refresher-state-v2` (payload reference to Deployer confirmed release) | P040 |
| `pcms.ui-client/v1`, `pcms.persona-broker.internal-endpoint/v1` | P028 |
| `pcms.timers.ensure/v1` | P029 |
| `pcms.module-capabilities/v1` | P031 |
| `pcms.ui-contribution/v1`, `pcms.module-manifest/v2` (additive `ui` entry) | P033 |
| `pcms.perchance.driver/v2`, `pcms.deployer.state/v2`, `pcms.generator-index/v1` | P036 (driver v2 extended by P039) |
| `pcms.repository-provider/v1`, `pcms.generator-repository/v1` | P037 |

If an implementing phase finds that it needs a durable schema change not listed here (for example a runtime-record
change in P031), it must stop and request an allocation. It must not invent a migration ID (AGENTS §4).

## H. Future workflow compatibility

These interfaces must stay stable so that a later Workflows module (built-in or runtime) can compose operations:

| Interface | Stability |
|---|---|
| `EntityRef` kinds | additive only |
| Module actions `{id, appliesTo, risk, input, preview/execute, idempotencyKey}`, invoked through the UI-client command path or a future `actions.invoke` capability | versioned with `pcms.ui-contribution` |
| `preview` side-effect-free; `execute` idempotent per key | normative |
| Durable truth = module state and durable receipts, never tab memory | normative (ADR-002) |
| HumanTask with `subjectRef` as the standard wait point, outliving dashboards | normative (ADR-002 §9) |
| `UNCERTAIN` stops a chain until it is reconciled; recovery hold blocks external mutation | normative |
| Background scheduling via declared schedules (`timers.ensure`) | `pcms.timers.ensure/v1` |

Example chain:

```
explorer.reserve → deployer.prepareFromReservation → [HumanTask create-generator]
  → deployer.deploy → deployer.verify → statistics (journal)
```

Because Core lives in the background, such a chain keeps progressing with no dashboard open. Every step is a
durable, idempotent, resumable unit.

## I. Roadmap rationale

### Dependency structure

```
P027 harness + pin>=154
  └─ P028 background Core + UI client
       ├─ P029 alarms/timers ───────────────┐
       ├─ P030 sandbox pages ──┐            │
       │                        └─ P031 runtime module lifecycle ─┐
       └─ P032 dashboard shell ──────────────┼─ P033 contribution contract
            ├─ P034 Accounts                 │      ├─ P041 backup/restore + modules UX
            └─ P035 popup (also P028)         │      └─ P036 Deployer v2/Generators (also P034)
                                              │            ├─ P037 repository scan
                                              │            │     └─ P038 scheduled sync (also P029)
                                              │            │           └─ P039 observe/drift
                                              │            │                 └─ P042 unattended automation
                                              └────────────┴─ P040 Refresher/Explorer/Provisioning (P033,P036,P029)
P043 LIVE (P035,P038,P040,P041,P042) → P044 LIVE
```

### Why this order

| Requirement | Satisfied by |
|---|---|
| Every later guarantee must be provable on the real packaged extension in the pinned build | **P027 first**: packaged-XPI harness and pin ≥ 154 (needed for sandbox pages) |
| Background authority before anything depends on scheduling or unattended work | P028 → P029 before P031/P038/P040/P042 |
| Production dynamic-module execution early, so later module work uses the shipped runtime rather than a test-only abstraction | P030 → P031 directly after the foundation. P033's contribution contract is proven with a real runtime fixture module. |
| UI tabs become clients | P028 (facade), P032 (shell) |
| Scheduled module work proven independent of tabs | A029-03, A031-02, A038-01, A040-02 |
| Repository/Deployer built on background services | P036–P038 after P029/P033 |
| Observation precedes automatic mutation | P039 → P042 |
| Live work only in the final two phases | P043/P044. Earlier phases keep unknown provider capabilities gated and fail-closed. `tools/verify-repo.mjs` rejects LIVE gates elsewhere. |

### Parallelism

Claims are checked mechanically. Possible concurrent groups are P029 ∥ P030 ∥ P032, then P031 ∥ P034 ∥ P035. The
following pairs share write paths, so the claim validator serialises them: P030/P035 (upstream import manifest),
P033/P034, P037/P040, P037/P041, P039/P040, P040/P041, P040/P042.

### Per-phase scope

Task titles, write paths, contracts, resources, migration slots and acceptance gates are in `plan.json` and
`acceptance.json`. Short non-scope notes:

| Phase | Non-scope |
|---|---|
| P027 | No product behaviour change except what the pin requires. Recording the ESR decision only. |
| P028 | No new UI design and no timers (P029). The module runtime is still unwired (P030/P031). |
| P029 | No domain schedules beyond a Core fixture job. Deployer and Refresher schedules come later. |
| P030 | No lifecycle UX and no capability set (P031). |
| P031 | No dashboard install UI. Install is driven through UI-client commands in the harness; the Modules page is P041. |
| P032 | No module contribution contract (P033) and no Accounts redesign (P034). |
| P036 | No repository, scheduling or observation. |
| P037 | No timers (P038) and no observation (P039). |
| P039 | No automatic overwrite of drift, ever. Real Perchance read path remains disabled until P043 confirms it. |
| P042 | Capability stays disabled for real Perchance until P044 confirms it live. |
| P043/P044 | Operator live acceptance in normal Firefox without Marionette or DevTools MCP. Any live discrepancy is first encoded as a deterministic regression fixture. |
