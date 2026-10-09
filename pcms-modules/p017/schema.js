import { REFRESHER_ERROR_CODES } from "./errors.js";
import {
  REFRESHER_SCHEMA_VERSION, REFRESHER_SCHEMA_VERSION_V1, REFRESHER_PROVIDER_ID, REFRESHER_STATE_KIND, REFRESHER_COHORT_KIND,
  REFRESHER_MEMBER_KIND, REFRESHER_MAX_COHORTS, REFRESHER_MAX_MEMBERS, REFRESHER_SOURCE_KIND, REFRESH_RELEASE_KIND,
  REFRESH_OPERATION_STATUS, REFRESH_OPERATION_STATUS_SET, REFRESH_UNRESOLVED_STATUSES,
  fail, exact, denseArray, normalizeCohortId, normalizeCohortName, normalizeAccountId, normalizeGeneratorId, normalizeSourceHash,
  normalizeTimestamp, normalizePolicy, operationIdFor
} from "./schema-input.js";
export * from "./schema-input.js";

const C=REFRESHER_ERROR_CODES.CORRUPT_STATE;
const LISTINGS=new Set(["PUBLICLY_LISTED","UNLISTED"]);
const SOURCE_KINDS=new Set(Object.values(REFRESHER_SOURCE_KIND));

// --- v1 (accepted P017): read only, for MIG-P040-refresher-state-v2 ---------------------------

function normalizeOperationV1(value,cohortId,ordinal){
  exact(value,["sequence","operationId","status","budgetDayStart"],C);
  if(!Number.isSafeInteger(value.sequence)||value.sequence<0||!REFRESH_OPERATION_STATUS_SET.has(value.status))fail(C);
  if(value.sequence===0){
    if(value.operationId!==null||value.status!==REFRESH_OPERATION_STATUS.IDLE||value.budgetDayStart!==null)fail(C);
    return Object.freeze({sequence:0,operationId:null,status:REFRESH_OPERATION_STATUS.IDLE,budgetDayStart:null});
  }
  const expected=operationIdFor(cohortId,ordinal,value.sequence);
  if(value.operationId!==expected)fail(C);
  const budgetDayStart=value.budgetDayStart===null?null:normalizeTimestamp(value.budgetDayStart,C);
  if(REFRESH_UNRESOLVED_STATUSES.has(value.status)&&budgetDayStart===null)fail(C);
  return Object.freeze({sequence:value.sequence,operationId:expected,status:value.status,budgetDayStart});
}
function normalizeMemberRecordV1(value,cohortId){
  exact(value,["schemaVersion","kind","generatorId","sourceHash","ordinal","lastConfirmedAt","confirmedCount","operation","createdAt","updatedAt"],C);
  if(value.schemaVersion!==REFRESHER_SCHEMA_VERSION_V1||value.kind!==REFRESHER_MEMBER_KIND
      ||!Number.isSafeInteger(value.ordinal)||value.ordinal<1||value.ordinal>REFRESHER_MAX_MEMBERS
      ||!Number.isSafeInteger(value.confirmedCount)||value.confirmedCount<0)fail(C);
  const lastConfirmedAt=value.lastConfirmedAt===null?null:normalizeTimestamp(value.lastConfirmedAt);
  if((value.confirmedCount===0)!==(lastConfirmedAt===null))fail(C);
  return Object.freeze({
    generatorId:normalizeGeneratorId(value.generatorId,C),sourceHash:normalizeSourceHash(value.sourceHash,C),ordinal:value.ordinal,
    lastConfirmedAt,confirmedCount:value.confirmedCount,operation:normalizeOperationV1(value.operation,cohortId,value.ordinal),
    createdAt:normalizeTimestamp(value.createdAt),updatedAt:normalizeTimestamp(value.updatedAt)
  });
}
function normalizeCohortRecordV1(value){
  exact(value,["schemaVersion","kind","cohortId","providerId","accountId","enabled","policy","members","createdAt","updatedAt"],C);
  if(value.schemaVersion!==REFRESHER_SCHEMA_VERSION_V1||value.kind!==REFRESHER_COHORT_KIND||value.providerId!==REFRESHER_PROVIDER_ID||typeof value.enabled!=="boolean")fail(C);
  const cohortId=normalizeCohortId(value.cohortId,C);
  denseArray(value.members,C);
  if(value.members.length<1||value.members.length>REFRESHER_MAX_MEMBERS)fail(C);
  const members=value.members.map((raw,index)=>{const member=normalizeMemberRecordV1(raw,cohortId);if(member.ordinal!==index+1)fail(C);return member;});
  return Object.freeze({cohortId,accountId:normalizeAccountId(value.accountId,C),enabled:value.enabled,policy:normalizePolicy(value.policy,C),
    members:Object.freeze(members),createdAt:normalizeTimestamp(value.createdAt),updatedAt:normalizeTimestamp(value.updatedAt)});
}
export function normalizeRefresherStateV1(value){
  exact(value,["schemaVersion","kind","cohorts"],C);
  if(value.schemaVersion!==REFRESHER_SCHEMA_VERSION_V1||value.kind!==REFRESHER_STATE_KIND)fail(C);
  denseArray(value.cohorts,C);if(value.cohorts.length>REFRESHER_MAX_COHORTS)fail(C);
  return Object.freeze({cohorts:Object.freeze(value.cohorts.map(normalizeCohortRecordV1))});
}

// --- v2 ------------------------------------------------------------------------------------------

// The content a refresh operation pins when it is prepared, so its intent fingerprint and the
// content dispatched later can never drift (04 §E.4.2 vocabulary).
export function normalizeRelease(value,code=C){
  exact(value,["payloadKind","payloadHash","thumbnailHash","listing"],code);
  const payloadHash=normalizeSourceHash(value.payloadHash,code);
  if(value.payloadKind===REFRESH_RELEASE_KIND.V1_SOURCE){
    if(value.thumbnailHash!==null||value.listing!==null)fail(code);
    return Object.freeze({payloadKind:value.payloadKind,payloadHash,thumbnailHash:null,listing:null});
  }
  if(value.payloadKind!==REFRESH_RELEASE_KIND.V2_RELEASE||!LISTINGS.has(value.listing))fail(code);
  return Object.freeze({payloadKind:value.payloadKind,payloadHash,
    thumbnailHash:value.thumbnailHash===null?null:normalizeSourceHash(value.thumbnailHash,code),listing:value.listing});
}
export function sameRelease(a,b){
  return a!==null&&b!==null&&a.payloadKind===b.payloadKind&&a.payloadHash===b.payloadHash&&a.thumbnailHash===b.thumbnailHash&&a.listing===b.listing;
}
function normalizeOperation(value,cohortId,ordinal,sourceKind){
  exact(value,["sequence","operationId","status","budgetDayStart","release"],C);
  if(!Number.isSafeInteger(value.sequence)||value.sequence<0||!REFRESH_OPERATION_STATUS_SET.has(value.status))fail(C);
  if(value.sequence===0){
    if(value.operationId!==null||value.status!==REFRESH_OPERATION_STATUS.IDLE||value.budgetDayStart!==null||value.release!==null)fail(C);
    return Object.freeze({sequence:0,operationId:null,status:REFRESH_OPERATION_STATUS.IDLE,budgetDayStart:null,release:null});
  }
  const expected=operationIdFor(cohortId,ordinal,value.sequence);
  if(value.operationId!==expected)fail(C);
  const budgetDayStart=value.budgetDayStart===null?null:normalizeTimestamp(value.budgetDayStart,C);
  const release=value.release===null?null:normalizeRelease(value.release);
  if(REFRESH_UNRESOLVED_STATUSES.has(value.status)&&(budgetDayStart===null||release===null))fail(C);
  // A Deployer-confirmed member never pins pasted source; a legacy member never pins a v2 release.
  if(release!==null&&(release.payloadKind===REFRESH_RELEASE_KIND.V2_RELEASE)!==(sourceKind===REFRESHER_SOURCE_KIND.DEPLOYER_CONFIRMED))fail(C);
  return Object.freeze({sequence:value.sequence,operationId:expected,status:value.status,budgetDayStart,release});
}
export function normalizeMemberRecord(value,cohortId){
  exact(value,["schemaVersion","kind","generatorId","sourceKind","sourceHash","ordinal","lastConfirmedAt","confirmedCount","operation","createdAt","updatedAt"],C);
  if(value.schemaVersion!==REFRESHER_SCHEMA_VERSION||value.kind!==REFRESHER_MEMBER_KIND||!SOURCE_KINDS.has(value.sourceKind)
      ||!Number.isSafeInteger(value.ordinal)||value.ordinal<1||value.ordinal>REFRESHER_MAX_MEMBERS*16
      ||!Number.isSafeInteger(value.confirmedCount)||value.confirmedCount<0)fail(C);
  const legacy=value.sourceKind===REFRESHER_SOURCE_KIND.LEGACY_SOURCE;
  if(legacy===(value.sourceHash===null))fail(C);
  const lastConfirmedAt=value.lastConfirmedAt===null?null:normalizeTimestamp(value.lastConfirmedAt);
  if((value.confirmedCount===0)!==(lastConfirmedAt===null))fail(C);
  return Object.freeze({
    schemaVersion:REFRESHER_SCHEMA_VERSION,kind:REFRESHER_MEMBER_KIND,
    generatorId:normalizeGeneratorId(value.generatorId,C),sourceKind:value.sourceKind,
    sourceHash:legacy?normalizeSourceHash(value.sourceHash,C):null,ordinal:value.ordinal,
    lastConfirmedAt,confirmedCount:value.confirmedCount,
    operation:normalizeOperation(value.operation,cohortId,value.ordinal,value.sourceKind),
    createdAt:normalizeTimestamp(value.createdAt),updatedAt:normalizeTimestamp(value.updatedAt)
  });
}
// Ordinals are never reused: an operation id names (cohort, ordinal, sequence), so a removed
// member's RemoteOperations can never be confused with a later member's.
export function normalizeCohortRecord(value){
  exact(value,["schemaVersion","kind","cohortId","name","providerId","accountId","enabled","policy","nextOrdinal","members","createdAt","updatedAt"],C);
  if(value.schemaVersion!==REFRESHER_SCHEMA_VERSION||value.kind!==REFRESHER_COHORT_KIND||value.providerId!==REFRESHER_PROVIDER_ID||typeof value.enabled!=="boolean")fail(C);
  const cohortId=normalizeCohortId(value.cohortId,C);
  if(!Number.isSafeInteger(value.nextOrdinal)||value.nextOrdinal<1||value.nextOrdinal>REFRESHER_MAX_MEMBERS*16+1)fail(C);
  denseArray(value.members,C);
  if(value.members.length>REFRESHER_MAX_MEMBERS)fail(C);
  const members=[];const targets=new Set();let previous=0;
  for(const raw of value.members){
    const member=normalizeMemberRecord(raw,cohortId);
    if(member.ordinal<=previous||member.ordinal>=value.nextOrdinal||targets.has(member.generatorId))fail(C);
    targets.add(member.generatorId);members.push(member);previous=member.ordinal;
  }
  return Object.freeze({
    schemaVersion:REFRESHER_SCHEMA_VERSION,kind:REFRESHER_COHORT_KIND,cohortId,name:normalizeCohortName(value.name,C),providerId:REFRESHER_PROVIDER_ID,
    accountId:normalizeAccountId(value.accountId,C),enabled:value.enabled,
    policy:normalizePolicy(value.policy,C),nextOrdinal:value.nextOrdinal,members:Object.freeze(members),
    createdAt:normalizeTimestamp(value.createdAt),updatedAt:normalizeTimestamp(value.updatedAt)
  });
}
export function emptyRefresherState(){return Object.freeze({schemaVersion:REFRESHER_SCHEMA_VERSION,kind:REFRESHER_STATE_KIND,cohorts:Object.freeze([])});}
export function normalizeRefresherState(value){
  exact(value,["schemaVersion","kind","cohorts"],C);
  if(value.schemaVersion!==REFRESHER_SCHEMA_VERSION||value.kind!==REFRESHER_STATE_KIND)fail(C);
  denseArray(value.cohorts,C);if(value.cohorts.length>REFRESHER_MAX_COHORTS)fail(C);
  const cohorts=[];const cohortIds=new Set();const targets=new Set();let previous=null;
  for(const raw of value.cohorts){
    const cohort=normalizeCohortRecord(raw);
    if(cohortIds.has(cohort.cohortId)||(previous!==null&&previous.localeCompare(cohort.cohortId)>=0))fail(C);
    for(const member of cohort.members){if(targets.has(member.generatorId))fail(C);targets.add(member.generatorId);}
    cohortIds.add(cohort.cohortId);cohorts.push(cohort);previous=cohort.cohortId;
  }
  return Object.freeze({schemaVersion:REFRESHER_SCHEMA_VERSION,kind:REFRESHER_STATE_KIND,cohorts:Object.freeze(cohorts)});
}
export function makeRefresherState(cohorts){
  if(!Array.isArray(cohorts))fail();const normalized=cohorts.map(normalizeCohortRecord).sort((a,b)=>a.cohortId.localeCompare(b.cohortId));
  return normalizeRefresherState({schemaVersion:REFRESHER_SCHEMA_VERSION,kind:REFRESHER_STATE_KIND,cohorts:normalized});
}
