import assert from "node:assert/strict";
import test from "node:test";

import { STATISTICS_ERROR_CODES } from "../../../pcms-modules/p018/errors.js";
import { createStatisticsService } from "../../../pcms-modules/p018/statistics.js";
import { auditEvent, makeAuditHarness } from "./harness.mjs";

const DEFINITIONS = Object.freeze([
  Object.freeze({
    metricId: "refresh.count",
    label: 'Refresh, "count"',
    eventType: "generator.refresh",
    aggregation: "COUNT"
  }),
  Object.freeze({
    metricId: "refresh.duration",
    label: "Refresh duration",
    eventType: "generator.refresh",
    aggregation: "SUM",
    valuePath: Object.freeze(["durationMs"])
  }),
  Object.freeze({
    metricId: "account.count",
    label: "Account changes",
    eventType: "account.updated",
    aggregation: "COUNT",
    subjectKind: "account"
  })
]);

test("A018-01/A018-02 metric projection is deterministic across pagination, incremental refresh, replay, and late timestamps", async () => {
  const harness = makeAuditHarness([
    "2026-10-05T10:00:00.000Z",
    "2026-10-06T10:00:00.000Z",
    "2026-10-05T12:00:00.000Z",
    "2026-10-07T09:00:00.000Z"
  ]);
  const service = createStatisticsService({ journal: harness.journal, definitions: DEFINITIONS, pageSize: 2 });

  await harness.append({
    type: "generator.refresh",
    subject: { kind: "generator", id: "gen-1" },
    data: { durationMs: 10, privateNote: "not projected" }
  });
  await harness.append({
    type: "unrelated.event",
    subject: { kind: "generator", id: "gen-2" },
    data: { durationMs: 999 }
  });

  const checkpoint = await service.rebuild();
  assert.equal(checkpoint.cursor, 2);
  assert.equal(checkpoint.lateEventCount, 0);

  await harness.append({
    type: "generator.refresh",
    subject: { kind: "generator", id: "gen-3" },
    data: { durationMs: 4, privateNote: "still not projected" }
  });
  await harness.append({
    type: "account.updated",
    subject: { kind: "account", id: "acct-1" },
    data: null
  });

  const incremental = await service.refresh(checkpoint);
  const replayed = await service.rebuild();
  assert.deepEqual(incremental, replayed);
  assert.equal(incremental.cursor, 4);
  assert.equal(incremental.watermarkTimestamp, "2026-10-07T09:00:00.000Z");
  assert.equal(incremental.lateEventCount, 1);

  assert.deepEqual(
    incremental.metrics.map(({ metricId, value, matchedEvents, lateMatchedEvents }) => ({ metricId, value, matchedEvents, lateMatchedEvents })),
    [
      { metricId: "refresh.count", value: 2, matchedEvents: 2, lateMatchedEvents: 1 },
      { metricId: "refresh.duration", value: 14, matchedEvents: 2, lateMatchedEvents: 1 },
      { metricId: "account.count", value: 1, matchedEvents: 1, lateMatchedEvents: 0 }
    ]
  );
  assert.deepEqual(incremental.metrics[0].buckets, [
    { day: "2026-10-05", value: 2, matchedEvents: 2, lateMatchedEvents: 1 }
  ]);
});

test("A018-03 view and CSV export are bounded, range-aware, stable, and omit raw event payloads/subjects", async () => {
  const harness = makeAuditHarness([
    "2026-10-05T10:00:00.000Z",
    "2026-10-06T10:00:00.000Z"
  ]);
  const service = createStatisticsService({ journal: harness.journal, definitions: DEFINITIONS });

  await harness.append({
    type: "generator.refresh",
    subject: { kind: "generator", id: "private-generator-id" },
    data: { durationMs: 5, secretLookingField: "must-not-export" }
  });
  await harness.append({
    type: "generator.refresh",
    subject: { kind: "generator", id: "other-private-id" },
    data: { durationMs: 7 }
  });
  const state = await service.rebuild();
  const view = service.view(state, {
    metricIds: ["refresh.count", "refresh.duration"],
    fromDay: "2026-10-05",
    toDay: "2026-10-05"
  });

  assert.equal(view.metrics.length, 2);
  assert.deepEqual(
    view.metrics.map(({ metricId, value, matchedEvents }) => ({ metricId, value, matchedEvents })),
    [
      { metricId: "refresh.count", value: 1, matchedEvents: 1 },
      { metricId: "refresh.duration", value: 5, matchedEvents: 1 }
    ]
  );
  assert.deepEqual(view.metrics[0].series, [
    { day: "2026-10-05", value: 1, matchedEvents: 1, lateMatchedEvents: 0 }
  ]);

  const csv = service.exportCsv(state, {
    metricIds: ["refresh.count"],
    fromDay: "2026-10-05",
    toDay: "2026-10-05"
  });
  assert.match(csv, /"Refresh, ""count"""/);
  assert.match(csv, /refresh\.count,"Refresh, ""count""",COUNT,TOTAL,1,1,0/);
  assert.doesNotMatch(csv, /private-generator-id|other-private-id|must-not-export/);
});

test("A018-02 changed metric semantics fence old projection state and require replay", async () => {
  const harness = makeAuditHarness(["2026-10-05T10:00:00.000Z"]);
  const first = createStatisticsService({ journal: harness.journal, definitions: DEFINITIONS });
  await harness.append({ type: "generator.refresh", data: { durationMs: 2 } });
  const state = await first.rebuild();

  const changed = DEFINITIONS.map((definition) => ({ ...definition }));
  changed[0] = { ...changed[0], eventType: "generator.other" };
  const second = createStatisticsService({ journal: harness.journal, definitions: changed });

  assert.throws(
    () => second.view(state),
    (error) => error?.code === STATISTICS_ERROR_CODES.CORRUPT_STATE
  );
  const rebuilt = await second.rebuild();
  assert.equal(rebuilt.metrics[0].value, 0);
});

test("A018-02 sequence gaps and invalid SUM values fail closed instead of silently skewing metrics", async () => {
  const gapJournal = Object.freeze({
    async read() {
      return {
        events: [auditEvent(2, { type: "generator.refresh", data: { durationMs: 1 } })],
        lastSequence: 2,
        hasMore: false
      };
    }
  });
  const gapService = createStatisticsService({ journal: gapJournal, definitions: DEFINITIONS });
  await assert.rejects(
    gapService.rebuild(),
    (error) => error?.code === STATISTICS_ERROR_CODES.CURSOR_GAP
  );

  const harness = makeAuditHarness(["2026-10-05T10:00:00.000Z"]);
  const sumService = createStatisticsService({ journal: harness.journal, definitions: DEFINITIONS });
  await harness.append({ type: "generator.refresh", data: { durationMs: "not-a-number" } });
  await assert.rejects(
    sumService.rebuild(),
    (error) => error?.code === STATISTICS_ERROR_CODES.INVALID_EVENT
  );
});

test("A018-02 inconsistent journal pagination metadata fails closed", async () => {
  const journal = Object.freeze({
    async read() {
      return { events: [], lastSequence: 1, hasMore: true };
    }
  });
  const service = createStatisticsService({ journal, definitions: DEFINITIONS });
  await assert.rejects(
    service.rebuild(),
    (error) => error?.code === STATISTICS_ERROR_CODES.JOURNAL_UNAVAILABLE
  );
});

test("A018-01/A018-03 definitions and view filters reject ambiguous input", () => {
  const journal = Object.freeze({ async read() { return { events: [], lastSequence: 0, hasMore: false }; } });
  assert.throws(
    () => createStatisticsService({
      journal,
      definitions: [{ metricId: "x", label: "X", eventType: "x.event", aggregation: "COUNT", valuePath: ["n"] }]
    }),
    (error) => error?.code === STATISTICS_ERROR_CODES.INVALID_DEFINITION
  );

  const service = createStatisticsService({ journal, definitions: DEFINITIONS });
  const state = service.createEmptyState();
  assert.throws(
    () => service.view(state, { fromDay: "2026-02-31" }),
    (error) => error?.code === STATISTICS_ERROR_CODES.INVALID_ARGUMENT
  );
  assert.throws(
    () => service.view(state, { metricIds: ["unknown.metric"] }),
    (error) => error?.code === STATISTICS_ERROR_CODES.INVALID_ARGUMENT
  );
});
