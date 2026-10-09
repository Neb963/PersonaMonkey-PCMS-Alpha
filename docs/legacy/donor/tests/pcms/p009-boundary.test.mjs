import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILE="extension/pcms/core/persona-broker.js";

test("A009-01 Persona Broker adapter has no raw PersonaMonkey/browser/native authority",async()=>{
  const source=await readFile(FILE,"utf8");
  assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/i);
  assert.doesNotMatch(source,/(?:\.\.\/)+lib\/|management-integration|persona-api|mullvad-native|cookieStoreId|userScripts/i);
});

test("A009-02 broker never invents mutation operation IDs or state preconditions",async()=>{
  const source=await readFile(FILE,"utf8");
  assert.doesNotMatch(source,/randomUUID|operationIdFactory|preconditionFactory/);
  assert.match(source,/createPersonaBrokerRequest\(cloned\)/);
});
