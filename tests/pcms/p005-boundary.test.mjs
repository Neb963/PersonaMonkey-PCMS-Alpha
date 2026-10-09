import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES=[
  "extension/pcms/storage/errors.js",
  "extension/pcms/storage/migrations.js",
  "extension/pcms/storage/indexeddb-backend.js",
  "extension/pcms/storage/storage-broker.js"
];

test("A005-02 storage broker stays inside the PCMS persistence boundary", async () => {
  const source=(await Promise.all(FILES.map((path)=>readFile(path,"utf8")))).join("\n");

  assert.doesNotMatch(source,/\bbrowser\s*\./);
  assert.doesNotMatch(source,/\bchrome\s*\./);
  assert.doesNotMatch(source,/runtime\.sendNativeMessage|connectNative/);
  assert.doesNotMatch(source,/persona(?:Monkey)?(?:Service|State)|cookieStoreId|mullvad/i);

  const broker=await readFile("extension/pcms/storage/storage-broker.js","utf8");
  assert.doesNotMatch(broker,/\bindexedDB\b/);
  assert.match(broker,/namespace:\s*namespaceStore/);
  assert.match(broker,/compareAndSwap/);
  assert.match(broker,/deleteCompareAndSwap/);
});

test("A005-01 migration authority is centralized and versioned", async () => {
  const migration=await readFile("extension/pcms/storage/migrations.js","utf8");
  const backend=await readFile("extension/pcms/storage/indexeddb-backend.js","utf8");

  assert.match(migration,/PCMS_DB_VERSION\s*=\s*1/);
  assert.match(migration,/PCMS_MIGRATIONS/);
  assert.match(migration,/createObjectStore\(PCMS_RECORD_STORE/);
  assert.match(backend,/onupgradeneeded/);
  assert.match(backend,/applyPcmsMigrations/);
  assert.match(backend,/transaction\(PCMS_RECORD_STORE, "readwrite"\)/);
});
