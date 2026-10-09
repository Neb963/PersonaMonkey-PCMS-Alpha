import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES = [
  "extension/pcms/runtime/errors.js",
  "extension/pcms/runtime/module-runtime.js"
];

test("A011-01/A011-02 runtime broker remains behind approved PCMS boundaries", async () => {
  const source = (await Promise.all(FILES.map((path) => readFile(path, "utf8")))).join("\n");
  assert.doesNotMatch(source, /\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source, /sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/);
  assert.doesNotMatch(source, /management-integration|persona-api|mullvad-native|cookieStoreId|userScripts/i);
  assert.doesNotMatch(source, /createObjectStore|PCMS_DB_VERSION|PCMS_MIGRATIONS|onupgradeneeded/);
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b/);
});

test("A011-02/A011-03 runtime uses package authority, sandbox host, durable generation state, and recovery hold", async () => {
  const source = await readFile("extension/pcms/runtime/module-runtime.js", "utf8");
  assert.match(source, /pkg\.manifest\.authority\.capabilities/);
  assert.match(source, /createSandboxControllerHost/);
  assert.match(source, /MODULE_RUNTIME_NAMESPACE = "core\.module-runtime"/);
  assert.match(source, /generation/);
  assert.match(source, /RECOVERY_HOLD/);
  assert.match(source, /recoverAll/);
});
