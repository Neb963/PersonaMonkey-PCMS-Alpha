import { MODULE_CANDIDATE_STATES } from "./registry.js";
import { assertModuleId, assertModulePackageHash, parseModuleArchive } from "./package.js";
import { MODULE_RUNTIME_STATES } from "../runtime/module-runtime.js";
import { MODULE_LIFECYCLE_ERROR_CODES, moduleLifecycleError } from "./lifecycle-errors.js";

export const MODULE_LIFECYCLE_NAMESPACE="core.module-lifecycle";
export const MODULE_LIFECYCLE_SCHEMA_VERSION=1;
export const MODULE_LIFECYCLE_STATES=Object.freeze({
  UNTRACKED:"UNTRACKED",
  PRESENT:"PRESENT",
  REMOVED:"REMOVED",
  PURGING:"PURGING",
  PURGED:"PURGED"
});
export const MODULE_LIFECYCLE_DEFAULT_RETENTION=3;
export const MODULE_LIFECYCLE_MAX_RETENTION=10;

const STATE_SET=new Set(Object.values(MODULE_LIFECYCLE_STATES));

function fail(code,options={}) { throw moduleLifecycleError(code,options); }

function plain(value) {
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}

function snapshotMethods(value,names,label) {
  if(!plain(value)||Object.getOwnPropertySymbols(value).length) throw new TypeError(label+" is invalid");
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(!names.every((name)=>Object.hasOwn(descriptors,name)
      && descriptors[name].enumerable
      && Object.hasOwn(descriptors[name],"value")
      && typeof descriptors[name].value==="function")) throw new TypeError(label+" is invalid");
  return Object.freeze(Object.fromEntries(names.map((name)=>[name,descriptors[name].value])));
}

function lifecycleKey(moduleId) { return "lifecycle:"+assertModuleId(moduleId); }

function defaultState(moduleId) {
  return Object.freeze({
    schemaVersion:MODULE_LIFECYCLE_SCHEMA_VERSION,
    kind:"module-lifecycle",
    moduleId,
    state:MODULE_LIFECYCLE_STATES.UNTRACKED,
    retainedPackageHashes:Object.freeze([])
  });
}

function normalizeState(value,moduleId,retentionLimit) {
  if(!plain(value)||Object.getOwnPropertySymbols(value).length) fail(MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE);
  const d=Object.getOwnPropertyDescriptors(value);
  const names=["schemaVersion","kind","moduleId","state","retainedPackageHashes"];
  if(Object.keys(d).length!==names.length||!names.every((name)=>Object.hasOwn(d,name)&&d[name].enumerable&&Object.hasOwn(d[name],"value"))) {
    fail(MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE);
  }
  if(d.schemaVersion.value!==MODULE_LIFECYCLE_SCHEMA_VERSION
      || d.kind.value!=="module-lifecycle"
      || d.moduleId.value!==moduleId
      || !STATE_SET.has(d.state.value)
      || d.state.value===MODULE_LIFECYCLE_STATES.UNTRACKED) fail(MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE);
  const raw=d.retainedPackageHashes.value;
  if(!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype||raw.length>retentionLimit) fail(MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE);
  const seen=new Set();
  const hashes=[];
  for(let i=0;i<raw.length;i+=1) {
    if(!Object.hasOwn(raw,i)) fail(MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE);
    let hash;
    try { hash=assertModulePackageHash(raw[i]); } catch { fail(MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE); }
    if(seen.has(hash)) fail(MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE);
    seen.add(hash);hashes.push(hash);
  }
  return Object.freeze({
    schemaVersion:MODULE_LIFECYCLE_SCHEMA_VERSION,
    kind:"module-lifecycle",
    moduleId,
    state:d.state.value,
    retainedPackageHashes:Object.freeze(hashes)
  });
}

function publicState(record,moduleId,retentionLimit) {
  if(!record) return Object.freeze({revision:0,value:defaultState(moduleId)});
  if(!Number.isSafeInteger(record.revision)||record.revision<1) fail(MODULE_LIFECYCLE_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({revision:record.revision,updatedAt:record.updatedAt,value:normalizeState(record.value,moduleId,retentionLimit)});
}

function expectedRevision(value) {
  if(!Number.isSafeInteger(value)||value<0) fail(MODULE_LIFECYCLE_ERROR_CODES.REVISION_CONFLICT);
  return value;
}

export function createModuleLifecycleService({
  storageBroker,
  moduleRegistry,
  moduleRuntime,
  retentionLimit=MODULE_LIFECYCLE_DEFAULT_RETENTION
}={}) {
  if(!storageBroker||typeof storageBroker.namespace!=="function") throw new TypeError("Module lifecycle requires PCMS storage");
  if(!Number.isSafeInteger(retentionLimit)||retentionLimit<1||retentionLimit>MODULE_LIFECYCLE_MAX_RETENTION) {
    throw new RangeError("Module lifecycle retention limit is invalid");
  }
  const registry=snapshotMethods(moduleRegistry,[
    "getModule","getPackage","stageCandidate","stageStoredCandidate","approveCandidate","admitCandidate",
    "markActivePackageKnownGood","rollbackAdmission","deactivateModule","listPackagesForModule",
    "deletePackage","deleteModule","rejectCandidate"
  ],"Module lifecycle registry");
  const runtime=snapshotMethods(moduleRuntime,[
    "getState","prepareUpdate","activate","disable","enable"
  ],"Module lifecycle runtime");
  const store=storageBroker.namespace(MODULE_LIFECYCLE_NAMESPACE);

  async function read(moduleId) {
    const id=assertModuleId(moduleId);
    return publicState(await store.get(lifecycleKey(id)),id,retentionLimit);
  }

  async function write(moduleId,current,state,retainedPackageHashes) {
    const id=assertModuleId(moduleId);
    const unique=[];
    const seen=new Set();
    for(const raw of retainedPackageHashes) {
      const hash=assertModulePackageHash(raw);
      if(seen.has(hash)) continue;
      seen.add(hash);unique.push(hash);
      if(unique.length===retentionLimit) break;
    }
    const value={
      schemaVersion:MODULE_LIFECYCLE_SCHEMA_VERSION,
      kind:"module-lifecycle",
      moduleId:id,
      state,
      retainedPackageHashes:unique
    };
    try {
      const saved=await store.compareAndSwap(lifecycleKey(id),{expectedRevision:current.revision,value});
      return publicState(saved,id,retentionLimit);
    } catch(error) {
      if(error?.code==="PCMS_STORAGE_CAS_MISMATCH") {
        fail(MODULE_LIFECYCLE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:error.currentRevision});
      }
      throw error;
    }
  }

  function assertOperable(state) {
    if(state.value.state===MODULE_LIFECYCLE_STATES.PURGING) fail(MODULE_LIFECYCLE_ERROR_CODES.INVALID_STATE);
  }

  async function stageInstall(archiveBytes,{expectedModuleRevision}={}) {
    const parsed=await parseModuleArchive(archiveBytes);
    const lifecycle=await read(parsed.manifest.moduleId);
    assertOperable(lifecycle);
    return registry.stageCandidate(archiveBytes,{expectedModuleRevision:expectedRevision(expectedModuleRevision)});
  }

  async function stageRollback(moduleId,packageHash,{expectedModuleRevision}={}) {
    const id=assertModuleId(moduleId);
    const hash=assertModulePackageHash(packageHash);
    const lifecycle=await read(id);
    assertOperable(lifecycle);
    if(!lifecycle.value.retainedPackageHashes.includes(hash)) fail(MODULE_LIFECYCLE_ERROR_CODES.ROLLBACK_NOT_RETAINED);
    return registry.stageStoredCandidate(id,hash,{expectedModuleRevision:expectedRevision(expectedModuleRevision)});
  }

  async function restorePreviousRuntime(moduleId,failedPackageHash,admittedRevision,wasDisabled) {
    let rolled;
    try {
      rolled=await registry.rollbackAdmission(moduleId,failedPackageHash,{expectedModuleRevision:admittedRevision});
    } catch {
      return;
    }
    if(wasDisabled||!rolled.value.activePackageHash) return;
    try {
      let currentRuntime=await runtime.getState(moduleId);
      if(currentRuntime.value.state===MODULE_RUNTIME_STATES.ACTIVE
          || currentRuntime.value.state===MODULE_RUNTIME_STATES.DRAINING) {
        currentRuntime=await runtime.prepareUpdate(moduleId,{expectedRevision:currentRuntime.revision});
      }
      if(currentRuntime.value.state===MODULE_RUNTIME_STATES.DISABLED) {
        currentRuntime=await runtime.enable(moduleId,{expectedRevision:currentRuntime.revision});
      }
      if(currentRuntime.value.state===MODULE_RUNTIME_STATES.IDLE) {
        await runtime.activate(moduleId,{expectedRevision:currentRuntime.revision});
      }
    } catch {}
  }

  async function applyCandidate(moduleId,packageHash,{
    expectedModuleRevision,
    expectedRuntimeRevision,
    approveAuthority=false
  }={}) {
    const id=assertModuleId(moduleId);
    const hash=assertModulePackageHash(packageHash);
    if(typeof approveAuthority!=="boolean") fail(MODULE_LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT);
    let module=await registry.getModule(id);
    if(!module||module.revision!==expectedRevision(expectedModuleRevision)) {
      fail(MODULE_LIFECYCLE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:module?.revision??0});
    }
    if(!module.value.candidate||module.value.candidate.packageHash!==hash) fail(MODULE_LIFECYCLE_ERROR_CODES.CANDIDATE_MISMATCH);

    if(module.value.candidate.state===MODULE_CANDIDATE_STATES.AWAITING_APPROVAL) {
      if(approveAuthority!==true) {
        return Object.freeze({
          applied:false,
          approvalRequired:true,
          moduleRevision:module.revision,
          packageHash:hash,
          addedCapabilities:Object.freeze([...module.value.candidate.authorityDelta.added])
        });
      }
      module=await registry.approveCandidate(id,hash,{expectedModuleRevision:module.revision});
    } else if(approveAuthority!==false&&approveAuthority!==true) {
      fail(MODULE_LIFECYCLE_ERROR_CODES.INVALID_ARGUMENT);
    }

    const runtimeBefore=await runtime.getState(id);
    const expectedRuntime=expectedRevision(expectedRuntimeRevision);
    if(runtimeBefore.revision!==expectedRuntime) {
      fail(MODULE_LIFECYCLE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:runtimeBefore.revision});
    }

    let lifecycle=await read(id);
    assertOperable(lifecycle);
    const previousActive=module.value.activePackageHash;
    const retained=[
      ...(previousActive&&previousActive!==hash?[previousActive]:[]),
      ...lifecycle.value.retainedPackageHashes.filter((item)=>item!==hash&&item!==previousActive)
    ];
    let lifecycleWritten=false;
    if(previousActive) {
      lifecycle=await write(id,lifecycle,MODULE_LIFECYCLE_STATES.PRESENT,retained);
      lifecycleWritten=true;
    }

    const wasDisabled=runtimeBefore.value.state===MODULE_RUNTIME_STATES.DISABLED;
    let prepared;
    try {
      prepared=await runtime.prepareUpdate(id,{expectedRevision:runtimeBefore.revision});
    } catch {
      fail(MODULE_LIFECYCLE_ERROR_CODES.ACTIVATION_FAILED);
    }

    let admitted;
    try {
      admitted=await registry.admitCandidate(id,hash,{
        expectedModuleRevision:module.revision,
        preserveLastKnownGood:true
      });
    } catch {
      if(!wasDisabled&&previousActive) {
        try { await runtime.activate(id,{expectedRevision:prepared.revision}); } catch {}
      }
      fail(MODULE_LIFECYCLE_ERROR_CODES.ACTIVATION_FAILED);
    }

    if(wasDisabled) {
      if(!lifecycleWritten) {
        lifecycle=await write(id,lifecycle,MODULE_LIFECYCLE_STATES.PRESENT,retained);
        lifecycleWritten=true;
      }
      return Object.freeze({
        applied:true,
        activated:false,
        packageHash:hash,
        moduleRevision:admitted.revision,
        runtimeRevision:prepared.revision,
        lifecycleRevision:lifecycle.revision
      });
    }

    let activated;
    try {
      activated=await runtime.activate(id,{expectedRevision:prepared.revision});
    } catch {
      await restorePreviousRuntime(id,hash,admitted.revision,false);
      fail(MODULE_LIFECYCLE_ERROR_CODES.ACTIVATION_FAILED);
    }

    let knownGood;
    try {
      knownGood=await registry.markActivePackageKnownGood(id,hash,{expectedModuleRevision:admitted.revision});
    } catch {
      await restorePreviousRuntime(id,hash,admitted.revision,false);
      fail(MODULE_LIFECYCLE_ERROR_CODES.ACTIVATION_FAILED);
    }

    if(!lifecycleWritten) {
      lifecycle=await write(id,lifecycle,MODULE_LIFECYCLE_STATES.PRESENT,retained);
      lifecycleWritten=true;
    }
    return Object.freeze({
      applied:true,
      activated:true,
      packageHash:hash,
      moduleRevision:knownGood.revision,
      runtimeRevision:activated.revision,
      generation:activated.generation,
      lifecycleRevision:lifecycle.revision
    });
  }

  async function disable(moduleId,{expectedRuntimeRevision}={}) {
    const id=assertModuleId(moduleId);
    const lifecycle=await read(id);
    assertOperable(lifecycle);
    return runtime.disable(id,{expectedRevision:expectedRevision(expectedRuntimeRevision)});
  }

  async function enable(moduleId,{expectedRuntimeRevision}={}) {
    const id=assertModuleId(moduleId);
    const lifecycle=await read(id);
    assertOperable(lifecycle);
    const module=await registry.getModule(id);
    if(!module?.value?.activePackageHash) fail(MODULE_LIFECYCLE_ERROR_CODES.INVALID_STATE);
    const enabled=await runtime.enable(id,{expectedRevision:expectedRevision(expectedRuntimeRevision)});
    let activated;
    try {
      activated=await runtime.activate(id,{expectedRevision:enabled.revision});
    } catch {
      if(module.value.lastKnownGoodPackageHash && module.value.lastKnownGoodPackageHash!==module.value.activePackageHash) {
        await restorePreviousRuntime(id,module.value.activePackageHash,module.revision,false);
      }
      fail(MODULE_LIFECYCLE_ERROR_CODES.ACTIVATION_FAILED);
    }
    if(module.value.lastKnownGoodPackageHash!==module.value.activePackageHash) {
      try {
        await registry.markActivePackageKnownGood(id,module.value.activePackageHash,{expectedModuleRevision:module.revision});
      } catch {
        await restorePreviousRuntime(id,module.value.activePackageHash,module.revision,false);
        fail(MODULE_LIFECYCLE_ERROR_CODES.ACTIVATION_FAILED);
      }
    }
    return activated;
  }

  async function remove(moduleId,{expectedModuleRevision,expectedRuntimeRevision}={}) {
    const id=assertModuleId(moduleId);
    const module=await registry.getModule(id);
    if(!module||module.revision!==expectedRevision(expectedModuleRevision)) {
      fail(MODULE_LIFECYCLE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:module?.revision??0});
    }
    if(module.value.candidate) fail(MODULE_LIFECYCLE_ERROR_CODES.INVALID_STATE);
    let lifecycle=await read(id);
    assertOperable(lifecycle);
    const retained=[
      ...(module.value.activePackageHash?[module.value.activePackageHash]:[]),
      ...lifecycle.value.retainedPackageHashes.filter((item)=>item!==module.value.activePackageHash)
    ];
    await runtime.disable(id,{expectedRevision:expectedRevision(expectedRuntimeRevision)});
    const removed=await registry.deactivateModule(id,{expectedModuleRevision:module.revision});
    lifecycle=await write(id,lifecycle,MODULE_LIFECYCLE_STATES.REMOVED,retained);
    return Object.freeze({
      removed:true,
      moduleRevision:removed.revision,
      lifecycleRevision:lifecycle.revision,
      retainedPackageHashes:lifecycle.value.retainedPackageHashes
    });
  }

  async function purge(moduleId,{expectedModuleRevision,expectedRuntimeRevision}={}) {
    const id=assertModuleId(moduleId);
    const runtimeState=await runtime.getState(id);
    if(runtimeState.revision!==expectedRevision(expectedRuntimeRevision)
        || runtimeState.value.state!==MODULE_RUNTIME_STATES.DISABLED) {
      fail(MODULE_LIFECYCLE_ERROR_CODES.INVALID_STATE);
    }

    let lifecycle=await read(id);
    if(lifecycle.value.state!==MODULE_LIFECYCLE_STATES.REMOVED
        && lifecycle.value.state!==MODULE_LIFECYCLE_STATES.PURGING) {
      fail(MODULE_LIFECYCLE_ERROR_CODES.INVALID_STATE);
    }
    if(lifecycle.value.state===MODULE_LIFECYCLE_STATES.REMOVED) {
      lifecycle=await write(id,lifecycle,MODULE_LIFECYCLE_STATES.PURGING,lifecycle.value.retainedPackageHashes);
    }

    let module=await registry.getModule(id);
    const expectedModule=expectedRevision(expectedModuleRevision);
    if(module) {
      if(module.revision!==expectedModule) fail(MODULE_LIFECYCLE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:module.revision});
      if(module.value.activePackageHash!==null||module.value.candidate!==null) fail(MODULE_LIFECYCLE_ERROR_CODES.INVALID_STATE);
      await registry.deleteModule(id,{expectedModuleRevision:module.revision});
    } else if(expectedModule!==0 && lifecycle.value.state!==MODULE_LIFECYCLE_STATES.PURGING) {
      fail(MODULE_LIFECYCLE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:0});
    }

    try {
      const packages=await registry.listPackagesForModule(id);
      for(const pkg of packages) await registry.deletePackage(pkg.packageHash);
    } catch {
      fail(MODULE_LIFECYCLE_ERROR_CODES.PURGE_INCOMPLETE);
    }

    lifecycle=await write(id,lifecycle,MODULE_LIFECYCLE_STATES.PURGED,[]);
    return Object.freeze({
      purged:true,
      lifecycleRevision:lifecycle.revision,
      retainedPackageHashes:lifecycle.value.retainedPackageHashes
    });
  }

  async function getState(moduleId) {
    return read(assertModuleId(moduleId));
  }

  return Object.freeze({
    stageInstall,
    stageRollback,
    applyCandidate,
    disable,
    enable,
    remove,
    purge,
    getState
  });
}
