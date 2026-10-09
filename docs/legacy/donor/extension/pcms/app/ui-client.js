// Dashboard-side facade over pcms.ui-client/v1. It mirrors the Core service methods the
// accepted P021/P026 views call, so those views run unchanged while every call is a
// validated query or idempotent command answered by the background Core (ADR-002 §8).
// This module constructs no Core service.
import {
  PCMS_UI_OPERATIONS,
  PCMS_UI_PROTOCOL_VERSION,
  PCMS_UI_REQUEST_TYPE
} from "../integration/ui-client-contract.js";

const DEFAULT_TIMEOUT_MS=60000;
let sequence=0;

function randomKey(){
  const bytes=new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

function cleanArgs(args){
  const list=[...args];
  while(list.length&&list[list.length-1]===undefined) list.pop();
  return list.map((value)=>value===undefined?null:JSON.parse(JSON.stringify(value)));
}

function remoteError(error){
  const failure=new Error(typeof error?.message==="string"?error.message:"PCMS operation failed");
  failure.name="PcmsUiClientError";
  failure.code=typeof error?.code==="string"?error.code:"PCMS_UI_OPERATION_FAILED";
  if(Number.isSafeInteger(error?.currentRevision)) failure.currentRevision=error.currentRevision;
  return failure;
}

function withTimeout(promise,ms,setTimeoutRef,clearTimeoutRef){
  let timer=null;
  const timeout=new Promise((_resolve,reject)=>{
    timer=setTimeoutRef(()=>reject(Object.assign(new Error("PCMS Core did not answer"),{code:"PCMS_UI_TIMEOUT"})),ms);
  });
  return Promise.race([promise,timeout]).finally(()=>clearTimeoutRef(timer));
}

export function createPcmsUiClient({
  transport,
  timeoutMs=DEFAULT_TIMEOUT_MS,
  newIdempotencyKey=()=>"ui-"+randomKey(),
  setTimeoutRef=globalThis.setTimeout,
  clearTimeoutRef=globalThis.clearTimeout
}={}){
  if(!transport||typeof transport.send!=="function"||typeof transport.subscribeRevision!=="function") {
    throw new TypeError("PCMS UI client requires a transport");
  }
  const unsubscribers=new Set();
  const receiptListeners=new Set();
  let closed=false;

  function emitReceipt(response,message){
    const raw=response?.receipt;
    if(!raw||typeof raw!=="object") return;
    const receipt=Object.freeze({
      receiptId:typeof raw.receiptId==="string"?raw.receiptId:null,
      subject:typeof raw.subject==="string"?raw.subject:message.name,
      status:typeof raw.status==="string"?raw.status:"UNKNOWN",
      replayed:raw.replayed===true,
      requestId:typeof response.requestId==="string"?response.requestId:message.requestId,
      ok:response.ok===true
    });
    for(const listener of receiptListeners){try{listener(receipt);}catch{}}
  }

  async function exchange(message){
    let lastError=null;
    // A transport failure (for example the event page unloading mid-call) is retried
    // once with the same idempotency key; the durable receipt prevents a double effect.
    for(let attempt=0;attempt<2;attempt+=1){
      let response;
      try{response=await withTimeout(Promise.resolve(transport.send(message)),timeoutMs,setTimeoutRef,clearTimeoutRef);}
      catch(error){lastError=error;continue;}
      if(!response||typeof response!=="object") throw remoteError({code:"PCMS_UI_PROTOCOL",message:"PCMS Core returned no response"});
      emitReceipt(response,message);
      if(!response.ok) throw remoteError(response.error);
      return response;
    }
    throw lastError||remoteError(null);
  }

  function request(name,args=[]){
    if(closed) return Promise.reject(remoteError({code:"PCMS_UI_CLOSED",message:"PCMS UI client is closed"}));
    const operation=Object.hasOwn(PCMS_UI_OPERATIONS,name)?PCMS_UI_OPERATIONS[name]:null;
    if(!operation) return Promise.reject(remoteError({code:"PCMS_UI_UNKNOWN_OPERATION",message:"Unknown PCMS operation"}));
    const message={
      type:PCMS_UI_REQUEST_TYPE,
      version:PCMS_UI_PROTOCOL_VERSION,
      requestId:"ui-"+(++sequence)+"-"+randomKey().slice(0,8),
      kind:operation.kind,
      name,
      params:{args:cleanArgs(args)}
    };
    if(operation.kind==="command") message.idempotencyKey=newIdempotencyKey();
    return exchange(message).then((response)=>response.result);
  }

  function buildFacade(){
    const facade={};
    for(const name of Object.keys(PCMS_UI_OPERATIONS)){
      const [service,method]=name.split(".");
      if(service==="core"||service==="broker"||service==="statistics") continue;
      facade[service]??={};
      facade[service][method]=(...args)=>request(name,args);
    }
    // Statistics is projected in the background; rebuild state never crosses the boundary.
    facade.statistics={
      async rebuild(){return null;},
      view(){return request("statistics.snapshot");}
    };
    // Read-only Persona Broker reads (persona.list, system.status) proxied through Core.
    facade.personaBroker={
      async request(envelope){return request("broker.request",[envelope]);}
    };
    for(const key of Object.keys(facade)) Object.freeze(facade[key]);
    return Object.freeze(facade);
  }

  return Object.freeze({
    request,
    status(){return request("core.status");},
    runtime:buildFacade(),
    subscribe(onRevision){
      const unsubscribe=transport.subscribeRevision(onRevision);
      unsubscribers.add(unsubscribe);
      return ()=>{unsubscribers.delete(unsubscribe);unsubscribe();};
    },
    subscribeReceipt(onReceipt){
      if(typeof onReceipt!=="function") throw new TypeError("PCMS receipt listener is invalid");
      receiptListeners.add(onReceipt);
      return ()=>receiptListeners.delete(onReceipt);
    },
    close(){
      if(closed) return;
      closed=true;
      for(const unsubscribe of unsubscribers) {try{unsubscribe();}catch{}}
      unsubscribers.clear();
      receiptListeners.clear();
    }
  });
}
