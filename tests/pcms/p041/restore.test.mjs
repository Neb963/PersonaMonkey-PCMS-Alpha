// A041-01 (U, I, SEC): a restore cannot start without a preview and typed confirmation;
// secrets are never included.
import test from "node:test";
import assert from "node:assert/strict";

import { createBackupRestoreService } from "../../../extension/pcms/recovery/backup-restore.js";
import { BACKUP_ERROR_CODES } from "../../../extension/pcms/recovery/errors.js";
import { confirmStagedRestore, PCMS_RESTORE_CONFIRMATION_PHRASE } from "../../../extension/pcms/recovery/schema.js";
import { getPcmsUiOperation } from "../../../extension/pcms/integration/ui-client-contract.js";
import { makeChecks, makeHold, makeProviderGate, makeRemoteOps, makeRuntime, makeStorage, NOW, record, sha256Hex } from "../p020/harness.mjs";
import { composeCore, UID_A, UID_B } from "./harness.mjs";

const SECRET_REF = "pcms-secret:v1:0f8fad5b-d9cb-469f-a165-70867728950e";

function fixture({ records, clock = () => NOW } = {}) {
  const events = [];
  const storage = makeStorage(records || [
    record("app.accounts", "state", { accounts: [{ id: "a", credentialRef: SECRET_REF }] }),
    record("core.modules", "module:acme.reports", { moduleId: "acme.reports" }),
    record("core.recovery", "hold", { state: "NORMAL" })
  ]);
  const hold = makeHold(events);
  const runtime = makeRuntime(events, []);
  const remote = makeRemoteOps(events, []);
  const gate = makeProviderGate(remote, events, {});
  const service = createBackupRestoreService({
    storageBroker: storage.broker, recoveryHold: hold.api, remoteOps: remote.api, providerGate: gate.api,
    moduleRuntime: runtime.api, reconciliationChecks: makeChecks().api, clock, sha256Hex
  });
  return { events, storage, hold, service };
}

function unchanged(f) {
  assert.equal(f.hold.state, "NORMAL", "no recovery hold was entered");
  assert.equal(f.storage.replacements.length, 0, "no data was replaced");
  assert.equal(f.events.includes("hold.enter"), false);
}

test("A041-01 staging a restore is a read-only preview of what the backup changes", async () => {
  const f = fixture();
  const backup = await f.service.createBackup({ backupId: "b-1" });
  f.storage.set([
    record("app.accounts", "state", { accounts: [] }, { revision: 4 }),
    record("app.extra", "x", { added: true }),
    record("core.recovery", "hold", { state: "NORMAL" })
  ]);
  const staged = await f.service.stageRestore(backup);
  unchanged(f);
  const p = staged.preview;
  assert.equal(p.kind, "pcms-restore-preview");
  assert.match(p.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(p.backupId, "b-1");
  assert.equal(p.backupSha256, backup.sha256);
  assert.equal(p.recordCount, 2);
  assert.equal(p.currentRecordCount, 2, "excluded namespaces are not counted");
  assert.deepEqual(p.differences, { added: 1, changed: 1, removed: 1, unchanged: 0 });
  assert.deepEqual(p.modules, { inBackup: ["acme.reports"], onlyNow: [] });
  assert.deepEqual(p.namespaces.map((row) => [row.namespace, row.backup, row.current]),
    [["app.accounts", 1, 1], ["app.extra", 0, 1], ["core.modules", 1, 0]]);
  assert.equal(p.confirmationPhrase, PCMS_RESTORE_CONFIRMATION_PHRASE);
  assert.ok(p.effects.some((line) => /PersonaMonkey Personas.*not changed/.test(line)));
  assert.ok(p.effects.some((line) => /never contain secret values/.test(line)));
  // The digest binds to the backup only: an identical preview later still confirms.
  f.storage.set([record("app.other", "y", { v: 1 })]);
  assert.equal((await f.service.stageRestore(backup)).preview.previewDigest, p.previewDigest);
});

test("A041-01 a restore cannot start without a preview and the typed confirmation", async () => {
  const f = fixture();
  const backup = await f.service.createBackup({ backupId: "b-1" });
  const staged = await f.service.stageRestore(backup);
  const code = (expected) => (error) => error.code === expected;

  // The raw backup, an unconfirmed stage, and the legacy P020 stage shape are all refused.
  await assert.rejects(() => f.service.applyStagedRestore(backup), code(BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED));
  await assert.rejects(() => f.service.applyStagedRestore(staged), code(BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED));
  const { preview: _drop, ...legacy } = staged;
  await assert.rejects(() => f.service.applyStagedRestore(legacy), code(BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED));
  // The phrase is exact.
  for (const phrase of ["restore", "RESTORE ", "", "yes"]) {
    await assert.rejects(() => f.service.applyStagedRestore({ ...staged, confirmation: { phrase, previewDigest: staged.preview.previewDigest } }),
      code(BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED), phrase);
  }
  assert.throws(() => confirmStagedRestore(staged, "restore"), code(BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED));
  // The confirmation must name this preview.
  const forged = "0".repeat(64);
  await assert.rejects(() => f.service.applyStagedRestore({ ...staged, confirmation: { phrase: "RESTORE", previewDigest: forged } }),
    code(BACKUP_ERROR_CODES.PREVIEW_MISMATCH));
  await assert.rejects(() => f.service.applyStagedRestore({
    ...staged, preview: { ...staged.preview, previewDigest: forged }, confirmation: { phrase: "RESTORE", previewDigest: forged }
  }), code(BACKUP_ERROR_CODES.PREVIEW_MISMATCH));
  // A confirmed preview of one backup cannot carry another backup.
  const other = await f.service.createBackup({ backupId: "b-2" });
  await assert.rejects(() => f.service.applyStagedRestore({ ...confirmStagedRestore(staged, "RESTORE"), backup: other }),
    code(BACKUP_ERROR_CODES.PREVIEW_MISMATCH));
  unchanged(f);

  const report = await f.service.applyStagedRestore(confirmStagedRestore(staged, "RESTORE"));
  assert.equal(report.backupId, "b-1");
  assert.equal(f.hold.state, "RECOVERY_HOLD");
  assert.equal(f.storage.replacements.length, 1);
});

test("A041-01 an expired preview must be produced again", async () => {
  let now = Date.parse(NOW);
  const f = fixture({ clock: () => new Date(now).toISOString() });
  const staged = await f.service.stageRestore(await f.service.createBackup({ backupId: "b-1" }));
  now += 61 * 60 * 1000;
  await assert.rejects(() => f.service.applyStagedRestore(confirmStagedRestore(staged, "RESTORE")),
    (error) => error.code === BACKUP_ERROR_CODES.PREVIEW_MISMATCH);
  unchanged(f);
  const fresh = await f.service.stageRestore(staged.backup);
  await f.service.applyStagedRestore(confirmStagedRestore(fresh, "RESTORE"));
  assert.equal(f.hold.state, "RECOVERY_HOLD");
});

test("A041-01 SEC backups carry SecretRefs and redaction markers only; credential values fail closed", async () => {
  const ok = fixture({ records: [
    record("app.accounts", "state", { accounts: [{ id: "a", credentialRef: SECRET_REF, secretRef: SECRET_REF }] }),
    record("core.audit", "e1", { data: { apiToken: "[REDACTED]", token: "OK" } }),
    record("module.acme.data", "cfg", { apiKey: null, sessionToken: SECRET_REF })
  ] });
  const backup = await ok.service.createBackup({ backupId: "b-ok" });
  assert.equal(backup.recordCount, 3);

  for (const [key, value] of [["password", "hunter2"], ["apiKey", "k-123"], ["accessToken", "tok"], ["secret", "s"],
    ["clientSecret", "c"], ["privateKey", "-----BEGIN"], ["credential", { user: "x" }]]) {
    const leaked = fixture({ records: [record("module.acme.data", "cfg", { nested: [{ [key]: value }] })] });
    await assert.rejects(() => leaked.service.createBackup({ backupId: "b-leak" }),
      (error) => error.code === BACKUP_ERROR_CODES.SECRET_MATERIAL, key);
  }

  // A crafted backup with a valid digest but a credential value is refused before any change.
  const crafted = structuredClone(backup);
  crafted.records[2].value = { password: "hunter2" };
  const { sha256: _old, ...payload } = crafted;
  crafted.sha256 = await sha256Hex(JSON.stringify(payload));
  const target = fixture();
  await assert.rejects(() => target.service.stageRestore(crafted), (error) => error.code === BACKUP_ERROR_CODES.SECRET_MATERIAL);
  unchanged(target);
});

test("A041-01 I integrated Core: preview, typed confirmation, then RECOVERY_HOLD; no secret value in the file", async () => {
  const c = composeCore();
  const { integration, recoveryHold } = c;
  await integration.accounts.createAccount({ accountId: "acct-1", displayName: "Primary", personaUid: UID_A }, { expectedRevision: 0 });
  const backup = await integration.backupRestore.createBackup({ backupId: "pcms-backup-20261008T120000Z" });
  const text = JSON.stringify(backup);
  assert.doesNotMatch(text, /hunter2|BEGIN PRIVATE/);
  await integration.accounts.createAccount({ accountId: "acct-2", displayName: "After", personaUid: UID_B }, { expectedRevision: 1 });

  const staged = await integration.backupRestore.stageRestore(JSON.parse(text));
  assert.equal(staged.preview.differences.changed >= 1, true);
  assert.equal((await recoveryHold.getStatus()).value.state, "NORMAL");
  await assert.rejects(() => integration.backupRestore.applyStagedRestore(staged),
    (error) => error.code === BACKUP_ERROR_CODES.CONFIRMATION_REQUIRED);
  assert.equal((await integration.accounts.listAccounts()).accounts.length, 2, "nothing restored");

  await integration.backupRestore.applyStagedRestore(confirmStagedRestore(staged, "RESTORE"));
  assert.equal((await recoveryHold.getStatus()).value.state, "RECOVERY_HOLD");
  assert.deepEqual((await integration.accounts.listAccounts()).accounts.map((a) => a.accountId), ["acct-1"]);
});

test("A041-01 UI client: stageRestore stays a query; the checklist query and per-item command are declared", () => {
  assert.equal(getPcmsUiOperation("backupRestore.stageRestore").kind, "query");
  assert.equal(getPcmsUiOperation("backupRestore.applyStagedRestore").kind, "command");
  const checklist = getPcmsUiOperation("backupRestore.recoveryChecklist");
  assert.deepEqual([checklist.kind, checklist.arity], ["query", 0]);
  const reconcile = getPcmsUiOperation("backupRestore.reconcileOperation");
  assert.deepEqual([reconcile.kind, reconcile.arity], ["command", 1]);
  assert.ok(reconcile.topics.includes("recovery"));
});
