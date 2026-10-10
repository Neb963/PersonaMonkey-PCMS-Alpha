# P304 — individual Refresher policy engine

Background-owned, read-only scheduler. No browser tabs, provider RPC, comment insertion or save operations. P403 composes dispatch, trusted provider readbacks and execution.

- `createRefresherStore` persists one strict-transaction IndexedDB ledger, separate from the frozen P102 Generator record. Every read validates shape; each write changes one ledger revision and resolves only on transaction completion. After cold start, instantiate using the same database.
- `createRefresherService({storage,ledger,clock,random})` implements the frozen `status`, `configure`, `setEligibility`, and `planPass` query/mutation surface. `checkpoint` is a background-only lifecycle input; `inspect` is diagnostics. Core/P403 supplies durable wakeups, the browser-run identity, and observed provider outages.
- A period defaults to A=24h and S=72h; independent internal jitter is at most ±30m. Sleep is a **minimum**, so negative sleep jitter is clamped; no activation is guaranteed at the end of sleep.
- Unknown public recent-page capacity means cap 0, never a fabricated 283 slots. The target cap uses `ceil(eligible*A/(A+S))`, limited by `floor(observedCapacity/(1+margin))`, eligible population, and a safe optional manual override. Empirically observed capacity must come from trusted P305/P403 integration, not a guessed provider guarantee.
- The monotonic health checkpoint only credits bounded intervals when both endpoints are `HEALTHY` and browserRun IDs match. Confirmed outages, explicit shutdown, cold-start identity changes and unknown evidence do not accrue active time. A normal Firefox event-page idle/warm wake retains its run ID; alarms must run sufficiently often to avoid conservative gap clipping.
- Manual pull-out preserves a durable hold and, when active, enforces fresh minimum sleep; pull-in does not override sleep/cap. Activation uses longest waiting eligible sleepers; resuming does not replay missed activations.
- Generated status cursors fence both scheduler revision and P102 inventory revision. No UI/projection status is proof of successful Perchance publication or refresh. Before P403 dispatches an external mutation, it must independently verify current account binding, ownership, route/session, Core recovery state, and provider readback.

P304 is deterministic-only acceptance; final Perchance/Firefox live checks are operator controlled.
