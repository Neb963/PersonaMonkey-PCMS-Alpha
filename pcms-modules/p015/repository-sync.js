// P038 — background repository checks. The timer service is the sole wake authority;
// a committed scan checkpoint, never a timer callback's memory, determines the next step.
import {REPO_ERRORS} from "../../extension/pcms/providers/repository/contract.js";

export const REPOSITORY_SYNC_SERVICE="core.deployer-repository-sync";
export const REPOSITORY_SYNC_OWNER="core";
export const REPOSITORY_SYNC_GENERATION=0;
export const REPOSITORY_SYNC_TIMERS=Object.freeze(["deployer.repository.sync.a","deployer.repository.sync.b"]);
export const REPOSITORY_SYNC_DEFAULT_MINUTES=60;
const CONTINUATION_MS=1000;
const MAX_CADENCE_MINUTES=1440;
const MIN_CADENCE_MINUTES=5;
const ONE_DAY_MS=24*60*60*1000;

function nowMs(clock){
  const n=Date.parse(clock());
  if(!Number.isFinite(n))throw new TypeError("Repository sync clock is invalid");
  return n;
}
function iso(n){return new Date(n).toISOString();}
function validState(value){
  if(!value||value.schemaVersion!==1||!Number.isSafeInteger(value.cadenceMinutes)
    ||value.cadenceMinutes<MIN_CADENCE_MINUTES||value.cadenceMinutes>MAX_CADENCE_MINUTES
    ||!Number.isSafeInteger(value.failureCount)||value.failureCount<0||value.failureCount>32
    ||![0,1].includes(value.slot)||typeof value.nextDueAt!=="string"
    ||!Number.isFinite(Date.parse(value.nextDueAt))
    ||(value.lastCheckedAt!==null&&(typeof value.lastCheckedAt!=="string"||!Number.isFinite(Date.parse(value.lastCheckedAt)))))
    throw new TypeError("Repository sync state is invalid");
  return value;
}
export function repositorySyncBackoff({failureCount,error,resetAt=null,now}={}){
  if(!Number.isSafeInteger(failureCount)||failureCount<1||failureCount>32||!Number.isFinite(now))
    throw new TypeError("Repository sync retry arguments are invalid");
  // 60s, 120s, 240s ... up to 60min. No automatic provider mutation follows.
  const base=Math.min(60*60*1000,60_000*2**Math.min(6,failureCount-1));
  const reset=error===REPO_ERRORS.RATE_LIMITED&&typeof resetAt==="string"?Date.parse(resetAt):NaN;
  return iso(Math.max(now+base,Number.isFinite(reset)&&reset>now?reset:0));
}
export function createDeployerRepositorySync({
  repository,timers,stateStore,clock=()=>new Date().toISOString(),cadenceMinutes=REPOSITORY_SYNC_DEFAULT_MINUTES,
  afterCheck=async()=>null
}={}){
  if(typeof repository?.read!=="function"||typeof repository?.startScan!=="function"
    ||typeof repository?.scanStep!=="function"||typeof stateStore?.read!=="function"
    ||typeof stateStore?.compareAndSwap!=="function"||typeof timers?.ensure!=="function"
    ||typeof timers?.get!=="function"||typeof timers?.cancel!=="function"
    ||typeof clock!=="function"||!Number.isSafeInteger(cadenceMinutes)
    ||cadenceMinutes<MIN_CADENCE_MINUTES||cadenceMinutes>MAX_CADENCE_MINUTES)
    throw new TypeError("Repository sync dependencies are invalid");

  const empty=()=>({schemaVersion:1,cadenceMinutes,failureCount:0,slot:0,
    nextDueAt:iso(nowMs(clock)),lastCheckedAt:null});
  async function readState(){
    const row=await stateStore.read();
    return row===null?{revision:0,value:null}:{revision:row.revision,value:validState(row.value)};
  }
  async function save(current,value){
    const saved=await stateStore.compareAndSwap({expectedRevision:current.revision,value});
    if(saved?.ok!==true)throw new Error("Repository sync revision conflict");
    return {revision:saved.revision,value:validState(saved.value)};
  }
  async function retire(timerId){
    const row=await timers.get(timerId);
    if(row?.value?.state==="SCHEDULED")await timers.cancel(timerId,{expectedRevision:row.revision});
  }
  async function schedule(state,now){
    const timerId=REPOSITORY_SYNC_TIMERS[state.slot];
    const opposite=REPOSITORY_SYNC_TIMERS[1-state.slot];
    await retire(opposite);
    let due=Date.parse(state.nextDueAt);
    // The generic timer deliberately drops >24h stale work. Repository sync
    // instead collapses arbitrarily many missed cadences into one new check.
    if(now-due>=ONE_DAY_MS-60_000){
      const current=await timers.get(timerId);
      if(current?.value?.state==="SCHEDULED")await timers.cancel(timerId,{expectedRevision:current.revision});
      due=now;
    }
    await timers.ensure({name:timerId,serviceName:REPOSITORY_SYNC_SERVICE,
      ownerId:REPOSITORY_SYNC_OWNER,generation:REPOSITORY_SYNC_GENERATION,dueAt:iso(due)});
    return {timerId,dueAt:iso(due)};
  }
  async function declare(){
    const repo=(await repository.read()).value;
    if(!repo.config){
      await Promise.all(REPOSITORY_SYNC_TIMERS.map(retire));
      return Object.freeze({enabled:false});
    }
    let current=await readState();
    if(!current.value)current=await save(current,empty());
    let state=current.value;
    // A configuration/ref change clears lastCheckedAt in P037. Check that
    // new identity once rather than waiting for the previous repository's due time.
    if(repo.lastCheckedAt===null&&state.lastCheckedAt!==null){
      state={...state,nextDueAt:iso(nowMs(clock)),failureCount:0,lastCheckedAt:null};
      current=await save(current,state);
    }
    // A callback can fail after P029 claimed its timer but before the P038
    // state CAS. Generic delivery-failed/overdue MISSED timers are not replayed
    // by ensure(v1), so explicitly mint one new occurrence here.
    const previous=await timers.get(REPOSITORY_SYNC_TIMERS[state.slot]);
    if(previous?.value?.state==="MISSED"&&previous.value.missedReason!=="interrupted"){
      state={...state,slot:1-state.slot,nextDueAt:iso(nowMs(clock)+CONTINUATION_MS)};
      current=await save(current,state);
    }
    return Object.freeze({enabled:true,...await schedule(state,nowMs(clock))});
  }
  async function onTimer({timerId}={}){
    const before=await readState();
    if(!before.value||timerId!==REPOSITORY_SYNC_TIMERS[before.value.slot])return {ignored:true};
    const repoBefore=(await repository.read()).value;
    if(!repoBefore.config)return {disabled:true};
    const now=nowMs(clock);
    let result;
    // The final P037 scan checkpoint may commit before this sync state CAS.
    // A resumed timer observes that completion and cannot prepare releases twice.
    const finishedSinceLastSync=repoBefore.scan===null&&repoBefore.lastCheckedAt!==null
      &&(before.value.lastCheckedAt===null
        ||Date.parse(repoBefore.lastCheckedAt)>Date.parse(before.value.lastCheckedAt));
    if(finishedSinceLastSync){
      result={done:true,status:repoBefore.lastFailure?"FAILED":"UNCHANGED",
        error:repoBefore.lastFailure?.code};
    }else{
      try{
        if(!repoBefore.scan)await repository.startScan();
        result=await repository.scanStep({batchSize:8});
      }catch(error){
        result={done:true,status:"FAILED",error:typeof error?.code==="string"?error.code:REPO_ERRORS.UNAVAILABLE};
      }
    }
    const repoAfter=(await repository.read()).value;
    let failureCount=before.value.failureCount;
    let nextDueAt;
    if(!result.done){
      nextDueAt=iso(now+CONTINUATION_MS);
    }else if(result.status==="FAILED"){
      failureCount=Math.min(32,failureCount+1);
      nextDueAt=repositorySyncBackoff({failureCount,error:result.error??repoAfter.lastFailure?.code,
        resetAt:repoAfter.lastFailure?.resetAt??null,now});
    }else{
      failureCount=0;
      nextDueAt=iso(now+before.value.cadenceMinutes*60_000);
    }
    // This CAS is the durable completion/continuation fence. If the event page
    // dies after scanStep but before CAS, declare() resumes its stored checkpoint.
    // If it dies after CAS but before ensure(), declare() creates the new timer.
    const next={...before.value,slot:1-before.value.slot,failureCount,nextDueAt,
      lastCheckedAt:repoAfter.lastCheckedAt??before.value.lastCheckedAt};
    await save(before,next);
    await schedule(next,nowMs(clock));
    // Observation work must not strand the independently durable repository timer.
    if(result.done&&result.status!=="FAILED")await afterCheck(repoAfter.lastCheckedAt);
    return Object.freeze({status:result.status,done:result.done,nextDueAt});
  }
  return Object.freeze({declare,onTimer,readState});
}
