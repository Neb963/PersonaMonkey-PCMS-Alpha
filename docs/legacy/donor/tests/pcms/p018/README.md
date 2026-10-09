# P018 — Statistics module evidence

Phase state: **ACCEPTED**.

## Implemented scope

P018 adds a read-only Statistics feature module under `pcms-modules/p018/**`.

- metric definitions are module-owned and bounded to deterministic `COUNT` or numeric `SUM` selectors;
- Statistics consumes only the accepted P007 Audit Journal `read()` capability and never appends events or mutates operational/domain state;
- projection state stores aggregate values, UTC-day buckets, cursor/watermark metadata, and metric-definition fencing, but no raw event payloads or subject identifiers;
- audit sequence gaps, unsafe/malformed metric input, invalid SUM sources, corrupt projection state, and inconsistent journal pagination fail closed;
- higher-sequence events with older timestamps are treated as late events and still contribute to their historical UTC-day buckets;
- full replay and incremental refresh converge on the same deterministic projection;
- metric selector/aggregation changes fence old state and require replay rather than mixing incompatible semantics;
- UI views support bounded metric/date filters with range-consistent totals;
- CSV export is deterministic and contains only metric metadata and aggregate numeric values, never raw event data or subject IDs.

## Acceptance mapping

### A018-01 — metric projection model

Covers bounded metric definitions, COUNT/SUM aggregation, ordered UTC-day buckets, deterministic totals, read-only Audit Journal integration, and projection-state validation.

### A018-02 — replay/late-event handling

Covers contiguous sequence fencing, pagination over the global journal tail, incremental refresh, full replay equivalence, older-timestamp late events, definition-change fencing, and fail-closed malformed journal/SUM inputs.

### A018-03 — UI/export

Covers sanitized projection views, metric/date filtering, range-aware totals, stable CSV ordering/escaping, and exclusion of raw audit subjects/payloads.

## Focused verification actually run

The exact committed product source at branch head `f3689a03105d4886039d5a027f31afd9d42c2b46` was loaded through the connected GitHub content path and executed in the connector JavaScript isolate.

Result: **12 focused U/I/C runtime and boundary checks passed**.

The checks exercised:
- P007-compatible paginated `read({ afterSequence, limit })` semantics with a global `lastSequence`;
- incremental refresh versus full replay equivalence;
- late-event counting and historical bucket placement;
- COUNT/SUM totals and matched-event counters;
- date-range totals and CSV escaping;
- raw subject/payload exclusion from export;
- metric-definition semantic fencing;
- strict calendar-day validation;
- sequence-gap rejection;
- absence of raw WebExtension/native/IndexedDB authority;
- absence of Audit Journal append/domain mutation paths.

A local clone/Node run was attempted, but the execution sandbox has no outbound GitHub DNS. No local Node test result is claimed.

## Independent branch CI

Branch head `f3689a03105d4886039d5a027f31afd9d42c2b46` passed:
- GitHub Actions `verify`, run **526** / run id **37291659796** — **success**;
- GitHub Actions `firefox-developer-edition`, run **521** / run id **37291659867** — **success**.

The repository `verify` workflow does not discover `tests/pcms/p018/*.test.mjs`; the focused P018 result above is separate and is not represented as an Actions test run.

## Independent final branch / PR / merged-main CI

Final synchronized PR head `c4a4e7645ed2a3ce820a22d597fbfa851a7633fa` passed:
- push `verify`, run **531** / run id **37292318684** — **success**;
- push `firefox-developer-edition`, run **526** / run id **37292318672** — **success**;
- pull-request `verify`, run **532** / run id **37292342892** — **success**;
- pull-request `firefox-developer-edition`, run **527** / run id **37292342928** — **success**.

Pull request #18 merged as `208f2925f47c835ea750bdde2a2b9fe6fa309d52`.

The exact merged main commit passed:
- GitHub Actions `verify`, run **533** / run id **37292542942** — **success**;
- GitHub Actions `firefox-developer-edition`, run **528** / run id **37292542910** — **success**.

## Acceptance decision

The MERGED governance checkpoint `9938183fd9ad93e6f14d301503323350716366e6` passed:
- repository verification run **534** / run id **37292739443** — **success**;
- pinned Firefox Developer Edition run **529** / run id **37292739577** — **success**.

Together with the exact-product-source focused U/I/C checks, accepted P007/P011 dependencies, final branch/PR CI, and exact merged-main CI, this satisfies **A018-01**, **A018-02**, and **A018-03**. P018 is **ACCEPTED**.
