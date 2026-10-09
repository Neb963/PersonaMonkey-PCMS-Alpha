import test from "node:test";
import assert from "node:assert/strict";

import { createModuleLifecycleService, MODULE_LIFECYCLE_STATES } from "../../../extension/pcms/modules/lifecycle.js";
import { MODULE_LIFECYCLE_ERROR_CODES } from "../../../extension/pcms/modules/lifecycle-errors.js";
import { MODULE_CANDIDATE_STATES } from "../../../extension/pcms/modules/registry.js";
import { MODULE_RUNTIME_STATES } from "../../../extension/pcms/runtime/module-runtime.js";
import { archive, makeRegistry, makeRuntime, makeStorage, stageAndApply } from "./harness.mjs";

function fixture({retentionLimit=3}={}) {
  const storage=makeStorage();
  const registry=makeRegistry(storage);
  const runtime=makeRuntime(registry);
  const service=createModuleLifecycleService({
    storageBroker:storage,
    moduleRegistry:registry,
    moduleRuntime:runtime.api,
    retentionLimit
  });
  return {storage,registry,runtime,service};
}

async function install(f,version,{moduleRevision=0,capabilities=["data.read"]}={}) {
  const staged=await f.service.stageInstall(archive(version,{capabilities}),{expectedModuleRevision:moduleRevision});
  const before=await f.runtime.api.getState("demo.module");
  const result=await f.service.applyCandidate("demo.module",staged.value.candidate.packageHash,{
    expectedModuleRevision:staged.revision,
    expectedRuntimeRevision:before.revision,
    approveAuthority:true
  });
  return {staged,result};
}

test("A022-01 first install requires explicit authority approval, then activates and marks known-good",async()=>{
  const f=fixture();
  const staged=await f.service.stageInstall(archive("1.0.0"),{expectedModuleRevision:0});
  assert.equal(staged.value.candidate.state,MODULE_CANDIDATE_STATES.AWAITING_APPROVAL);

  const pending=await f.service.applyCandidate("demo.module",staged.value.candidate.packageHash,{
    expectedModuleRevision:staged.revision,
    expectedRuntimeRevision:0,
    approveAuthority:false
  });
  assert.equal(pending.applied,false);
  assert.equal(pending.approvalRequired,true);
  assert.deepEqual(f.runtime.events,[]);

  const applied=await f.service.applyCandidate("demo.module",staged.value.candidate.packageHash,{
    expectedModuleRevision:pending.moduleRevision,
    expectedRuntimeRevision:0,
    approveAuthority:true
  });
  assert.equal(applied.applied,true);
  assert.equal(applied.activated,true);

  const module=await f.registry.getModule("demo.module");
  const runtime=await f.runtime.api.getState("demo.module");
  const lifecycle=await f.service.getState("demo.module");
  assert.equal(module.value.activePackageHash,staged.value.candidate.packageHash);
  assert.equal(module.value.lastKnownGoodPackageHash,staged.value.candidate.packageHash);
  assert.equal(runtime.value.state,MODULE_RUNTIME_STATES.ACTIVE);
  assert.equal(runtime.value.activePackageHash,staged.value.candidate.packageHash);
  assert.equal(lifecycle.value.state,MODULE_LIFECYCLE_STATES.PRESENT);
  assert.deepEqual(lifecycle.value.retainedPackageHashes,[]);
});

test("A022-01 update fences runtime generation and retains the previous package for rollback",async()=>{
  const f=fixture();
  const first=await install(f,"1.0.0");
  const beforeModule=await f.registry.getModule("demo.module");
  const beforeRuntime=await f.runtime.api.getState("demo.module");

  const staged=await f.service.stageInstall(archive("2.0.0"),{expectedModuleRevision:beforeModule.revision});
  assert.equal(staged.value.candidate.state,MODULE_CANDIDATE_STATES.READY);
  const applied=await f.service.applyCandidate("demo.module",staged.value.candidate.packageHash,{
    expectedModuleRevision:staged.revision,
    expectedRuntimeRevision:beforeRuntime.revision,
    approveAuthority:false
  });

  const module=await f.registry.getModule("demo.module");
  const runtime=await f.runtime.api.getState("demo.module");
  const lifecycle=await f.service.getState("demo.module");
  assert.equal(module.value.activePackageHash,staged.value.candidate.packageHash);
  assert.equal(module.value.lastKnownGoodPackageHash,staged.value.candidate.packageHash);
  assert.equal(runtime.value.activePackageHash,staged.value.candidate.packageHash);
  assert.ok(runtime.value.generation>beforeRuntime.value.generation);
  assert.deepEqual(lifecycle.value.retainedPackageHashes,[first.staged.value.candidate.packageHash]);
  assert.equal(f.runtime.events.some(x=>x.startsWith("prepare:")),true);
  assert.equal(applied.generation,runtime.value.generation);
});

test("A022-01 disabled update stays disabled and is not promoted known-good until enable succeeds",async()=>{
  const f=fixture();
  const first=await install(f,"1.0.0");
  let module=await f.registry.getModule("demo.module");
  let runtime=await f.runtime.api.getState("demo.module");
  const disabled=await f.service.disable("demo.module",{expectedRuntimeRevision:runtime.revision});

  const staged=await f.service.stageInstall(archive("2.0.0"),{expectedModuleRevision:module.revision});
  const applied=await f.service.applyCandidate("demo.module",staged.value.candidate.packageHash,{
    expectedModuleRevision:staged.revision,
    expectedRuntimeRevision:disabled.revision,
    approveAuthority:false
  });
  assert.equal(applied.activated,false);

  module=await f.registry.getModule("demo.module");
  runtime=await f.runtime.api.getState("demo.module");
  assert.equal(runtime.value.state,MODULE_RUNTIME_STATES.DISABLED);
  assert.equal(module.value.activePackageHash,staged.value.candidate.packageHash);
  assert.equal(module.value.lastKnownGoodPackageHash,first.staged.value.candidate.packageHash);

  await f.service.enable("demo.module",{expectedRuntimeRevision:runtime.revision});
  module=await f.registry.getModule("demo.module");
  runtime=await f.runtime.api.getState("demo.module");
  assert.equal(runtime.value.state,MODULE_RUNTIME_STATES.ACTIVE);
  assert.equal(runtime.value.activePackageHash,staged.value.candidate.packageHash);
  assert.equal(module.value.lastKnownGoodPackageHash,staged.value.candidate.packageHash);
});

test("A022-01 failed update activation rolls registry/runtime back to last-known-good",async()=>{
  const f=fixture();
  const first=await install(f,"1.0.0");
  const beforeModule=await f.registry.getModule("demo.module");
  const beforeRuntime=await f.runtime.api.getState("demo.module");
  const staged=await f.service.stageInstall(archive("2.0.0"),{expectedModuleRevision:beforeModule.revision});

  f.runtime.failNextActivation();
  await assert.rejects(
    ()=>f.service.applyCandidate("demo.module",staged.value.candidate.packageHash,{
      expectedModuleRevision:staged.revision,
      expectedRuntimeRevision:beforeRuntime.revision,
      approveAuthority:false
    }),
    e=>e?.code===MODULE_LIFECYCLE_ERROR_CODES.ACTIVATION_FAILED
  );

  const module=await f.registry.getModule("demo.module");
  const runtime=await f.runtime.api.getState("demo.module");
  assert.equal(module.value.activePackageHash,first.staged.value.candidate.packageHash);
  assert.equal(module.value.lastKnownGoodPackageHash,first.staged.value.candidate.packageHash);
  assert.equal(runtime.value.state,MODULE_RUNTIME_STATES.ACTIVE);
  assert.equal(runtime.value.activePackageHash,first.staged.value.candidate.packageHash);
  assert.ok(runtime.value.generation>beforeRuntime.value.generation);
});

test("A022-02 disable preserves installation, remove deactivates it, purge deletes packages but preserves runtime tombstone",async()=>{
  const f=fixture();
  const installed=await install(f,"1.0.0");
  let module=await f.registry.getModule("demo.module");
  let runtime=await f.runtime.api.getState("demo.module");

  const disabled=await f.service.disable("demo.module",{expectedRuntimeRevision:runtime.revision});
  assert.equal(disabled.value.state,MODULE_RUNTIME_STATES.DISABLED);
  module=await f.registry.getModule("demo.module");
  assert.equal(module.value.activePackageHash,installed.staged.value.candidate.packageHash);

  const reenabled=await f.service.enable("demo.module",{expectedRuntimeRevision:disabled.revision});
  assert.equal(reenabled.packageHash,installed.staged.value.candidate.packageHash);
  runtime=await f.runtime.api.getState("demo.module");
  module=await f.registry.getModule("demo.module");

  const removed=await f.service.remove("demo.module",{
    expectedModuleRevision:module.revision,
    expectedRuntimeRevision:runtime.revision
  });
  assert.equal(removed.removed,true);
  module=await f.registry.getModule("demo.module");
  runtime=await f.runtime.api.getState("demo.module");
  assert.equal(module.value.activePackageHash,null);
  assert.equal(module.value.lastKnownGoodPackageHash,installed.staged.value.candidate.packageHash);
  assert.equal(runtime.value.state,MODULE_RUNTIME_STATES.DISABLED);
  const generationBeforePurge=runtime.value.generation;

  const purged=await f.service.purge("demo.module",{
    expectedModuleRevision:module.revision,
    expectedRuntimeRevision:runtime.revision
  });
  assert.equal(purged.purged,true);
  assert.equal((await f.registry.getModule("demo.module")),null);
  assert.deepEqual(await f.registry.listPackagesForModule("demo.module"),[]);
  const lifecycle=await f.service.getState("demo.module");
  assert.equal(lifecycle.value.state,MODULE_LIFECYCLE_STATES.PURGED);
  runtime=await f.runtime.api.getState("demo.module");
  assert.equal(runtime.value.state,MODULE_RUNTIME_STATES.DISABLED);
  assert.equal(runtime.value.generation,generationBeforePurge);
});

test("A022-03 rollback history is bounded and only retained versions can be staged",async()=>{
  const f=fixture({retentionLimit:2});
  const hashes=[];
  let moduleRevision=0;

  for(const version of ["1.0.0","2.0.0","3.0.0","4.0.0"]) {
    const staged=await f.service.stageInstall(archive(version),{expectedModuleRevision:moduleRevision});
    const runtime=await f.runtime.api.getState("demo.module");
    await f.service.applyCandidate("demo.module",staged.value.candidate.packageHash,{
      expectedModuleRevision:staged.revision,
      expectedRuntimeRevision:runtime.revision,
      approveAuthority:true
    });
    hashes.push(staged.value.candidate.packageHash);
    moduleRevision=(await f.registry.getModule("demo.module")).revision;
  }

  let lifecycle=await f.service.getState("demo.module");
  assert.deepEqual(lifecycle.value.retainedPackageHashes,[hashes[2],hashes[1]]);
  await assert.rejects(
    ()=>f.service.stageRollback("demo.module",hashes[0],{expectedModuleRevision:moduleRevision}),
    e=>e?.code===MODULE_LIFECYCLE_ERROR_CODES.ROLLBACK_NOT_RETAINED
  );

  const stagedRollback=await f.service.stageRollback("demo.module",hashes[1],{expectedModuleRevision:moduleRevision});
  const runtime=await f.runtime.api.getState("demo.module");
  await f.service.applyCandidate("demo.module",hashes[1],{
    expectedModuleRevision:stagedRollback.revision,
    expectedRuntimeRevision:runtime.revision,
    approveAuthority:true
  });

  const module=await f.registry.getModule("demo.module");
  lifecycle=await f.service.getState("demo.module");
  assert.equal(module.value.activePackageHash,hashes[1]);
  assert.equal(module.value.lastKnownGoodPackageHash,hashes[1]);
  assert.deepEqual(lifecycle.value.retainedPackageHashes,[hashes[3],hashes[2]]);
});

test("A022-03 purge requires removed+disabled state and fails closed otherwise",async()=>{
  const f=fixture();
  await install(f,"1.0.0");
  const module=await f.registry.getModule("demo.module");
  const runtime=await f.runtime.api.getState("demo.module");
  await assert.rejects(
    ()=>f.service.purge("demo.module",{expectedModuleRevision:module.revision,expectedRuntimeRevision:runtime.revision}),
    e=>e?.code===MODULE_LIFECYCLE_ERROR_CODES.INVALID_STATE
  );
  assert.notEqual((await f.registry.getModule("demo.module")),null);
});
