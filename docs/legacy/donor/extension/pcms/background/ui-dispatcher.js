// Background side of pcms.ui-client/v1 (ADR-002 §8): sender + schema validation,
// bounded query projections and idempotent, durably receipted commands.
import {
  PCMS_UI_ERROR_CODES,
  PCMS_UI_PROTOCOL_VERSION,
  PCMS_UI_MAX_RECEIPT_LIST,
  getPcmsUiOperation,
  PCMS_UI_RESPONSE_TYPE,
  PcmsUiProtocolError,
  isPcmsUiSender,
  serializePcmsUiError,
  validatePcmsUiRequest
} from "../integration/ui-client-contract.js";
import { redactPcmsUiSecrets } from "../integration/ui-contribution-contract.js";

export const PCMS_UI_RECEIPT_NAMESPACE="core.ui-receipts";
export const PCMS_UI_RECEIPT_RETENTION_MS=7*24*60*60*1000;
const MAX_RETAINED_RESULT_BYTES=256*1024;

function response(requestId,body){
  return Object.freeze({type:PCMS_UI_RESPONSE_TYPE,version:PCMS_UI_PROTOCOL_VERSION,requestId,...body});
}
function failure(requestId,error){
  return response(requestId,{ok:false,error:serializePcmsUiError(error)});
}
function protocolError(code,message){return new PcmsUiProtocolError(code,message);}

async function sha256Hex(text){
  const bytes=new TextEncoder().encode(text);
  const digest=await globalThis.crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

function jsonSize(value){
  try{return JSON.stringify(value===undefined?null:value).length;}
  catch{return Infinity;}
}

async function invoke(core,name,args){
  if(name==="broker.request") return core.personaBroker.request(args[0]);
  if(name==="statistics.snapshot") return core.statistics.view(await core.statistics.rebuild());
  const [service,method]=name.split(".");
  const target=core[service];
  if(!target||typeof target[method]!=="function") throw protocolError(PCMS_UI_ERROR_CODES.UNKNOWN_OPERATION,"PCMS UI operation is not available");
  return target[method](...args);
}

export function createPcmsUiDispatcher({
  ensureCore,
  readStatus,
  onCommitted=async()=>{},
  runtimeId,
  extensionBaseUrl,
  clock=()=>new Date().toISOString()
}={}){
  if(typeof ensureCore!=="function") throw new TypeError("PCMS UI dispatcher requires ensureCore");
  if(typeof readStatus!=="function") throw new TypeError("PCMS UI dispatcher requires readStatus");
  if(typeof onCommitted!=="function") throw new TypeError("PCMS UI dispatcher onCommitted is invalid");
  const inflight=new Map();

  function receipts(core){return core.storageBroker.namespace(PCMS_UI_RECEIPT_NAMESPACE);}
  
  // UI clients cannot access hashes, command payloads, error bodies or stored results.
  async function listReceiptSummaries(core){
    const now=Date.parse(clock());
    const summaries=[];
    for(const row of await receipts(core).list()){
      const value=row?.value;
      if(value?.schemaVersion!==1||value.kind!=="ui-command-receipt"
          ||typeof value.receiptId!=="string"||value.receiptId!==row.key
          ||typeof value.subject!=="string"||getPcmsUiOperation(value.subject)?.kind!=="command"
          ||!["PENDING","FAILED","COMPLETED"].includes(value.status)
          ||typeof value.recordedAt!=="string") continue;
      const recorded=Date.parse(value.recordedAt);
      const completedAt=typeof value.completedAt==="string"&&Number.isFinite(Date.parse(value.completedAt))
        ?value.completedAt:null;
      const lastRecorded=completedAt?Date.parse(completedAt):recorded;
      // Match the existing Core prune rule: a long-running command completed
      // recently must remain visible even if it was originally started days ago.
      if(!Number.isFinite(recorded)||!Number.isFinite(now)
          ||recorded>now+5*60*1000||lastRecorded>now+5*60*1000
          ||now-lastRecorded>PCMS_UI_RECEIPT_RETENTION_MS) continue;
      // A P028 PENDING receipt with no matching in-flight command survived a
      // previous Core context: the outcome is unknown, NOT still running.
      const status=value.status==="PENDING"&&!inflight.has(value.receiptId)?"UNKNOWN":value.status;
      summaries.push(Object.freeze({
        receiptId:value.receiptId,subject:value.subject,status,
        recordedAt:value.recordedAt,completedAt
      }));
    }
    const rank={UNKNOWN:0,FAILED:1,PENDING:2,COMPLETED:3};
    summaries.sort((a,b)=>rank[a.status]-rank[b.status]
      ||Date.parse(b.completedAt||b.recordedAt)-Date.parse(a.completedAt||a.recordedAt)
      ||a.receiptId.localeCompare(b.receiptId));
    return Object.freeze({receipts:Object.freeze(summaries.slice(0,PCMS_UI_MAX_RECEIPT_LIST))});
  }

  function replay(requestId,row,requestHash){
    const value=row.value;
    if(value?.requestHash!==requestHash) {
      return failure(requestId,protocolError(PCMS_UI_ERROR_CODES.IDEMPOTENCY_CONFLICT,"This idempotency key was used for a different command"));
    }
    const receipt=Object.freeze({receiptId:value.receiptId,subject:value.subject,status:value.status,replayed:true});
    if(value.status==="COMPLETED"){
      if(!value.resultRetained) {
        return response(requestId,{ok:false,receipt,error:serializePcmsUiError(protocolError(PCMS_UI_ERROR_CODES.RESULT_NOT_RETAINED,"Command already completed; refresh to see its effect"))});
      }
      return response(requestId,{ok:true,receipt,result:value.result});
    }
    if(value.status==="FAILED") return response(requestId,{ok:false,receipt,error:value.error});
    // PENDING: the context that ran it was unloaded mid-command. Never replay it.
    return response(requestId,{ok:false,receipt,error:serializePcmsUiError(protocolError(PCMS_UI_ERROR_CODES.OUTCOME_UNKNOWN,"The command was interrupted; refresh before trying again"))});
  }

  async function runCommand(core,request){
    const store=receipts(core);
    const key=request.idempotencyKey;
    // P040: secret fields are redacted first; the durable receipt never derives from a secret.
    const requestHash=await sha256Hex(JSON.stringify({name:request.name,args:redactPcmsUiSecrets(request.args)}));
    const existing=await store.get(key);
    if(existing) return replay(request.requestId,existing,requestHash);
    const recordedAt=new Date(clock()).toISOString();
    const pending={
      schemaVersion:1,
      kind:"ui-command-receipt",
      receiptId:key,
      subject:request.name,
      requestHash,
      status:"PENDING",
      recordedAt,
      completedAt:null,
      resultRetained:false,
      result:null,
      error:null
    };
    let row;
    try{row=await store.compareAndSwap(key,{expectedRevision:0,value:pending});}
    catch(error){
      const raced=await store.get(key);
      if(raced) return replay(request.requestId,raced,requestHash);
      throw error;
    }

    let result,error=null;
    try{result=await invoke(core,request.name,request.args);}
    catch(caught){error=caught;}
    const retain=!error&&request.operation.retainResult&&jsonSize(result)<=MAX_RETAINED_RESULT_BYTES;
    const settled={
      ...pending,
      status:error?"FAILED":"COMPLETED",
      completedAt:new Date(clock()).toISOString(),
      resultRetained:retain,
      result:retain?(result===undefined?null:JSON.parse(JSON.stringify(result))):null,
      error:error?serializePcmsUiError(error):null
    };
    try{await store.compareAndSwap(key,{expectedRevision:row.revision,value:settled});}catch{}
    try{await onCommitted(request.operation.topics);}catch{}
    const receipt=Object.freeze({receiptId:key,subject:request.name,status:settled.status});
    return error
      ? response(request.requestId,{ok:false,receipt,error:settled.error})
      : response(request.requestId,{ok:true,receipt,result});
  }

  async function handle(message,sender){
    const requestId=typeof message?.requestId==="string"?message.requestId.slice(0,128):null;
    if(!isPcmsUiSender(sender,{runtimeId,extensionBaseUrl})) {
      return failure(requestId,protocolError(PCMS_UI_ERROR_CODES.SENDER_REJECTED,"PCMS UI request sender rejected"));
    }
    let request;
    try{request=validatePcmsUiRequest(message);}
    catch(error){return failure(requestId,error);}

    if(request.name==="core.status"){
      try{await ensureCore();}catch{}
      return response(request.requestId,{ok:true,result:await readStatus()});
    }

    let core;
    try{core=await ensureCore();}
    catch{return failure(request.requestId,protocolError(PCMS_UI_ERROR_CODES.CORE_UNAVAILABLE,"PCMS Core is unavailable"));}

    if(request.kind==="query"){
      try{
        const result=request.name==="uiReceipts.list"
          ?await listReceiptSummaries(core)
          :await invoke(core,request.name,request.args);
        return response(request.requestId,{ok:true,result});
      } catch(error){return failure(request.requestId,error);}
    }

    // Concurrent duplicates of one idempotency key share one execution.
    const key=request.idempotencyKey;
    if(inflight.has(key)) {
      const shared=await inflight.get(key);
      return {...shared,requestId:request.requestId};
    }
    const run=runCommand(core,request).catch((error)=>failure(request.requestId,error));
    inflight.set(key,run);
    try{return await run;}
    finally{inflight.delete(key);}
  }

  async function pruneReceipts(core,{now=Date.now(),limit=500}={}){
    const store=receipts(core);
    let removed=0;
    for(const row of await store.list()){
      if(removed>=limit) break;
      const completedAt=Date.parse(row?.value?.completedAt||row?.value?.recordedAt||"");
      if(Number.isFinite(completedAt)&&now-completedAt>PCMS_UI_RECEIPT_RETENTION_MS){
        try{await store.deleteCompareAndSwap(row.key,{expectedRevision:row.revision});removed+=1;}catch{}
      }
    }
    return removed;
  }

  return Object.freeze({handle,pruneReceipts});
}
