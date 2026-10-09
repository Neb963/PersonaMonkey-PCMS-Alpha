// T041.3 packaged proof (A041-03 PKG/FDE) in the exact pinned Developer Edition, plus the
// Settings → Backup & restore flow (A041-01/02) observed in the real dashboard DOM.
//
// The product XPI is installed once and one dashboard tab stays open throughout. A fixture
// runtime module, built here at run time with a random nonce (so it cannot be in the XPI), is
// driven only through the Settings → Modules page: Install from file → review → approve,
// update (new capability highlighted) → approve, roll back, remove, purge. The module runs in
// a background sandbox frame without extension reload, and the dashboard page is never
// reloaded. Then Settings → Backup & restore downloads a backup file, previews it, refuses to
// restore until RESTORE is typed, and shows the recovery checklist with linked subjects.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { execFileText, loadBrowserPin, sha256File, writeJson } from "../../../tools/firefox/lib.mjs";
import { PackagedFirefox, waitFor } from "../../../tools/firefox/packaged-harness.mjs";
import { FIXTURE_CAPABILITIES, FIXTURE_MODULE_ID, buildCounterArchiveText } from "../../fixtures/modules/counter.mjs";

const PRODUCT = "persona-route-manager@local";
const ID = FIXTURE_MODULE_ID;
const root = resolve(process.env.FIREFOX_PACKAGED_DIR || join(tmpdir(), "pcms-firefox-p041"));
const reportPath = resolve(process.env.FIREFOX_P041_REPORT || join(root, "p041-report.json"));
const downloads = join(root, "downloads");
const pin = await loadBrowserPin();
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const xpi = resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report = {
  schemaVersion: 1,
  phase: "P041",
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
  const id = "p041-" + (++sequence) + "-" + Date.now();
  const response = await page(`
    const [name, args, kind, id] = [arguments[0], arguments[1], arguments[2], arguments[3]];
    const message = { type: "PCMS_UI_REQUEST", version: 1, requestId: id, kind, name, params: { args } };
    if (kind === "command") message.idempotencyKey = id;
    return api.runtime.sendMessage(message);`, [name, args, kind, id]);
  if (!response?.ok) throw Object.assign(new Error((response?.error?.code || "PCMS_UI_FAILED") + ": " + (response?.error?.message || name)), { code: response?.error?.code });
  return response.result;
}

async function frames() {
  return page(`const bg = await api.runtime.getBackgroundPage();
    return [...bg.document.querySelectorAll("iframe[data-pcms-module]")].map((frame) => ({
      module: frame.getAttribute("data-pcms-module"),
      generation: Number(frame.getAttribute("data-pcms-generation")),
      sandbox: frame.getAttribute("sandbox")
    }));`);
}

async function go(hash) { await h.pageScript("location.hash = arguments[0]; return true;", [hash]); }

// One DOM read of everything the Settings checks look at.
async function dom() {
  return h.pageScript(`
    const text = (selector) => document.querySelector(selector)?.textContent ?? null;
    const dialog = document.querySelector("[data-module-dialog]");
    return {
      hash: location.hash,
      marker: window.wrappedJSObject.__p041Marker ?? null,
      modulesVisible: document.getElementById("viewModules")?.hidden === false,
      backupVisible: document.getElementById("viewSettingsBackup")?.hidden === false,
      runtime: document.querySelector("[data-modules-runtime]")?.dataset.modulesRuntime ?? null,
      rows: [...document.querySelectorAll("[data-module-row]")].map((tr) => ({
        moduleId: tr.dataset.moduleRow, source: tr.dataset.moduleSource, state: tr.dataset.state,
        version: tr.children[1]?.textContent ?? null,
        actions: [...tr.querySelectorAll("[data-module-action]")].map((b) => b.dataset.moduleAction)
      })),
      dialog: dialog ? { kind: dialog.dataset.moduleDialog, hidden: dialog.hidden, risk: dialog.dataset.risk ?? null,
        title: dialog.querySelector("h3")?.textContent ?? null,
        capabilities: [...dialog.querySelectorAll("[data-capability]")].map((li) => ({ capability: li.dataset.capability, added: li.dataset.capabilityNew === "true", text: li.textContent })),
        acceptDisabled: dialog.querySelector("[data-dialog-accept]")?.disabled ?? null } : null,
      modulesFeedback: text("[data-modules-feedback]"),
      recovery: document.querySelector("[data-recovery-status]")?.dataset.recoveryStatus ?? null,
      recoveryText: text("[data-recovery-status]"),
      download: document.querySelector("[data-backup-download]")?.dataset.backupDownload ?? null,
      preview: document.querySelector("[data-restore-preview]")?.dataset.restorePreview ?? null,
      previewText: text(".settings-preview"),
      restoreDisabled: document.querySelector("[data-restore-apply]")?.disabled ?? null,
      checks: [...document.querySelectorAll("[data-check-id]")].map((li) => ({ id: li.dataset.checkId, status: li.dataset.checkStatus,
        href: li.querySelector("[data-check-subject]")?.getAttribute("href") ?? null })),
      resumeDisabled: document.querySelector("[data-recovery-resume]")?.disabled ?? null,
      backupFeedback: text("[data-backup-feedback]")
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

const row = (d, moduleId = ID) => d.rows.find((item) => item.moduleId === moduleId) || null;

// The operator's "choose file": a real File set on the page's file input.
async function chooseFile(selector, name, text) {
  await h.pageScript(`const input = document.querySelector(arguments[0]);
    const transfer = new DataTransfer();
    transfer.items.add(new File([arguments[2]], arguments[1], { type: "application/json" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;`, [selector, name, text]);
}
async function click(selector) {
  await h.pageScript(`const node = document.querySelector(arguments[0]); if (!node) throw new Error("missing " + arguments[0]); node.click(); return true;`, [selector]);
}
async function typeInto(selector, value) {
  await h.pageScript(`const node = document.querySelector(arguments[0]); node.value = arguments[1];
    node.dispatchEvent(new Event("input", { bubbles: true })); return true;`, [selector, value]);
}
async function approveDialog(kind, label, beforeAccept = async () => {}) {
  const state = await until((d) => d.dialog && !d.dialog.hidden && d.dialog.kind === kind, label);
  await beforeAccept(state);
  await click("[data-module-dialog] [data-dialog-accept]");
  return state;
}

try {
  await mkdir(downloads, { recursive: true });
  h = await PackagedFirefox.create({ root: join(root, "profiles-p041") });
  await h.start();
  await h.client.script(`Services.prefs.setIntPref("browser.download.folderList", 2);
    Services.prefs.setStringPref("browser.download.dir", arguments[0]);
    Services.prefs.setBoolPref("browser.download.useDownloadDir", true);
    Services.prefs.setBoolPref("browser.download.always_ask_before_handling_new_types", false);
    Services.prefs.setBoolPref("browser.download.panel.shown", true);`, [downloads]);
  assert.equal(await h.install(xpi), PRODUCT);
  tab = await h.openPage(PRODUCT, "pcms/app/index.html#/settings/modules");
  await waitFor(() => h.pageScript('return document.getElementById("brokerLiveStatus")?.dataset.state==="connected";'),
    "packaged P041 dashboard connects", 30000);
  // Set once; it survives only if the dashboard page is never reloaded.
  await h.pageScript("window.wrappedJSObject.__p041Marker = 'p041-dashboard'; return true;");

  // A041-03: Settings → Modules lists built-ins without remove/purge and offers Install from file.
  let state = await until((d) => d.modulesVisible && d.runtime === "AVAILABLE" && row(d, "accounts"), "Settings → Modules renders");
  for (const builtin of state.rows.filter((item) => item.source === "Built-in")) assert.deepEqual(builtin.actions, [], builtin.moduleId);
  assert.equal(row(state, ID), null);
  report.facts.builtIns = state.rows.map((item) => item.moduleId);

  // Install from file → review dialog (capabilities in plain language) → approve → runs live.
  const nonce = randomBytes(16).toString("hex");
  const v1Caps = FIXTURE_CAPABILITIES.filter((cap) => !cap.startsWith("module.attention."));
  await chooseFile("[data-module-install]", ID + "-1.0.0.json", buildCounterArchiveText({ version: "1.0.0", nonce, capabilities: v1Caps }));
  // Checked while the review is still open: after Accept the frame may start at any moment.
  state = await approveDialog("review", "install review dialog", async () => {
    assert.deepEqual(await frames(), [], "nothing runs before approval");
  });
  assert.equal(state.dialog.title, "Install " + ID + " 1.0.0");
  assert.deepEqual(state.dialog.capabilities.map((item) => item.capability).sort(), [...v1Caps].sort());
  assert.ok(state.dialog.capabilities.every((item) => item.added && /^New: can /.test(item.text)), JSON.stringify(state.dialog.capabilities));
  state = await until((d) => row(d)?.version === "1.0.0" && /^(Active|Ready)/.test(row(d).state), "installed module active");
  let live = await waitFor(async () => { const f = await frames(); return f.length === 1 ? f : null; }, "module frame in background", 20000);
  assert.equal(live[0].module, ID);
  assert.equal(live[0].sandbox, "allow-scripts");
  const v1 = await ui("modules.get", [ID], "query");
  report.facts.installed = { version: v1.version, generation: v1.generation, status: v1.status, frames: live };
  report.checks.installFromFileReviewApproveRunsLive = true;

  // Update: a new capability needs approval; the dialog highlights it as New.
  await chooseFile("[data-module-install]", ID + "-1.1.0.json", buildCounterArchiveText({ version: "1.1.0", nonce }));
  // The view opens the review as soon as Core reports the update awaiting approval; the row
  // behind it already says so.
  state = await until((d) => d.dialog?.kind === "review" && !d.dialog.hidden && /needs approval/.test(row(d)?.state || ""), "update awaits approval");
  state = await approveDialog("review", "update review dialog");
  assert.equal(state.dialog.title, "Update " + ID + " 1.1.0");
  const added = state.dialog.capabilities.filter((item) => item.added).map((item) => item.capability).sort();
  assert.deepEqual(added, ["module.attention.open", "module.attention.settle"]);
  assert.ok(state.dialog.capabilities.filter((item) => !item.added).every((item) => !/^New:/.test(item.text)));
  state = await until((d) => row(d)?.version === "1.1.0" && /^(Active|Ready)/.test(row(d).state), "update applied live");
  const v2 = await ui("modules.get", [ID], "query");
  assert.ok(v2.generation > v1.generation, "a new generation runs the update");
  const probe = await ui("modules.call", [ID, "probe", null]);
  assert.equal(probe.version, "1.1.0");
  assert.equal(probe.nonce, nonce);
  report.facts.updated = { version: v2.version, generation: v2.generation, addedCapabilities: added };
  report.checks.updateReviewHighlightsNewCapabilityAndAppliesLive = true;

  // Roll back to the retained 1.0.0 package (confirmation dialog), live.
  assert.ok(row(state).actions.includes("rollback"), JSON.stringify(row(state)));
  await click(`[data-module-row="${ID}"] [data-module-action="rollback"]`);
  await approveDialog("rollback", "rollback confirmation");
  state = await until((d) => row(d)?.version === "1.0.0" && !d.dialog?.kind?.match(/rollback/), "rolled back live", 30000);
  const rolled = await ui("modules.get", [ID], "query");
  assert.equal(rolled.version, "1.0.0");
  assert.ok(rolled.generation > v2.generation);
  report.facts.rolledBack = { version: rolled.version, generation: rolled.generation, state: row(state).state };
  report.checks.rollbackLive = true;

  // Remove: data kept for restore; the module stops.
  await click(`[data-module-row="${ID}"] [data-module-action="remove"]`);
  state = await approveDialog("remove", "remove confirmation");
  state = await until((d) => /^Removed/.test(row(d)?.state || ""), "removed");
  assert.deepEqual(row(state).actions, ["purge"]);
  await waitFor(async () => (await frames()).length === 0 ? true : null, "removed module frame stops", 20000);
  report.checks.removeLive = true;

  // Purge: DESTRUCTIVE, needs the typed module name.
  await click(`[data-module-row="${ID}"] [data-module-action="purge"]`);
  state = await until((d) => d.dialog?.kind === "purge" && !d.dialog.hidden, "purge dialog");
  assert.equal(state.dialog.risk, "DESTRUCTIVE");
  assert.equal(state.dialog.acceptDisabled, true);
  await typeInto("[data-module-dialog] [data-dialog-typed]", "fixture");
  assert.equal((await dom()).dialog.acceptDisabled, true);
  await typeInto("[data-module-dialog] [data-dialog-typed]", ID);
  assert.equal((await dom()).dialog.acceptDisabled, false);
  await click("[data-module-dialog] [data-dialog-accept]");
  state = await until((d) => row(d) === null && /purged/.test(d.modulesFeedback || ""), "purged");
  assert.equal((await ui("modules.get", [ID], "query")).installed, false);
  report.checks.purgeNeedsTypedNameAndDeletes = true;

  assert.equal(state.marker, "p041-dashboard", "the dashboard page was never reloaded");
  assert.equal((await h.extension(PRODUCT)).state, "running", "the extension was never reloaded or disabled");
  report.checks.wholeLifecycleWithoutExtensionOrPageReload = true;

  // A041-01 (FDE): Create backup downloads an auto-named file that holds no secret value.
  await go("#/settings/backup");
  state = await until((d) => d.backupVisible && d.recovery === "NORMAL", "Backup & restore renders");
  await click("[data-backup-create]");
  state = await until((d) => d.download && /created/.test(d.backupFeedback || ""), "backup created and offered as a file");
  assert.match(state.download, /^pcms-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  const fileText = await page(`const href = document.querySelector("[data-backup-download]").href; return (await fetch(href)).text();`);
  const file = JSON.parse(fileText);
  assert.equal(file.kind, "pcms-backup");
  assert.match(file.backupId, /^pcms-backup-\d{8}T\d{6}Z-[a-f0-9]{6}$/);
  assert.equal(fileText.includes("fixture-secret-" + nonce), false, "the module's audited apiToken value is not in the backup");
  let saved = null;
  try {
    saved = await waitFor(async () => (await readdir(downloads)).find((name) => name === state.download) || null, "download saved", 15000);
  } catch {}
  report.facts.backup = { filename: state.download, backupId: file.backupId, recordCount: file.recordCount, savedToDisk: Boolean(saved) };
  report.checks.backupDownloadsAutoNamedFileWithoutSecrets = true;

  // Previewed restore: the Restore button stays disabled until RESTORE is typed.
  await chooseFile("[data-restore-file]", state.download, fileText);
  state = await until((d) => d.preview === file.backupId, "restore preview");
  assert.equal(state.restoreDisabled, true);
  assert.match(state.previewText, /Differences from now/);
  assert.match(state.previewText, /PersonaMonkey Personas, routing and browser state are not changed/);
  await typeInto("[data-restore-typed]", "restore");
  assert.equal((await dom()).restoreDisabled, true);
  assert.equal((await ui("recoveryHold.getStatus", [], "query")).value.state, "NORMAL", "preview changed nothing");
  await typeInto("[data-restore-typed]", "RESTORE");
  assert.equal((await dom()).restoreDisabled, false);
  await click("[data-restore-apply]");
  state = await until((d) => d.recovery === "RECOVERY_HOLD" && d.checks.length > 0, "restored under recovery hold with checklist", 45000);
  report.checks.restoreNeedsPreviewAndTypedConfirmation = true;

  // A041-02 (FDE): every failing check links to its subject; Resume only when all pass.
  const failing = state.checks.filter((item) => item.status === "FAIL");
  for (const item of failing) assert.ok(item.href && item.href.startsWith("#/"), JSON.stringify(item));
  report.facts.checklist = state.checks;
  if (failing.length) {
    assert.equal(state.resumeDisabled, true, "Resume is disabled while a check fails");
  } else {
    assert.equal(state.resumeDisabled, false);
    await click("[data-recovery-resume]");
    state = await until((d) => d.recovery === "NORMAL", "hold released after passing checks", 30000);
  }
  report.facts.finalRecovery = state.recovery;
  report.checks.checklistLinksSubjectsAndGatesResume = true;

  await h.closePage(tab);
  tab = null;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack || error);
  throw error;
} finally {
  await h?.stop();
  await writeJson(reportPath, report);
  if (h) await rm(h.profilePath, { recursive: true, force: true });
  await rm(downloads, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
