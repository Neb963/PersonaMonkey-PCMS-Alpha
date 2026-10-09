import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES=[
 "extension/pcms/remoteops/errors.js","extension/pcms/remoteops/schema.js","extension/pcms/remoteops/remote-ops.js",
 "extension/pcms/remoteops/recovery-hold.js","extension/pcms/remoteops/provider-gate.js"
];

test("A010-01/A010-02 P010 stays behind storage/provider boundaries",async()=>{
 const source=(await Promise.all(FILES.map(p=>readFile(p,"utf8")))).join("\n");
 assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
 assert.doesNotMatch(source,/sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/);
 assert.doesNotMatch(source,/management-integration|persona-api|mullvad-native|cookieStoreId|userScripts/i);
 assert.doesNotMatch(source,/createObjectStore|PCMS_DB_VERSION|PCMS_MIGRATIONS|onupgradeneeded/);
});

test("A010-02 ProviderGate has no blind automatic retry loop",async()=>{
 const source=await readFile("extension/pcms/remoteops/provider-gate.js","utf8");
 assert.doesNotMatch(source,/while\s*\(|setInterval|setTimeout|retry\s*\(/i);
 assert.match(source,/RECONCILE_REQUIRED/);
});

test("A010-03 recovery hold explicitly names all architectural reconciliation checks",async()=>{
 const source=await readFile("extension/pcms/remoteops/recovery-hold.js","utf8");
 for(const key of ["moduleGenerations","personaBindings","providerCapabilities"])assert.match(source,new RegExp(key));
 assert.match(source,/listUnresolved/);
});
