import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES=[
  "extension/pcms/secrets/errors.js",
  "extension/pcms/secrets/secret-ref.js",
  "extension/pcms/secrets/protocol.js",
  "extension/pcms/secrets/native-secret-backend.js",
  "extension/pcms/secrets/secret-store.js"
];

test("A006-01/A006-02 secret subsystem is isolated from ordinary PCMS state and PersonaMonkey internals", async () => {
  const source=(await Promise.all(FILES.map((path)=>readFile(path,"utf8")))).join("\n");

  assert.doesNotMatch(source,/\.\.\/storage\//i);
  assert.doesNotMatch(source,/indexedDB|createPcmsStorageBroker|PCMS_RECORD_STORE/);
  assert.doesNotMatch(source,/management-integration|persona-broker|persona-api|cookieStoreId/i);
  assert.doesNotMatch(source,/com\.persona\.mullvad_router|mullvad-native|mullvadRuntime/i);
  assert.doesNotMatch(source,/\bconsole\s*\.|logger\s*\.|\.log\s*\(/);
});

test("A006-02 only the narrow backend adapter knows the native transport contract", async () => {
  const backend=await readFile("extension/pcms/secrets/native-secret-backend.js","utf8");
  const store=await readFile("extension/pcms/secrets/secret-store.js","utf8");
  const protocol=await readFile("extension/pcms/secrets/protocol.js","utf8");

  assert.match(protocol,/com\.persona\.pcms_secret_store/);
  assert.match(backend,/sendNativeMessage/);
  assert.doesNotMatch(backend,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(store,/sendNativeMessage|connectNative|\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.match(store,/resolveForPrivilegedUse/);
  assert.match(store,/describeRef/);
});

test("A006-03 error vocabulary and diagnostics contain no secret values or backend exception text", async () => {
  const errors=await readFile("extension/pcms/secrets/errors.js","utf8");
  const refs=await readFile("extension/pcms/secrets/secret-ref.js","utf8");

  assert.match(errors,/Secret backend is unavailable/);
  assert.match(errors,/Secret backend protocol failed/);
  assert.doesNotMatch(errors,/cause\s*=/);
  assert.match(refs,/pcms-secret:v1:\[opaque\]/);
});
