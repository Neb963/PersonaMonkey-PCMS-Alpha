import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES=[
  "extension/pcms/modules/errors.js",
  "extension/pcms/modules/authority.js",
  "extension/pcms/modules/package.js",
  "extension/pcms/modules/registry.js"
];

test("A008-01 P008 remains a package/authority model without privileged execution", async () => {
  const source=(await Promise.all(FILES.map((p)=>readFile(p,"utf8")))).join("\n");
  assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/sendNativeMessage|connectNative|nativeMessaging/);
  assert.doesNotMatch(source,/\bindexedDB\b/);
  assert.doesNotMatch(source,/management-integration|mullvad-native|cookieStoreId|userScripts/i);
  assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\b/);
});

test("A008-02 authority envelope excludes raw privileged roots and wildcards", async () => {
  const source=await readFile("extension/pcms/modules/authority.js","utf8");
  assert.match(source,/RESERVED_ROOTS/);
  assert.match(source,/browser/);
  assert.match(source,/chrome/);
  assert.match(source,/indexeddb/);
});

test("A008-03 registry uses only the PCMS storage broker namespace and does not allocate schema", async () => {
  const source=await readFile("extension/pcms/modules/registry.js","utf8");
  assert.match(source,/MODULE_REGISTRY_NAMESPACE = "core\.modules"/);
  assert.match(source,/storageBroker\.namespace\(MODULE_REGISTRY_NAMESPACE\)/);
  assert.doesNotMatch(source,/createObjectStore|PCMS_DB_VERSION|PCMS_MIGRATIONS|onupgradeneeded/);
  assert.doesNotMatch(source,/generation/i);
});
