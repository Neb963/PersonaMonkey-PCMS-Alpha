import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MODULE_FILES=[
  "pcms-modules/p015/errors.js",
  "pcms-modules/p015/schema.js",
  "pcms-modules/p015/deployer.js"
];

test("A015-01/A015-02/A015-03 Deployer stays behind bounded PCMS/provider capabilities",async()=>{
  const source=(await Promise.all(MODULE_FILES.map((path)=>readFile(path,"utf8")))).join("\n");
  assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/i);
  assert.doesNotMatch(source,/personamonkey.*(?:service|state)|management-api|mullvad-native/i);
  assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\b/);
  assert.doesNotMatch(source,/document\.|querySelector|MutationObserver|fetch\s*\(/);
  assert.doesNotMatch(source,/password|credential|secretRef|accessToken|refreshToken/i);
});

test("A015-01 durable schema contains only source hashes, never generator source bytes",async()=>{
  const schema=await readFile("pcms-modules/p015/schema.js","utf8");
  assert.doesNotMatch(schema,/["']source["']/);
  assert.match(schema,/sourceHash/);
});

test("A015-02 mutation uses only the accepted Perchance generator.update contract through ProviderGate",async()=>{
  const deployer=await readFile("pcms-modules/p015/deployer.js","utf8");
  assert.match(deployer,/PERCHANCE_GENERATOR_UPDATE_ACTION/);
  assert.match(deployer,/gate\.mutate/);
  assert.match(deployer,/gate\.reconcile/);
  assert.doesNotMatch(deployer,/updateGenerator\s*\(|reconcileGeneratorUpdate\s*\(/);
  assert.doesNotMatch(deployer,/generator\.create|generator\.delete|account\.create/i);
});
