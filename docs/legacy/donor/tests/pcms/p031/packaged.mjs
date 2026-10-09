// T031.3 packaged proof (A031-01/02/03 PKG/FDE) in the exact pinned Developer Edition.
//
// The product XPI is installed once. A fixture runtime module, built here at run time with
// a random nonce (so it cannot be in the XPI), is installed and driven only through the
// PCMS UI client protocol (PCMS_UI_REQUEST from a product extension page):
// 1. install -> AWAITING_APPROVAL -> approve: its controller runs in a sandbox frame of the
//    real background document, with no rebuild, reinstall, reload or browser restart;
// 2. it sees only granted capabilities and no browser API;
// 3. with zero PCMS tabs and the event page unloaded, its declared schedule fires through
//    the Core timer service and the module is rehydrated lazily;
// 4. update activates a new generation live and the old one stops writing;
// 5. disable/enable work live; after a profile restart the module is READY (not running)
//    until its schedule fires, again with zero PCMS tabs;
// 6. rollback, remove and purge work live.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { execFileText, loadBrowserPin, sha256File, writeJson } from "../../../tools/firefox/lib.mjs";
import { PackagedFirefox, waitFor } from "../../../tools/firefox/packaged-harness.mjs";
import { FIXTURE_MODULE_ID, buildCounterArchiveText } from "../../fixtures/modules/counter.mjs";

const PRODUCT = "persona-route-manager@local";
const ID = FIXTURE_MODULE_ID;
const DATA_NAMESPACE = "module." + ID + ".data";
const root = resolve(process.env.FIREFOX_PACKAGED_DIR || join(tmpdir(), "pcms-firefox-p031"));
const reportPath = resolve(process.env.FIREFOX_P031_REPORT || join(root, "p031-report.json"));
const pin = await loadBrowserPin();
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const xpi = resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report = {
  schemaVersion: 1,
  phase: "P031",
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

// One UI client request from the dashboard page to the background Core.
async function ui(name, args = [], kind = "command") {
  const id = "p031-" + (++sequence) + "-" + Date.now();
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
const get = () => ui("modules.get", [ID], "query");

async function frames() {
  return page(`const bg = await api.runtime.getBackgroundPage();
    return [...bg.document.querySelectorAll("iframe")].map((frame) => ({
      module: frame.getAttribute("data-pcms-module"),
      generation: Number(frame.getAttribute("data-pcms-generation")),
      sandbox: frame.getAttribute("sandbox"),
      src: frame.getAttribute("src"),
      contentDocumentNull: frame.contentDocument === null
    }));`);
}

// Module data rows, read through the accepted backup projection (never put in the report).
async function moduleData() {
  const result = await ui("backupRestore.createBackup", [{ backupId: "p031-probe-" + Date.now() + "-" + (++sequence) }]);
  return Object.fromEntries(result.records.filter((record) => record.namespace === DATA_NAMESPACE)
    .map((record) => [record.key, { revision: record.revision, updatedAt: record.updatedAt, value: record.value }]));
}

async function openTab() { tab = await h.openPage(PRODUCT, "pcms/app/index.html"); return tab; }
async function closeTab() { if (tab) await h.closePage(tab); tab = null; }

// Waits with zero PCMS tabs until the module's tick is due, then for the background to run.
async function sleepUntil(iso, label) {
  const delay = Math.max(0, Date.parse(iso) - Date.now());
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay + 1500));
  await waitFor(async () => (await h.extension(PRODUCT)).state === "running", label, 20000);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

function tickOf(status) { return status.timers.find((timer) => timer.name === "tick"); }

try {
  await mkdir(root, { recursive: true });
  h = await PackagedFirefox.create({ root: join(root, "profiles-p031") });
  await h.start();
  assert.equal(await h.install(xpi), PRODUCT);
  await openTab();

  const listed = await ui("modules.list", [], "query");
  assert.equal(listed.runtime.state, "AVAILABLE", JSON.stringify(listed.runtime));
  assert.deepEqual(listed.modules, []);
  report.facts.runtime = listed.runtime;

  // A031-01: install a run-time archive through PCMS, approve its authority, it runs live.
  const nonce = randomBytes(16).toString("hex");
  const staged = await ui("modules.install", [buildCounterArchiveText({ version: "1.0.0", nonce })]);
  assert.equal(staged.status, "AWAITING_APPROVAL");
  assert.deepEqual(await frames(), [], "no frame before approval");
  const v1 = await ui("modules.approve", [ID, staged.candidate.packageHash]);
  assert.equal(v1.status, "ACTIVE");
  assert.equal(v1.version, "1.0.0");
  let live = await frames();
  assert.equal(live.length, 1);
  assert.equal(live[0].module, ID);
  assert.equal(live[0].generation, v1.generation);
  assert.equal(live[0].sandbox, "allow-scripts");
  assert.equal(live[0].contentDocumentNull, true);
  assert.ok(live[0].src.endsWith("/pcms/sandbox/controller.html"));
  report.facts.installed = { generation: v1.generation, packageHash: v1.activePackageHash, frames: live };
  report.checks.runtimeArchiveInstalledApprovedAndRunningInBackgroundFrame = true;

  // A031-02 SEC: only approved capabilities, bounded, no browser API.
  const probe = await ui("modules.call", [ID, "probe", null]);
  assert.equal(probe.nonce, nonce, "the controller executing is the one supplied at run time");
  assert.equal(probe.browserAbsent, true);
  assert.equal(probe.chromeAbsent, true);
  assert.equal(probe.ungrantedDenied, true);
  assert.equal(probe.ungrantedCode, "PCMS_SANDBOX_CAPABILITY_DENIED");
  assert.equal(probe.oversizedRejected, true);
  assert.equal(probe.shortTimerRejected, true);
  assert.equal(probe.attentionOpened, true);
  assert.equal(probe.attentionSettled, "RESOLVED");
  report.facts.probe = { origin: probe.origin, ungrantedCode: probe.ungrantedCode, timers: probe.timers.map((timer) => timer.name) };
  report.checks.onlyApprovedCapabilitiesNoAmbientAuthority = true;

  // A031-02: zero PCMS tabs, event page unloaded; the schedule fires and rehydrates the module.
  const firstTick = tickOf(await get());
  assert.equal(firstTick.state, "SCHEDULED");
  await closeTab();
  report.firstUnload = await h.forceIdleUnload(PRODUCT);
  assert.equal(report.firstUnload.state, "stopped", "Firefox test hook must confirm suspension");
  await sleepUntil(firstTick.dueAt, "module schedule wakes the unloaded background");
  const reopenedAt = new Date().toISOString();
  await openTab();
  const afterUnload = await waitFor(async () => {
    const data = await moduleData();
    return data.ticks?.value?.count >= 1 ? data : null;
  }, "module tick written with zero PCMS tabs", 20000);
  assert.ok(afterUnload.ticks.updatedAt < reopenedAt, "the tick ran before any PCMS tab was reopened");
  const rehydrated = await get();
  assert.equal(rehydrated.status, "ACTIVE");
  assert.ok(rehydrated.generation > v1.generation, "rehydration started a new generation");
  assert.equal(tickOf(rehydrated).state, "SCHEDULED", "the next occurrence was declared");
  report.facts.afterUnload = { tickUpdatedAt: afterUnload.ticks.updatedAt, reopenedAt, count: afterUnload.ticks.value.count, generation: rehydrated.generation };
  report.checks.scheduleRunsWithZeroTabsAfterEventPageUnload = true;

  // A031-03: update activates a new generation live; the previous one stops writing.
  assert.equal((await ui("modules.call", [ID, "beat", null])).version, "1.0.0");
  await waitFor(async () => ((await moduleData()).beat?.value?.count >= 2 ? true : null), "v1 beat loop writes", 10000);
  const v2 = await ui("modules.install", [buildCounterArchiveText({ version: "2.0.0", nonce })]);
  assert.equal(v2.status, "ACTIVE");
  assert.equal(v2.version, "2.0.0");
  assert.ok(v2.generation > rehydrated.generation);
  live = await frames();
  assert.deepEqual(live.map((frame) => [frame.module, frame.generation]), [[ID, v2.generation]], "the old generation's frame is gone");
  const frozen = (await moduleData()).beat.value.count;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal((await moduleData()).beat.value.count, frozen, "the previous generation can no longer write");
  assert.equal((await ui("modules.call", [ID, "probe", null])).version, "2.0.0");
  report.facts.update = { from: rehydrated.generation, to: v2.generation, beatFrozenAt: frozen };
  report.checks.updateNewGenerationWithoutReloadOldGenerationFenced = true;

  // A031-03: disable and enable live.
  const disabled = await ui("modules.disable", [ID]);
  assert.equal(disabled.status, "DISABLED");
  assert.deepEqual(await frames(), []);
  assert.deepEqual(disabled.timers.map((timer) => timer.state), ["CANCELLED"]);
  const enabled = await ui("modules.enable", [ID]);
  assert.equal(enabled.status, "ACTIVE");
  assert.equal(enabled.version, "2.0.0");
  assert.equal((await frames()).length, 1);
  assert.equal(tickOf(enabled).state, "SCHEDULED");
  report.checks.disableEnableLive = true;

  // A031-02: profile restart. The module is READY until work addresses it; its schedule
  // fires with zero PCMS tabs.
  const restartTick = tickOf(enabled);
  await closeTab();
  await h.restart();
  assert.equal((await h.extension(PRODUCT)).id, PRODUCT);
  await openTab();
  const afterRestart = await get();
  const restartedBeforeDue = Date.now() < Date.parse(restartTick.dueAt);
  report.facts.restart = { status: afterRestart.status, running: afterRestart.running, restartedBeforeDue, dueAt: restartTick.dueAt };
  if (restartedBeforeDue) {
    assert.equal(afterRestart.status, "READY", "lazy: no controller runs after restart until its work is due");
    assert.equal(afterRestart.running, false);
    assert.deepEqual(await frames(), []);
  }
  const ticksBefore = (await moduleData()).ticks.value.count;
  await closeTab();
  report.restartUnload = await h.forceIdleUnload(PRODUCT);
  await sleepUntil(restartTick.dueAt, "module schedule wakes the background after restart");
  const reopenedAfterRestart = new Date().toISOString();
  await openTab();
  const afterRestartTick = await waitFor(async () => {
    const data = await moduleData();
    return data.ticks.value.count > ticksBefore ? data : null;
  }, "module tick after restart with zero PCMS tabs", 20000);
  assert.ok(afterRestartTick.ticks.updatedAt < reopenedAfterRestart);
  assert.equal(afterRestartTick.ticks.value.version, "2.0.0");
  report.facts.afterRestartTick = { count: afterRestartTick.ticks.value.count, updatedAt: afterRestartTick.ticks.updatedAt, reopenedAt: reopenedAfterRestart };
  report.checks.profileRestartLazyRehydrationAndZeroTabSchedule = true;

  // A031-03: rollback, remove, purge live.
  const rolledBack = await ui("modules.rollback", [ID, v1.activePackageHash]);
  assert.equal(rolledBack.status, "ACTIVE");
  assert.equal(rolledBack.version, "1.0.0");
  assert.equal((await ui("modules.call", [ID, "probe", null])).version, "1.0.0");
  const removed = await ui("modules.remove", [ID]);
  assert.equal(removed.status, "REMOVED");
  assert.deepEqual(await frames(), []);
  assert.ok(Object.keys(await moduleData()).length > 0, "remove keeps module data");
  const purged = await ui("modules.purge", [ID]);
  assert.equal(purged.purged, true);
  assert.deepEqual(await moduleData(), {});
  assert.equal((await get()).installed, false);
  report.facts.purge = { dataKeysDeleted: purged.dataKeysDeleted };
  report.checks.rollbackRemovePurgeLive = true;
  await closeTab();
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
