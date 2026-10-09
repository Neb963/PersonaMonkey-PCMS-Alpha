// A033-03 U/I: disabled, updating, failed, incompatible and removed modules degrade
// gracefully, and dashboards keep working while modules are unloaded (03 §6).
import assert from "node:assert/strict";
import test from "node:test";

import {
  contributionNavItems,
  humanTaskModuleState,
  modulePageModel,
  modulePageRenderKey,
  routableModuleIds,
  overviewModuleCards
} from "../../../extension/pcms/app/contributions.js";
import { resolvePcmsRouteV2 } from "../../../extension/pcms/app/router-v2.js";
import { PCMS_UI_PRESENTATION as P, createPcmsUiContributionHost } from "../../../extension/pcms/integration/ui-contributions.js";
import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";
import { makeMemoryBackend } from "../p023/harness.mjs";
import { BOARD_ID, SHELF_ID, buildBoardArchiveText, createShelfContribution } from "./fixtures.mjs";
import { UNAVAILABLE, byId, makeWorld, openContext } from "./harness.mjs";

async function installBoard(core, options = {}) {
  const staged = await core.modules.install(buildBoardArchiveText(options));
  return staged.status === "AWAITING_APPROVAL" ? core.modules.approve(BOARD_ID, staged.candidate.packageHash) : staged;
}

const page = (snapshot, moduleId = BOARD_ID) => modulePageModel(snapshot, { moduleId, view: null, objectId: null });

test("A033-03 U every 03 §6 presentation state is computed from lifecycle, runtime and validation", async () => {
  const storageBroker = createPcmsStorageBroker({ backend: makeMemoryBackend({ rows: new Map() }), clock: () => "2026-10-08T12:00:00.000Z" });
  let described;
  let support = { state: "AVAILABLE" };
  let hold = "NORMAL";
  const host = createPcmsUiContributionHost({
    storageBroker,
    modules: { list: async () => ({ runtime: support, modules: [described] }), get: async () => described, call: async () => null },
    recoveryHold: { getStatus: async () => ({ value: { state: hold } }) }
  });
  const publish = host.capabilities["core.ui.publish"];
  const context = { moduleId: BOARD_ID, generation: 1, packageHash: "sha256:" + "a".repeat(64), assertCurrent: async () => {} };
  const good = { descriptor: { contractVersion: 1, moduleId: BOARD_ID, title: "Board", nav: { label: "Board" } },
    summary: { status: { token: "OK", label: "fine" }, headline: "ok" } };
  const base = { moduleId: BOARD_ID, installed: true, status: "ACTIVE", version: "1.0.0", activePackageHash: context.packageHash,
    candidate: null, runtimeState: "ACTIVE", generation: 1, running: true, failures: 0, reason: null };
  const state = async () => {
    const view = byId(await host.api.snapshot(), BOARD_ID);
    return [view.presentation.state, Boolean(view.nav), view.presentation.included, view.nav?.greyed ?? null];
  };

  described = { ...base };
  assert.deepEqual(await state(), [P.AWAITING_UI, true, false, false], "nothing published yet");
  assert.deepEqual(await publish(good, context), { ok: true, generation: 1 });
  assert.deepEqual(await state(), [P.ACTIVE, true, true, false]);
  described = { ...base, candidate: { state: "AWAITING_APPROVAL", version: "1.1.0" } };
  assert.deepEqual(await state(), [P.UPDATE_AWAITS_APPROVAL, true, true, false]);
  described = { ...base, runtimeState: "DRAINING" };
  assert.deepEqual(await state(), [P.UPDATING, true, false, false], "contributions omitted while draining");
  described = { ...base, status: "UNAVAILABLE", failures: 2, reason: "PCMS_MODULE_LIFECYCLE_ACTIVATION_FAILED" };
  assert.deepEqual(await state(), [P.FAILED, true, true, false], "last-known-good contributions keep showing");
  described = { ...base, status: "DISABLED", runtimeState: "DISABLED" };
  assert.deepEqual(await state(), [P.DISABLED, false, false, null]);
  described = { ...base, status: "REMOVED", runtimeState: "DISABLED" };
  assert.deepEqual(await state(), [P.REMOVED, false, false, null]);
  described = { ...base, status: "AWAITING_APPROVAL", activePackageHash: null };
  assert.deepEqual(await state(), [P.INSTALLING, false, false, null]);
  described = { ...base };
  hold = "RECOVERY_HOLD";
  assert.deepEqual(await state(), [P.HELD, true, true, false]);
  hold = "NORMAL";
  support = { state: "UNAVAILABLE" };
  assert.deepEqual(await state(), [P.UNSUPPORTED, false, false, null]);
  support = { state: "AVAILABLE" };

  // Incompatible: a future contract version and an invalid descriptor are both stored as markers.
  assert.equal((await publish({ descriptor: { contractVersion: 2, moduleId: BOARD_ID, title: "Future" } }, context)).code, "PCMS_UI_CONTRIBUTION_UNSUPPORTED");
  assert.deepEqual(await state(), [P.INCOMPATIBLE, true, false, true]);
  assert.equal(page(await host.api.snapshot()).message, "Needs a newer PCMS (contract v2)");
  assert.equal((await publish({ descriptor: { ...good.descriptor, script: "x" } }, context)).code, "PCMS_UI_CONTRIBUTION_INVALID");
  assert.match(page(await host.api.snapshot()).message, /Module UI is invalid/);

  // A publish from an older package never shows for the new one (generation change).
  await publish(good, context);
  described = { ...base, activePackageHash: "sha256:" + "b".repeat(64) };
  assert.deepEqual(await state(), [P.AWAITING_UI, true, false, false]);
});

test("A033-03 I disabled, removed and purged runtime modules leave the shell safe and explain themselves", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world, { shelf: createShelfContribution() });
  t.after(() => ctx.unload());
  await installBoard(ctx.core);
  await ctx.core.humanTasks.open({ taskId: "board-review", taskKind: "test.board", title: "Look at the board", instructions: "", priority: "NORMAL", subjectRef: { kind: "module", id: BOARD_ID } });

  const activeRoute = { href: "#/m/" + BOARD_ID, moduleId: BOARD_ID, view: null, objectId: null };
  const activeKey = modulePageRenderKey(activeRoute, page(await ctx.ui.snapshot()), byId(await ctx.ui.snapshot(), BOARD_ID));
  await ctx.core.modules.disable(BOARD_ID);
  let snapshot = await ctx.ui.snapshot();
  // Packaged-Firefox regression: a state page (no actions) must still get a new render key.
  const disabledKey = modulePageRenderKey(activeRoute, page(snapshot), byId(snapshot, BOARD_ID));
  assert.notEqual(disabledKey, activeKey);
  assert.equal(contributionNavItems(snapshot).some((item) => item.moduleId === BOARD_ID), false, "hidden from navigation");
  assert.equal(overviewModuleCards(snapshot).some((card) => card.moduleId === BOARD_ID), false);
  assert.equal((await ctx.ui.search("boardcard", 20)).hits.length, 0, "omitted from search");
  assert.deepEqual((await ctx.ui.facets({ kind: "account", id: "alice" })).facets.map((entry) => entry.moduleId), [SHELF_ID], "omitted from facets");
  assert.deepEqual(page(snapshot), { kind: "state", moduleId: BOARD_ID, title: "Fixture board", state: P.DISABLED, token: "UNAVAILABLE", label: "Disabled", message: "Module disabled · Enable in Settings", banner: null });
  const task = (await ctx.core.humanTasks.listAttention({ limit: 10 })).find((row) => row.value.taskId === "board-review").value;
  assert.deepEqual(humanTaskModuleState(task, snapshot), { blocked: true, note: "Fixture board is disabled — enable it to act" });
  await assert.rejects(ctx.ui.invoke(BOARD_ID, "reset", null, null, { confirmed: true }), /not available/);
  assert.equal(byId(snapshot, SHELF_ID).presentation.state, P.ACTIVE, "other modules keep working");

  await ctx.core.modules.enable(BOARD_ID);
  assert.equal(byId(await ctx.ui.snapshot(), BOARD_ID).presentation.state, P.ACTIVE);

  await ctx.core.modules.remove(BOARD_ID);
  snapshot = await ctx.ui.snapshot();
  assert.equal(page(snapshot).state, P.REMOVED);
  assert.match(page(snapshot).message, /Module removed/);
  await ctx.core.modules.purge(BOARD_ID);
  snapshot = await ctx.ui.snapshot();
  assert.equal(byId(snapshot, BOARD_ID), null);
  assert.deepEqual(page(snapshot), { kind: "missing", moduleId: BOARD_ID, title: BOARD_ID, message: "This module isn't installed", banner: null });
  // Packaged-Firefox regression: the deep link resolves (no redirect to Overview).
  const resolved = resolvePcmsRouteV2("#/m/" + BOARD_ID, { moduleIds: routableModuleIds(snapshot, "#/m/" + BOARD_ID) });
  assert.deepEqual([resolved.valid, resolved.route.route, resolved.route.moduleId], [true, "module", BOARD_ID]);
  assert.equal(routableModuleIds(snapshot, "#/m/../x").includes(".."), false);
});

test("A033-03 I a failed update keeps the last-known-good UI; incompatible updates grey the module out", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world);
  t.after(() => ctx.unload());
  await installBoard(ctx.core, { version: "1.0.0", nonce: "good-nonce-12345" });

  await assert.rejects(ctx.core.modules.install(buildBoardArchiveText({ version: "1.1.0", variant: "fail-start" })), /ACTIVATION_FAILED|activation/i);
  let view = byId(await ctx.ui.snapshot(), BOARD_ID);
  assert.equal(view.presentation.state, P.FAILED);
  assert.match(view.presentation.banner, /running 1\.0\.0/);
  assert.equal(view.summary.headline, "2 cards · board good-non", "last-known-good summary is still served");
  assert.equal(view.nav.dot, "WARNING");

  // Incompatible: a working controller that publishes a future contract version.
  const future = await ctx.core.modules.install(buildBoardArchiveText({ version: "2.0.0", variant: "future-contract" }));
  assert.equal(future.status, "ACTIVE");
  view = byId(await ctx.ui.snapshot(), BOARD_ID);
  assert.equal(view.presentation.state, P.INCOMPATIBLE);
  assert.equal(view.nav.greyed, true);
  assert.equal(view.summary, null);
  assert.equal(page(await ctx.ui.snapshot()).message, "Needs a newer PCMS (contract v2)");

  await ctx.core.modules.install(buildBoardArchiveText({ version: "2.0.1", variant: "invalid-ui" }));
  assert.match(page(await ctx.ui.snapshot()).message, /Module UI is invalid/);
  assert.equal(byId(await ctx.ui.snapshot(), BOARD_ID).errorCode, "PCMS_UI_CONTRIBUTION_INVALID");

  await ctx.core.modules.install(buildBoardArchiveText({ version: "2.1.0" }));
  assert.equal(byId(await ctx.ui.snapshot(), BOARD_ID).presentation.state, P.ACTIVE, "a valid update recovers");
});

test("A033-03 I dashboards keep working while modules are unloaded; pulls rehydrate lazily", async () => {
  const world = makeWorld();
  const first = await openContext(world);
  await installBoard(first.core, { nonce: "unload-nonce-1234" });
  first.unload();

  // New background context (event-page unload): nothing runs until work addresses the module.
  const second = await openContext(world, { wake: "WARM" });
  try {
    const snapshot = await second.ui.snapshot();
    const view = byId(snapshot, BOARD_ID);
    assert.equal(second.document.created.length, 0, "the snapshot did not wake the module");
    assert.equal(view.presentation.state, P.ACTIVE);
    assert.equal(view.summary.headline, "2 cards · board unload-n");
    assert.equal((await second.ui.search("boardcard", 20)).hits.length, 2);
    assert.equal(second.document.created.length, 0, "search is served from the published cache");
    assert.equal((await second.core.modules.get(BOARD_ID)).running, false);

    const facets = await second.ui.facets({ kind: "account", id: "alice" });
    assert.equal(facets.facets[0].facet.title, "Board");
    assert.equal(second.document.created.length, 1, "an on-demand pull activated the module lazily");
  } finally {
    second.unload();
  }
});

test("A033-03 I unsupported Firefox hides runtime modules; built-ins and other pages keep working", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world, { shelf: createShelfContribution() });
  t.after(() => ctx.unload());
  await installBoard(ctx.core);
  ctx.setSupport(UNAVAILABLE);
  const snapshot = await ctx.ui.snapshot();
  assert.equal(byId(snapshot, BOARD_ID).presentation.state, P.UNSUPPORTED);
  assert.equal(page(snapshot).message, "Requires Firefox 154+");
  assert.deepEqual(contributionNavItems(snapshot).map((item) => item.moduleId), [SHELF_ID, "statistics"]);
});

test("A033-03 U one failing built-in degrades to 'unavailable' without breaking the page", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world, { shelf: createShelfContribution({ fail: "summary" }) });
  t.after(() => ctx.unload());
  const snapshot = await ctx.ui.snapshot();
  const shelf = byId(snapshot, SHELF_ID);
  assert.equal(shelf.summary, null);
  assert.equal(shelf.summaryError, "PCMS_UI_CONTRIBUTION_FAILED");
  assert.equal(shelf.nav.dot, "ERROR");
  assert.equal(overviewModuleCards(snapshot).find((card) => card.moduleId === SHELF_ID).headline, "Fixture shelf information unavailable");
  assert.ok(byId(snapshot, "statistics").summary, "Statistics still renders");
});

test("A033-03 U a hanging facet is cut off at 1.5 s and reported for that module only", async (t) => {
  const world = makeWorld();
  const ctx = await openContext(world, { shelf: createShelfContribution({ fail: "slow-facet" }) });
  t.after(() => ctx.unload());
  await installBoard(ctx.core);
  const started = Date.now();
  const facets = await ctx.ui.facets({ kind: "account", id: "alice" });
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(facets.facets.map((entry) => [entry.moduleId, entry.facet?.title ?? null, entry.error]), [
    [SHELF_ID, null, "PCMS_UI_CONTRIBUTION_TIMEOUT"],
    [BOARD_ID, "Board", null]
  ]);
});
