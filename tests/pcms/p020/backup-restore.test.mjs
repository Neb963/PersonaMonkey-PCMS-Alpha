import test from "node:test";
import assert from "node:assert/strict";

import { createBackupRestoreService } from "../../../extension/pcms/recovery/backup-restore.js";
import { BACKUP_ERROR_CODES } from "../../../extension/pcms/recovery/errors.js";
import { PCMS_BACKUP_EXCLUDED_NAMESPACES, confirmStagedRestore } from "../../../extension/pcms/recovery/schema.js";
import { makeChecks, makeHold, makeProviderGate, makeRemoteOps, makeRuntime, makeStorage, NOW, record, sha256Hex } from "./harness.mjs";

function fixture({records,remoteRows=[],checks}={}){
  const events=[];
  const storage=makeStorage(records||[
    record("app.accounts","state",{accounts:[{id:"a"}]}),
    record("core.recovery","hold",{state:"NORMAL"}),
    record("core.backups","meta",{kept:true})
  ]);
  const hold=makeHold(events);
  const runtime=makeRuntime(events);
  const remote=makeRemoteOps(events,remoteRows);
  const gate=makeProviderGate(remote,events,{});
  const rc=checks||makeChecks();
  const service=createBackupRestoreService({
    storageBroker:storage.broker,recoveryHold:hold.api,remoteOps:remote.api,providerGate:gate.api,moduleRuntime:runtime.api,
    reconciliationChecks:rc.api,clock:()=>NOW,sha256Hex
  });
  return {events,storage,hold,runtime,remote,gate,checks:rc,service};
}

test("A020-01 backup is deterministic, integrity-protected, and excludes recovery/retention namespaces",async()=>{
  const f=fixture();
  const backup=await f.service.createBackup({backupId:"b-1"});
  assert.equal(backup.backupId,"b-1");
  assert.equal(backup.recordCount,1);
  assert.deepEqual(backup.records.map(r=>r.namespace),["app.accounts"]);
  assert.equal(backup.sha256.length,64);
  assert.equal(PCMS_BACKUP_EXCLUDED_NAMESPACES.includes("core.recovery"),true);
  assert.equal(PCMS_BACKUP_EXCLUDED_NAMESPACES.includes("core.backups"),true);
  const staged=await f.service.stageRestore(backup);
  assert.equal(staged.backup.sha256,backup.sha256);
});

test("A020-01 tampered backup fails closed before restore",async()=>{
  const f=fixture();
  const backup=await f.service.createBackup({backupId:"b-1"});
  const tampered=structuredClone(backup);
  tampered.records[0].value={accounts:[{id:"changed"}]};
  await assert.rejects(()=>f.service.stageRestore(tampered),(e)=>e.code===BACKUP_ERROR_CODES.INTEGRITY_MISMATCH);
  assert.equal(f.hold.state,"NORMAL");
  assert.equal(f.storage.replacements.length,0);
});

test("A020-02 staged restore enters hold, quiesces runtime, preserves excluded namespaces, then atomically replaces",async()=>{
  const f=fixture();
  const backup=await f.service.createBackup({backupId:"b-restore"});
  f.storage.set([
    record("app.accounts","state",{accounts:[{id:"current"}]}, {revision:7}),
    record("core.recovery","hold",{state:"CURRENT-HOLD"}, {revision:9}),
    record("core.backups","meta",{kept:"current"}, {revision:3})
  ]);
  const staged=await f.service.stageRestore(backup);
  const report=await f.service.applyStagedRestore(confirmStagedRestore(staged,"RESTORE"));
  assert.equal(f.hold.state,"RECOVERY_HOLD");
  assert.deepEqual(report.quiescedModuleIds,["live.module"]);
  assert.deepEqual(report.recoveredModuleIds,["restored.module"]);
  assert.deepEqual(f.storage.records.map(r=>r.namespace),["app.accounts","core.backups","core.recovery"]);
  assert.deepEqual(f.storage.records.find(r=>r.namespace==="app.accounts").value,{accounts:[{id:"a"}]});
  assert.deepEqual(f.storage.records.find(r=>r.namespace==="core.backups").value,{kept:"current"});
  assert.equal(f.events.indexOf("hold.enter") < f.events.indexOf("runtime.quiesce:live.module"),true);
  assert.equal(f.events.indexOf("runtime.quiesce:live.module") < f.events.indexOf("runtime.recover"),true);
});

test("A020-02 replacement failure leaves recovery hold active",async()=>{
  const f=fixture();
  const backup=await f.service.createBackup({backupId:"b-fail"});
  const staged=await f.service.stageRestore(backup);
  f.storage.failReplace(true);
  await assert.rejects(()=>f.service.applyStagedRestore(confirmStagedRestore(staged,"RESTORE")));
  assert.equal(f.hold.state,"RECOVERY_HOLD");
  assert.equal(f.events.includes("hold.release"),false);
});

test("A020-03 reconciliation never replays: safe unresolved work is cancelled and APPLIED ambiguity is reconciled",async()=>{
  const events=[];
  const storage=makeStorage([record("app.data","x",{ok:true})]);
  const hold=makeHold(events);
  await hold.api.enterRecoveryHold({reason:"restore:b"});
  const runtime=makeRuntime(events,[{moduleId:"m",revision:3,value:{state:"IDLE"}}]);
  runtime.setRecovered([]);
  const remote=makeRemoteOps(events,[
    {revision:1,value:{operationId:"prepared",state:"PREPARED"}},
    {revision:2,value:{operationId:"retryable",state:"RETRYABLE"}},
    {revision:3,value:{operationId:"uncertain",state:"UNCERTAIN"}}
  ]);
  const gate=makeProviderGate(remote,events,{uncertain:"APPLIED"});
  const checks=makeChecks();
  const service=createBackupRestoreService({storageBroker:storage.broker,recoveryHold:hold.api,remoteOps:remote.api,providerGate:gate.api,moduleRuntime:runtime.api,reconciliationChecks:checks.api,clock:()=>NOW,sha256Hex});
  const result=await service.reconcileAndRelease();
  assert.equal(result.released,true);
  assert.equal(hold.state,"NORMAL");
  assert.equal(remote.get("prepared").value.state,"CANCELLED");
  assert.equal(remote.get("retryable").value.state,"CANCELLED");
  assert.equal(remote.get("uncertain").value.state,"SUCCEEDED");
  assert.equal(events.some(x=>x.startsWith("remote.dispatch")),false);
});

test("A020-03 UNKNOWN remote outcome keeps RECOVERY_HOLD active",async()=>{
  const events=[];
  const storage=makeStorage([record("app.data","x",{ok:true})]);
  const hold=makeHold(events);await hold.api.enterRecoveryHold({reason:"restore:b"});
  const runtime=makeRuntime(events,[{moduleId:"m",revision:1,value:{state:"IDLE"}}]);runtime.setRecovered([]);
  const remote=makeRemoteOps(events,[{revision:1,value:{operationId:"uncertain",state:"UNCERTAIN"}}]);
  const gate=makeProviderGate(remote,events,{uncertain:"UNKNOWN"});
  const service=createBackupRestoreService({storageBroker:storage.broker,recoveryHold:hold.api,remoteOps:remote.api,providerGate:gate.api,moduleRuntime:runtime.api,reconciliationChecks:makeChecks().api,clock:()=>NOW,sha256Hex});
  const result=await service.reconcileAndRelease();
  assert.equal(result.released,false);
  assert.deepEqual(result.unresolvedOperationIds,["uncertain"]);
  assert.equal(hold.state,"RECOVERY_HOLD");
});

test("A020-03 failed Persona/provider reconciliation checks keep hold active",async()=>{
  for(const options of [{personaBindings:false},{providerCapabilities:false}]){
    const events=[];const storage=makeStorage([record("app.data","x",{ok:true})]);
    const hold=makeHold(events);await hold.api.enterRecoveryHold({reason:"restore:b"});
    const runtime=makeRuntime(events,[{moduleId:"m",revision:1,value:{state:"IDLE"}}]);runtime.setRecovered([]);
    const remote=makeRemoteOps(events,[]);
    const gate=makeProviderGate(remote,events,{});
    const service=createBackupRestoreService({storageBroker:storage.broker,recoveryHold:hold.api,remoteOps:remote.api,providerGate:gate.api,moduleRuntime:runtime.api,reconciliationChecks:makeChecks(options).api,clock:()=>NOW,sha256Hex});
    const result=await service.reconcileAndRelease();
    assert.equal(result.released,false);
    assert.equal(hold.state,"RECOVERY_HOLD");
  }
});
