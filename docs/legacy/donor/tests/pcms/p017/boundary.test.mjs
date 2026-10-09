import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES=[
  "pcms-modules/p017/errors.js",
  "pcms-modules/p017/schema-input.js",
  "pcms-modules/p017/schema.js",
  "pcms-modules/p017/refresher-helpers.js",
  "pcms-modules/p017/refresher-store.js",
  "pcms-modules/p017/refresher-operations.js",
  "pcms-modules/p017/refresher.js"
];

test("A017-01/A017-02/A017-03 Refresher stays behind bounded PCMS/provider capabilities",async()=>{
  const source=(await Promise.all(FILES.map(path=>readFile(path,"utf8")))).join("\n");
  assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/i);
  assert.doesNotMatch(source,/personamonkey.*(?:service|state)|management-api|mullvad-native/i);
  assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\b/);
  assert.doesNotMatch(source,/document\.|querySelector|MutationObserver|fetch\s*\(/);
  assert.doesNotMatch(source,/password|credential|secretRef|accessToken|refreshToken/i);
});

test("A017-02 schedules stay module-owned and do not create a second scheduler",async()=>{
  const source=await readFile("pcms-modules/p017/refresher.js","utf8");
  assert.doesNotMatch(source,/createTimerService|timerService|setInterval|setTimeout/);
});

test("A017-03 mutation uses accepted generator.update only through ProviderGate",async()=>{
  const source=(await Promise.all(FILES.map(path=>readFile(path,"utf8")))).join("\n");
  assert.match(source,/PERCHANCE_GENERATOR_UPDATE_ACTION/);
  assert.match(source,/gate\.mutate/);
  assert.match(source,/gate\.reconcile/);
  assert.doesNotMatch(source,/updateGenerator\s*\(|reconcileGeneratorUpdate\s*\(/);
});
