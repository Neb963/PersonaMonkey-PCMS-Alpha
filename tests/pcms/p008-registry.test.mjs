import assert from "node:assert/strict";
import test from "node:test";

import { MODULE_ERROR_CODES } from "../../extension/pcms/modules/errors.js";
import { PCMS_MODULE_ARCHIVE_FORMAT, encodeModuleArchive } from "../../extension/pcms/modules/package.js";
import { MODULE_CANDIDATE_STATES, createModulePackageRegistry } from "../../extension/pcms/modules/registry.js";

function archive(version, capabilities) {
  return encodeModuleArchive({
    format:PCMS_MODULE_ARCHIVE_FORMAT,
    manifest:{schemaVersion:1,moduleId:"demo.module",version,controller:"controller.js",authority:{capabilities}},
    files:{"controller.js":`() => ({ version(){ return ${JSON.stringify(version)}; } })`}
  });
}

function makeStorage(shared={rows:new Map()}) {
  const clone=(v)=>structuredClone(v);
  return {
    shared,
    namespace(namespace) {
      assert.equal(namespace,"core.modules");
      return {
        async get(key) {
          const row=shared.rows.get(key);
          return row?clone(row):null;
        },
        async compareAndSwap(key,{expectedRevision,value}) {
          const row=shared.rows.get(key);
          const current=row?.revision||0;
          if(current!==expectedRevision){
            const e=new Error("cas"); e.code="PCMS_STORAGE_CAS_MISMATCH"; e.currentRevision=current; throw e;
          }
          const next={key,revision:current+1,updatedAt:"storage-clock",value:clone(value)};
          shared.rows.set(key,next);
          return clone(next);
        }
      };
    }
  };
}

test("A008-03 first install preserves candidate until exact authority approval and admission", async () => {
  let tick=0;
  const storage=makeStorage();
  const registry=createModulePackageRegistry({storageBroker:storage,clock:()=>`2026-10-05T01:00:0${++tick}Z`});
  const staged=await registry.stageCandidate(archive("1.0.0",["storage.read"]),{expectedModuleRevision:0});
  assert.equal(staged.revision,1);
  assert.equal(staged.value.activePackageHash,null);
  assert.equal(staged.value.lastKnownGoodPackageHash,null);
  assert.equal(staged.value.candidate.state,MODULE_CANDIDATE_STATES.AWAITING_APPROVAL);
  assert.deepEqual(staged.value.candidate.authorityDelta.added,["storage.read"]);

  await assert.rejects(
    registry.admitCandidate("demo.module",staged.value.candidate.packageHash,{expectedModuleRevision:1}),
    (e)=>e?.code===MODULE_ERROR_CODES.APPROVAL_REQUIRED
  );
  const approved=await registry.approveCandidate("demo.module",staged.value.candidate.packageHash,{expectedModuleRevision:1});
  assert.equal(approved.revision,2);
  assert.equal(approved.value.candidate.state,MODULE_CANDIDATE_STATES.READY);
  assert.deepEqual(approved.value.candidate.approval.addedCapabilities,["storage.read"]);

  const admitted=await registry.admitCandidate("demo.module",staged.value.candidate.packageHash,{expectedModuleRevision:2});
  assert.equal(admitted.revision,3);
  assert.equal(admitted.value.activePackageHash,staged.value.candidate.packageHash);
  assert.equal(admitted.value.lastKnownGoodPackageHash,staged.value.candidate.packageHash);
  assert.equal(admitted.value.candidate,null);
});

test("A008-02 update authority expansion cannot replace last-known-good before admission", async () => {
  const storage=makeStorage();
  const first=createModulePackageRegistry({storageBroker:storage,clock:()=>"2026-10-05T02:00:00Z"});
  let state=await first.stageCandidate(archive("1.0.0",[]),{expectedModuleRevision:0});
  state=await first.admitCandidate("demo.module",state.value.candidate.packageHash,{expectedModuleRevision:1});
  const originalHash=state.value.activePackageHash;

  const update=await first.stageCandidate(archive("2.0.0",["provider.execute"]),{expectedModuleRevision:2});
  assert.equal(update.value.activePackageHash,originalHash);
  assert.equal(update.value.lastKnownGoodPackageHash,originalHash);
  assert.equal(update.value.candidate.state,MODULE_CANDIDATE_STATES.AWAITING_APPROVAL);
  await assert.rejects(
    first.stageCandidate(archive("3.0.0",[]),{expectedModuleRevision:3}),
    (e)=>e?.code===MODULE_ERROR_CODES.CANDIDATE_EXISTS
  );

  const rejected=await first.rejectCandidate("demo.module",update.value.candidate.packageHash,{expectedModuleRevision:3});
  assert.equal(rejected.value.activePackageHash,originalHash);
  assert.equal(rejected.value.lastKnownGoodPackageHash,originalHash);
  assert.equal(rejected.value.candidate,null);
});

test("A008-03 CAS fencing and restart preserve an immutable staged candidate", async () => {
  const shared={rows:new Map()};
  const storage=makeStorage(shared);
  const first=createModulePackageRegistry({storageBroker:storage,clock:()=>"2026-10-05T03:00:00Z"});
  const staged=await first.stageCandidate(archive("1.0.0",[]),{expectedModuleRevision:0});

  await assert.rejects(
    first.rejectCandidate("demo.module",staged.value.candidate.packageHash,{expectedModuleRevision:0}),
    (e)=>e?.code===MODULE_ERROR_CODES.REVISION_CONFLICT && e.currentRevision===1
  );

  const second=createModulePackageRegistry({storageBroker:makeStorage(shared),clock:()=>"2026-10-05T03:10:00Z"});
  const restored=await second.getModule("demo.module");
  assert.equal(restored.revision,1);
  assert.equal(restored.value.candidate.packageHash,staged.value.candidate.packageHash);
  const pkg=await second.getPackage(staged.value.candidate.packageHash);
  assert.equal(pkg.manifest.version,"1.0.0");
});

test("A008-03 stored package corruption fails closed before admission", async () => {
  const storage=makeStorage();
  const registry=createModulePackageRegistry({storageBroker:storage,clock:()=>"2026-10-05T04:00:00Z"});
  const staged=await registry.stageCandidate(archive("1.0.0",[]),{expectedModuleRevision:0});
  const hash=staged.value.candidate.packageHash;
  const key="package:"+hash;
  storage.shared.rows.get(key).value.files["controller.js"]="tampered";
  await assert.rejects(
    registry.admitCandidate("demo.module",hash,{expectedModuleRevision:1}),
    (e)=>e?.code===MODULE_ERROR_CODES.IDENTITY_CONFLICT
  );
});

test("A008-03 corrupt persisted module candidate metadata fails closed on read", async () => {
  const storage=makeStorage();
  const registry=createModulePackageRegistry({storageBroker:storage,clock:()=>"2026-10-05T05:00:00Z"});
  await registry.stageCandidate(archive("1.0.0",["storage.read"]),{expectedModuleRevision:0});
  const row=storage.shared.rows.get("module:demo.module");
  row.value.candidate.authorityDelta.requiresApproval=false;

  await assert.rejects(
    registry.getModule("demo.module"),
    (e)=>e?.code===MODULE_ERROR_CODES.CORRUPT_STATE
  );
});
