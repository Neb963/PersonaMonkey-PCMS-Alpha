import test from "node:test";
import assert from "node:assert/strict";

import { createModuleLifecycleService } from "../../../extension/pcms/modules/lifecycle.js";
import { createModuleRuntimeBroker, MODULE_RUNTIME_STATES } from "../../../extension/pcms/runtime/module-runtime.js";
import { MODULE_RUNTIME_ERROR_CODES } from "../../../extension/pcms/runtime/errors.js";
import {
  makeRegistry,
  makeSandboxFactories,
  makeStorage,
  moduleArchive
} from "../p011-harness.mjs";

function archive(version) {
  return moduleArchive({
    version,
    source:`() => ({
      start(){ return "${version}"; },
      version(){ return "${version}"; },
      dispose(){ return null; }
    })`
  });
}

async function install(service,runtime,registry,bytes,{expectedModuleRevision=0}={}) {
  const staged=await service.stageInstall(bytes,{expectedModuleRevision});
  const runtimeState=await runtime.getState("demo.module");
  const applied=await service.applyCandidate("demo.module",staged.value.candidate.packageHash,{
    expectedModuleRevision:staged.revision,
    expectedRuntimeRevision:runtimeState.revision,
    approveAuthority:false
  });
  return {staged,applied,module:await registry.getModule("demo.module")};
}

test("A024-03 clean install, update and abrupt restart preserve package identity and generation fencing", async (t) => {
  const shared={namespaces:new Map()};
  const storage1=makeStorage(shared);
  const registry1=makeRegistry(storage1);
  const factories1=makeSandboxFactories();
  t.after(()=>factories1.dispose());

  const runtime1=createModuleRuntimeBroker({
    storageBroker:storage1,
    moduleRegistry:registry1,
    frameFactory:factories1.frameFactory,
    sandboxHostFactory:factories1.sandboxHostFactory
  });
  const lifecycle1=createModuleLifecycleService({
    storageBroker:storage1,
    moduleRegistry:registry1,
    moduleRuntime:runtime1
  });

  const first=await install(lifecycle1,runtime1,registry1,archive("1.0.0"));
  assert.equal(first.applied.activated,true);
  assert.equal(await runtime1.invoke("demo.module","version"),"1.0.0");
  const firstRuntime=await runtime1.getState("demo.module");

  const beforeUpdate=await registry1.getModule("demo.module");
  const second=await install(lifecycle1,runtime1,registry1,archive("2.0.0"),{
    expectedModuleRevision:beforeUpdate.revision
  });
  assert.equal(second.applied.activated,true);
  assert.equal(await runtime1.invoke("demo.module","version"),"2.0.0");
  const secondRuntime=await runtime1.getState("demo.module");
  assert.ok(secondRuntime.value.generation>firstRuntime.value.generation);
  assert.notEqual(second.module.value.activePackageHash,first.module.value.activePackageHash);
  assert.equal(second.module.value.lastKnownGoodPackageHash,second.module.value.activePackageHash);

  let holdState="RECOVERY_HOLD";
  const storage2=makeStorage(shared);
  const registry2=makeRegistry(storage2);
  const factories2=makeSandboxFactories();
  t.after(()=>factories2.dispose());
  const runtime2=createModuleRuntimeBroker({
    storageBroker:storage2,
    moduleRegistry:registry2,
    frameFactory:factories2.frameFactory,
    sandboxHostFactory:factories2.sandboxHostFactory,
    recoveryHold:{
      async getStatus(){ return {value:{state:holdState}}; }
    }
  });

  assert.deepEqual(await runtime2.recoverAll(),["demo.module"]);
  const recovered=await runtime2.getState("demo.module");
  assert.equal(recovered.value.state,MODULE_RUNTIME_STATES.IDLE);
  assert.equal(recovered.value.generation,secondRuntime.value.generation+1);

  await assert.rejects(
    runtime1.invoke("demo.module","version"),
    (error)=>error?.code===MODULE_RUNTIME_ERROR_CODES.STALE_GENERATION
  );
  await assert.rejects(
    runtime2.activate("demo.module",{expectedRevision:recovered.revision}),
    (error)=>error?.code===MODULE_RUNTIME_ERROR_CODES.RECOVERY_HOLD
  );

  holdState="NORMAL";
  const restarted=await runtime2.activate("demo.module",{expectedRevision:recovered.revision});
  assert.equal(restarted.generation,recovered.value.generation);
  assert.equal(restarted.packageHash,second.module.value.activePackageHash);
  assert.equal(await runtime2.invoke("demo.module","version"),"2.0.0");
});
