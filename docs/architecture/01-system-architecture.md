# 01 — System Architecture

## Topology

```
PersonaMonkey-PCMS Firefox Developer Edition extension
|
+-- PersonaMonkey subsystem
|   +-- Personas / contextual identities
|   +-- personaUid continuity
|   +-- Mullvad routing + fail-closed guards
|   +-- userscripts
|   +-- workflows/jobs
|   +-- owned-tab execution / external automation
|   +-- control leases
|   +-- existing persistence / compatibility
|
+-- PCMS subsystem  (Core in the background event page; ADR-002)
    +-- PCMS background entry / ensurePcmsCore()
    +-- Persona Broker (in-process internal endpoint, Integration-v1 semantics)
    +-- module registry / package store
    +-- sandbox runtime broker
    +-- separate PCMS IndexedDB
    +-- RemoteOps
    +-- ProviderGate
    +-- SecretRef adapter
    +-- HumanTask / Attention
    +-- timers/services
    +-- minimal Audit Journal
    +-- recovery / backup
    +-- module supervisor + sandbox controller frames (ADR-003)
    +-- installable modules
    +-- UI clients: PCMS dashboard tabs, popup (no Core instance)
```

## Boundary rule

PCMS consumes PersonaMonkey through a typed broker preserving Integration API v1 semantics even though both run in one extension.

PCMS modules never receive PersonaMonkey service objects directly.

## PCMS Core shared identities

- AccountId
- PersonaBinding(AccountId -> personaUid)
- ProviderTargetRef
- RemoteOperation
- SecretRef
- HumanTask
- ModuleInstance/runtime generation

Projects, Deployments, Explorer candidates, Refresher cohorts, Statistics definitions and Provisioning attempts are module-owned.

## Dynamic code

Module controller/UI code executes only in a declared Firefox sandbox page behind authenticated bounded RPC.

Provider/browser automation executes through PersonaMonkey external artifacts/execution. PCMS does not create a second `browser.userScripts` authority.

## Persistence

PersonaMonkey keeps its existing storage/compatibility. PCMS owns a separate IndexedDB to avoid coupling PCMS migrations to PersonaMonkey state schema.

Authoritative PCMS state transition and its audit append are transactionally atomic when both belong to PCMS storage.

The Audit Journal is append/read/projection infrastructure only. It is not an event-sourced domain store or workflow bus.

## Remote mutation

PCMS RemoteOps provides durable target-level operation identity/fencing across restarts/module updates.

PersonaMonkey control leases provide short browser-control exclusivity.

Both participate in mutating browser operations; neither substitutes for the other.

## Recovery

Restore activates PCMS in `RECOVERY_HOLD`. Module generations, unresolved RemoteOps, Persona bindings and provider capabilities reconcile before mutation is re-enabled. Missed timers are not replayed as an unbounded backlog.

## Runtime host (ADR-002)

PCMS Core is created once per extension background context by an idempotent initializer that waits for PersonaMonkey's fail-closed bootstrap. Firefox MV3 background contexts are event pages: they unload when idle and are woken by events. All correctness state is durable; alarms only wake the background and are recreated from durable timers. Dashboards and the popup are clients that communicate through validated `PCMS_UI_REQUEST` messages and a `storage.session` change signal; they never construct Core services.

Cold start (browser/extension start) runs the full startup recovery; a warm wake within the same browser session treats any `DISPATCHING` operation as interrupted (`UNCERTAIN` + `RECOVERY_HOLD`) without re-holding for operations that were already unresolved while the previous context operated normally.

## Runtime modules in production (ADR-003)

Runtime-installed module controllers run in the declared Firefox sandbox page (Firefox ≥ 154), framed inside the background page, behind the accepted bounded RPC and generation fencing. Lifecycle transitions run live without extension reload; execution contexts are reconstructed lazily after unload/restart.
