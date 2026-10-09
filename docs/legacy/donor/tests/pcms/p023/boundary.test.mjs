import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const INTEGRATION_FILES=[
  "extension/pcms/integration/errors.js",
  "extension/pcms/integration/adapters.js",
  "extension/pcms/integration/explorer-deployer.js",
  "extension/pcms/integration/recovery-checks.js",
  "extension/pcms/integration/composition.js"
];

test("A023 boundary: integration Core adds no raw browser/native/IndexedDB/provider transport authority",async()=>{
  const source=(await Promise.all(INTEGRATION_FILES.map(path=>readFile(path,"utf8")))).join("\n");
  for(const forbidden of [
    /\bbrowser\s*(?:\.|\[)/,
    /\bchrome\s*(?:\.|\[)/,
    /\bindexedDB\b/,
    /sendNativeMessage|connectNative|nativeMessaging/,
    /management-integration|persona-api|mullvad-native/i,
    /\beval\s*\(|new\s+Function\b/,
    /\bfetch\s*\(/
  ]) assert.doesNotMatch(source,forbidden);
});

test("A023 boundary: composition depends on feature factories, never imports feature policy into Core",async()=>{
  const source=await readFile("extension/pcms/integration/composition.js","utf8");
  assert.doesNotMatch(source,/pcms-modules\//);
  assert.match(source,/featureFactories/);
  assert.match(source,/createPcmsUiProjectionService/);
  assert.match(source,/createModuleLifecycleService/);
  assert.match(source,/createBackupRestoreService/);
  assert.match(source,/createIntegrationRecoveryChecks/);
});

test("A023 boundary: Explorer->Deployer bridge is local-state composition, not a provider mutation path",async()=>{
  const source=await readFile("extension/pcms/integration/explorer-deployer.js","utf8");
  assert.match(source,/getDeploymentReservation/);
  assert.match(source,/createDeployment/);
  assert.doesNotMatch(source,/ProviderGate|RemoteOperation|mutate\s*\(|reconcile\s*\(|generator\.update/);
});

test("A023 boundary: shared module state uses explicit bounded namespaces rather than raw storage handles",async()=>{
  const source=await readFile("extension/pcms/integration/composition.js","utf8");
  for(const namespace of ["module.accounts","module.deployer","module.explorer","module.refresher","module.provisioning"]){
    assert.match(source,new RegExp(namespace.replace(".","\\.")));
  }
  assert.doesNotMatch(source,/\.admin\b|replaceAllRecords|listAllRecords/);
});
