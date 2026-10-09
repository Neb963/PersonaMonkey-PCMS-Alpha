// A033-02 SEC/U: risky module actions are confirmed by Core-rendered dialogs, Core repeats
// the confirmation and recovery-hold checks, and a module-UI frame can only *request*
// its own module's declared actions, reads, EntityRef navigation and a bounded size.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPcmsModuleActionRunner, pcmsActionConfirmation } from "../../../extension/pcms/app/module-actions.js";
import { createPcmsModuleFrameRequestHandler } from "../../../extension/pcms/app/module-frame-host.js";
import { BOARD_ID, SHELF_ID, buildBoardArchiveText, createShelfContribution } from "./fixtures.mjs";
import { byId, makeWorld, openContext } from "./harness.mjs";

async function installBoard(core) {
  const staged = await core.modules.install(buildBoardArchiveText());
  return core.modules.approve(BOARD_ID, staged.candidate.packageHash);
}

test("A033-02 SEC Core refuses unconfirmed risky executes, undeclared actions, bad targets and bad input", async (t) => {
  const world = makeWorld();
  const shelf = createShelfContribution();
  const ctx = await openContext(world, { shelf });
  t.after(() => ctx.unload());
  await installBoard(ctx.core);

  await assert.rejects(ctx.ui.invoke(SHELF_ID, "empty", null, null, {}), (error) => error.code === "PCMS_UI_CONFIRMATION_REQUIRED");
  await assert.rejects(ctx.ui.invoke(BOARD_ID, "reset", null, null, { confirmed: false }), (error) => error.code === "PCMS_UI_CONFIRMATION_REQUIRED");
  assert.deepEqual(shelf.calls, [], "the module was never called");
  await assert.rejects(ctx.ui.invoke(SHELF_ID, "drop-table", null, null, {}), (error) => error.code === "PCMS_UI_ACTION_UNKNOWN");
  await assert.rejects(ctx.ui.invoke(SHELF_ID, "assign", { kind: "generator", id: "g1" }, { slot: 1 }, { confirmed: true }), /target/);
  await assert.rejects(ctx.ui.invoke(SHELF_ID, "assign", { kind: "account", id: "alice" }, { slot: 99 }, { confirmed: true }), /out of bounds/);
  await assert.rejects(ctx.ui.invoke(SHELF_ID, "restock", null, null, { idempotencyKey: "short" }), /idempotencyKey/);
  await assert.rejects(ctx.ui.preview(SHELF_ID, "restock", null, null), /no preview/);
  assert.deepEqual(shelf.calls, []);

  const restocked = await ctx.ui.invoke(SHELF_ID, "restock", null, null, { idempotencyKey: "restock-0001" });
  assert.equal(restocked.status.token, "OK", "LOCAL actions need no confirmation");
  const assigned = await ctx.ui.invoke(SHELF_ID, "assign", { kind: "account", id: "alice" }, { slot: 2 }, { confirmed: true, idempotencyKey: "assign-0001" });
  assert.equal(assigned.message, "assign done");
  assert.deepEqual(shelf.calls.map((call) => [call.actionId, call.target, call.input, call.options.mode]), [
    ["restock", { kind: "module", id: SHELF_ID }, null, "execute"],
    ["assign", { kind: "account", id: "alice" }, { slot: 2 }, "execute"]
  ]);

  const actions = await ctx.auditJournal.read({ afterSequence: 0, limit: 500 });
  const recorded = actions.events.filter((event) => event.type === "module.ui.action").map((event) => [event.subject.id, event.data.actionId, event.data.confirmed]);
  assert.deepEqual(recorded, [[SHELF_ID, "restock", false], [SHELF_ID, "assign", true]]);
});

test("A033-02 SEC recovery hold blocks risky module actions in Core before the module is called", async (t) => {
  const world = makeWorld();
  const shelf = createShelfContribution();
  const ctx = await openContext(world, { shelf });
  t.after(() => ctx.unload());
  await ctx.core.recoveryHold.enterRecoveryHold({ reason: "p033-test" });
  const view = byId(await ctx.ui.snapshot(), SHELF_ID);
  assert.equal(view.presentation.state, "HELD");
  assert.deepEqual(view.actions.map((action) => [action.id, action.held]), [["restock", false], ["empty", true], ["assign", true]]);
  await assert.rejects(ctx.ui.invoke(SHELF_ID, "empty", null, null, { confirmed: true }), (error) => error.code === "PCMS_UI_RECOVERY_HOLD");
  assert.deepEqual(shelf.calls, []);
});

test("A033-02 the dashboard previews, shows the Core dialog, and executes only after confirmation", async () => {
  const sent = [];
  let answer = false;
  const dialogs = [];
  const runtime = { ui: {
    async preview(...args) { sent.push(["preview", ...args]); return { impact: { title: "Reset the board?", consequences: ["All 2 cards are removed."], confirmLabel: "Reset board", excluded: [] } }; },
    async invoke(...args) { sent.push(["invoke", ...args]); return { status: { token: "OK", label: "Reset" }, message: "Board reset." }; }
  } };
  const runner = createPcmsModuleActionRunner({ runtime, confirm: async (model) => { dialogs.push(model); return answer; }, newKey: () => "uia-fixed-key-0001" });
  const module = { moduleId: BOARD_ID, title: "Fixture board" };
  const reset = { id: "reset", label: "Reset board", risk: "DESTRUCTIVE", confirm: true, preview: true, held: false };

  const cancelled = await runner.run({ module, action: reset });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(sent.map((entry) => entry[0]), ["preview"], "cancel never executes");
  assert.deepEqual(dialogs[0], pcmsActionConfirmation("Fixture board", reset, { title: "Reset the board?", consequences: ["All 2 cards are removed."], confirmLabel: "Reset board", excluded: [] }));

  answer = true;
  const done = await runner.run({ module, action: reset });
  assert.equal(done.message, "Board reset.");
  assert.deepEqual(sent.at(-1), ["invoke", BOARD_ID, "reset", null, null, { idempotencyKey: "uia-fixed-key-0001", confirmed: true }]);

  // Risky without a preview still gets the Core dialog with Core wording.
  const bind = { id: "assign", label: "Assign account", risk: "BINDING", confirm: true, preview: false, held: false };
  answer = false;
  assert.equal((await runner.run({ module, action: bind, target: { kind: "account", id: "a" } })).cancelled, true);
  assert.match(dialogs.at(-1).consequences[0], /Persona or account/);

  // LOCAL runs without a dialog; a held action never reaches Core.
  const before = dialogs.length;
  await runner.run({ module, action: { id: "pin", label: "Pin", risk: "LOCAL", confirm: false, preview: false, held: false } });
  assert.equal(dialogs.length, before);
  const calls = sent.length;
  await assert.rejects(runner.run({ module, action: { ...reset, held: true } }), (error) => error.code === "PCMS_UI_RECOVERY_HOLD");
  assert.equal(sent.length, calls);
});

test("A033-02 SEC frame requests are validated and scoped to the frame's own module", async () => {
  const calls = [];
  const runtime = { ui: {
    async listRows(...args) { calls.push(["listRows", ...args]); return { rows: [], next: null }; },
    async getDetail(...args) { calls.push(["getDetail", ...args]); return { title: "x", sections: [] }; }
  } };
  const ran = [];
  const navigated = [];
  const sizes = [];
  const handle = createPcmsModuleFrameRequestHandler({
    runtime,
    frameInfo: { moduleId: BOARD_ID, title: "Fixture board", actions: [{ id: "reset", label: "Reset", risk: "DESTRUCTIVE", confirm: true }] },
    runAction: async (request) => { ran.push(request); return { cancelled: false, status: { token: "OK", label: "ok" }, message: "done", download: { text: "secret-ish" } }; },
    navigate: (href) => navigated.push(href),
    resize: (height) => sizes.push(height)
  });
  const request = (method, params, extra = {}) => handle({ version: 1, sessionId: "s", type: "request", requestId: "r1", method, params, ...extra });

  assert.equal((await request("listRows", { view: "cards" })).ok, true);
  assert.deepEqual(calls[0], ["listRows", BOARD_ID, "cards", null]);
  const crossModule = await request("listRows", { view: "cards", moduleId: "statistics" });
  assert.equal(crossModule.ok, false, "a frame cannot name another module");
  assert.equal(calls.length, 1);

  const undeclared = await request("invoke", { actionId: "export" });
  assert.deepEqual([undeclared.ok, undeclared.error.code], [false, "PCMS_UI_ACTION_UNKNOWN"]);
  const invoked = await request("invoke", { actionId: "reset" });
  assert.deepEqual(invoked.result, { cancelled: false, status: { token: "OK", label: "ok" }, message: "done", subject: null }, "only status text crosses back into the frame");
  assert.equal(ran[0].action.confirm, true, "risky frame requests go through the Core-dialog runner");
  assert.equal(ran[0].module.moduleId, BOARD_ID);

  assert.equal((await request("navigate", { entity: { kind: "account", id: "alice" } })).result.href, "#/accounts/alice");
  assert.equal((await request("navigate", { entity: { kind: "url", id: "https://evil.example" } })).ok, false);
  assert.equal((await request("navigate", { href: "javascript:alert(1)" })).ok, false);
  assert.deepEqual(navigated, ["#/accounts/alice"]);
  await request("resize", { height: 99999 });
  await request("resize", { height: 10 });
  assert.deepEqual(sizes, [4000, 120]);

  assert.equal(await request("eval", {}), null, "unknown methods are ignored");
  assert.equal(await handle({ type: "request", requestId: "r", method: "listRows", params: { view: "x" } }), null, "malformed envelopes are ignored");
  assert.equal(await request("listRows", { view: "x" }, { requestId: "<script>" }), null);
});

test("A033-02 SEC the module-UI page and frame host give module code no extension, network or DOM authority", async () => {
  const [page, script, host, manifestText, css] = await Promise.all([
    readFile("extension/pcms/sandbox/module-ui.html", "utf8"),
    readFile("extension/pcms/sandbox/module-ui.js", "utf8"),
    readFile("extension/pcms/app/module-frame-host.js", "utf8"),
    readFile("extension/manifest.json", "utf8"),
    readFile("extension/pcms/sandbox/module-ui.css", "utf8")
  ]);
  const manifest = JSON.parse(manifestText);
  assert.ok(manifest.sandbox.pages.includes("pcms/sandbox/module-ui.html"), "declared sandbox page (opaque origin)");
  const csp = manifest.content_security_policy.sandbox;
  for (const directive of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
  assert.doesNotMatch(script, /\bbrowser\s*\.|\bchrome\s*\.|indexedDB|innerHTML|outerHTML|insertAdjacentHTML|document\.write|fetch\s*\(|XMLHttpRequest|WebSocket|importScripts/);
  assert.match(script, /event\.source !== window\.parent/, "bootstraps only from the embedding dashboard");
  assert.doesNotMatch(css, /@import|url\(/);
  // The host embeds only the declared page, with allow-scripts and nothing else, and fails closed.
  assert.match(host, /setAttribute\("sandbox","allow-scripts"\)/);
  assert.doesNotMatch(host, /allow-same-origin|allow-top-navigation|allow-popups/);
  assert.match(host, /frame\.contentDocument/);
  assert.match(host, /PCMS_MODULE_UI_PAGE="\.\.\/sandbox\/module-ui\.html"/);
  assert.doesNotMatch(page, /<(?:iframe|form|object|embed|base)\b/i);
});
