import { REFRESHER_ERROR_CODES } from "./errors.js";
import {
  REFRESHER_MAX_MEMBERS, REFRESHER_MODE, REFRESHER_SOURCE_KIND, REFRESH_OPERATION_STATUS, REFRESH_RELEASE_KIND, REFRESH_UNRESOLVED_STATUSES,
  normalizeCohortId, normalizeGeneratorId, operationIdFor, sameRelease
} from "./schema.js";
import { fail, revision, isoNow, replaceCohort, replaceMember, scheduleInfo, nextActiveStart, inDay, usedBudget, eligibleMember, sortEligible, project } from "./refresher-helpers.js";
import { createRefresherStore } from "./refresher-store.js";
import { createRefreshOperations } from "./refresher-operations.js";
import { createDeployerReleaseSource } from "./release-source.js";

const MINUTE_MS=60*1000;
// Background pass bounds (A040-02): a pass never dispatches more than this many refreshes, and the
// next wake is never further away than the horizon so newly confirmed releases are picked up.
export const REFRESHER_PASS_MAX_DISPATCHES=4;
export const REFRESHER_WAKE_MIN_MS=MINUTE_MS;
export const REFRESHER_WAKE_HORIZON_MS=6*60*MINUTE_MS;

// `deployer` (+ optional `repository` and `repositoryProvider`) lets the Refresher follow the
// Deployer's confirmed release (P040). An explicit `releaseSource` takes precedence (tests).
export function createRefresherService({deployer=null,repository=null,repositoryProvider=null,releaseSource=null,...options}={}){
  const source=releaseSource??(deployer?createDeployerReleaseSource({deployer,repository,repositoryProvider}):null);
  const ctx=createRefresherStore({...options,releaseSource:source});
  const {read,commit,requireAccount,gateFor,remoteState,confirmedRelease,readRelease,cancelRemote,createCohort,getCohort,listCohorts,updatePolicy,renameCohort,addMember,removeMember,setMemberSourceHash,clock}=ctx;
  async function planRefreshes(rawCohortId,{at=clock(),limit=256}={}){
    const cohortId=normalizeCohortId(rawCohortId);if(!Number.isSafeInteger(limit)||limit<1||limit>REFRESHER_MAX_MEMBERS)fail(REFRESHER_ERROR_CODES.INVALID_ARGUMENT);const current=await read();const cohort=current.value.cohorts.find(x=>x.cohortId===cohortId);if(!cohort)fail(REFRESHER_ERROR_CODES.NOT_FOUND);const info=scheduleInfo(cohort.policy,at);const used=usedBudget(cohort,info);const remaining=Math.max(0,cohort.policy.dailyBudget-used);
    let eligible=[];if(cohort.enabled&&cohort.policy.mode===REFRESHER_MODE.AUTO_RECENT&&info.active&&remaining>0)eligible=cohort.members.filter(m=>eligibleMember(m,info)).sort(sortEligible).slice(0,Math.min(limit,remaining));
    return Object.freeze({revision:current.revision,cohortId,mode:cohort.policy.mode,enabled:cohort.enabled,active:info.active,dayStart:info.dayStart,dayEnd:info.dayEnd,budget:Object.freeze({limit:cohort.policy.dailyBudget,used,remaining}),members:Object.freeze(eligible.map(m=>project(cohort,m,info)))});
  }
  async function listCohortViews({at=clock()}={}){const current=await read();const views=current.value.cohorts.map(cohort=>{const info=scheduleInfo(cohort.policy,at);const used=usedBudget(cohort,info);return Object.freeze({cohortId:cohort.cohortId,name:cohort.name,accountId:cohort.accountId,enabled:cohort.enabled,mode:cohort.policy.mode,policy:cohort.policy,active:info.active,dayStart:info.dayStart,dayEnd:info.dayEnd,budget:Object.freeze({limit:cohort.policy.dailyBudget,used,remaining:Math.max(0,cohort.policy.dailyBudget-used)}),members:Object.freeze(cohort.members.map(m=>project(cohort,m,info)))});});return Object.freeze({revision:current.revision,cohorts:Object.freeze(views)});}
  // Pins what this operation will dispatch: the legacy source hash, or the Deployer's confirmed
  // release at this moment (04 §E.4.2). The budget reservation is part of the same write.
  async function prepareRefresh(rawCohortId,rawGeneratorId,{expectedRevision,at=clock()}={}){
    const cohortId=normalizeCohortId(rawCohortId),generatorId=normalizeGeneratorId(rawGeneratorId),expected=revision(expectedRevision);const current=await read();if(current.revision!==expected)fail(REFRESHER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});const cohort=current.value.cohorts.find(x=>x.cohortId===cohortId);if(!cohort)fail(REFRESHER_ERROR_CODES.NOT_FOUND);const member=cohort.members.find(x=>x.generatorId===generatorId);if(!member)fail(REFRESHER_ERROR_CODES.NOT_FOUND);if(!cohort.enabled)fail(REFRESHER_ERROR_CODES.SCHEDULE_INACTIVE);if(REFRESH_UNRESOLVED_STATUSES.has(member.operation.status))fail(REFRESHER_ERROR_CODES.OPERATION_BUSY);
    const info=scheduleInfo(cohort.policy,at);if(cohort.policy.mode===REFRESHER_MODE.AUTO_RECENT&&!info.active)fail(REFRESHER_ERROR_CODES.SCHEDULE_INACTIVE);if(inDay(member.lastConfirmedAt,info))fail(REFRESHER_ERROR_CODES.INVALID_TRANSITION);if(usedBudget(cohort,info)>=cohort.policy.dailyBudget)fail(REFRESHER_ERROR_CODES.BUDGET_EXHAUSTED);await requireAccount(cohort.accountId);
    let release;
    if(member.sourceKind===REFRESHER_SOURCE_KIND.LEGACY_SOURCE)release=Object.freeze({payloadKind:REFRESH_RELEASE_KIND.V1_SOURCE,payloadHash:member.sourceHash,thumbnailHash:null,listing:null});
    else{const confirmed=await confirmedRelease(generatorId);if(!confirmed.refreshable||confirmed.accountId!==cohort.accountId)fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);release=confirmed.release;}
    const sequence=member.operation.sequence+1;const now=isoNow(clock);const nextMember=Object.freeze({...member,operation:Object.freeze({sequence,operationId:operationIdFor(cohortId,member.ordinal,sequence),status:REFRESH_OPERATION_STATUS.PENDING,budgetDayStart:info.dayStart,release}),updatedAt:now});const nextCohort=Object.freeze({...replaceMember(cohort,generatorId,nextMember),updatedAt:now});const saved=await commit(current.revision,replaceCohort(current,cohortId,nextCohort));return Object.freeze({revision:saved.revision,member:saved.value.cohorts.find(x=>x.cohortId===cohortId).members.find(x=>x.generatorId===generatorId)});
  }
  const {dispatchRefresh,reconcileRefresh,cancelRefresh}=createRefreshOperations({read,commit,requireAccount,gateFor,remoteState,confirmedRelease,readRelease,cancelRemote,clock});

  // One explicit operator refresh of a Deployer-confirmed member: prepare (unless a provably
  // undispatched intent is already pending) and dispatch. Content is never supplied by the caller.
  async function refreshNow(rawCohortId,rawGeneratorId,{at=clock()}={}){
    const cohortId=normalizeCohortId(rawCohortId),generatorId=normalizeGeneratorId(rawGeneratorId);
    let current=await read();const cohort=current.value.cohorts.find(x=>x.cohortId===cohortId);if(!cohort)fail(REFRESHER_ERROR_CODES.NOT_FOUND);
    let member=cohort.members.find(x=>x.generatorId===generatorId);if(!member)fail(REFRESHER_ERROR_CODES.NOT_FOUND);
    if(member.sourceKind!==REFRESHER_SOURCE_KIND.DEPLOYER_CONFIRMED)fail(REFRESHER_ERROR_CODES.INVALID_TRANSITION);
    let rev=current.revision;
    if(![REFRESH_OPERATION_STATUS.PENDING,REFRESH_OPERATION_STATUS.RETRYABLE].includes(member.operation.status)){
      const prepared=await prepareRefresh(cohortId,generatorId,{expectedRevision:rev,at});rev=prepared.revision;
    }
    return dispatchRefresh(cohortId,generatorId,{expectedRevision:rev});
  }

  // A040-02: the declared background pass. Bounded, budget-fenced, no tabs, no pasted source.
  // Order: finish or discard intents that are already pending, then start new refreshes in the
  // accepted deterministic order. Uncertain outcomes are never retried here (reconcile first).
  async function runBackgroundPass({at=clock(),maxDispatches=REFRESHER_PASS_MAX_DISPATCHES}={}){
    if(!Number.isSafeInteger(maxDispatches)||maxDispatches<1||maxDispatches>32)fail(REFRESHER_ERROR_CODES.INVALID_ARGUMENT);
    const out={at:isoNow(()=>at),dispatched:[],cancelled:[],skipped:[],errors:[]};
    const initial=await read();
    for(const listed of initial.value.cohorts){
      if(out.dispatched.length>=maxDispatches)break;
      if(!listed.enabled||listed.policy.mode!==REFRESHER_MODE.AUTO_RECENT)continue;
      if(!scheduleInfo(listed.policy,at).active)continue;
      const cohortId=listed.cohortId;
      const followers=listed.members.filter(m=>m.sourceKind===REFRESHER_SOURCE_KIND.DEPLOYER_CONFIRMED);
      for(const pending of followers.filter(m=>[REFRESH_OPERATION_STATUS.PENDING,REFRESH_OPERATION_STATUS.RETRYABLE].includes(m.operation.status))){
        if(out.dispatched.length>=maxDispatches)break;
        try{
          const confirmed=await confirmedRelease(pending.generatorId);
          const fresh=(await read());
          if(!confirmed.refreshable&&confirmed.reason!=="BUSY"&&confirmed.reason!=="PAUSED"||confirmed.refreshable&&(!sameRelease(confirmed.release,pending.operation.release)||confirmed.accountId!==listed.accountId)){
            await cancelRefresh(cohortId,pending.generatorId,{expectedRevision:fresh.revision});out.cancelled.push(pending.generatorId);continue;
          }
          if(!confirmed.refreshable){out.skipped.push(Object.freeze({generatorId:pending.generatorId,reason:confirmed.reason}));continue;}
          const result=await dispatchRefresh(cohortId,pending.generatorId,{expectedRevision:fresh.revision});
          out.dispatched.push(Object.freeze({generatorId:pending.generatorId,status:result.status}));
        }catch(error){out.errors.push(Object.freeze({generatorId:pending.generatorId,code:String(error?.code||"ERROR").slice(0,96)}));}
      }
      for(let guard=0;guard<maxDispatches&&out.dispatched.length<maxDispatches;guard+=1){
        const plan=await planRefreshes(cohortId,{at,limit:REFRESHER_MAX_MEMBERS});
        const tried=new Set([...out.skipped,...out.errors].map(x=>x.generatorId));
        const next=plan.members.find(m=>m.sourceKind===REFRESHER_SOURCE_KIND.DEPLOYER_CONFIRMED&&!tried.has(m.generatorId));
        if(!next)break;
        try{
          const confirmed=await confirmedRelease(next.generatorId);
          if(!confirmed.refreshable||confirmed.accountId!==listed.accountId){out.skipped.push(Object.freeze({generatorId:next.generatorId,reason:confirmed.refreshable?"ACCOUNT_MISMATCH":confirmed.reason}));continue;}
          const prepared=await prepareRefresh(cohortId,next.generatorId,{expectedRevision:plan.revision,at});
          const result=await dispatchRefresh(cohortId,next.generatorId,{expectedRevision:prepared.revision});
          out.dispatched.push(Object.freeze({generatorId:next.generatorId,status:result.status}));
        }catch(error){out.errors.push(Object.freeze({generatorId:next.generatorId,code:String(error?.code||"ERROR").slice(0,96)}));}
      }
    }
    return Object.freeze({at:out.at,dispatched:Object.freeze(out.dispatched),cancelled:Object.freeze(out.cancelled),skipped:Object.freeze(out.skipped),errors:Object.freeze(out.errors)});
  }

  // When the background pass should next run: soon while refreshable work is due, otherwise at
  // the next budget day or active cycle, never beyond the horizon. null when nothing is scheduled.
  async function nextWakeAt({at=clock()}={}){
    const atIso=isoNow(()=>at);const atMs=Date.parse(atIso);const current=await read();let best=null;
    const consider=(iso)=>{const ms=Math.min(Math.max(Date.parse(iso),atMs+REFRESHER_WAKE_MIN_MS),atMs+REFRESHER_WAKE_HORIZON_MS);if(best===null||ms<best)best=ms;};
    for(const cohort of current.value.cohorts){
      if(!cohort.enabled||cohort.policy.mode!==REFRESHER_MODE.AUTO_RECENT)continue;
      const followers=cohort.members.filter(m=>m.sourceKind===REFRESHER_SOURCE_KIND.DEPLOYER_CONFIRMED);
      if(!followers.length)continue;
      const info=scheduleInfo(cohort.policy,atIso);
      if(!info.active){consider(nextActiveStart(cohort.policy,atIso));continue;}
      const remaining=cohort.policy.dailyBudget-usedBudget(cohort,info);
      let due=false;
      if(followers.some(m=>[REFRESH_OPERATION_STATUS.PENDING,REFRESH_OPERATION_STATUS.RETRYABLE].includes(m.operation.status)))due=true;
      else if(remaining>0){
        for(const member of followers.filter(m=>eligibleMember(m,info))){
          let confirmed;try{confirmed=await confirmedRelease(member.generatorId);}catch{continue;}
          if(confirmed.refreshable&&confirmed.accountId===cohort.accountId){due=true;break;}
        }
      }
      consider(due?atIso:info.dayEnd);
    }
    return best===null?null:new Date(best).toISOString();
  }

  // Read-only refreshability of each Deployer-confirmed member, for the Refresher pages.
  async function describeMember(rawCohortId,rawGeneratorId){
    const cohortId=normalizeCohortId(rawCohortId),generatorId=normalizeGeneratorId(rawGeneratorId);
    const current=await read();const cohort=current.value.cohorts.find(x=>x.cohortId===cohortId);if(!cohort)fail(REFRESHER_ERROR_CODES.NOT_FOUND);
    const member=cohort.members.find(x=>x.generatorId===generatorId);if(!member)fail(REFRESHER_ERROR_CODES.NOT_FOUND);
    if(member.sourceKind!==REFRESHER_SOURCE_KIND.DEPLOYER_CONFIRMED)return Object.freeze({cohort,member,confirmed:null});
    let confirmed;try{confirmed=await confirmedRelease(generatorId);}catch{confirmed=Object.freeze({release:null,accountId:null,refreshable:false,reason:"UNAVAILABLE"});}
    return Object.freeze({cohort,member,confirmed});
  }
  return Object.freeze({createCohort,getCohort,listCohorts,updatePolicy,renameCohort,addMember,removeMember,setMemberSourceHash,planRefreshes,listCohortViews,prepareRefresh,dispatchRefresh,reconcileRefresh,cancelRefresh,refreshNow,runBackgroundPass,nextWakeAt,describeMember,confirmedRelease});
}
export { REFRESHER_MODE, REFRESH_OPERATION_STATUS, REFRESHER_SOURCE_KIND };
