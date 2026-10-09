import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("A022 boundary: lifecycle has no browser/native/raw IndexedDB/secret authority",async()=>{
  const source=(await Promise.all([
    "extension/pcms/modules/lifecycle.js",
    "extension/pcms/modules/lifecycle-errors.js"
  ].map(path=>readFile(path,"utf8")))).join("\n");
  for(const forbidden of [
    /\bbrowser\s*(?:\.|\[)/,
    /\bchrome\s*(?:\.|\[)/,
    /\bindexedDB\b/,
    /sendNativeMessage|nativeMessaging/,
    /resolveForPrivilegedUse|secretValue/i,
    /\beval\s*\(/
  ]) assert.doesNotMatch(source,forbidden);
});

test("A022 boundary: lifecycle composes accepted registry/runtime surfaces and does not dispatch provider/browser operations",async()=>{
  const source=await readFile("extension/pcms/modules/lifecycle.js","utf8");
  assert.match(source,/stageCandidate/);
  assert.match(source,/admitCandidate/);
  assert.match(source,/prepareUpdate/);
  assert.match(source,/rollbackAdmission/);
  assert.match(source,/disable/);
  assert.match(source,/deletePackage/);
  assert.doesNotMatch(source,/ProviderGate|RemoteOperation|persona\.control|execution\.|fetch\s*\(/);
});

test("A022 boundary: purge preserves generation fencing by never deleting runtime state",async()=>{
  const source=await readFile("extension/pcms/modules/lifecycle.js","utf8");
  const start=source.indexOf("async function purge");
  const end=source.indexOf("async function getState",start);
  const slice=source.slice(start,end);
  assert.match(slice,/runtime\.getState/);
  assert.doesNotMatch(slice,/runtime\.purge|delete.*runtime|MODULE_RUNTIME_NAMESPACE/);
});
