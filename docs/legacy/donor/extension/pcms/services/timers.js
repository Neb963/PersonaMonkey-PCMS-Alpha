import { AUDIT_ERROR_CODES } from "../audit/errors.js";
import { CORE_SERVICE_ERROR_CODES, coreServiceError } from "./errors.js";

export const TIMER_NAMESPACE = "core.timers";
export const TIMER_SCHEMA_VERSION = 1;
export const PCMS_TIMERS_ENSURE_CONTRACT = "pcms.timers.ensure/v1";
export const TIMER_STATES = Object.freeze({ SCHEDULED:"SCHEDULED", DISPATCHING:"DISPATCHING", FIRED:"FIRED", CANCELLED:"CANCELLED", MISSED:"MISSED" });

const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SERVICE_PATTERN=/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const STATE_SET=new Set(Object.values(TIMER_STATES));
function fail(code,options={}){throw coreServiceError(code,options);}
function assertId(value){if(typeof value!=="string"||!ID_PATTERN.test(value))fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);return value;}
function assertService(value){if(typeof value!=="string"||value.length>128||!SERVICE_PATTERN.test(value))fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);return value;}
function assertGeneration(value){if(!Number.isSafeInteger(value)||value<0)fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);return value;}
function assertRevision(value){if(!Number.isSafeInteger(value)||value<0)fail(CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT);return value;}
function iso(value){const n=Date.parse(value);if(!Number.isFinite(n))fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);return new Date(n).toISOString();}
function normalizeValue(value,timerId){
  if(!value||typeof value!=="object"||Array.isArray(value))fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  const required=["schemaVersion","kind","timerId","serviceName","ownerId","generation","dueAt","state","createdAt","completedAt"];
  const allowed=new Set([...required,"missedReason"]);
  const keys=Object.keys(value);
  if(!required.every(k=>Object.hasOwn(value,k))||keys.some(k=>!allowed.has(k))||value.schemaVersion!==1||value.kind!=="timer"||value.timerId!==timerId||!STATE_SET.has(value.state))fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  const missedReason=value.missedReason??null;
  try{assertId(value.timerId);assertService(value.serviceName);assertId(value.ownerId);assertGeneration(value.generation);iso(value.dueAt);iso(value.createdAt);if(value.completedAt!==null)iso(value.completedAt);}catch{fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);}
  if(missedReason!==null&&(typeof missedReason!=="string"||missedReason.length<1||missedReason.length>96))fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  if(value.state!==TIMER_STATES.MISSED&&missedReason!==null)fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  if((value.state===TIMER_STATES.FIRED||value.state===TIMER_STATES.CANCELLED||value.state===TIMER_STATES.MISSED)!==(value.completedAt!==null))fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);
  if(value.state===TIMER_STATES.SCHEDULED||value.state===TIMER_STATES.DISPATCHING){if(value.completedAt!==null)fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);}
  return Object.freeze({...value,missedReason});
}
function publicRecord(record,timerId){if(!record)return null;if(!Number.isSafeInteger(record.revision)||record.revision<1)fail(CORE_SERVICE_ERROR_CODES.CORRUPT_STATE);return Object.freeze({key:record.key,revision:record.revision,updatedAt:record.updatedAt,value:normalizeValue(record.value,timerId)});}

export function createTimerService({
  storageBroker,
  auditJournal,
  serviceRegistry,
  clock = () => new Date().toISOString(),
  maxDuePerRun = 32,
  maxOverdueMs = 24*60*60*1000,
  onChanged = async()=>{}
} = {}) {
  if(!storageBroker||typeof storageBroker.namespace!=="function")throw new TypeError("Timer service requires the PCMS storage broker");
  if(!auditJournal||typeof auditJournal.transitionAndAppend!=="function")throw new TypeError("Timer service requires the PCMS audit journal");
  if(!serviceRegistry||typeof serviceRegistry.describe!=="function"||typeof serviceRegistry.call!=="function")throw new TypeError("Timer service requires the core service registry");
  if(typeof clock!=="function")throw new TypeError("Timer service clock is invalid");
  if(typeof onChanged!=="function")throw new TypeError("Timer service change hook is invalid");
  if(!Number.isSafeInteger(maxDuePerRun)||maxDuePerRun<1||maxDuePerRun>256)throw new RangeError("Timer due-work capacity is invalid");
  if(!Number.isSafeInteger(maxOverdueMs)||maxOverdueMs<0||maxOverdueMs>30*24*60*60*1000)throw new RangeError("Timer overdue bound is invalid");
  const store=storageBroker.namespace(TIMER_NAMESPACE);
  async function get(timerId){const id=assertId(timerId);return publicRecord(await store.get(id),id);}
  async function write(id,expectedRevision,value,eventType,data){
    try{
      const result=await auditJournal.transitionAndAppend({namespace:TIMER_NAMESPACE,key:id,expectedRevision,value},{type:eventType,subject:{kind:"timer",id},data});
      const state=publicRecord(result.state,id);
      try{await onChanged(Object.freeze({timerId:id,eventType,state}));}catch{}
      return state;
    }catch(error){if(error?.code===AUDIT_ERROR_CODES.CONFLICT)fail(CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:error.currentRevision});throw error;}
  }
  async function schedule({timerId,serviceName,dueAt,ownerId,generation}={}){
    const id=assertId(timerId),name=assertService(serviceName),owner=assertId(ownerId),gen=assertGeneration(generation),due=iso(dueAt);
    const registration=serviceRegistry.describe(name);
    if(!registration)fail(CORE_SERVICE_ERROR_CODES.SERVICE_UNAVAILABLE);
    if(registration.ownerId!==owner||registration.generation!==gen)fail(CORE_SERVICE_ERROR_CODES.STALE_SERVICE,{currentGeneration:registration.generation});
    const existing=await get(id);if(existing)fail(CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:existing.revision});
    const createdAt=new Date(clock()).toISOString();
    return write(id,0,{schemaVersion:1,kind:"timer",timerId:id,serviceName:name,ownerId:owner,generation:gen,dueAt:due,state:TIMER_STATES.SCHEDULED,createdAt,completedAt:null,missedReason:null},"timer.scheduled",{serviceName:name,dueAt:due});
  }
  async function cancel(timerId,{expectedRevision}={}){
    const id=assertId(timerId),expected=assertRevision(expectedRevision),current=await get(id);if(!current)fail(CORE_SERVICE_ERROR_CODES.NOT_FOUND);if(current.revision!==expected)fail(CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});if(current.value.state!==TIMER_STATES.SCHEDULED)fail(CORE_SERVICE_ERROR_CODES.INVALID_TRANSITION);
    const completedAt=new Date(clock()).toISOString();return write(id,current.revision,{...current.value,state:TIMER_STATES.CANCELLED,completedAt,missedReason:null},"timer.cancelled",null);
  }
  async function markMissed(current,reason,now){return write(current.value.timerId,current.revision,{...current.value,state:TIMER_STATES.MISSED,completedAt:now,missedReason:reason},"timer.missed",{reason});}
  async function dispatch(current,now){
    const v=current.value;const reg=serviceRegistry.describe(v.serviceName);
    if(!reg)return null;
    if(reg.ownerId!==v.ownerId||reg.generation!==v.generation)return markMissed(current,"stale-service",now);
    let claimed=await write(v.timerId,current.revision,{...v,state:TIMER_STATES.DISPATCHING,missedReason:null},"timer.dispatching",{serviceName:v.serviceName});
    try{
      await serviceRegistry.call(v.serviceName,"onTimer",{timerId:v.timerId,dueAt:v.dueAt},{ownerId:v.ownerId,generation:v.generation});
    }catch{
      return markMissed(claimed,"delivery-failed",now);
    }
    return write(v.timerId,claimed.revision,{...claimed.value,state:TIMER_STATES.FIRED,completedAt:now,missedReason:null},"timer.fired",null);
  }
  async function runDue({ now = clock(), limit = maxDuePerRun } = {}){
    const nowIso=iso(now),nowMs=Date.parse(nowIso);if(!Number.isSafeInteger(limit)||limit<1||limit>maxDuePerRun)fail(CORE_SERVICE_ERROR_CODES.TIMER_CAPACITY);
    const rows=await store.list();const due=[];
    for(const row of rows){const timer=publicRecord(row,row.key);if(timer.value.state===TIMER_STATES.SCHEDULED&&Date.parse(timer.value.dueAt)<=nowMs)due.push(timer);}
    due.sort((a,b)=>a.value.dueAt.localeCompare(b.value.dueAt)||a.value.timerId.localeCompare(b.value.timerId));
    const selected=due.slice(0,limit);const results=[];
    for(const timer of selected){
      if(nowMs-Date.parse(timer.value.dueAt)>maxOverdueMs){results.push(await markMissed(timer,"overdue",nowIso));continue;}
      const delivered=await dispatch(timer,nowIso);if(delivered)results.push(delivered);
    }
    return Object.freeze({ processed:Object.freeze(results), remainingDue:Math.max(0,due.length-results.length) });
  }
  async function recoverInterrupted({ now = clock(), limit = maxDuePerRun } = {}){
    const nowIso=iso(now);if(!Number.isSafeInteger(limit)||limit<1||limit>maxDuePerRun)fail(CORE_SERVICE_ERROR_CODES.TIMER_CAPACITY);
    const rows=await store.list();const interrupted=[];
    for(const row of rows){const timer=publicRecord(row,row.key);if(timer.value.state===TIMER_STATES.DISPATCHING)interrupted.push(timer);}
    interrupted.sort((a,b)=>a.value.timerId.localeCompare(b.value.timerId));
    const selected=interrupted.slice(0,limit);const out=[];
    for(const timer of selected)out.push(await markMissed(timer,"interrupted",nowIso));
    return Object.freeze({ recovered:Object.freeze(out), remainingInterrupted:Math.max(0,interrupted.length-selected.length) });
  }
  function sameTarget(value,{serviceName,ownerId,generation}){return value.serviceName===serviceName&&value.ownerId===ownerId&&value.generation===generation;}
  async function ensure({name,timerId,serviceName,dueAt,ownerId,generation}={}){
    if(name!==undefined&&timerId!==undefined&&name!==timerId)fail(CORE_SERVICE_ERROR_CODES.INVALID_ARGUMENT);
    const id=assertId(name??timerId),service=assertService(serviceName),owner=assertId(ownerId),gen=assertGeneration(generation),due=iso(dueAt);
    const registration=serviceRegistry.describe(service);
    if(!registration)fail(CORE_SERVICE_ERROR_CODES.SERVICE_UNAVAILABLE);
    if(registration.ownerId!==owner||registration.generation!==gen)fail(CORE_SERVICE_ERROR_CODES.STALE_SERVICE,{currentGeneration:registration.generation});
    for(let attempt=0;attempt<4;attempt+=1){
      const current=await get(id);
      if(!current){
        try{
          const createdAt=new Date(clock()).toISOString();
          return await write(id,0,{schemaVersion:1,kind:"timer",timerId:id,serviceName:service,ownerId:owner,generation:gen,dueAt:due,state:TIMER_STATES.SCHEDULED,createdAt,completedAt:null,missedReason:null},"timer.scheduled",{serviceName:service,dueAt:due,declared:true});
        }catch(error){if(error?.code===CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT)continue;throw error;}
      }
      const target={serviceName:service,ownerId:owner,generation:gen};
      if(current.value.state===TIMER_STATES.DISPATCHING){
        if(sameTarget(current.value,target)&&current.value.dueAt===due)return current;
        fail(CORE_SERVICE_ERROR_CODES.INVALID_TRANSITION);
      }
      if(current.value.state===TIMER_STATES.SCHEDULED){
        const nextDue=Date.parse(current.value.dueAt)<=Date.parse(due)?current.value.dueAt:due;
        if(sameTarget(current.value,target)&&nextDue===current.value.dueAt)return current;
        try{
          return await write(id,current.revision,{...current.value,serviceName:service,ownerId:owner,generation:gen,dueAt:nextDue,state:TIMER_STATES.SCHEDULED,completedAt:null,missedReason:null},"timer.ensured",{serviceName:service,dueAt:nextDue});
        }catch(error){if(error?.code===CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT)continue;throw error;}
      }
      const sameOccurrence=current.value.dueAt===due;
      if(sameOccurrence&&!(current.value.state===TIMER_STATES.MISSED&&current.value.missedReason==="interrupted"))return current;
      try{
        const createdAt=new Date(clock()).toISOString();
        return await write(id,current.revision,{schemaVersion:1,kind:"timer",timerId:id,serviceName:service,ownerId:owner,generation:gen,dueAt:due,state:TIMER_STATES.SCHEDULED,createdAt,completedAt:null,missedReason:null},"timer.ensured",{serviceName:service,dueAt:due,catchUp:sameOccurrence});
      }catch(error){if(error?.code===CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT)continue;throw error;}
    }
    const current=await get(id);
    fail(CORE_SERVICE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current?.revision??0});
  }
  async function list(){const rows=await store.list();return Object.freeze(rows.map(row=>publicRecord(row,row.key)).sort((a,b)=>a.value.timerId.localeCompare(b.value.timerId)));}
  return Object.freeze({ schedule, ensure, get, cancel, runDue, recoverInterrupted, list });
}
