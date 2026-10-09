import { createModulePackageRegistry } from "../../../extension/pcms/modules/registry.js";
import { PCMS_MODULE_ARCHIVE_FORMAT, encodeModuleArchive } from "../../../extension/pcms/modules/package.js";
import { MODULE_RUNTIME_STATES } from "../../../extension/pcms/runtime/module-runtime.js";

const clone=(value)=>structuredClone(value);

export function makeStorage(shared={namespaces:new Map()}) {
  function rows(namespace) {
    let map=shared.namespaces.get(namespace);
    if(!map){map=new Map();shared.namespaces.set(namespace,map);}
    return map;
  }
  return Object.freeze({
    shared,
    namespace(namespace) {
      const map=rows(namespace);
      return Object.freeze({
        async get(key){const row=map.get(key);return row?clone(row):null;},
        async compareAndSwap(key,{expectedRevision,value}) {
          const current=map.get(key);
          const revision=current?.revision||0;
          if(revision!==expectedRevision){
            const error=new Error("cas");
            error.code="PCMS_STORAGE_CAS_MISMATCH";
            error.currentRevision=revision;
            throw error;
          }
          const next={key,revision:revision+1,updatedAt:"2026-10-05T12:00:00.000Z",value:clone(value)};
          map.set(key,next);
          return clone(next);
        },
        async deleteCompareAndSwap(key,{expectedRevision}) {
          const current=map.get(key);
          const revision=current?.revision||0;
          if(revision!==expectedRevision){
            const error=new Error("cas");
            error.code="PCMS_STORAGE_CAS_MISMATCH";
            error.currentRevision=revision;
            throw error;
          }
          if(!current)return {deleted:false,revision:0};
          map.delete(key);
          return {deleted:true,revision};
        },
        async list(){return [...map.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(clone);}
      });
    }
  });
}

export function archive(version,{moduleId="demo.module",capabilities=["data.read"]}={}) {
  return encodeModuleArchive({
    format:PCMS_MODULE_ARCHIVE_FORMAT,
    manifest:{
      schemaVersion:1,
      moduleId,
      version,
      controller:"controller.js",
      authority:{capabilities}
    },
    files:{
      "controller.js":`() => ({ start(){ return ${JSON.stringify(version)}; }, version(){ return ${JSON.stringify(version)}; }, dispose(){ return null; } })`
    }
  });
}

export function makeRegistry(storage) {
  let tick=0;
  return createModulePackageRegistry({
    storageBroker:storage,
    clock:()=>`2026-10-05T12:00:${String(++tick).padStart(2,"0")}.000Z`
  });
}

export function makeRuntime(registry) {
  const rows=new Map();
  const events=[];
  let failNext=false;

  function defaultRow(moduleId) {
    return {revision:0,value:{moduleId,generation:0,state:MODULE_RUNTIME_STATES.IDLE,activePackageHash:null}};
  }
  function current(moduleId){return rows.get(moduleId)||defaultRow(moduleId);}
  function save(moduleId,value) {
    const row=current(moduleId);
    const next={revision:row.revision+1,value:clone(value)};
    rows.set(moduleId,next);
    return clone(next);
  }
  function check(moduleId,expectedRevision) {
    const row=current(moduleId);
    if(row.revision!==expectedRevision) throw new Error("runtime revision");
    return row;
  }

  const api=Object.freeze({
    async getState(moduleId){return clone(current(moduleId));},
    async prepareUpdate(moduleId,{expectedRevision}={}) {
      const row=check(moduleId,expectedRevision);
      events.push("prepare:"+moduleId+":"+row.value.state);
      return save(moduleId,{
        moduleId,
        generation:row.value.generation+1,
        state:row.value.state===MODULE_RUNTIME_STATES.DISABLED?MODULE_RUNTIME_STATES.DISABLED:MODULE_RUNTIME_STATES.IDLE,
        activePackageHash:null
      });
    },
    async activate(moduleId,{expectedRevision}={}) {
      const row=check(moduleId,expectedRevision);
      if(row.value.state!==MODULE_RUNTIME_STATES.IDLE) throw new Error("runtime state");
      const module=await registry.getModule(moduleId);
      const packageHash=module?.value?.activePackageHash;
      if(!packageHash) throw new Error("no active package");
      events.push("activate:"+packageHash);
      if(failNext){
        failNext=false;
        save(moduleId,{
          moduleId,
          generation:Math.max(1,row.value.generation)+1,
          state:MODULE_RUNTIME_STATES.IDLE,
          activePackageHash:null
        });
        throw new Error("activation failed");
      }
      const generation=Math.max(1,row.value.generation);
      const saved=save(moduleId,{
        moduleId,
        generation,
        state:MODULE_RUNTIME_STATES.ACTIVE,
        activePackageHash:packageHash
      });
      return Object.freeze({
        revision:saved.revision,
        generation,
        packageHash,
        sessionId:"session-"+generation,
        startResult:"ok"
      });
    },
    async disable(moduleId,{expectedRevision}={}) {
      const row=check(moduleId,expectedRevision);
      events.push("disable:"+moduleId);
      if(row.value.state===MODULE_RUNTIME_STATES.DISABLED)return clone(row);
      return save(moduleId,{
        moduleId,
        generation:row.value.generation+1,
        state:MODULE_RUNTIME_STATES.DISABLED,
        activePackageHash:null
      });
    },
    async enable(moduleId,{expectedRevision}={}) {
      const row=check(moduleId,expectedRevision);
      if(row.value.state!==MODULE_RUNTIME_STATES.DISABLED) throw new Error("runtime state");
      events.push("enable:"+moduleId);
      return save(moduleId,{
        moduleId,
        generation:row.value.generation+1,
        state:MODULE_RUNTIME_STATES.IDLE,
        activePackageHash:null
      });
    }
  });

  return Object.freeze({
    api,
    events,
    failNextActivation(){failNext=true;}
  });
}

export async function stageAndApply(service,runtime,bytes,{moduleRevision=0,approveAuthority=true}={}) {
  const staged=await service.stageInstall(bytes,{expectedModuleRevision:moduleRevision});
  const runtimeState=await runtime.api.getState(staged.value.moduleId);
  return service.applyCandidate(staged.value.moduleId,staged.value.candidate.packageHash,{
    expectedModuleRevision:staged.revision,
    expectedRuntimeRevision:runtimeState.revision,
    approveAuthority
  });
}
