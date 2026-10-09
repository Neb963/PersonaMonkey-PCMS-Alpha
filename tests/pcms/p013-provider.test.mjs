import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteOps } from "../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../extension/pcms/remoteops/provider-gate.js";
import { REMOTE_OP_ERROR_CODES } from "../../extension/pcms/remoteops/errors.js";
import { createPerchanceProviderAdapter } from "../../extension/pcms/providers/perchance/adapter.js";
import {
  generatorSourceFingerprint,
  sha256Hex
} from "../../extension/pcms/providers/perchance/contract.js";
import { PERCHANCE_PROVIDER_ERROR_CODES } from "../../extension/pcms/providers/perchance/errors.js";
import { createPerchanceEmulator } from "../../extension/pcms/providers/perchance/emulator.js";
import { makeStorage } from "./p010-harness.mjs";

const NEW_SOURCE="new source";
const OLD_SOURCE="old source";
const NEW_HASH="eb326958738d171e78bdff8117386308557c0f4d19783441bca3dea03314d2bc";
const OLD_HASH="470f5e33c65605ccb235dfaab0f3bc914bb2c23ea7a408bf3ad81218feae39a2";

function operation(operationId="op-1",sourceHash=NEW_HASH){
  return {
    operationId,
    providerId:"perchance",
    action:"generator.update",
    targetRef:{kind:"generator",id:"gen-123"},
    intentFingerprint:generatorSourceFingerprint(sourceHash)
  };
}

function setup(){
  const storage=makeStorage();
  const remoteOps=createRemoteOps({storageBroker:storage});
  const recoveryHold=createRecoveryHoldController({storageBroker:storage,remoteOps});
  const emulator=createPerchanceEmulator();
  const adapter=createPerchanceProviderAdapter({driver:emulator.driver});
  const gate=createProviderGate({
    remoteOps,
    recoveryHold,
    providers:{perchance:adapter.providerDescriptor}
  });
  return {storage,remoteOps,recoveryHold,emulator,adapter,gate};
}

test("A013-01 compatibility probe accepts only the exact PCMS Perchance driver contract",async()=>{
  const h=setup();
  const compatible=await h.adapter.probeCompatibility();
  assert.deepEqual(compatible,{
    contractId:"pcms.perchance.driver",
    contractVersion:1,
    providerId:"perchance",
    operations:["generator.update"]
  });
  h.emulator.setCompatible(false);
  await assert.rejects(
    h.adapter.probeCompatibility(),
    error=>error?.code===PERCHANCE_PROVIDER_ERROR_CODES.INCOMPATIBLE
  );
});

test("A013-01 driver and compatibility boundaries reject accessors without invoking them",async()=>{
  let invoked=0;
  const driver={};
  Object.defineProperty(driver,"probe",{enumerable:true,get(){invoked+=1;return async()=>({});}});
  Object.defineProperty(driver,"updateGenerator",{enumerable:true,value:async()=>({status:"APPLIED"})});
  Object.defineProperty(driver,"reconcileGeneratorUpdate",{enumerable:true,value:async()=>({status:"UNKNOWN"})});
  assert.throws(()=>createPerchanceProviderAdapter({driver}),TypeError);
  assert.equal(invoked,0);

  const badSnapshot={contractId:"pcms.perchance.driver",contractVersion:1,providerId:"perchance"};
  Object.defineProperty(badSnapshot,"operations",{enumerable:true,get(){invoked+=1;return["generator.update"];}});
  const adapter=createPerchanceProviderAdapter({driver:{
    probe:async()=>badSnapshot,
    updateGenerator:async()=>({status:"APPLIED"}),
    reconcileGeneratorUpdate:async()=>({status:"UNKNOWN"})
  }});
  await assert.rejects(adapter.probeCompatibility(),error=>error?.code===PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  assert.equal(invoked,0);
});

test("A013-01 admitted driver method surface cannot be replaced after adapter construction",async()=>{
  const driver={
    probe:async()=>({contractId:"pcms.perchance.driver",contractVersion:1,providerId:"perchance",operations:["generator.update"]}),
    updateGenerator:async()=>({status:"APPLIED"}),
    reconcileGeneratorUpdate:async()=>({status:"UNKNOWN"})
  };
  const adapter=createPerchanceProviderAdapter({driver});
  driver.probe=async()=>({contractId:"pcms.perchance.driver",contractVersion:999,providerId:"perchance",operations:["generator.update"]});
  assert.equal((await adapter.probeCompatibility()).contractVersion,1);
});

test("A013-02 deterministic emulator applies generator.update through ProviderGate",async()=>{
  const h=setup();
  h.emulator.seedGenerator({generatorId:"gen-123",sourceHash:OLD_HASH,source:OLD_SOURCE});
  const result=await h.gate.mutate({
    operation:operation(),
    dispatchInput:{sourceHash:NEW_HASH,source:NEW_SOURCE}
  });
  assert.equal(result.status,"APPLIED");
  assert.equal(result.operation.value.state,"SUCCEEDED");
  assert.deepEqual(h.emulator.getGenerator("gen-123"),{
    generatorId:"gen-123",sourceHash:NEW_HASH,source:NEW_SOURCE
  });
  assert.equal(await sha256Hex(NEW_SOURCE),NEW_HASH);
});

test("A013-02 pre-apply ambiguity reconciles NOT_APPLIED before retry",async()=>{
  const h=setup();
  h.emulator.seedGenerator({generatorId:"gen-123",sourceHash:OLD_HASH,source:OLD_SOURCE});
  h.emulator.failNext("before-apply");
  await assert.rejects(
    h.gate.mutate({operation:operation(),dispatchInput:{sourceHash:NEW_HASH,source:NEW_SOURCE}}),
    error=>error?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL
  );
  assert.equal((await h.remoteOps.get("op-1")).value.state,"UNCERTAIN");
  assert.equal(h.emulator.getGenerator("gen-123").sourceHash,OLD_HASH);
  const reconciled=await h.gate.reconcile("op-1");
  assert.equal(reconciled.value.state,"RETRYABLE");
  const retried=await h.gate.mutate({operation:operation(),dispatchInput:{sourceHash:NEW_HASH,source:NEW_SOURCE}});
  assert.equal(retried.operation.value.state,"SUCCEEDED");
});

test("A013-02 post-apply ambiguity reconciles APPLIED without replay",async()=>{
  const h=setup();
  h.emulator.failNext("after-apply");
  await assert.rejects(
    h.gate.mutate({operation:operation(),dispatchInput:{sourceHash:NEW_HASH,source:NEW_SOURCE}}),
    error=>error?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL
  );
  assert.equal(h.emulator.getGenerator("gen-123").sourceHash,NEW_HASH);
  const reconciled=await h.gate.reconcile("op-1");
  assert.equal(reconciled.value.state,"SUCCEEDED");
  const repeat=await h.gate.mutate({operation:operation(),dispatchInput:{sourceHash:NEW_HASH,source:NEW_SOURCE}});
  assert.equal(repeat.status,"ALREADY_APPLIED");
});

test("A013-03 missing reconciliation evidence remains UNKNOWN and fenced",async()=>{
  const h=setup();
  h.emulator.failNext("after-apply");
  await assert.rejects(
    h.gate.mutate({operation:operation(),dispatchInput:{sourceHash:NEW_HASH,source:NEW_SOURCE}}),
    error=>error?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL
  );
  h.emulator.clearReceipts();
  const reconciled=await h.gate.reconcile("op-1");
  assert.equal(reconciled.value.state,"UNCERTAIN");
  assert.equal(reconciled.value.resolution,"RECONCILED_UNKNOWN");
  await assert.rejects(
    h.gate.mutate({operation:operation(),dispatchInput:{sourceHash:NEW_HASH,source:NEW_SOURCE}}),
    error=>error?.code===REMOTE_OP_ERROR_CODES.RECONCILE_REQUIRED
  );
});

test("A013-03 malformed provider outcomes fail closed and reconcile from explicit receipt",async()=>{
  const h=setup();
  h.emulator.failNext("malformed");
  await assert.rejects(
    h.gate.mutate({operation:operation(),dispatchInput:{sourceHash:NEW_HASH,source:NEW_SOURCE}}),
    error=>error?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL
  );
  assert.equal((await h.remoteOps.get("op-1")).value.state,"UNCERTAIN");
  const reconciled=await h.gate.reconcile("op-1");
  assert.equal(reconciled.value.state,"SUCCEEDED");
});

test("A013-03 source hash mismatch never reaches the provider driver",async()=>{
  const h=setup();
  h.emulator.seedGenerator({generatorId:"gen-123",sourceHash:OLD_HASH,source:OLD_SOURCE});
  await assert.rejects(
    h.gate.mutate({operation:operation(),dispatchInput:{sourceHash:NEW_HASH,source:OLD_SOURCE}}),
    error=>error?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL
  );
  assert.equal(h.emulator.getGenerator("gen-123").sourceHash,OLD_HASH);
  assert.equal((await h.remoteOps.get("op-1")).value.state,"UNCERTAIN");
});

test("A013-03 compatibility is re-probed for every mutation and fails closed on drift",async()=>{
  const h=setup();
  await h.adapter.probeCompatibility();
  h.emulator.setCompatible(false);
  await assert.rejects(
    h.gate.mutate({operation:operation(),dispatchInput:{sourceHash:NEW_HASH,source:NEW_SOURCE}}),
    error=>error?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL
  );
  assert.equal(h.emulator.getGenerator("gen-123"),null);
  assert.equal((await h.remoteOps.get("op-1")).value.state,"UNCERTAIN");
});
