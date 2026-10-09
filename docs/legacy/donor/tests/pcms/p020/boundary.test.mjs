import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("A020 boundary: recovery core has no browser/native/secret-value authority",async()=>{
  const source=(await Promise.all(["errors.js","schema.js","retention.js","backup-restore.js"].map(name=>readFile(new URL(`../../../extension/pcms/recovery/${name}`,import.meta.url),"utf8")))).join("\n");
  for(const forbidden of [/\bbrowser\s*\./,/\bchrome\s*\./,/sendNativeMessage/,/\bnativeMessaging\b/,/resolveForPrivilegedUse/,/secretValue/i,/\bpassword\b/i,/\bpassphrase\b/i,/\beval\s*\(/]) {
    assert.equal(forbidden.test(source),false,`forbidden authority/token: ${forbidden}`);
  }
});

test("A020 boundary: restore uses privileged broker administration, RECOVERY_HOLD and no replay dispatch",async()=>{
  const source=await readFile(new URL("../../../extension/pcms/recovery/backup-restore.js",import.meta.url),"utf8");
  assert.match(source,/storageBroker\.admin/);
  assert.match(source,/enterRecoveryHold/);
  assert.match(source,/recoverInterruptedDispatches/);
  assert.match(source,/gate\.reconcile/);
  assert.doesNotMatch(source,/gate\.mutate|beginDispatch|markSucceeded|markFailed/);
});

test("A020 boundary: IndexedDB full replacement is one readwrite transaction",async()=>{
  const source=await readFile(new URL("../../../extension/pcms/storage/indexeddb-backend.js",import.meta.url),"utf8");
  const start=source.indexOf("function replaceAllRecords");
  const end=source.indexOf("\n  return Object.freeze",start);
  const slice=source.slice(start,end);
  assert.match(slice,/transaction\(PCMS_RECORD_STORE, "readwrite"\)/);
  assert.match(slice,/store\.clear\(\)/);
  assert.match(slice,/store\.put\(/);
  assert.match(slice,/transaction\.onabort/);
});
