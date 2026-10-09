import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";
import { createPcmsAuditJournal } from "../../../extension/pcms/audit/journal.js";
import { AUDIT_ERROR_CODES, auditError } from "../../../extension/pcms/audit/errors.js";
import {
  AUDIT_META_KEY,
  AUDIT_NAMESPACE,
  auditEventKey,
  createAuditEvent,
  parseAuditEventKey
} from "../../../extension/pcms/audit/schema.js";
import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../../../extension/pcms/remoteops/recovery-hold.js";
import { createProviderGate } from "../../../extension/pcms/remoteops/provider-gate.js";
import { createModulePackageRegistry } from "../../../extension/pcms/modules/registry.js";
import { createModuleRuntimeBroker } from "../../../extension/pcms/runtime/module-runtime.js";

export const UID_A="11111111-1111-4111-8111-111111111111";
export const UID_B="22222222-2222-4222-8222-222222222222";
export const HASH_A="eb326958738d171e78bdff8117386308557c0f4d19783441bca3dea03314d2bc";
export const HASH_B="470f5e33c65605ccb235dfaab0f3bc914bb2c23ea7a408bf3ad81218feae39a2";

const clone=(value)=>structuredClone(value);
const id=(namespace,key)=>namespace+"\u0000"+key;

export function makeMemoryBackend(shared={rows:new Map()}) {
  function getRecord(namespace,key){return shared.rows.get(id(namespace,key))||null;}
  function putRecord(record){shared.rows.set(id(record.namespace,record.key),clone(record));}
  return Object.freeze({
    shared,
    async open(){},
    close(){},
    async get(namespace,key){const row=getRecord(namespace,key);return row?clone(row):null;},
    async compareAndSwap(namespace,key,expectedRevision,value,updatedAt){
      const current=getRecord(namespace,key);
      const revision=current?.revision||0;
      if(revision!==expectedRevision){
        const error=new Error("cas");
        error.code="PCMS_STORAGE_CAS_MISMATCH";
        error.currentRevision=revision;
        throw error;
      }
      const next={id:id(namespace,key),namespace,key,revision:revision+1,value:clone(value),updatedAt};
      putRecord(next);
      return clone(next);
    },
    async deleteCompareAndSwap(namespace,key,expectedRevision){
      const current=getRecord(namespace,key);
      const revision=current?.revision||0;
      if(revision!==expectedRevision){
        const error=new Error("cas");
        error.code="PCMS_STORAGE_CAS_MISMATCH";
        error.currentRevision=revision;
        throw error;
      }
      if(!current)return {deleted:false,revision:0};
      shared.rows.delete(id(namespace,key));
      return {deleted:true,revision};
    },
    async listNamespace(namespace){
      return [...shared.rows.values()]
        .filter((row)=>row.namespace===namespace)
        .sort((a,b)=>a.key.localeCompare(b.key))
        .map(clone);
    },
    async listAllRecords(){
      return [...shared.rows.values()]
        .sort((a,b)=>a.namespace.localeCompare(b.namespace)||a.key.localeCompare(b.key))
        .map(clone);
    },
    async replaceAllRecords(records){
      shared.rows.clear();
      for(const row of records){
        putRecord({
          id:id(row.namespace,row.key),
          namespace:row.namespace,
          key:row.key,
          revision:row.revision,
          updatedAt:row.updatedAt,
          value:row.value
        });
      }
      return {replaced:records.length};
    }
  });
}

export function makeAuditBackend(storageBackend) {
  const shared=storageBackend.shared;
  function get(namespace,key){return shared.rows.get(id(namespace,key))||null;}
  function put(record){shared.rows.set(id(record.namespace,record.key),clone(record));}
  function meta(){
    const row=get(AUDIT_NAMESPACE,AUDIT_META_KEY);
    return {row,lastSequence:row?.value?.lastSequence||0};
  }
  function eventRecord(event){
    const key=auditEventKey(event.sequence);
    return {id:id(AUDIT_NAMESPACE,key),namespace:AUDIT_NAMESPACE,key,revision:1,value:event,updatedAt:event.timestamp};
  }
  function metaRecord(sequence,timestamp){
    return {id:id(AUDIT_NAMESPACE,AUDIT_META_KEY),namespace:AUDIT_NAMESPACE,key:AUDIT_META_KEY,revision:sequence,value:{lastSequence:sequence},updatedAt:timestamp};
  }
  function nextEvent(draft,timestamp){
    const sequence=meta().lastSequence+1;
    return createAuditEvent({sequence,timestamp,draft});
  }

  return Object.freeze({
    async open(){},
    close(){},
    async append({draft,timestamp}){
      const event=nextEvent(draft,timestamp);
      put(eventRecord(event));
      put(metaRecord(event.sequence,timestamp));
      return clone(event);
    },
    async transitionAndAppend({transition,draft,timestamp}){
      const current=get(transition.namespace,transition.key);
      const revision=current?.revision||0;
      if(revision!==transition.expectedRevision){
        throw auditError(AUDIT_ERROR_CODES.CONFLICT,"conflict",{currentRevision:revision});
      }
      const event=nextEvent(draft,timestamp);
      const state={
        id:id(transition.namespace,transition.key),
        namespace:transition.namespace,
        key:transition.key,
        revision:revision+1,
        value:clone(transition.value),
        updatedAt:timestamp
      };
      put(state);
      put(eventRecord(event));
      put(metaRecord(event.sequence,timestamp));
      return {state:clone(state),event:clone(event)};
    },
    async read({afterSequence,limit}){
      const lastSequence=meta().lastSequence;
      const events=[...shared.rows.values()]
        .filter((row)=>row.namespace===AUDIT_NAMESPACE && parseAuditEventKey(row.key)!==null)
        .map((row)=>row.value)
        .filter((event)=>event.sequence>afterSequence)
        .sort((a,b)=>a.sequence-b.sequence)
        .slice(0,limit)
        .map(clone);
      const cursor=events.length?events[events.length-1].sequence:afterSequence;
      return {events,lastSequence,hasMore:cursor<lastSequence};
    }
  });
}

export function makePersonaBroker(personas={
  [UID_A]:{personaUid:UID_A,cookieStoreId:"firefox-container-a"},
  [UID_B]:{personaUid:UID_B,cookieStoreId:"firefox-container-b"}
}) {
  return Object.freeze({
    async request(request){
      const uid=request?.params?.personaUid;
      const result=personas[uid]||null;
      if(!result){
        return Object.freeze({ok:false,error:Object.freeze({code:"PERSONA_NOT_FOUND"})});
      }
      return Object.freeze({ok:true,result:Object.freeze(clone(result))});
    }
  });
}

export function makeProvisioningSupport() {
  const sessions=new Map();
  let generation=0;
  const sessionGuard=Object.freeze({
    async acquire({attemptId,personaUid}={}){
      const handle=Object.freeze({sessionKey:"session-"+attemptId,generation:++generation});
      sessions.set(attemptId,{personaUid,...handle});
      return handle;
    },
    async validate({attemptId,personaUid,sessionKey,generation:expected}={}){
      const current=sessions.get(attemptId);
      const active=Boolean(current&&current.personaUid===personaUid&&current.sessionKey===sessionKey&&current.generation===expected);
      return Object.freeze({active,handle:active?Object.freeze({attemptId,personaUid}):null});
    },
    async release({attemptId}={}){sessions.delete(attemptId);return Object.freeze({released:true});}
  });
  const providerSession=Object.freeze({
    async preflight(){return Object.freeze({status:"READY",reason:null});},
    async probeCompatibility(){return Object.freeze({providerId:"perchance",contractId:"pcms.perchance.provisioning",contractVersion:1,operations:Object.freeze(["account.provision"])});}
  });
  return Object.freeze({sessionGuard,providerSession});
}

export function makeCore() {
  let tick=0;
  const clock=()=>new Date(Date.UTC(2026,9,5,12,0,tick++)).toISOString();
  const backend=makeMemoryBackend();
  const storageBroker=createPcmsStorageBroker({backend,clock});
  const auditJournal=createPcmsAuditJournal({backend:makeAuditBackend(backend),clock});
  const remoteOps=createRemoteOps({storageBroker,clock});
  const recoveryHold=createRecoveryHoldController({storageBroker,remoteOps,clock});
  const providers=Object.freeze({
    perchance:Object.freeze({
      operations:Object.freeze({
        "generator.update":Object.freeze({
          async dispatch(){return Object.freeze({status:"APPLIED"});},
          async reconcile(){return Object.freeze({status:"APPLIED"});}
        }),
        "account.provision":Object.freeze({
          async dispatch(){return Object.freeze({status:"APPLIED"});},
          async reconcile(){return Object.freeze({status:"APPLIED"});}
        })
      })
    })
  });
  const providerGate=createProviderGate({remoteOps,recoveryHold,providers});
  const moduleRegistry=createModulePackageRegistry({storageBroker,clock});
  const moduleRuntime=createModuleRuntimeBroker({storageBroker,moduleRegistry,recoveryHold});
  const personaBroker=makePersonaBroker();
  const provisioning=makeProvisioningSupport();
  const providerProbes=Object.freeze([Object.freeze({
    async probeCompatibility(){return Object.freeze({providerId:"perchance"});}
  })]);

  return Object.freeze({
    backend,storageBroker,auditJournal,remoteOps,recoveryHold,providerGate,
    moduleRegistry,moduleRuntime,personaBroker,provisioning,providerProbes,clock
  });
}
