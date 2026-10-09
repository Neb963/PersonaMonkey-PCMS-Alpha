import {
  PERCHANCE_GENERATOR_UPDATE_ACTION,
  PERCHANCE_PROVIDER_ID,
  generatorReleaseFingerprint,
  generatorSourceFingerprint,
  sha256Hex
} from "../../extension/pcms/providers/perchance/contract.js";
import { readRefresherState } from "./migration.js";
import { REFRESHER_ERROR_CODES, refresherError } from "./errors.js";
import {
  REFRESHER_COHORT_KIND,
  REFRESHER_MAX_COHORTS,
  REFRESHER_MAX_MEMBERS,
  REFRESHER_MODE,
  REFRESHER_MEMBER_KIND,
  REFRESHER_PROVIDER_ID,
  REFRESHER_SCHEMA_VERSION,
  REFRESHER_TARGET_KIND,
  REFRESH_OPERATION_STATUS,
  REFRESH_UNRESOLVED_STATUSES,
  emptyRefresherState,
  makeRefresherState,
  normalizeAccountId,
  normalizeCohortCreateInput,
  normalizeCohortId,
  normalizeGeneratorId,
  normalizePolicy,
  normalizeSourceHash,
  REFRESH_RELEASE_KIND,
  normalizeTimestamp,
  operationIdFor
} from "./schema.js";

const DAY_MS=24*60*60*1000;
const HOUR_MS=60*60*1000;
export const REMOTE_STATES=new Set(["PREPARED","DISPATCHING","UNCERTAIN","RETRYABLE","SUCCEEDED","FAILED","CANCELLED"]);
export function fail(code,options={}){throw refresherError(code,options);}
export function plain(value){if(!value||typeof value!=="object"||Array.isArray(value))return false;const p=Object.getPrototypeOf(value);return p===Object.prototype||p===null;}
export function snapshotMethods(value,names,label,{allowExtra=false}={}){
  if(!plain(value)||Object.getOwnPropertySymbols(value).length)throw new TypeError(label+" is invalid");
  const d=Object.getOwnPropertyDescriptors(value);
  if((!allowExtra&&Object.keys(d).length!==names.length)||!names.every(n=>Object.hasOwn(d,n)&&d[n].enumerable&&Object.hasOwn(d[n],"value")&&typeof d[n].value==="function"))throw new TypeError(label+" is invalid");
  return Object.freeze(Object.fromEntries(names.map(n=>[n,d[n].value])));
}
export function revision(value){if(!Number.isSafeInteger(value)||value<0)fail(REFRESHER_ERROR_CODES.REVISION_CONFLICT);return value;}
export function isoNow(clock){let d;try{d=new Date(clock());}catch{fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);}if(Number.isNaN(d.getTime()))fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);return d.toISOString();}
export function publicState(record){
  if(record===null)return Object.freeze({revision:0,value:emptyRefresherState()});
  if(!plain(record)||Object.getOwnPropertySymbols(record).length)fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);
  const d=Object.getOwnPropertyDescriptors(record);
  if(Object.keys(d).length!==2||!Object.hasOwn(d,"revision")||!Object.hasOwn(d,"value")||!d.revision.enumerable||!d.value.enumerable||!Object.hasOwn(d.revision,"value")||!Object.hasOwn(d.value,"value")||!Number.isSafeInteger(d.revision.value)||d.revision.value<1)fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({revision:d.revision.value,value:readRefresherState(d.value.value).value});
}
export function normalizeAccountSnapshot(raw,expectedAccountId){
  if(!plain(raw)||Object.getOwnPropertySymbols(raw).length)fail(REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
  const d=Object.getOwnPropertyDescriptors(raw);for(const x of Object.values(d))if(!x.enumerable||!Object.hasOwn(x,"value"))fail(REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
  if(!Object.hasOwn(d,"accountId")||!Object.hasOwn(d,"providerId")||d.accountId.value!==expectedAccountId||d.providerId.value!==REFRESHER_PROVIDER_ID)fail(REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
  return Object.freeze({accountId:expectedAccountId,providerId:REFRESHER_PROVIDER_ID});
}
export function normalizeRemoteRow(raw,expectedOperationId){
  if(raw===null)return null;if(!plain(raw)||Object.getOwnPropertySymbols(raw).length)fail(REFRESHER_ERROR_CODES.REMOTE_STATE);
  const d=Object.getOwnPropertyDescriptors(raw);for(const x of Object.values(d))if(!x.enumerable||!Object.hasOwn(x,"value"))fail(REFRESHER_ERROR_CODES.REMOTE_STATE);
  if(!Object.hasOwn(d,"value")||!plain(d.value.value))fail(REFRESHER_ERROR_CODES.REMOTE_STATE);
  const vd=Object.getOwnPropertyDescriptors(d.value.value);for(const x of Object.values(vd))if(!x.enumerable||!Object.hasOwn(x,"value"))fail(REFRESHER_ERROR_CODES.REMOTE_STATE);
  if(vd.operationId?.value!==expectedOperationId||!REMOTE_STATES.has(vd.state?.value))fail(REFRESHER_ERROR_CODES.REMOTE_STATE);
  return Object.freeze({state:vd.state.value});
}
export function replaceCohort(state,cohortId,replacement){const i=state.value.cohorts.findIndex(x=>x.cohortId===cohortId);if(i<0)fail(REFRESHER_ERROR_CODES.NOT_FOUND);const xs=[...state.value.cohorts];xs[i]=replacement;return makeRefresherState(xs);}
export function replaceMember(cohort,generatorId,replacement){const i=cohort.members.findIndex(x=>x.generatorId===generatorId);if(i<0)fail(REFRESHER_ERROR_CODES.NOT_FOUND);const members=[...cohort.members];members[i]=replacement;return Object.freeze({...cohort,members:Object.freeze(members)});}
export function scheduleInfo(policy,at){
  const atIso=normalizeTimestamp(at,REFRESHER_ERROR_CODES.INVALID_ARGUMENT);const atMs=Date.parse(atIso);const offset=policy.dayOffsetMinutes*60*1000;
  const dayStartMs=Math.floor((atMs-offset)/DAY_MS)*DAY_MS+offset;const dayStart=new Date(dayStartMs).toISOString();const dayEnd=new Date(dayStartMs+DAY_MS).toISOString();
  const anchorMs=Date.parse(policy.anchorAt);let active=false;let cycleIndex=null;
  if(atMs>=anchorMs){const activeMs=policy.activeHours*HOUR_MS;const cycleMs=activeMs+policy.sleepDays*DAY_MS;const elapsed=atMs-anchorMs;cycleIndex=Math.floor(elapsed/cycleMs);active=(elapsed%cycleMs)<activeMs;}
  return Object.freeze({at:atIso,dayStart,dayEnd,active,cycleIndex});
}
// Earliest instant after `at` at which an inactive AUTO_RECENT cycle becomes active again.
export function nextActiveStart(policy,at){
  const atMs=Date.parse(normalizeTimestamp(at,REFRESHER_ERROR_CODES.INVALID_ARGUMENT));const anchorMs=Date.parse(policy.anchorAt);
  if(atMs<anchorMs)return new Date(anchorMs).toISOString();
  const cycleMs=policy.activeHours*HOUR_MS+policy.sleepDays*DAY_MS;
  return new Date(anchorMs+(Math.floor((atMs-anchorMs)/cycleMs)+1)*cycleMs).toISOString();
}
export function inDay(iso,info){return iso!==null&&Date.parse(iso)>=Date.parse(info.dayStart)&&Date.parse(iso)<Date.parse(info.dayEnd);}
export function unresolvedReservation(member,info){return REFRESH_UNRESOLVED_STATUSES.has(member.operation.status)&&member.operation.budgetDayStart===info.dayStart;}
export function usedBudget(cohort,info){return cohort.members.reduce((n,m)=>n+(inDay(m.lastConfirmedAt,info)||unresolvedReservation(m,info)?1:0),0);}
export function eligibleMember(member,info){return !inDay(member.lastConfirmedAt,info)&&!REFRESH_UNRESOLVED_STATUSES.has(member.operation.status);}
export function sortEligible(a,b){
  if(a.lastConfirmedAt===null&&b.lastConfirmedAt!==null)return -1;if(a.lastConfirmedAt!==null&&b.lastConfirmedAt===null)return 1;
  if(a.lastConfirmedAt!==b.lastConfirmedAt)return (a.lastConfirmedAt||"").localeCompare(b.lastConfirmedAt||"");return a.ordinal-b.ordinal;
}
// The fingerprint follows the pinned release: a legacy member keeps the accepted v1 source
// fingerprint, a Deployer-confirmed member uses the v2 release fingerprint (04 §E.4.2).
export async function operationDraft(cohort,member){
  const release=member.operation.release;
  if(release===null)fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);
  const intentFingerprint=release.payloadKind===REFRESH_RELEASE_KIND.V2_RELEASE
    ?await generatorReleaseFingerprint(release)
    :generatorSourceFingerprint(release.payloadHash);
  return Object.freeze({
    operationId:member.operation.operationId,providerId:PERCHANCE_PROVIDER_ID,action:PERCHANCE_GENERATOR_UPDATE_ACTION,
    targetRef:Object.freeze({kind:REFRESHER_TARGET_KIND,id:member.generatorId}),intentFingerprint
  });
}
export function project(cohort,member,info){
  const confirmedToday=inDay(member.lastConfirmedAt,info);const reservedToday=unresolvedReservation(member,info);const remaining=Math.max(0,cohort.policy.dailyBudget-usedBudget(cohort,info));
  return Object.freeze({
    generatorId:member.generatorId,sourceKind:member.sourceKind,sourceHash:member.sourceHash,release:member.operation.release,ordinal:member.ordinal,lastConfirmedAt:member.lastConfirmedAt,confirmedCount:member.confirmedCount,
    operationId:member.operation.operationId,operationStatus:member.operation.status,confirmedToday,reservedToday,
    eligible:cohort.enabled&&(cohort.policy.mode===REFRESHER_MODE.MANUAL||info.active)&&remaining>0&&eligibleMember(member,info),
    actions:Object.freeze({canPrepare:cohort.enabled&&(cohort.policy.mode===REFRESHER_MODE.MANUAL||info.active)&&remaining>0&&eligibleMember(member,info),canDispatch:[REFRESH_OPERATION_STATUS.PENDING,REFRESH_OPERATION_STATUS.RETRYABLE].includes(member.operation.status),canReconcile:[REFRESH_OPERATION_STATUS.ACTIVE,REFRESH_OPERATION_STATUS.RECONCILE].includes(member.operation.status)})
  });
}
