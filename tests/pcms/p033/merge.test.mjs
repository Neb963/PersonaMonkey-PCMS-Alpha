// A033-01 U/I: a fixture built-in module and a fixture runtime module appear in navigation,
// Overview, search and facets through the real background Core, without Core edits beyond
// the bundled-module list. Statistics is the shipped built-in pilot.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import {
  contributionNavItems,
  derivedAttention,
  mergeSearchResults,
  modulePageModel,
  overviewModuleCards,
  routableModuleIds
} from "../../../extension/pcms/app/contributions.js";
import { PCMS_BUNDLED_MODULES } from "../../../extension/pcms/integration/bundled-modules.js";
import { PCMS_UI_OPERATIONS } from "../../../extension/pcms/integration/ui-client-contract.js";
import { createPcmsUiClient } from "../../../extension/pcms/app/ui-client.js";
import { BOARD_ID, SHELF_ID, buildBoardArchiveText, createShelfContribution } from "./fixtures.mjs";
import { byId, makeWorld, openContext } from "./harness.mjs";

async function installBoard(core, options = {}) {
  const staged = await core.modules.install(buildBoardArchiveText(options));
  return staged.status === "AWAITING_APPROVAL" ? core.modules.approve(BOARD_ID, staged.candidate.packageHash) : staged;
}

test("A033-01 I built-in and runtime fixtures appear in navigation, Overview, search and facets", async (t) => {
  const world = makeWorld();
  const shelf = createShelfContribution();
  const ctx = await openContext(world, { shelf });
  t.after(() => ctx.unload());

  // Before install: only built-ins.
  let snapshot = await ctx.ui.snapshot();
  assert.deepEqual(contributionNavItems(snapshot).map((item) => item.moduleId), [SHELF_ID, "statistics"]);

  const active = await installBoard(ctx.core, { nonce: "merge-nonce-1234" });
  assert.equal(active.status, "ACTIVE");
  snapshot = await ctx.ui.snapshot();
  assert.equal(snapshot.contract, "pcms.ui-contribution/v1");

  // Navigation: ordered by the module-declared order, runtime dot from its summary token.
  const nav = contributionNavItems(snapshot);
  assert.deepEqual(nav.map((item) => [item.moduleId, item.label, item.href]), [
    [SHELF_ID, "Shelf", "#/m/fixture-shelf"],
    ["statistics", "Statistics", "#/m/statistics"],
    [BOARD_ID, "Board", "#/m/fixture.board"]
  ]);
  assert.equal(nav.find((item) => item.moduleId === BOARD_ID).dot, "WARNING");
  assert.ok(routableModuleIds(snapshot).includes(BOARD_ID));

  // Overview cards: module-supplied headline and facts, Core-chosen visuals.
  const cards = overviewModuleCards(snapshot);
  const boardCard = cards.find((card) => card.moduleId === BOARD_ID);
  assert.equal(boardCard.headline, "2 cards · board merge-no");
  assert.deepEqual(boardCard.status, { token: "WARNING", label: "Needs review" });
  assert.equal(cards.find((card) => card.moduleId === SHELF_ID).headline, "2 shelf items");
  assert.match(cards.find((card) => card.moduleId === "statistics").headline, /metric/);

  // Search: built-in in-process search, runtime published entries matched by Core.
  const boardHits = (await ctx.ui.search("boardcard", 20)).hits;
  assert.deepEqual(boardHits.map((hit) => hit.href), ["#/m/fixture.board/card/alpha", "#/m/fixture.board/card/beta"]);
  const shelfHits = (await ctx.ui.search("oak", 20)).hits;
  assert.deepEqual(shelfHits.map((hit) => [hit.moduleId, hit.title]), [[SHELF_ID, "Shelf item oak"]]);
  const merged = mergeSearchResults([{ kind: "account", id: "alice", title: "Alice", subtitle: "a", href: "#/accounts/alice", score: 0 }], boardHits);
  assert.deepEqual(merged.map((item) => item.kind), ["account", "module", "module"]);
  assert.equal((await ctx.ui.search("Attention opened", 20)).hits[0].moduleId, "statistics");

  // Facets on an Account page, in nav order; the runtime facet is pulled on demand.
  const facets = await ctx.ui.facets({ kind: "account", id: "alice" });
  assert.deepEqual(facets.facets.map((entry) => [entry.moduleId, entry.facet.title, entry.facet.actions]), [
    [SHELF_ID, "Shelf", ["assign"]],
    [BOARD_ID, "Board", ["pin"]]
  ]);

  // Derived Attention (conditions) from both kinds, never stored as HumanTasks.
  assert.deepEqual(derivedAttention(snapshot).map((item) => item.key), ["fixture.board:review", "fixture-shelf:low-stock"]);
  const tasks = await ctx.core.humanTasks.listAttention({ limit: 100 });
  assert.equal(tasks.some((row) => /review|low-stock/.test(row.value.taskId)), false);
});

test("A033-01 I module pages: declarative views for built-ins, a frame page for the runtime module", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world, { shelf: createShelfContribution() });
  t.after(() => ctx.unload());
  await installBoard(ctx.core);
  const snapshot = await ctx.ui.snapshot();

  const shelfPage = modulePageModel(snapshot, { moduleId: SHELF_ID, view: null, objectId: null });
  assert.equal(shelfPage.kind, "page");
  assert.equal(shelfPage.view.id, "items");
  const rows = await ctx.ui.listRows(SHELF_ID, "items", null);
  assert.deepEqual(rows.rows.map((row) => row.cells.name), ["oak", "pine"]);
  const detail = await ctx.ui.getDetail(SHELF_ID, "item", "oak");
  assert.equal(detail.title, "Item oak");
  await assert.rejects(ctx.ui.listRows(SHELF_ID, "undeclared", null), /not declared/);

  const boardPage = modulePageModel(snapshot, { moduleId: BOARD_ID, view: null, objectId: null });
  assert.equal(boardPage.kind, "frame");
  const frame = await ctx.ui.frame(BOARD_ID);
  assert.equal(frame.moduleId, BOARD_ID);
  assert.match(frame.source, /^\(ui\) =>/);
  // The frame's action specs carry preview/confirm so the dashboard runner previews and confirms.
  assert.deepEqual(frame.actions.map((action) => [action.id, action.confirm, action.preview]), [["record-probe", false, false], ["reset", true, true], ["pin", false, false]]);
  await assert.rejects(ctx.ui.frame(SHELF_ID), /no page frame/, "built-ins never get a frame");
});

test("A033-01 Statistics is the shipped built-in pilot: summary, metric rows, detail and READ export", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world);
  t.after(() => ctx.unload());
  await ctx.core.humanTasks.open({ taskId: "p033-stat", taskKind: "test.task", title: "Count me", instructions: "", priority: "NORMAL", subjectRef: null });
  const snapshot = await ctx.ui.snapshot();
  const statistics = byId(snapshot, "statistics");
  assert.equal(statistics.kind, "builtin");
  assert.equal(statistics.nav.label, "Statistics");
  assert.match(statistics.summary.headline, /^1 metric · 1 matched events$/);
  const rows = await ctx.ui.listRows("statistics", "metrics", null);
  assert.deepEqual(rows.rows.map((row) => [row.id, row.cells.value]), [["attention_opened", 1]]);
  const detail = await ctx.ui.getDetail("statistics", "metric", "attention_opened");
  assert.equal(detail.title, "Attention opened");
  const exported = await ctx.ui.invoke("statistics", "export", null, null, { idempotencyKey: "p033-export-1" });
  assert.equal(exported.download.mediaType, "text/csv");
  assert.match(exported.download.text, /^metric_id,label,aggregation,day,value/);
});

test("A033-01 adding a built-in is one bundled-module entry; no Core file names a fixture", async () => {
  assert.deepEqual(PCMS_BUNDLED_MODULES.map((entry) => [entry.moduleId, entry.ui]), [["statistics", "/pcms-modules/p018/ui.js"]]);
  const roots = ["extension/pcms", "pcms-modules"];
  const offenders = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = dir + "/" + entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:js|html|css|json)$/.test(entry.name) && /fixture\.board|fixture-shelf/.test(await readFile(path, "utf8"))) offenders.push(path);
    }
  }
  for (const root of roots) await walk(root);
  assert.deepEqual(offenders, []);
  // Shell files carry no per-module code for contributed modules.
  const shell = (await Promise.all(["app.js", "index.html", "router-v2.js", "contributions.js", "module-view.js"]
    .map((name) => readFile("extension/pcms/app/" + name, "utf8")))).join("\n");
  assert.doesNotMatch(shell, /createUiContribution|pcms-modules\/p018|statistics\.view|exportCsv/);
});

test("A033-01 pcms.ui-client/v1 carries the ui.* merge points with query/command kinds", async () => {
  const kinds = Object.fromEntries(Object.entries(PCMS_UI_OPERATIONS).filter(([name]) => name.startsWith("ui.")).map(([name, op]) => [name, op.kind]));
  assert.deepEqual(kinds, {
    "ui.snapshot": "query", "ui.search": "query", "ui.facets": "query", "ui.listRows": "query", "ui.getDetail": "query",
    "ui.preview": "query", "ui.frame": "query", "ui.activity": "query", "ui.getSettings": "query",
    "ui.invoke": "command", "ui.setSetting": "command"
  });
  const sent = [];
  const client = createPcmsUiClient({ transport: { send: async (message) => { sent.push(message); return { ok: true, result: { modules: [] } }; }, subscribeRevision: () => () => {} } });
  await client.runtime.ui.snapshot();
  await client.runtime.ui.invoke("statistics", "export", null, null, { idempotencyKey: "abcdefgh" });
  assert.deepEqual(sent.map((message) => [message.name, message.kind, typeof message.idempotencyKey]), [["ui.snapshot", "query", "undefined"], ["ui.invoke", "command", "string"]]);
});

test("A033-01 built-in activity formatting and settings persisted in the module namespace", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world, { shelf: createShelfContribution() });
  t.after(() => ctx.unload());
  await ctx.auditJournal.append({ type: "module.event.restocked", subject: { kind: "module", id: SHELF_ID }, data: null });
  const activity = await ctx.ui.activity(10);
  assert.deepEqual(activity.lines.map((line) => [line.moduleId, line.text, line.token]), [[SHELF_ID, "Shelf restocked", "OK"]]);

  await installBoard(ctx.core);
  assert.deepEqual((await ctx.ui.getSettings(BOARD_ID)).values, { columns: 3 });
  assert.deepEqual((await ctx.ui.setSetting(BOARD_ID, "columns", 5)).values, { columns: 5 });
  await assert.rejects(ctx.ui.setSetting(BOARD_ID, "columns", 9), /out of bounds/);
  await assert.rejects(ctx.ui.setSetting(BOARD_ID, "undeclared", 1), /not declared/);
  const stored = await ctx.storageBroker.namespace("module.fixture.board.settings").get("columns");
  assert.equal(stored.value, 5);
});
