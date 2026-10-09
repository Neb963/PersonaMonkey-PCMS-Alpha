import { getPersonaBrokerCommand } from "../core/persona-broker-contract.js";
import { createPerchanceProviderAdapter } from "../providers/perchance/adapter.js";
import { PERCHANCE_ASSISTED_CAPABILITIES, createPerchanceAssistedReleaseMethods } from "../providers/perchance/assisted-driver.js";
import { createPerchanceExecutionReadDriver } from "../providers/perchance/execution-read-driver.js";
import { createPerchanceExecutionUpdateDriver } from "../providers/perchance/execution-update-driver.js";
import {
  PERCHANCE_DRIVER_CONTRACT_ID,
  PERCHANCE_DRIVER_CONTRACT_VERSION_V2,
  PERCHANCE_GENERATOR_UPDATE_ACTION,
  PERCHANCE_PROVIDER_ID
} from "../providers/perchance/contract.js";

const CONTEXT_NAMESPACE="integration.live-provider-context";
const DISPATCH_MODE_NAMESPACE="integration.live-provider-dispatch-mode";
const PROVISION_ACTION="account.provision";
const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const UID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plain(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
}
function id(value,label="id"){
  if(typeof value!=="string"||!ID_PATTERN.test(value)) throw new TypeError(label+" is invalid");
  return value;
}
function uid(value){
  if(typeof value!=="string"||!UID_PATTERN.test(value)) throw new TypeError("personaUid is invalid");
  return value.toLowerCase();
}
function errorFromResponse(response){
  const error=new Error(response?.error?.message||"Persona Broker request failed");
  error.name="PcmsLiveBrokerError";
  error.code=response?.error?.code||"PCMS_LIVE_BROKER_ERROR";
  error.retryable=response?.error?.retryable===true;
  return error;
}
function requestId(prefix,sequence){
  return "pcms-"+prefix+"-"+String(sequence);
}
function operationSuffix(operationId,suffix){
  const value=operationId+":"+suffix;
  return value.length<=256?value:"pcms:"+suffix+":"+operationId.slice(-220);
}

export function createLiveBrokerClient({broker}={}){
  if(!broker||typeof broker.request!=="function") throw new TypeError("Live Broker client requires Persona Broker");
  let state=null;
  let sequence=0;
  let tail=Promise.resolve();

  function serialized(run){
    const next=tail.then(run,run);
    tail=next.catch(()=>{});
    return next;
  }
  function observe(response){
    if(response&&typeof response.bootId==="string"&&Number.isSafeInteger(response.revision)&&response.revision>=0){
      state=Object.freeze({bootId:response.bootId,revision:response.revision});
    }
  }
  async function syncUnlocked(){
    const response=await broker.request({
      command:"system.status",
      params:{},
      requestId:requestId("status",++sequence)
    });
    observe(response);
    if(!response.ok) throw errorFromResponse(response);
    return response.result;
  }
  async function request(command,params={},options={}){
    return serialized(async()=>{
      const descriptor=getPersonaBrokerCommand(command);
      if(!descriptor) throw new TypeError("Unknown Persona Broker command");
      const envelope={
        command,
        params,
        requestId:requestId("req",++sequence)
      };
      if(descriptor.requiresOperation){
        const operationId=id(options.operationId,"operationId");
        await syncUnlocked();
        envelope.operationId=operationId;
        envelope.precondition={bootId:state.bootId,revision:state.revision};
      }
      let response;
      try{
        response=await broker.request(envelope);
      }catch(error){
        try{await syncUnlocked();}catch{}
        throw error;
      }
      observe(response);
      if(!response.ok) throw errorFromResponse(response);
      return response.result;
    });
  }
  function sync(){return serialized(syncUnlocked);}
  function snapshot(){return state?Object.freeze({...state}):null;}
  return Object.freeze({request,sync,snapshot});
}

export function createLiveOperationContext({storageBroker}={}){
  if(!storageBroker||typeof storageBroker.namespace!=="function") throw new TypeError("Live operation context requires PCMS storage");
  const store=storageBroker.namespace(CONTEXT_NAMESPACE);

  async function bind({operation,accountId,personaUid}={}){
    if(!plain(operation)) throw new TypeError("Operation context requires operation");
    const operationId=id(operation.operationId,"operationId");
    const providerId=id(operation.providerId,"providerId");
    const action=id(operation.action,"action");
    if(!plain(operation.targetRef)) throw new TypeError("Operation target is invalid");
    const targetKind=id(operation.targetRef.kind,"target kind");
    const targetId=id(operation.targetRef.id,"target id");
    if(typeof operation.intentFingerprint!=="string"||operation.intentFingerprint.length<1||operation.intentFingerprint.length>512) {
      throw new TypeError("Operation intent fingerprint is invalid");
    }
    const value=Object.freeze({
      schemaVersion:1,
      kind:"live-provider-context",
      operationId,
      providerId,
      action,
      accountId:id(accountId,"accountId"),
      personaUid:uid(personaUid),
      targetRef:Object.freeze({kind:targetKind,id:targetId}),
      intentFingerprint:operation.intentFingerprint
    });
    const current=await store.get(operationId);
    if(current){
      if(JSON.stringify(current.value)!==JSON.stringify(value)) throw new Error("Live provider operation context conflict");
      return current;
    }
    return store.compareAndSwap(operationId,{expectedRevision:0,value});
  }

  async function get(rawOperationId){
    const operationId=id(rawOperationId,"operationId");
    const row=await store.get(operationId);
    if(!row) return null;
    const value=row.value;
    if(!plain(value)||value.schemaVersion!==1||value.kind!=="live-provider-context"||value.operationId!==operationId
      ||typeof value.accountId!=="string"||!UID_PATTERN.test(value.personaUid)||!plain(value.targetRef)){
      throw new Error("Live provider operation context is corrupt");
    }
    return Object.freeze({
      operationId:value.operationId,
      providerId:value.providerId,
      action:value.action,
      accountId:value.accountId,
      personaUid:value.personaUid.toLowerCase(),
      targetRef:Object.freeze({...value.targetRef}),
      intentFingerprint:value.intentFingerprint
    });
  }

  return Object.freeze({bind,get});
}

function createProvisioningSessionGuard({client}){
  async function acquire({attemptId,personaUid,sessionEpoch}={}){
    const safeAttempt=id(attemptId,"attemptId");
    const safeUid=uid(personaUid);
    if(!Number.isSafeInteger(sessionEpoch)||sessionEpoch<1) throw new TypeError("sessionEpoch is invalid");
    const operationId=operationSuffix("provision-session:"+safeAttempt+":"+sessionEpoch,"acquire");
    let lease;
    try{
      lease=await client.request("persona.control.acquire",{
        personaUid:safeUid,
        purpose:"PCMS account provisioning "+safeAttempt,
        ttlMs:300000
      },{operationId});
    }catch(error){
      const current=await client.request("persona.control.get",{personaUid:safeUid});
      if(current?.controlled!==true||current?.owner!=="self"||typeof current?.leaseId!=="string") throw error;
      lease=current;
    }
    if(typeof lease?.leaseId!=="string"||lease.leaseId.length<1) throw new Error("Persona control lease is unavailable");
    return Object.freeze({sessionKey:lease.leaseId,generation:sessionEpoch});
  }

  async function validate({attemptId,personaUid,sessionKey,generation}={}){
    const safeAttempt=id(attemptId,"attemptId");
    const safeUid=uid(personaUid);
    id(sessionKey,"sessionKey");
    if(!Number.isSafeInteger(generation)||generation<1) return Object.freeze({active:false,handle:null});
    let current;
    try{current=await client.request("persona.control.get",{personaUid:safeUid});}
    catch{return Object.freeze({active:false,handle:null});}
    const active=current?.controlled===true&&current?.owner==="self"&&current?.leaseId===sessionKey;
    return Object.freeze({
      active,
      handle:active?Object.freeze({attemptId:safeAttempt,personaUid:safeUid,sessionKey,generation}):null
    });
  }

  async function release({attemptId="release",personaUid,sessionKey,generation}={}){
    const safeUid=uid(personaUid);
    id(sessionKey,"sessionKey");
    const suffix=Number.isSafeInteger(generation)&&generation>0?String(generation):"0";
    try{
      await client.request("persona.control.release",{leaseId:sessionKey},{
        operationId:operationSuffix("provision-session:"+id(attemptId,"attemptId")+":"+suffix,"release")
      });
    }catch(error){
      let current;
      try{current=await client.request("persona.control.get",{personaUid:safeUid});}catch{throw error;}
      if(current?.controlled===true&&current?.owner==="self"&&current?.leaseId===sessionKey) throw error;
    }
    return Object.freeze({released:true});
  }
  return Object.freeze({acquire,validate,release});
}

function createProvisioningProviderSession(){
  const prompted=new Set();
  async function preflight({sessionHandle}={}){
    const key=sessionHandle?.sessionKey;
    if(typeof key!=="string"||key.length<1) return Object.freeze({status:"HUMAN_REQUIRED",reason:"OPERATOR_ACTION"});
    if(!prompted.has(key)){
      prompted.add(key);
      return Object.freeze({status:"HUMAN_REQUIRED",reason:"OPERATOR_ACTION"});
    }
    return Object.freeze({status:"READY",reason:null});
  }
  return Object.freeze({preflight});
}

async function requireContext(operationContext,operationId){
  const context=await operationContext.get(operationId);
  if(!context) throw new Error("Live provider operation context is unavailable");
  return context;
}

async function openPersona(client,context,url,operationId,suffix){
  return client.request("persona.open",{
    personaUid:context.personaUid,
    url,
    active:true,
    allowDirect:true
  },{
    operationId:operationSuffix(operationId,suffix)
  });
}

function providerDescriptor(adapter,accountProvisionBehavior){
  return Object.freeze({
    operations:Object.freeze({
      ...adapter.providerDescriptor.operations,
      [PROVISION_ACTION]:Object.freeze(accountProvisionBehavior)
    })
  });
}

export function createPcmsLiveMutationIntegration({
  storageBroker,
  personaBroker,
  operator,
  observationProfile = null,
  automationProfile = null,
  allowDirect = false
}={}){
  if(!operator||typeof operator.choose!=="function") throw new TypeError("Live mutations require an operator bridge");
  const client=createLiveBrokerClient({broker:personaBroker});
  const operationContext=createLiveOperationContext({storageBroker});
  const readDriver=createPerchanceExecutionReadDriver({client,profile:observationProfile,allowDirect});
  // P042: unattended generator.update v2 only through reviewed PersonaMonkey execution
  // artifacts. Production composes no automation profile, so `unattended` stays false.
  const updateDriver=createPerchanceExecutionUpdateDriver({client,profile:automationProfile,allowDirect});
  const dispatchModes=storageBroker.namespace(DISPATCH_MODE_NAMESPACE);
  async function markUnattended(operationId){
    const current=await dispatchModes.get(operationId);
    if(current?.value?.mode==="UNATTENDED") return;
    if(current) throw new Error("Live provider dispatch mode conflict");
    await dispatchModes.compareAndSwap(operationId,{expectedRevision:0,value:Object.freeze({schemaVersion:1,operationId,mode:"UNATTENDED"})});
  }
  async function dispatchedUnattended(operationId){
    return (await dispatchModes.get(id(operationId,"operationId")))?.value?.mode==="UNATTENDED";
  }

  // pcms.perchance.driver/v2 (P036): the same assisted generator.update also takes release
  // payloads. Every unattended/observe/listing capability stays off until live phases.
  const release=createPerchanceAssistedReleaseMethods({
    operator,
    async openTarget({operationId,generatorId,phase}){
      const context=await requireContext(operationContext,operationId);
      await openPersona(client,context,"https://perchance.org/"+encodeURIComponent(generatorId),operationId,phase);
      return context;
    }
  });
  const driver=Object.freeze({
    async probe(){
      await client.request("system.status",{});
      const observe=await readDriver.available();
      const unattended=await updateDriver.available();
      return Object.freeze({
        contractId:PERCHANCE_DRIVER_CONTRACT_ID,
        contractVersion:PERCHANCE_DRIVER_CONTRACT_VERSION_V2,
        providerId:PERCHANCE_PROVIDER_ID,
        operations:Object.freeze([PERCHANCE_GENERATOR_UPDATE_ACTION,...(observe?["generator.observe"]:[])]),
        // The reviewed artifact sets listing and thumbnail itself; create is never offered.
        capabilities:Object.freeze({...PERCHANCE_ASSISTED_CAPABILITIES,observe,unattended,
          listing:unattended,thumbnail:unattended})
      });
    },
    // The dispatch mode is durable before the artifact runs, so reconciliation asks the same
    // authority that dispatched. Without the capability the assisted handoff is unchanged.
    async updateGeneratorRelease(input){
      if(!await updateDriver.available()) return release.updateGeneratorRelease(input);
      const context=await requireContext(operationContext,input.operationId);
      await markUnattended(input.operationId);
      return updateDriver.updateGeneratorRelease({...input,personaUid:context.personaUid});
    },
    async reconcileGeneratorRelease(input){
      if(await dispatchedUnattended(input.operationId)&&await updateDriver.available()){
        const context=await requireContext(operationContext,input.operationId);
        const answer=await updateDriver.reconcileGeneratorRelease({...input,personaUid:context.personaUid});
        if(answer.status!=="UNKNOWN") return answer;
      }
      // An unanswered unattended operation falls back to the operator; it is never retried.
      return release.reconcileGeneratorRelease(input);
    },
    observeGenerator:readDriver.observeGenerator,
    async updateGenerator({operationId,generatorId,sourceHash,source}={}){
      const context=await requireContext(operationContext,operationId);
      await openPersona(client,context,"https://perchance.org/"+encodeURIComponent(generatorId),operationId,"open");
      const choice=await operator.choose({
        operationId,
        phase:"dispatch",
        subjectRef:context.targetRef,
        title:"Apply Perchance generator update",
        instructions:"PCMS opened the generator in its bound Persona. Copy the desired source below into the Perchance editor and save it. Resolve any stale-save warning explicitly. Choose Applied only after Perchance confirms the save.",
        source,
        sourceHash,
        choices:["APPLIED","NOT_APPLIED"]
      });
      if(choice!=="APPLIED"&&choice!=="NOT_APPLIED") throw new Error("Generator update outcome is uncertain");
      return Object.freeze({status:choice});
    },
    async reconcileGeneratorUpdate({operationId,generatorId,sourceHash}={}){
      const context=await requireContext(operationContext,operationId);
      await openPersona(client,context,"https://perchance.org/"+encodeURIComponent(generatorId),operationId,"verify");
      const choice=await operator.choose({
        operationId,
        phase:"reconcile",
        subjectRef:context.targetRef,
        title:"Reconcile Perchance generator update",
        instructions:"Inspect the server-saved generator in the bound Persona. Choose Applied only if the saved source matches the intended SHA-256. Choose Not applied only if you can prove the intended save did not happen; otherwise keep it Unknown.",
        source:null,
        sourceHash,
        choices:["APPLIED","NOT_APPLIED","UNKNOWN"]
      });
      return Object.freeze({status:["APPLIED","NOT_APPLIED","UNKNOWN"].includes(choice)?choice:"UNKNOWN"});
    }
  });
  const adapter=createPerchanceProviderAdapter({driver});

  const accountProvisionBehavior=Object.freeze({
    async dispatch({operation}={}){
      const context=await requireContext(operationContext,operation.operationId);
      await openPersona(client,context,"https://perchance.org/",operation.operationId,"open");
      const choice=await operator.choose({
        operationId:operation.operationId,
        phase:"dispatch",
        subjectRef:context.targetRef,
        title:"Complete Perchance account provisioning",
        instructions:"Complete the provider action in this bound Persona, including login, email verification, or CAPTCHA if Perchance asks for it. PCMS does not bypass or solve CAPTCHA. Choose Applied only after the account/session is usable.",
        source:null,
        sourceHash:null,
        choices:["APPLIED","NOT_APPLIED"]
      });
      if(choice!=="APPLIED"&&choice!=="NOT_APPLIED") throw new Error("Provisioning outcome is uncertain");
      return Object.freeze({status:choice});
    },
    async reconcile({operation}={}){
      const context=await requireContext(operationContext,operation.operationId);
      await openPersona(client,context,"https://perchance.org/",operation.operationId,"verify");
      const choice=await operator.choose({
        operationId:operation.operationId,
        phase:"reconcile",
        subjectRef:context.targetRef,
        title:"Reconcile Perchance account provisioning",
        instructions:"Verify the provider account/session in this bound Persona. Choose Applied only when the intended provisioning is known complete; choose Not applied only when known absent; otherwise keep it Unknown.",
        source:null,
        sourceHash:null,
        choices:["APPLIED","NOT_APPLIED","UNKNOWN"]
      });
      return Object.freeze({status:["APPLIED","NOT_APPLIED","UNKNOWN"].includes(choice)?choice:"UNKNOWN"});
    }
  });

  const provisioning=Object.freeze({
    sessionGuard:createProvisioningSessionGuard({client}),
    providerSession:createProvisioningProviderSession()
  });

  return Object.freeze({
    providers:Object.freeze({
      [PERCHANCE_PROVIDER_ID]:providerDescriptor(adapter,accountProvisionBehavior)
    }),
    providerProbes:Object.freeze([adapter]),
    operationContext,
    provisioning,
    client
  });
}
