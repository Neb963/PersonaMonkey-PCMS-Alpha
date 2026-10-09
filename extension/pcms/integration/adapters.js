import { INTEGRATION_ERROR_CODES, integrationError } from "./errors.js";

const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

function fail(code,options={}) { throw integrationError(code,options); }

function plain(value) {
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}

function snapshotMethods(value,names,label,{allowExtra=false}={}) {
  if(!plain(value)||Object.getOwnPropertySymbols(value).length) throw new TypeError(label+" is invalid");
  const d=Object.getOwnPropertyDescriptors(value);
  if((!allowExtra&&Object.keys(d).length!==names.length)
      || !names.every((name)=>Object.hasOwn(d,name)&&d[name].enumerable&&Object.hasOwn(d[name],"value")&&typeof d[name].value==="function")) {
    throw new TypeError(label+" is invalid");
  }
  return Object.freeze(Object.fromEntries(names.map((name)=>[name,d[name].value])));
}

function boundedId(value) {
  if(typeof value!=="string"||!ID_PATTERN.test(value)) fail(INTEGRATION_ERROR_CODES.INVALID_ARGUMENT);
  return value;
}

function mapCas(error) {
  if(error?.code==="PCMS_STORAGE_CAS_MISMATCH") {
    return Object.freeze({ok:false,currentRevision:Number.isSafeInteger(error.currentRevision)?error.currentRevision:0});
  }
  fail(INTEGRATION_ERROR_CODES.STORAGE_PROTOCOL);
}

export function createSingletonStateStore({storageBroker,namespace,key="state"}={}) {
  if(!storageBroker||typeof storageBroker.namespace!=="function") throw new TypeError("Singleton state store requires PCMS storage");
  if(typeof namespace!=="string"||typeof key!=="string") throw new TypeError("Singleton state store identity is invalid");
  const store=storageBroker.namespace(namespace);
  return Object.freeze({
    async read() {
      let row;
      try { row=await store.get(key); } catch { fail(INTEGRATION_ERROR_CODES.STORAGE_PROTOCOL); }
      if(row===null)return null;
      return Object.freeze({revision:row.revision,value:row.value});
    },
    async compareAndSwap({expectedRevision,value}={}) {
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0) fail(INTEGRATION_ERROR_CODES.INVALID_ARGUMENT);
      try {
        const row=await store.compareAndSwap(key,{expectedRevision,value});
        return Object.freeze({ok:true,revision:row.revision,value:row.value});
      } catch(error) {
        return mapCas(error);
      }
    }
  });
}

export function createKeyedStateStore({storageBroker,namespace,keyPrefix=""}={}) {
  if(!storageBroker||typeof storageBroker.namespace!=="function") throw new TypeError("Keyed state store requires PCMS storage");
  if(typeof namespace!=="string"||typeof keyPrefix!=="string") throw new TypeError("Keyed state store identity is invalid");
  const store=storageBroker.namespace(namespace);
  const keyFor=(id)=>keyPrefix+boundedId(id);
  return Object.freeze({
    async get(id) {
      let row;
      try { row=await store.get(keyFor(id)); } catch { fail(INTEGRATION_ERROR_CODES.STORAGE_PROTOCOL); }
      return row===null?null:Object.freeze({revision:row.revision,value:row.value});
    },
    async list() {
      let rows;
      try { rows=await store.list(); } catch { fail(INTEGRATION_ERROR_CODES.STORAGE_PROTOCOL); }
      if(!Array.isArray(rows)) fail(INTEGRATION_ERROR_CODES.STORAGE_PROTOCOL);
      const prefix=keyPrefix;
      const filtered=rows.filter((row)=>typeof row?.key==="string"&&row.key.startsWith(prefix));
      return Object.freeze(filtered.map((row)=>Object.freeze({revision:row.revision,value:row.value})));
    },
    async compareAndSwap({attemptId,expectedRevision,value}={}) {
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0) fail(INTEGRATION_ERROR_CODES.INVALID_ARGUMENT);
      const key=keyFor(attemptId);
      try {
        const row=await store.compareAndSwap(key,{expectedRevision,value});
        return Object.freeze({ok:true,revision:row.revision,value:row.value});
      } catch(error) {
        return mapCas(error);
      }
    }
  });
}

export function createPersonaResolverFromBroker({broker,requestIdFactory=null}={}) {
  const api=snapshotMethods(broker,["request"],"Persona Broker",{allowExtra:true});
  let sequence=0;
  const nextId=typeof requestIdFactory==="function"
    ? requestIdFactory
    : ()=>"pcms-persona-"+(++sequence);
  return Object.freeze({
    async get(personaUid) {
      boundedId(personaUid);
      let response;
      try {
        response=await api.request(Object.freeze({
          command:"persona.get",
          requestId:boundedId(nextId()),
          params:Object.freeze({personaUid})
        }));
      } catch {
        fail(INTEGRATION_ERROR_CODES.BROKER_PROTOCOL);
      }
      if(!plain(response)||typeof response.ok!=="boolean") fail(INTEGRATION_ERROR_CODES.BROKER_PROTOCOL);
      if(response.ok===false) {
        if(response.error?.code==="PERSONA_NOT_FOUND") return null;
        fail(INTEGRATION_ERROR_CODES.BROKER_PROTOCOL);
      }
      if(!plain(response.result)) fail(INTEGRATION_ERROR_CODES.BROKER_PROTOCOL);
      return response.result;
    }
  });
}

export function createAccountProviderGateResolver({accountsService,providerGate,operationContext=null}={}) {
  const accounts=snapshotMethods(accountsService,["getAccount"],"Accounts service",{allowExtra:true});
  const gate=snapshotMethods(providerGate,["mutate","reconcile"],"ProviderGate",{allowExtra:true});
  const context=operationContext===null?null:snapshotMethods(operationContext,["bind"],"Live operation context",{allowExtra:true});
  return Object.freeze({
    async get(accountId) {
      boundedId(accountId);
      let account;
      try { account=await accounts.getAccount(accountId); } catch { return null; }
      if(!account)return null;
      if(context===null)return gate;
      return Object.freeze({
        async mutate(input) {
          await context.bind({
            operation:input?.operation,
            accountId:account.accountId,
            personaUid:account.personaUid
          });
          return gate.mutate(input);
        },
        reconcile:gate.reconcile
      });
    }
  });
}

export function createRemoteOperationReader({remoteOps}={}) {
  const ops=snapshotMethods(remoteOps,["get"],"RemoteOps",{allowExtra:true});
  return Object.freeze({async get(operationId){return ops.get(boundedId(operationId));}});
}

export function createProvisioningRemoteControl({providerGate,remoteOps,operationContext=null}={}) {
  const gate=snapshotMethods(providerGate,["mutate","reconcile"],"ProviderGate",{allowExtra:true});
  const ops=snapshotMethods(remoteOps,["get"],"RemoteOps",{allowExtra:true});
  const context=operationContext===null?null:snapshotMethods(operationContext,["bind"],"Live operation context",{allowExtra:true});
  return Object.freeze({
    async mutate(input) {
      if(context!==null) {
        await context.bind({
          operation:input?.operation,
          accountId:input?.dispatchInput?.accountId,
          personaUid:input?.dispatchInput?.personaUid
        });
      }
      return gate.mutate(input);
    },
    reconcile:gate.reconcile,
    get:ops.get
  });
}
