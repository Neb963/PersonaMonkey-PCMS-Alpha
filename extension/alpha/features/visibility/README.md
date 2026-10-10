# P305 — Recent visibility and adaptive metrics

This feature implements the frozen `Visibility` service methods: `observeRecent`,
`getPosition`, and `collectStats`. It also exposes read-only bounded
`collectDueStats`, `budget`, and pure `classifyRetry` for the later P403
refresh executor. **P305 never performs a source edit, browser execution,
Perchance network request, or a provider mutation.**

The caller injects the P204 Inventory service and trusted PersonaMonkey-executed
read observations. `feedSource.observe()` must provide a **global** recent-page
snapshot tagged `TRUSTED_RENDERED_RECENT`: `feedKeys`, `renderedKeys`,
optional `pinnedKeys` and `filteredKeys`, `asOf`, and `evidenceRefs`.
Rendered ordering must be collected *after* page pinning/filtering, not fabricated
from the raw recent feed. `statsSource.readViews({key})` must return an
independently observed view counter tagged `TRUSTED_GENERATOR_VIEWS`.
These are injected read-only adapter interfaces, **not claims of validated
Perchance endpoints**; production wiring requires its own later assignment.

`createVisibilityLedger()` owns the strict IndexedDB read-modify-write journal.
It preserves global poll reservations and a UTC-day request budget across
background wake and restart. Feed requests occur no more often than once per
10 minutes globally; unsuccessful attempts still consume their slot. In a day,
144 feed slots are reserved before allocating up to 856 stats requests under
the default total cap of 1,000. This is a conservative local budget, not a
promise that Perchance accepts that volume. Individual counter cadence adapts
to active (1h), sleeping managed (12h), unlisted/other (24h), and excluded
(72h). Bounded nine-day history produces daily/weekly deltas only with actual
baselines; timestamps, staleness, unknowns, and counter resets are explicit.

Presence in the rendered page is distinct from public-feed API position.
Feed inclusion without rendered inclusion is `LIKELY_FILTERED`; absence is
`NOT_VISIBLE` (not a ban). Unknown or failed observations never assert a
prohibition. `classifyRetry` gives bounded, stagger-friendly guidance only;
P403 owns any later executor/reload/comment ledger.

Deterministic regression command:
`node --test tests/alpha/visibility/*.test.mjs`

The P305 tests use trusted synthetic fixtures; actual Perchance/Firefox
provider behavior is **not live verified**.
