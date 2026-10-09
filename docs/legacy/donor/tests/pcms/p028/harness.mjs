import { createPcmsAuditJournal } from "../../../extension/pcms/audit/journal.js";
import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";
import { makeAuditBackend, makeMemoryBackend } from "../p023/harness.mjs";

export const UID="11111111-1111-4111-8111-111111111111";
export const BASE_URL="moz-extension://pcms-test-uuid/";
export const RUNTIME_ID="persona-route-manager@local";
export const PCMS_SENDER=Object.freeze({id:RUNTIME_ID,url:BASE_URL+"pcms/app/index.html"});

// One durable store standing in for PCMS IndexedDB: the real storage broker and Audit
// Journal over the accepted P023 memory backends. A "new context" is new service
// objects over the same `shared` rows.
export function makeDurable(shared={rows:new Map()},{now="2026-10-07T12:00:00.000Z"}={}){
  const backend=makeMemoryBackend(shared);
  const clock=()=>now;
  const storageBroker=createPcmsStorageBroker({backend,clock});
  const auditJournal=createPcmsAuditJournal({backend:makeAuditBackend(backend),clock});
  return {shared,storageBroker,auditJournal,clock};
}

export function makeSessionStore(shared=new Map()){
  return {
    shared,
    async get(key){return shared.has(key)?structuredClone(shared.get(key)):null;},
    async set(key,value){shared.set(key,structuredClone(value));}
  };
}

// Persona Broker fake following the Integration-v1 response envelope.
export function brokerHarness({bootId="boot-p028"}={}){
  const requests=[];
  let revision=10;
  return {
    requests,
    broker:Object.freeze({
      async request(request){
        requests.push(structuredClone(request));
        if(request.command==="system.status"){
          return Object.freeze({ok:true,result:Object.freeze({ready:true}),bootId,revision});
        }
        if(request.command==="persona.open"){
          revision+=1;
          return Object.freeze({ok:true,result:Object.freeze({tabId:revision,personaUid:request.params.personaUid}),bootId,revision});
        }
        throw new Error("Unexpected broker command: "+request.command);
      }
    })
  };
}

// Integration-v1 handler fake (what managementIntegration.handleInternalRequest returns),
// usable behind either the runtime-message transport or the in-process endpoint.
export function integrationHandler({personas=[{personaUid:UID,cookieStoreId:"firefox-container-1",name:"Persona One"}]}={}){
  let revision=7;
  const seen=[];
  return {
    seen,
    async handleRequest(request){
      seen.push(structuredClone(request));
      const base={type:"PERSONAMONKEY_INTEGRATION_RESPONSE",version:1,requestId:request.requestId,bootId:"boot-1"};
      if(request.operationId!==undefined) base.operationId=request.operationId;
      if(request.precondition&&(request.precondition.bootId!=="boot-1"||request.precondition.revision!==revision)){
        return {...base,ok:false,revision,error:{code:"STATE_CONFLICT",message:"Revision changed",retryable:true}};
      }
      if(request.command==="system.status") return {...base,ok:true,revision,result:{ready:true,productVersion:"1.2.0"}};
      if(request.command==="persona.list") return {...base,ok:true,revision,result:{items:personas,hasMore:false}};
      if(request.command==="persona.open"){revision+=1;return {...base,ok:true,revision,result:{tabId:3,personaUid:request.params.personaUid}};}
      if(request.command==="persona.get"){
        const persona=personas.find((item)=>item.personaUid===request.params.personaUid);
        return persona
          ? {...base,ok:true,revision,result:{personaUid:persona.personaUid,cookieStoreId:persona.cookieStoreId}}
          : {...base,ok:false,revision,error:{code:"PERSONA_NOT_FOUND",message:"Persona not found",retryable:false}};
      }
      if(request.command==="persona.control.get") return {...base,ok:true,revision,result:{controlled:false,owner:null,leaseId:null}};
      return {...base,ok:false,revision,error:{code:"INTEGRATION_UNKNOWN_COMMAND",message:"Unknown command",retryable:false}};
    }
  };
}
