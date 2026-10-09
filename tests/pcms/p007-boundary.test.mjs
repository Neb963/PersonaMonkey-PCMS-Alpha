import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES = [
  "extension/pcms/audit/errors.js",
  "extension/pcms/audit/schema.js",
  "extension/pcms/audit/indexeddb-journal.js",
  "extension/pcms/audit/journal.js"
];

test("A007-01 audit journal stays inside PCMS storage authority and does not allocate a migration", async () => {
  const source = (await Promise.all(FILES.map((path) => readFile(path, "utf8")))).join("\n");
  assert.doesNotMatch(source, /\bbrowser\s*\.|\bchrome\s*\./);
  assert.doesNotMatch(source, /runtime\.sendNativeMessage|connectNative/);
  assert.doesNotMatch(source, /persona(?:Monkey)?(?:Service|State)|cookieStoreId|mullvad/i);
  assert.doesNotMatch(source, /createObjectStore|PCMS_DB_VERSION\s*=/);

  const backend = await readFile("extension/pcms/audit/indexeddb-journal.js", "utf8");
  assert.match(backend, /transaction\(PCMS_RECORD_STORE, "readwrite"\)/);
  assert.match(backend, /store\.put\(nextState\)/);
  assert.match(backend, /store\.add\(makeEventRecord\(event\)\)/);
  assert.match(backend, /store\.put\(makeMetaRecord\(event\.sequence/);
});

test("A007-02 public journal exposes append/read/projection only, not an event bus or raw IndexedDB", async () => {
  const journal = await readFile("extension/pcms/audit/journal.js", "utf8");
  assert.doesNotMatch(journal, /\bindexedDB\b|dispatchEvent|BroadcastChannel|runtime\.sendMessage/);
  assert.match(journal, /append,/);
  assert.match(journal, /transitionAndAppend,/);
  assert.match(journal, /read,/);
  assert.match(journal, /project/);
  assert.match(journal, /reducer must be synchronous/);
});

test("A007-03 journal records are projections/evidence, not an event-sourced domain store", async () => {
  const architecture = await readFile("docs/architecture/01-system-architecture.md", "utf8");
  assert.match(architecture, /Audit Journal is append\/read\/projection infrastructure only/);
  assert.match(architecture, /not an event-sourced domain store or workflow bus/);
});
