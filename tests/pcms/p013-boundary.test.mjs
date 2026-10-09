import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES=[
  "extension/pcms/providers/perchance/errors.js",
  "extension/pcms/providers/perchance/contract.js",
  "extension/pcms/providers/perchance/adapter.js",
  "extension/pcms/providers/perchance/emulator.js"
];

test("A013-01/A013-02/A013-03 provider code stays behind PCMS boundaries",async()=>{
  const source=(await Promise.all(FILES.map(path=>readFile(path,"utf8")))).join("\n");
  assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/i);
  assert.doesNotMatch(source,/management-integration|persona-api|mullvad-native|cookieStoreId|userScripts/i);
  assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\b/);
  assert.doesNotMatch(source,/document\.|querySelector|MutationObserver|fetch\s*\(/);
});

test("A013-03 provider adapter exposes only the ProviderGate mutation already established by P010",async()=>{
  const source=await readFile("extension/pcms/providers/perchance/adapter.js","utf8");
  assert.match(source,/PERCHANCE_GENERATOR_UPDATE_ACTION/);
  assert.doesNotMatch(source,/generator\.create|generator\.delete|account\.|explorer|refresher/i);
});
