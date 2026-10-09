import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MODULE_FILES=[
  "pcms-modules/p016/errors.js",
  "pcms-modules/p016/schema.js",
  "pcms-modules/p016/explorer.js"
];

test("A016-01/A016-02/A016-03 Explorer stays behind bounded account/discovery state capabilities",async()=>{
  const source=(await Promise.all(MODULE_FILES.map((path)=>readFile(path,"utf8")))).join("\n");
  assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/i);
  assert.doesNotMatch(source,/personamonkey.*(?:service|state)|management-api|mullvad-native/i);
  assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\b/);
  assert.doesNotMatch(source,/document\.|querySelector|MutationObserver|fetch\s*\(/);
  assert.doesNotMatch(source,/password|credential|secretRef|accessToken|refreshToken/i);
});

test("A016-01 discovery schema stores observed hashes and identifiers, never generator source bytes",async()=>{
  const schema=await readFile("pcms-modules/p016/schema.js","utf8");
  assert.doesNotMatch(schema,/[\"']source[\"']/);
  assert.match(schema,/observedSourceHash/);
});

test("A016-02 Explorer reservations are local durable state, not external provider mutations",async()=>{
  const explorer=await readFile("pcms-modules/p016/explorer.js","utf8");
  assert.doesNotMatch(explorer,/gate\.mutate|gate\.reconcile|RemoteOperation|remoteOps/i);
  assert.doesNotMatch(explorer,/updateGenerator\s*\(|reconcileGeneratorUpdate\s*\(/);
  assert.doesNotMatch(explorer,/p015|createDeployment\s*\(/i);
});
