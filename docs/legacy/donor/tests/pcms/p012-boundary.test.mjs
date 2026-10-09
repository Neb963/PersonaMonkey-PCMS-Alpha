import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES=[
  "extension/pcms/services/errors.js",
  "extension/pcms/services/registry.js",
  "extension/pcms/services/human-tasks.js",
  "extension/pcms/services/timers.js"
];

test("A012-01/A012-02/A012-03 services remain behind approved PCMS boundaries",async()=>{
  const source=(await Promise.all(FILES.map(path=>readFile(path,"utf8")))).join("\n");
  assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/i);
  assert.doesNotMatch(source,/management-integration|persona-api|mullvad-native|cookieStoreId|userScripts/i);
  assert.doesNotMatch(source,/createObjectStore|PCMS_DB_VERSION|PCMS_MIGRATIONS|onupgradeneeded/);
  assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\b/);
});

test("A012-01/A012-02 authoritative HumanTask and timer transitions use the audit transition primitive",async()=>{
  const human=await readFile("extension/pcms/services/human-tasks.js","utf8");
  const timers=await readFile("extension/pcms/services/timers.js","utf8");
  assert.match(human,/auditJournal\.transitionAndAppend/);
  assert.match(timers,/auditJournal\.transitionAndAppend/);
  assert.match(timers,/DISPATCHING/);
  assert.match(timers,/recoverInterrupted/);
  assert.doesNotMatch(timers,/setInterval|setTimeout/);
});
