// T033.3 packaged proof (A033-01/02/03 FDE/PKG) in the exact pinned Developer Edition.
//
// The product XPI is installed once. The Statistics built-in pilot and a runtime fixture
// module (built here at run time with a random nonce, so it cannot be in the XPI) are driven
// only through the PCMS UI client protocol, and observed only in the real dashboard DOM:
// 1. both appear in navigation and Overview; the runtime module's entries appear in Search;
// 2. its page runs in the sandboxed module-UI frame (opaque origin, no extension API, no
//    network) and its DESTRUCTIVE request is confirmed by the Core dialog outside the frame;
// 3. with zero PCMS tabs and the event page unloaded, a reopened dashboard still shows the
//    module from Core's published cache without waking it;
// 4. failed, disabled, incompatible, removed and purged states degrade gracefully.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { execFileText, loadBrowserPin, sha256File, writeJson } from "../../../tools/firefox/lib.mjs";
import { PackagedFirefox, waitFor } from "../../../tools/firefox/packaged-harness.mjs";
import { BOARD_ID, buildBoardArchiveText } from "./fixtures.mjs";

const PRODUCT = "persona-route-manager@local";
const DATA_NAMESPACE = "module." + BOARD_ID + ".data";
const root = resolve(process.env.FIREFOX_PACKAGED_DIR || join(tmpdir(), "pcms-firefox-p033"));
const reportPath = resolve(process.env.FIREFOX_P033_REPORT || join(root, "p033-report.json"));
const pin = await loadBrowserPin();
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const xpi = resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report = {
  schemaVersion: 1,
  phase: "P033",
  commitSha: process.env.GITHUB_SHA || (await execFileText("git", ["rev-parse", "HEAD"])).stdout.trim(),
  workflowRun: process.env.GITHUB_RUN_ID || null,
  version: pin.version,
  artifactSha256: pin.archive.sha256,
  productXpiSha256: await sha256File(xpi),
  checks: {},
  facts: {}
};

let h;
let tab = null;
let sequence = 0;

async function page(code, args = []) {
  const result = await h.pageScript(`const done = arguments[arguments.length - 1];
    (async () => { const api = window.wrappedJSObject.browser; ${code} })()
      .then(value => done({ ok: true, value: JSON.parse(JSON.stringify(value ?? null)) }),
        error => done({ ok: false, error: String(error && error.stack || error) }));`, args, { async: true });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function ui(name, args = [], kind = "command") {
  const id = "p033-" + (++sequence) + "-" + Date.now();
  const response = await page(`
    const [name, args, kind, id] = [arguments[0], arguments[1], arguments[2], arguments[3]];
    const message = { type: "PCMS_UI_REQUEST", version: 1, requestId: id, kind, name, params: { args } };
    if (kind === "command") message.idempotencyKey = id;
    return api.runtime.sendMessage(message);`, [name, args, kind, id]);
  if (!response?.ok) {
    const error = new Error((response?.error?.code || "PCMS_UI_FAILED") + ": " + (response?.error?.message || name));
    error.code = response?.error?.code;
    throw error;
  }
  return response.result;
}

async function moduleData() {
  const result = await ui("backupRestore.createBackup", [{ backupId: "p033-probe-" + Date.now() + "-" + (++sequence) }]);
  return Object.fromEntries(result.records.filter((record) => record.namespace === DATA_NAMESPACE)
    .map((record) => [record.key, record.value]));
}

async function openDashboard() {
  tab = await h.openPage(PRODUCT, "pcms/app/index.html");
  await waitFor(() => h.pageScript('return document.getElementById("brokerLiveStatus")?.dataset.state==="connected";'),
    "packaged P033 dashboard connects", 30000);
  return tab;
}
async function closeDashboard() { if (tab) await h.closePage(tab); tab = null; }

async function go(hash) {
  await h.pageScript("location.hash = arguments[0]; return true;", [hash]);
}

// One DOM read of everything the checks look at.
async function dom() {
  return h.pageScript(`
    const text = (selector) => document.querySelector(selector)?.textContent ?? null;
    const navLink = document.querySelector('#primaryNav a[data-module-id="${BOARD_ID}"]');
    const frame = document.querySelector("#moduleFrameContainer iframe");
    const dialog = document.getElementById("moduleConfirmDialog");
    return {
      hash: location.hash,
      revision: document.body.dataset.pcmsRevision || null,
      contributions: document.body.dataset.pcmsContributions || null,
      navModules: [...document.querySelectorAll("#primaryNav a[data-module-id]")].map((a) => a.dataset.moduleId),
      boardNav: navLink ? { label: navLink.firstChild?.textContent ?? navLink.textContent, greyed: navLink.dataset.greyed === "true",
        dot: navLink.querySelector(".nav-dot")?.dataset.token ?? null } : null,
      statisticsNav: Boolean(document.querySelector('#primaryNav a[data-module-id="statistics"]')),
      cards: [...document.querySelectorAll("#overviewModuleCards [data-module-id]")].map((card) => ({
        moduleId: card.dataset.moduleId, headline: card.querySelector(".module-card-headline")?.textContent ?? null })),
      searchResults: [...document.querySelectorAll("#searchResults a")].map((a) => a.getAttribute("href")),
      conditions: [...document.querySelectorAll("#attentionConditions [data-condition-key]")].map((a) => a.dataset.conditionKey),
      pageVisible: document.getElementById("viewModulePage")?.hidden === false,
      pageModule: document.getElementById("viewModulePage")?.dataset.moduleId ?? null,
      pageState: document.getElementById("viewModulePage")?.dataset.state ?? null,
      pageMessage: text("#viewModulePage [data-page-message]"),
      banner: text("#viewModulePage .module-banner"),
      frame: frame ? {
        sandbox: frame.getAttribute("sandbox"),
        src: frame.getAttribute("src"),
        contentDocumentNull: frame.contentDocument === null,
        height: frame.getAttribute("height"),
        state: document.getElementById("moduleFrameContainer").dataset.frameState ?? null,
        isolated: document.getElementById("moduleFrameContainer").dataset.frameIsolated ?? null,
        requests: Number(document.getElementById("moduleFrameContainer").dataset.frameRequests || 0)
      } : null,
      dialog: dialog ? { state: dialog.dataset.state, risk: dialog.dataset.risk ?? null, hidden: dialog.hidden,
        title: text("#moduleConfirmTitle"), consequences: text("#moduleConfirmConsequences"), accept: text("#moduleConfirmAccept"),
        insideFrame: Boolean(dialog.closest("#moduleFrameContainer")) } : null,
      notification: text("#notificationStatus"),
      moduleReceipts: [...document.querySelectorAll("#actionTrayLocalList [data-module-action]")].map((row) => row.dataset.moduleAction + "=" + row.dataset.outcome),
      settingsRow: document.querySelector('#contributedModuleList [data-module-id="${BOARD_ID}"]')?.dataset.state ?? null
    };`);
}

async function until(predicate, label, timeout = 30000) {
  let last = null;
  try {
    return await waitFor(async () => { last = await dom(); return predicate(last) ? last : null; }, label, timeout);
  } catch (error) {
    error.message += " · last DOM " + JSON.stringify(last);
    throw error;
  }
}

async function installBoard(options) {
  const staged = await ui("modules.install", [buildBoardArchiveText(options)]);
  if (staged.status !== "AWAITING_APPROVAL") return staged;
  return ui("modules.approve", [BOARD_ID, staged.candidate.packageHash]);
}

try {
  await mkdir(root, { recursive: true });
  h = await PackagedFirefox.create({ root: join(root, "profiles-p033") });
  await h.start();
  assert.equal(await h.install(xpi), PRODUCT);
  await openDashboard();

  // A033-01: the shipped built-in pilot contributes through the contract.
  let state = await until((d) => d.statisticsNav && d.cards.some((card) => card.moduleId === "statistics"), "Statistics contributes nav and Overview");
  report.facts.builtIn = { nav: state.navModules, statisticsCard: state.cards.find((card) => card.moduleId === "statistics") };

  // A033-01: a runtime module installed at run time appears in nav, Overview and Search.
  const nonce = randomBytes(16).toString("hex");
  const tag = nonce.slice(0, 8);
  const v1 = await installBoard({ version: "1.0.0", nonce });
  assert.equal(v1.status, "ACTIVE");
  state = await until((d) => d.boardNav && d.cards.some((card) => card.moduleId === BOARD_ID), "runtime module in nav and Overview");
  assert.equal(state.boardNav.label, "Board");
  assert.equal(state.boardNav.dot, "WARNING");
  assert.equal(state.cards.find((card) => card.moduleId === BOARD_ID).headline, "2 cards · board " + tag);
  await go("#/search?q=" + nonce);
  state = await until((d) => d.searchResults.includes("#/m/fixture.board/card/alpha"), "runtime module search entries");
  await go("#/attention");
  state = await until((d) => d.conditions.includes(BOARD_ID + ":review"), "runtime module condition in Attention");
  report.facts.runtime = { nav: state.navModules, generation: v1.generation };
  report.checks.builtInAndRuntimeInNavOverviewSearch = true;

  // A033-02: the module page runs in the sandboxed module-UI frame; its DESTRUCTIVE request is
  // confirmed by the Core-rendered dialog outside the frame.
  assert.equal((await moduleData()).board, undefined, "nothing reset yet");
  await go("#/m/" + BOARD_ID);
  state = await until((d) => d.dialog?.state === "open", "Core confirmation dialog for the frame's reset request", 45000);
  assert.equal(state.frame.sandbox, "allow-scripts");
  assert.ok(state.frame.src.endsWith("../sandbox/module-ui.html") || state.frame.src.endsWith("/pcms/sandbox/module-ui.html"), state.frame.src);
  assert.equal(state.frame.contentDocumentNull, true, "the dashboard cannot reach the module page document");
  assert.equal(state.frame.isolated, "true");
  assert.equal(state.frame.height, "360", "bounded resize request honoured");
  assert.equal(state.dialog.title, "Reset the fixture board?");
  assert.equal(state.dialog.risk, "DESTRUCTIVE");
  assert.equal(state.dialog.insideFrame, false);
  assert.match(state.dialog.consequences, /All 2 cards are removed/);
  let data = await moduleData();
  assert.equal(data.board, undefined, "the reset has not executed while the dialog is open");
  const probe = data["ui-probe"].facts;
  assert.equal(probe.moduleId, BOARD_ID);
  assert.equal(probe.browserAbsent, true, "no WebExtension API in the module page");
  assert.equal(probe.chromeAbsent, true);
  assert.equal(probe.origin, "null", "opaque origin");
  assert.equal(probe.parentDocumentReadable, false, "no access to the dashboard DOM");
  assert.ok(["blocked", "no-fetch"].includes(probe.network), "no network: " + probe.network);
  assert.equal(probe.undeclaredActionRejected, true);
  assert.equal(probe.rowsRead, 2);
  report.facts.frame = { ...state.frame, probe };
  await h.pageScript('document.getElementById("moduleConfirmAccept").click(); return true;');
  data = await waitFor(async () => { const rows = await moduleData(); return rows.board?.resets === 1 ? rows : null; }, "confirmed reset executes", 20000);
  assert.deepEqual(data.board.cards, []);
  state = await until((d) => d.dialog?.state === "closed" && d.moduleReceipts.includes(BOARD_ID + ":reset=OK"), "receipt shown in the action tray");
  report.checks.sandboxedModulePageNoExtensionApiNoNetwork = true;
  report.checks.riskyActionConfirmedByCoreDialog = true;

  // A033-03: with zero PCMS tabs and the event page unloaded, a reopened dashboard is served
  // from Core's published cache without waking the module.
  await closeDashboard();
  report.unload = await h.forceIdleUnload(PRODUCT);
  assert.equal(report.unload.state, "stopped");
  await openDashboard();
  state = await until((d) => d.boardNav && d.cards.find((card) => card.moduleId === BOARD_ID)?.headline === "0 cards · board " + tag,
    "reopened dashboard shows the unloaded module from cache");
  const asleep = await ui("modules.get", [BOARD_ID], "query");
  assert.equal(asleep.running, false, "rendering nav and Overview did not activate the module");
  report.facts.unloaded = { running: asleep.running, status: asleep.status };
  report.checks.dashboardsWorkWhileModulesUnloaded = true;

  // A033-03: a failed update keeps the last-known-good UI and says so; cancel never executes.
  await assert.rejects(installBoard({ version: "1.1.0", nonce, variant: "fail-start" }), /ACTIVATION_FAILED|activation/i);
  await go("#/m/" + BOARD_ID);
  state = await until((d) => d.pageModule === BOARD_ID && /running 1\.0\.0/.test(d.banner || ""), "failed-update banner");
  report.facts.failed = { banner: state.banner, settings: state.settingsRow };
  state = await until((d) => d.dialog?.state === "open", "frame requests reset again", 45000);
  await h.pageScript('document.getElementById("moduleConfirmCancel").click(); return true;');
  await until((d) => d.dialog?.state === "closed" && d.moduleReceipts.includes(BOARD_ID + ":reset=CANCELLED"), "cancel acknowledged");
  assert.equal((await moduleData()).board.resets, 1, "cancel executed nothing");
  report.checks.failedUpdateKeepsLastKnownGood = true;
  report.checks.cancelledConfirmationExecutesNothing = true;

  // A033-03: disabled — hidden from nav, the deep link explains instead of breaking.
  await go("#/overview");
  await ui("modules.disable", [BOARD_ID]);
  await go("#/m/" + BOARD_ID);
  state = await until((d) => !d.boardNav && d.pageMessage === "Module disabled · Enable in Settings", "disabled module page");
  assert.equal(state.settingsRow, "Disabled");
  await ui("modules.enable", [BOARD_ID]);
  await go("#/overview");
  await until((d) => d.boardNav !== null, "enabled module returns to nav");
  report.checks.disabledHiddenAndExplained = true;

  // A033-03: incompatible — a working module publishing an unsupported contract is greyed out.
  const future = await installBoard({ version: "2.0.0", nonce, variant: "future-contract" });
  assert.equal(future.status, "ACTIVE");
  await go("#/m/" + BOARD_ID);
  state = await until((d) => d.boardNav?.greyed === true && d.pageMessage === "Needs a newer PCMS (contract v2)", "incompatible module page");
  report.checks.incompatibleGreyedOut = true;

  // A033-03: removed and purged.
  await go("#/overview");
  await ui("modules.remove", [BOARD_ID]);
  await go("#/m/" + BOARD_ID);
  state = await until((d) => !d.boardNav && /^Module removed/.test(d.pageMessage || ""), "removed module page");
  await go("#/overview");
  assert.equal((await ui("modules.purge", [BOARD_ID])).purged, true);
  await go("#/m/" + BOARD_ID);
  state = await until((d) => !d.boardNav && d.pageMessage === "This module isn't installed", "purged module deep link stays safe");
  assert.equal(state.statisticsNav, true, "the rest of the shell keeps working");
  report.checks.removedAndPurgedDegradeGracefully = true;

  await closeDashboard();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack || error);
  throw error;
} finally {
  await h?.stop();
  await writeJson(reportPath, report);
  if (h) await rm(h.profilePath, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
