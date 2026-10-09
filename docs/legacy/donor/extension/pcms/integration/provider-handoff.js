// ADR-002 §9: assisted provider steps are a durable handoff, not an in-memory dialog.
//
// Dispatch opens the target in its bound Persona (done by the live driver), records
// the handoff and opens a `provider.confirm-apply` HumanTask. The operator chooses
// nothing at dispatch time, so the driver reports an unknown outcome and
// ProviderGate records the operation UNCERTAIN. The operator's answer, given from
// any dashboard tab at any later time, is submitted through the existing reconcile
// path. UNKNOWN keeps the target UNCERTAIN and opens a fresh task. Nothing is replayed.

import { HUMAN_TASK_PRIORITIES, HUMAN_TASK_STATES } from "../services/human-tasks.js";

export const PROVIDER_HANDOFF_NAMESPACE="integration.live-provider-handoff";
export const PROVIDER_HANDOFF_TASK_KIND="provider.confirm-apply";
export const PROVIDER_HANDOFF_OUTCOMES=Object.freeze(["APPLIED","NOT_APPLIED","UNKNOWN"]);

const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_SOURCE_LENGTH=4*1024*1024;
const RESOLUTION_BY_OUTCOME=Object.freeze({APPLIED:"applied",NOT_APPLIED:"not_applied",UNKNOWN:"unknown"});
const OUTCOME_BY_RESOLUTION=Object.freeze({applied:"APPLIED",not_applied:"NOT_APPLIED"});

function id(value,label){
  if(typeof value!=="string"||!ID_PATTERN.test(value)) throw new TypeError(label+" is invalid");
  return value;
}
function text(value,max){
  const safe=value===null||value===undefined?"":String(value);
  return safe.length<=max?safe:safe.slice(0,max-1)+"…";
}
function subject(value){
  if(!value||typeof value!=="object"||Array.isArray(value)) return null;
  if(typeof value.kind!=="string"||typeof value.id!=="string") return null;
  return Object.freeze({kind:text(value.kind,64),id:text(value.id,256)});
}
function taskIdFor(operationId,seq){
  const prefix="provider-confirm:"+seq+":";
  const tail=operationId.length+prefix.length<=256?operationId:operationId.slice(-(256-prefix.length));
  return prefix+tail;
}

function normalizeRecord(row,operationId){
  const value=row?.value;
  if(!value||typeof value!=="object"||value.schemaVersion!==1||value.kind!=="provider-handoff"
    ||value.operationId!==operationId||!Number.isSafeInteger(value.seq)||value.seq<1
    ||typeof value.taskId!=="string"||typeof value.title!=="string"||typeof value.instructions!=="string"
    ||(value.source!==null&&typeof value.source!=="string")
    ||(value.sourceHash!==null&&typeof value.sourceHash!=="string")
    ||(value.payload!==undefined&&value.payload!==null&&!releasePayloadShape(value.payload))) {
    throw new Error("Provider handoff record is corrupt");
  }
  return Object.freeze({revision:row.revision,value});
}

// P036 generator.update v2 handoff payload: code and HTML separately, optional JPEG thumbnail
// (base64) and the listing wording. Older records carry no payload and read as null.
const LISTING_WORDS=Object.freeze(["Publicly listed","Unlisted"]);
function releasePayloadShape(value){
  return Boolean(value)&&typeof value==="object"&&!Array.isArray(value)
    &&typeof value.code==="string"&&typeof value.html==="string"
    &&(value.thumbnail===null||typeof value.thumbnail==="string")
    &&LISTING_WORDS.includes(value.listing)
    &&typeof value.payloadHash==="string"&&value.payloadHash.length<=128
    &&(value.label===null||(typeof value.label==="string"&&value.label.length<=160));
}
function releasePayload(value){
  if(value===null||value===undefined) return null;
  if(!releasePayloadShape(value)||value.code.length+value.html.length>MAX_SOURCE_LENGTH||(value.thumbnail?.length||0)>1500000) {
    throw new TypeError("Provider handoff payload is invalid");
  }
  return Object.freeze({code:value.code,html:value.html,thumbnail:value.thumbnail,listing:value.listing,payloadHash:value.payloadHash,label:value.label});
}

export function createProviderHandoff({storageBroker,humanTasks,clock=()=>new Date().toISOString()}={}){
  if(!storageBroker||typeof storageBroker.namespace!=="function") throw new TypeError("Provider handoff requires PCMS storage");
  if(!humanTasks||typeof humanTasks.open!=="function"||typeof humanTasks.get!=="function"||typeof humanTasks.resolve!=="function") {
    throw new TypeError("Provider handoff requires HumanTasks");
  }
  if(typeof clock!=="function") throw new TypeError("Provider handoff clock is invalid");
  const store=storageBroker.namespace(PROVIDER_HANDOFF_NAMESPACE);

  async function read(operationId){
    const row=await store.get(operationId);
    return row?normalizeRecord(row,operationId):null;
  }

  async function ensureTask(record){
    const existing=await humanTasks.get(record.taskId);
    if(existing) return existing;
    const subjectLine=record.subjectRef?record.subjectRef.kind+" "+record.subjectRef.id+". ":"";
    const hashLine=record.sourceHash?" Intended SHA-256: "+record.sourceHash+".":"";
    try{
      return await humanTasks.open({
        taskId:record.taskId,
        taskKind:PROVIDER_HANDOFF_TASK_KIND,
        title:text(record.title,160),
        instructions:text(subjectLine+record.instructions+hashLine,2000),
        priority:HUMAN_TASK_PRIORITIES.HIGH,
        subjectRef:record.subjectRef
      });
    }catch(error){
      // A concurrent opener won; the durable task is what matters.
      const raced=await humanTasks.get(record.taskId);
      if(raced) return raced;
      throw error;
    }
  }

  async function writeNext(current,operationId,{title,instructions,source,sourceHash,subjectRef,payload=null}){
    const seq=(current?.value.seq||0)+1;
    const value=Object.freeze({
      schemaVersion:1,
      kind:"provider-handoff",
      operationId,
      seq,
      taskId:taskIdFor(operationId,seq),
      title:text(title||"Confirm provider action",160),
      instructions:text(instructions,1500),
      source:source===null||source===undefined?(current?.value.source??null):text(source,MAX_SOURCE_LENGTH),
      sourceHash:sourceHash===null||sourceHash===undefined?(current?.value.sourceHash??null):text(sourceHash,128),
      subjectRef:subject(subjectRef)??current?.value.subjectRef??null,
      payload:releasePayload(payload)??current?.value.payload??null,
      openedAt:new Date(clock()).toISOString()
    });
    const row=await store.compareAndSwap(operationId,{expectedRevision:current?.revision||0,value});
    return normalizeRecord(row,operationId);
  }

  // Operator interface used by the live provider driver (same shape as the P026 bridge).
  async function choose({operationId,phase,title,instructions,source=null,sourceHash=null,subjectRef=null,payload=null,choices=[]}={}){
    const opId=id(operationId,"operationId");
    if(phase!=="dispatch"&&phase!=="reconcile") throw new TypeError("Provider handoff phase is invalid");
    if(!Array.isArray(choices)||choices.length<1) throw new TypeError("Operator choices are required");
    const current=await read(opId);

    if(phase==="dispatch"){
      const record=await writeNext(current,opId,{title,instructions,source,sourceHash,subjectRef,payload});
      await ensureTask(record.value);
      // Handoff recorded; the outcome is unknown until the operator answers.
      return null;
    }

    if(!current){
      const record=await writeNext(null,opId,{title,instructions,source,sourceHash,subjectRef});
      await ensureTask(record.value);
      return "UNKNOWN";
    }
    const task=await humanTasks.get(current.value.taskId);
    if(!task){
      await ensureTask(current.value);
      return "UNKNOWN";
    }
    if(task.value.state===HUMAN_TASK_STATES.OPEN) return "UNKNOWN";
    const outcome=task.value.state===HUMAN_TASK_STATES.RESOLVED
      ? OUTCOME_BY_RESOLUTION[task.value.resolutionCode]
      : undefined;
    if(outcome&&choices.includes(outcome)) return outcome;
    // Answered UNKNOWN (or cancelled): keep the target UNCERTAIN and ask again.
    const record=await writeNext(current,opId,{title,instructions,source:null,sourceHash:null,subjectRef});
    await ensureTask(record.value);
    return "UNKNOWN";
  }

  async function findByTask(rawTaskId){
    const taskId=id(rawTaskId,"taskId");
    for(const row of await store.list()){
      if(row?.value?.taskId===taskId) return normalizeRecord(row,row.key);
    }
    return null;
  }

  async function describe(taskId){
    const record=await findByTask(taskId);
    if(!record) return null;
    const task=await humanTasks.get(record.value.taskId);
    return Object.freeze({
      taskId:record.value.taskId,
      operationId:record.value.operationId,
      title:record.value.title,
      instructions:record.value.instructions,
      source:record.value.source,
      sourceHash:record.value.sourceHash,
      subjectRef:record.value.subjectRef,
      payload:record.value.payload??null,
      state:task?.value.state||null,
      outcomes:PROVIDER_HANDOFF_OUTCOMES
    });
  }

  // Records the operator's answer durably. The caller then runs reconciliation.
  async function answer(taskId,outcome){
    if(!PROVIDER_HANDOFF_OUTCOMES.includes(outcome)) throw new TypeError("Provider handoff outcome is invalid");
    const record=await findByTask(taskId);
    if(!record) throw new Error("Provider handoff not found");
    const task=await humanTasks.get(record.value.taskId);
    if(!task) throw new Error("Provider handoff task not found");
    if(task.value.state===HUMAN_TASK_STATES.OPEN){
      await humanTasks.resolve(task.value.taskId,{expectedRevision:task.revision,resolutionCode:RESOLUTION_BY_OUTCOME[outcome]});
    }else if(task.value.resolutionCode!==RESOLUTION_BY_OUTCOME[outcome]){
      throw new Error("Provider handoff was already answered differently");
    }
    return Object.freeze({taskId:record.value.taskId,operationId:record.value.operationId,outcome});
  }

  return Object.freeze({choose,describe,answer});
}
