import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MODULE_FILES=[
  "pcms-modules/p014/errors.js",
  "pcms-modules/p014/schema.js",
  "pcms-modules/p014/accounts.js"
];

test("A014-01/A014-02/A014-03 Accounts module has no raw privileged or persistence authority",async()=>{
  const source=(await Promise.all(MODULE_FILES.map((path)=>readFile(path,"utf8")))).join("\n");
  assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/i);
  assert.doesNotMatch(source,/personamonkey.*(?:service|state)|management-api|mullvad-native/i);
  assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\b/);
  assert.doesNotMatch(source,/password|credential|secretRef|accessToken|refreshToken/i);
});

test("A014-03 durable account schema never includes cookieStoreId",async()=>{
  const schema=await readFile("pcms-modules/p014/schema.js","utf8");
  assert.doesNotMatch(schema,/cookieStoreId/);
  const accounts=await readFile("pcms-modules/p014/accounts.js","utf8");
  assert.match(accounts,/cookieStoreId/);
  assert.match(accounts,/reconcileBindings/);
});
