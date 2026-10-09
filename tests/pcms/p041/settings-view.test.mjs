// A041-01/02/03 (U): the Settings views gate restore on preview + typed phrase, gate Resume on
// passing checks, link every failing check, and drive module lifecycle commands only after
// the review/confirmation dialogs.
import test from "node:test";
import assert from "node:assert/strict";

import { createPcmsSettingsView } from "../../../extension/pcms/app/views/settings/settings-view.js";
import {
  parsePcmsBackupFile, pcmsBackupFilename, pcmsBackupId, pcmsConfirmedRestore, pcmsRestoreGate, presentPcmsRestorePreview
} from "../../../extension/pcms/app/views/settings/backup-model.js";
import {
  pcmsModuleConfirmModel, pcmsModuleReviewModel, pcmsModulesPageModel, pcmsRuntimeModuleRow
} from "../../../extension/pcms/app/views/settings/modules-model.js";
import { fakeFile, makeDocument, makeWindow, settle } from "./fake-dom.mjs";

const DIGEST = "a".repeat(64);
const PREVIEW = Object.freeze({
  kind: "pcms-restore-preview", previewDigest: DIGEST, previewedAt: "2026-10-08T12:00:00.000Z",
  backupId: "pcms-backup-20261007T140312Z", backupSha256: "b".repeat(64), createdAt: "2026-10-07T14:03:12.000Z",
  recordCount: 3, currentRecordCount: 4,
  namespaces: [{ namespace: "app.accounts", backup: 1, current: 1 }, { namespace: "core.modules", backup: 1, current: 2 }],
  namespacesTruncated: false, differences: { added: 0, changed: 1, removed: 2, unchanged: 1 },
  modules: { inBackup: ["acme.reports"], onlyNow: ["acme.extra"] },
  effects: ["Restoring replaces current PCMS data with this backup.", "Backups never contain secret values; credentials are kept as references only."],
  confirmationPhrase: "RESTORE"
});
const BACKUP = Object.freeze({ schemaVersion: 1, kind: "pcms-backup", backupId: PREVIEW.backupId, createdAt: PREVIEW.createdAt, recordCount: 0, records: [], sha256: "b".repeat(64) });
const STAGE = Object.freeze({ schemaVersion: 1, kind: "pcms-staged-restore", stagedAt: PREVIEW.previewedAt, backup: BACKUP, preview: PREVIEW });

function heldChecklist(items, releasable = false) {
  return { hold: { state: "RECOVERY_HOLD", revision: 3 }, items, failing: items.filter((i) => i.status !== "PASS").length, releasable };
}
const FAILING = heldChecklist([
  { id: "check:personaBindings", kind: "check", label: "Account ↔ Persona bindings resolved", status: "FAIL", subject: { kind: "accounts", id: null } },
  { id: "check:remoteOperations", kind: "check", label: "Pending operations checked", status: "FAIL", subject: { kind: "attention", id: null } },
  { id: "operation:op-1", kind: "operation", label: "generator.update · generator gen-1", status: "FAIL", subject: { kind: "generator", id: "gen-1" }, operationId: "op-1", reconcilable: true },
  { id: "check:providerCapabilities", kind: "check", label: "Provider compatibility confirmed", status: "PASS", subject: { kind: "settings", id: "diagnostics" } }
]);
const PASSING = heldChecklist([
  { id: "check:personaBindings", kind: "check", label: "Account ↔ Persona bindings resolved", status: "PASS", subject: { kind: "accounts", id: null } }
], true);

function mount({ checklist = { hold: { state: "NORMAL" }, items: [], failing: 0, releasable: false }, modules = { runtime: { state: "AVAILABLE" }, modules: [] } } = {}) {
  const calls = [];
  const state = { checklist, modules };
  const record = (name, result) => async (...args) => { calls.push([name, args]); return typeof result === "function" ? result(...args) : result; };
  const runtime = {
    backupRestore: {
      createBackup: record("createBackup", (input) => ({ ...BACKUP, backupId: input.backupId, recordCount: 3 })),
      stageRestore: record("stageRestore", STAGE),
      applyStagedRestore: record("applyStagedRestore", { backupId: BACKUP.backupId }),
      recoveryChecklist: record("recoveryChecklist", () => state.checklist),
      reconcileOperation: record("reconcileOperation", (id) => ({ operationId: id, resolved: true, state: null })),
      reconcileAndRelease: record("reconcileAndRelease", { released: true, unresolvedOperationIds: [] })
    },
    modules: {
      list: record("modules.list", () => state.modules),
      install: record("modules.install", () => ({ moduleId: "acme.reports", status: "AWAITING_APPROVAL", installed: true,
        capabilities: [], candidate: { packageHash: "c".repeat(64), version: "1.0.0", state: "AWAITING_APPROVAL", addedCapabilities: ["module.storage.read", "module.timers.ensure"] } })),
      approve: record("modules.approve", (id) => ({ moduleId: id, status: "ACTIVE", version: "1.0.0", installed: true })),
      reject: record("modules.reject", (id) => ({ moduleId: id, installed: false })),
      enable: record("modules.enable", (id) => ({ moduleId: id, status: "ACTIVE" })),
      disable: record("modules.disable", (id) => ({ moduleId: id, status: "DISABLED" })),
      rollback: record("modules.rollback", (id) => ({ moduleId: id, status: "ACTIVE", version: "1.0.0" })),
      remove: record("modules.remove", (id) => ({ moduleId: id, status: "REMOVED" })),
      purge: record("modules.purge", (id) => ({ moduleId: id, purged: true, dataKeysDeleted: 2 }))
    }
  };
  const documentRef = makeDocument(["settingsBackup", "settingsModulesManager"]);
  const windowRef = makeWindow();
  const view = createPcmsSettingsView({ documentRef, windowRef, runtime, now: () => new Date("2026-10-07T14:03:12Z") });
  const q = (selector) => documentRef.body.querySelector(selector);
  const qa = (selector) => documentRef.body.querySelectorAll(selector);
  const names = () => calls.map(([name]) => name);
  return { view, runtime, calls, names, state, documentRef, windowRef, q, qa };
}

async function type(input, text) { input.value = text; await input.dispatch("input"); }
async function choose(input, file) { input.files = [file]; await input.dispatch("change"); }

test("A041-01 U backup files are auto-named, timestamped and parsed defensively", () => {
  const when = new Date("2026-10-07T14:03:12Z");
  assert.equal(pcmsBackupFilename(when), "pcms-backup-2026-10-07-1403.json");
  assert.equal(pcmsBackupId(when, "ab12cd"), "pcms-backup-20261007T140312Z-ab12cd");
  assert.notEqual(pcmsBackupId(when, "ab12cd"), "p026-manual-backup");
  assert.throws(() => parsePcmsBackupFile(""), /empty/);
  assert.throws(() => parsePcmsBackupFile("{not json"), /not JSON/);
  assert.throws(() => parsePcmsBackupFile(JSON.stringify({ kind: "something-else" })), /not a PCMS backup/);
  assert.throws(() => parsePcmsBackupFile("x".repeat(20), { maxBytes: 10 }), /too large/);
  assert.equal(parsePcmsBackupFile(JSON.stringify(BACKUP)).backupId, BACKUP.backupId);
  const view = presentPcmsRestorePreview(PREVIEW, { locale: "en-GB" });
  assert.match(view.summary, /3 records/);
  assert.match(view.differences, /1 changed, 2 removed/);
  assert.match(view.modules, /acme\.reports.*acme\.extra/);
  assert.deepEqual(view.groups, ["accounts 1", "modules 1 (now 2)"]);
});

test("A041-01 U Restore stays disabled without a preview and the exact typed phrase", () => {
  assert.equal(pcmsRestoreGate({}).enabled, false);
  assert.equal(pcmsRestoreGate({ stage: STAGE, typed: "" }).enabled, false);
  assert.equal(pcmsRestoreGate({ stage: STAGE, typed: "restore" }).enabled, false);
  assert.equal(pcmsRestoreGate({ stage: STAGE, typed: "RESTORE", busy: true }).enabled, false);
  assert.equal(pcmsRestoreGate({ stage: STAGE, typed: "RESTORE" }).enabled, true);
  assert.throws(() => pcmsConfirmedRestore(STAGE, "Restore"), (error) => error.code === "PCMS_BACKUP_CONFIRMATION_REQUIRED");
  assert.deepEqual(pcmsConfirmedRestore(STAGE, "RESTORE").confirmation, { phrase: "RESTORE", previewDigest: DIGEST });
});

test("A041-01 U view: create downloads a file; restore needs a preview and typing RESTORE", async () => {
  const h = mount();
  await h.view.refresh({ route: "settings", section: "backup" });
  assert.equal(h.q("[data-recovery-status]").dataset.recoveryStatus, "NORMAL");
  assert.match(h.q("[data-recovery-status]").textContent, /Normal — changes are allowed/);

  await h.q("[data-backup-create]").click();
  const [, [input]] = h.calls.find(([name]) => name === "createBackup");
  assert.match(input.backupId, /^pcms-backup-20261007T140312Z-[a-f0-9]{6}$/);
  const link = h.q("[data-backup-download]");
  assert.equal(link.dataset.backupDownload, "pcms-backup-2026-10-07-1403.json");
  assert.equal(link.download, "pcms-backup-2026-10-07-1403.json");
  assert.equal(JSON.parse(h.windowRef.urls[0].text).backupId, input.backupId);

  // A non-backup file never reaches Core.
  await choose(h.q("[data-restore-file]"), fakeFile("notes.json", "{\"hello\":1}"));
  assert.equal(h.names().includes("stageRestore"), false);
  assert.match(h.q("[data-backup-feedback]").textContent, /cannot be restored/);

  await choose(h.q("[data-restore-file]"), fakeFile("pcms-backup.json", JSON.stringify(BACKUP)));
  assert.equal(h.q("[data-restore-preview]").dataset.restorePreview, PREVIEW.backupId);
  assert.equal(h.q("[data-restore-preview]").hidden, false);
  const apply = h.q("[data-restore-apply]");
  assert.equal(apply.disabled, true);
  await apply.click();
  for (const text of ["restore", "RESTOR", "RESTORE!"]) {
    await type(h.q("[data-restore-typed]"), text);
    assert.equal(apply.disabled, true, text);
  }
  assert.equal(h.names().includes("applyStagedRestore"), false);

  await type(h.q("[data-restore-typed]"), "RESTORE");
  assert.equal(apply.disabled, false);
  h.state.checklist = FAILING;
  await apply.click();
  const [, [applied]] = h.calls.find(([name]) => name === "applyStagedRestore");
  assert.deepEqual(applied.confirmation, { phrase: "RESTORE", previewDigest: DIGEST });
  assert.equal(applied.preview.previewDigest, DIGEST);
  assert.equal(h.q("[data-restore-preview]").hidden, true, "the preview is consumed");
  assert.equal(h.q("[data-recovery-status]").dataset.recoveryStatus, "RECOVERY_HOLD");
});

test("A041-02 U view: Resume is disabled while any check fails; each failing check links to its subject", async () => {
  const h = mount({ checklist: FAILING });
  await h.view.refresh({ route: "settings", section: "backup" });
  const rows = h.qa("[data-check-id]");
  assert.equal(rows.length, 4);
  const failing = rows.filter((row) => row.dataset.checkStatus === "FAIL");
  assert.equal(failing.length, 3);
  for (const row of failing) {
    const link = row.querySelector("[data-check-subject]");
    assert.ok(link && link.href.startsWith("#/"), row.dataset.checkId);
  }
  assert.deepEqual(failing.map((row) => row.querySelector("[data-check-subject]").href), ["#/accounts", "#/attention", "#/search?q=gen-1"]);
  const resume = h.q("[data-recovery-resume]");
  assert.equal(resume.disabled, true);
  await resume.click();
  assert.equal(h.names().includes("reconcileAndRelease"), false);

  await h.q("[data-check-operation]").click();
  assert.deepEqual(h.calls.find(([name]) => name === "reconcileOperation")[1], ["op-1"]);

  h.state.checklist = PASSING;
  await h.view.refresh({ route: "settings", section: "backup" });
  assert.equal(h.q("[data-recovery-resume]").disabled, false);
  await h.q("[data-recovery-resume]").click();
  assert.equal(h.names().includes("reconcileAndRelease"), true);
});

test("A041-03 U modules model: actions follow state; built-ins have no remove or purge", () => {
  const base = { moduleId: "acme.reports", installed: true, version: "1.1.0", capabilities: ["module.storage.read"],
    activePackageHash: "a".repeat(64), retainedPackageHashes: ["a".repeat(64), "b".repeat(64)], candidate: null, failures: 0 };
  const ids = (row) => row.actions.map((item) => item.id);
  assert.deepEqual(ids(pcmsRuntimeModuleRow({ ...base, status: "ACTIVE" })), ["disable", "rollback", "remove"]);
  assert.equal(pcmsRuntimeModuleRow({ ...base, status: "ACTIVE" }).actions[1].packageHash, "b".repeat(64));
  assert.deepEqual(ids(pcmsRuntimeModuleRow({ ...base, status: "DISABLED" })), ["enable", "rollback", "remove"]);
  assert.deepEqual(ids(pcmsRuntimeModuleRow({ ...base, status: "REMOVED" })), ["purge"]);
  assert.deepEqual(ids(pcmsRuntimeModuleRow({ ...base, status: "AWAITING_APPROVAL", activePackageHash: null, retainedPackageHashes: [],
    candidate: { packageHash: "c".repeat(64), version: "1.0.0", state: "AWAITING_APPROVAL", addedCapabilities: [] } })), ["review", "remove"]);
  const update = pcmsRuntimeModuleRow({ ...base, status: "ACTIVE",
    candidate: { packageHash: "d".repeat(64), version: "1.2.0", state: "AWAITING_APPROVAL", addedCapabilities: ["module.timers.ensure"] } });
  assert.equal(update.state, "Update 1.2.0 needs approval");
  assert.equal(update.actions[0].id, "review");

  const page = pcmsModulesPageModel({ runtime: { state: "AVAILABLE" }, modules: [{ ...base, status: "ACTIVE" }] });
  for (const row of page.rows.filter((item) => item.source === "Built-in")) assert.deepEqual(row.actions, []);
  assert.equal(page.rows.find((row) => row.moduleId === "accounts").state, "Active · required");
  assert.match(pcmsModulesPageModel({ runtime: { state: "UNSUPPORTED" }, modules: [] }).runtimeMessage, /Firefox 154/);

  const review = pcmsModuleReviewModel({ ...base, status: "ACTIVE",
    candidate: { packageHash: "d".repeat(64), version: "1.2.0", state: "AWAITING_APPROVAL", addedCapabilities: ["module.timers.ensure"] } });
  assert.deepEqual(review.capabilities.map((item) => [item.capability, item.added]),
    [["module.storage.read", false], ["module.timers.ensure", true]]);
  assert.equal(review.capabilities[1].text, "schedule its own background work");

  assert.equal(pcmsModuleConfirmModel("purge", { moduleId: "acme.reports" }).phrase, "acme.reports");
  assert.equal(pcmsModuleConfirmModel("purge", { moduleId: "acme.reports" }).risk, "DESTRUCTIVE");
  assert.ok(pcmsModuleConfirmModel("remove", { moduleId: "acme.reports" }).lines.some((line) => /kept for a later restore/.test(line)));
  assert.equal(pcmsModuleConfirmModel("remove", { moduleId: "acme.reports" }).phrase, null);
});

test("A041-03 U view: install opens the review; purge needs the typed module name", async () => {
  const active = { moduleId: "acme.reports", installed: true, status: "ACTIVE", version: "1.0.0", capabilities: ["module.storage.read"],
    activePackageHash: "a".repeat(64), retainedPackageHashes: ["a".repeat(64)], candidate: null, failures: 0 };
  const h = mount({ modules: { runtime: { state: "AVAILABLE" }, modules: [] } });
  await h.view.refresh({ route: "settings", section: "modules" });
  assert.equal(h.q("[data-modules-runtime]").dataset.modulesRuntime, "AVAILABLE");
  assert.ok(h.q('[data-module-row="accounts"]'));

  const installing = choose(h.q("[data-module-install]"), fakeFile("acme.json", "ARCHIVE"));
  await settle();
  const dialog = h.q("[data-module-dialog]");
  assert.equal(dialog.dataset.moduleDialog, "review");
  const capabilities = dialog.querySelectorAll("[data-capability]");
  assert.deepEqual(capabilities.map((li) => [li.dataset.capability, li.dataset.capabilityNew]),
    [["module.storage.read", "true"], ["module.timers.ensure", "true"]]);
  assert.equal(h.names().includes("modules.approve"), false);
  h.state.modules = { runtime: { state: "AVAILABLE" }, modules: [active] };
  await dialog.querySelector("[data-dialog-accept]").click();
  await installing;
  await settle();
  assert.deepEqual(h.calls.find(([name]) => name === "modules.approve")[1], ["acme.reports", "c".repeat(64)]);
  assert.equal(h.q('[data-module-row="acme.reports"]').dataset.state, "Active");

  h.state.modules = { runtime: { state: "AVAILABLE" }, modules: [{ ...active, status: "REMOVED" }] };
  await h.view.refresh({ route: "settings", section: "modules" });
  const purging = h.q('[data-module-action="purge"]').click();
  await settle();
  const purge = h.q("[data-module-dialog]");
  assert.equal(purge.dataset.moduleDialog, "purge");
  assert.equal(purge.dataset.risk, "DESTRUCTIVE");
  const accept = purge.querySelector("[data-dialog-accept]");
  assert.equal(accept.disabled, true);
  await type(purge.querySelector("[data-dialog-typed]"), "acme");
  assert.equal(accept.disabled, true);
  await accept.click();
  assert.equal(h.names().includes("modules.purge"), false);
  await type(purge.querySelector("[data-dialog-typed]"), "acme.reports");
  assert.equal(accept.disabled, false);
  await accept.click();
  await purging;
  assert.deepEqual(h.calls.find(([name]) => name === "modules.purge")[1], ["acme.reports"]);
  assert.match(h.q("[data-modules-feedback]").textContent, /purged/);
});
