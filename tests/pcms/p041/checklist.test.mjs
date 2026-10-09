// A041-02 (U, I): hold release is impossible while checks fail, and every failing check
// links to its subject. Per-item reconciliation settles one operation at a time.
import test from "node:test";
import assert from "node:assert/strict";

import { BACKUP_ERROR_CODES } from "../../../extension/pcms/recovery/errors.js";
import { confirmStagedRestore } from "../../../extension/pcms/recovery/schema.js";
import { REMOTE_OP_ERROR_CODES } from "../../../extension/pcms/remoteops/errors.js";
import { parsePcmsRouteV2 } from "../../../extension/pcms/app/router-v2.js";
import { pcmsChecklistSubjectHref, presentPcmsRecoveryChecklist } from "../../../extension/pcms/app/views/settings/backup-model.js";
import { composeCore, prepareOperation, UID_A } from "./harness.mjs";

async function restoredCore({ reconcileOutcome = "APPLIED" } = {}) {
  const c = composeCore({ reconcileOutcome });
  const { integration, remoteOps } = c;
  await integration.accounts.createAccount({ accountId: "acct-1", displayName: "Primary", personaUid: UID_A }, { expectedRevision: 0 });
  await prepareOperation(remoteOps, { operationId: "op-prepared", targetRef: { kind: "generator", id: "gen-1" } });
  await prepareOperation(remoteOps, {
    operationId: "op-uncertain", action: "account.provision", targetRef: { kind: "account", id: "acct-1" }, uncertain: true
  });
  const backup = await integration.backupRestore.createBackup({ backupId: "b-ops" });
  const staged = await integration.backupRestore.stageRestore(backup);
  await integration.backupRestore.applyStagedRestore(confirmStagedRestore(staged, "RESTORE"));
  return c;
}

function byId(list) { return Object.fromEntries(list.items.map((item) => [item.id, item])); }

function assertEveryFailingRowLinks(list) {
  const view = presentPcmsRecoveryChecklist(list);
  for (const row of view.rows.filter((item) => item.status === "FAIL")) {
    assert.ok(row.href.startsWith("#/"), row.id);
    assert.doesNotThrow(() => parsePcmsRouteV2(row.href), row.href);
  }
  for (const item of list.items.filter((entry) => entry.status !== "PASS")) {
    assert.ok(item.subject && typeof item.subject.kind === "string", "failing check " + item.id + " names its subject");
  }
  return view;
}

test("A041-02 I failing checks name their subjects and the hold cannot be released", async () => {
  const c = await restoredCore();
  const { integration, recoveryHold, directory } = c;
  directory.personas.delete(UID_A); // the restored account now points at a missing Persona

  const list = await integration.backupRestore.recoveryChecklist();
  assert.equal(list.hold.state, "RECOVERY_HOLD");
  assert.equal(list.releasable, false);
  const items = byId(list);
  assert.equal(items["check:personaBindings"].status, "FAIL");
  assert.deepEqual(items["check:personaBindings"].subject, { kind: "accounts", id: null });
  assert.equal(items["check:providerCapabilities"].status, "PASS");
  assert.equal(items["check:moduleGenerations"].status, "PASS");
  assert.equal(items["check:remoteOperations"].status, "FAIL");
  assert.deepEqual(items["operation:op-prepared"].subject, { kind: "generator", id: "gen-1" });
  assert.deepEqual(items["operation:op-uncertain"].subject, { kind: "account", id: "acct-1" });
  assert.equal(items["operation:op-uncertain"].state, "UNCERTAIN");

  const view = assertEveryFailingRowLinks(list);
  const hrefs = Object.fromEntries(view.rows.map((row) => [row.id, row.href]));
  assert.equal(hrefs["check:personaBindings"], "#/accounts");
  assert.equal(hrefs["operation:op-uncertain"], "#/accounts/acct-1");
  assert.equal(hrefs["operation:op-prepared"], "#/search?q=gen-1");
  assert.equal(view.canResume, false);

  // Release is impossible while checks fail: through the service and through the hold itself.
  const attempt = await integration.backupRestore.reconcileAndRelease();
  assert.equal(attempt.released, false);
  assert.equal(attempt.reconciliation.personaBindings, false);
  const status = await recoveryHold.getStatus();
  assert.equal(status.value.state, "RECOVERY_HOLD");
  await assert.rejects(() => recoveryHold.releaseRecoveryHold({
    expectedRevision: status.revision, checks: { moduleGenerations: true, personaBindings: false, providerCapabilities: true }
  }), (error) => error.code === REMOTE_OP_ERROR_CODES.RECOVERY_INCOMPLETE);

  // The Persona comes back: every check passes and the hold releases.
  directory.personas.set(UID_A, { personaUid: UID_A, cookieStoreId: "firefox-container-0" });
  const ready = await integration.backupRestore.recoveryChecklist();
  assert.equal(ready.releasable, true);
  assert.equal(presentPcmsRecoveryChecklist(ready).canResume, true);
  const released = await integration.backupRestore.reconcileAndRelease();
  assert.equal(released.released, true);
  assert.equal((await recoveryHold.getStatus()).value.state, "NORMAL");
  const normal = presentPcmsRecoveryChecklist(await integration.backupRestore.recoveryChecklist());
  assert.equal(normal.held, false);
  assert.deepEqual(normal.rows, []);
});

test("A041-02 I per-item reconciliation settles exactly one operation and never dispatches", async () => {
  const c = await restoredCore({ reconcileOutcome: "UNKNOWN" });
  const { integration, remoteOps } = c;

  const first = await integration.backupRestore.reconcileOperation("op-prepared");
  assert.deepEqual(first, { operationId: "op-prepared", resolved: true, state: null });
  assert.equal((await remoteOps.get("op-prepared")).value.state, "CANCELLED");
  assert.equal((await remoteOps.get("op-uncertain")).value.state, "UNCERTAIN", "the other item is untouched");

  // The provider cannot tell: it stays uncertain and keeps the hold.
  const unknown = await integration.backupRestore.reconcileOperation("op-uncertain");
  assert.deepEqual(unknown, { operationId: "op-uncertain", resolved: false, state: "UNCERTAIN" });
  assert.equal((await integration.backupRestore.reconcileAndRelease()).released, false);
  assert.deepEqual(byId(await integration.backupRestore.recoveryChecklist())["operation:op-uncertain"].status, "FAIL");

  c.outcome.value = "APPLIED";
  const applied = await integration.backupRestore.reconcileOperation("op-uncertain");
  assert.deepEqual(applied, { operationId: "op-uncertain", resolved: true, state: null });
  assert.equal((await remoteOps.get("op-uncertain")).value.state, "SUCCEEDED");
  const list = await integration.backupRestore.recoveryChecklist();
  assert.equal(list.failing, 0);
  assert.equal(list.releasable, true);
  await assert.rejects(() => integration.backupRestore.reconcileOperation("op-uncertain"),
    (error) => error.code === BACKUP_ERROR_CODES.OPERATION_NOT_FOUND);
  assert.equal((await integration.backupRestore.reconcileAndRelease()).released, true);
  await assert.rejects(() => integration.backupRestore.reconcileOperation("op-prepared"),
    (error) => error.code === BACKUP_ERROR_CODES.NOT_HELD);
});

test("A041-02 U checklist presentation: Resume only when Core says releasable and nothing fails", () => {
  const held = { hold: { state: "RECOVERY_HOLD" }, releasable: true, items: [
    { id: "check:a", kind: "check", label: "A", status: "PASS", subject: { kind: "settings", id: "modules" } },
    { id: "operation:x", kind: "operation", label: "X", status: "FAIL", subject: { kind: "generator", id: "g" }, operationId: "x", reconcilable: true }
  ] };
  const view = presentPcmsRecoveryChecklist(held);
  assert.equal(view.canResume, false, "a failing row blocks resume even if a stale releasable flag says otherwise");
  assert.equal(view.rows[1].operationId, "x");
  assert.equal(presentPcmsRecoveryChecklist({ ...held, items: [held.items[0]], releasable: false }).canResume, false);
  assert.equal(presentPcmsRecoveryChecklist({ ...held, items: [held.items[0]] }).canResume, true);
  assert.equal(presentPcmsRecoveryChecklist({ hold: { state: "NORMAL" }, items: held.items, releasable: false }).canResume, false);

  assert.equal(pcmsChecklistSubjectHref({ kind: "module", id: "acme.reports" }), "#/m/acme.reports");
  assert.equal(pcmsChecklistSubjectHref({ kind: "settings", id: "diagnostics" }), "#/settings/diagnostics");
  assert.equal(pcmsChecklistSubjectHref({ kind: "attention", id: null }), "#/attention");
  assert.equal(pcmsChecklistSubjectHref({ kind: "module", id: "Not A Module" }), "#/attention", "an unroutable subject still links somewhere safe");
  assert.equal(pcmsChecklistSubjectHref(null), "#/attention");
});
