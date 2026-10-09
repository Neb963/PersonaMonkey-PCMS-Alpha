import { PERCHANCE_PROVIDER_ID } from "../../extension/pcms/providers/perchance/contract.js";
import { REFRESHER_ERROR_CODES } from "./errors.js";
import {
  REFRESHER_COHORT_KIND, REFRESHER_MAX_COHORTS, REFRESHER_MAX_MEMBERS, REFRESHER_MEMBER_KIND, REFRESHER_PROVIDER_ID, REFRESHER_SCHEMA_VERSION,
  REFRESHER_SOURCE_KIND, REFRESH_OPERATION_STATUS, REFRESH_UNRESOLVED_STATUSES, makeRefresherState, normalizeCohortCreateInput, normalizeCohortId,
  normalizeCohortName, normalizeGeneratorId, normalizePolicy, normalizeRelease, normalizeSourceHash
} from "./schema.js";
import { fail, plain, snapshotMethods, revision, isoNow, publicState, normalizeAccountSnapshot, normalizeRemoteRow, replaceCohort, replaceMember } from "./refresher-helpers.js";

function memberRecord({generatorId,sourceHash},ordinal,now){
  return Object.freeze({schemaVersion:REFRESHER_SCHEMA_VERSION,kind:REFRESHER_MEMBER_KIND,generatorId,
    sourceKind:sourceHash===null?REFRESHER_SOURCE_KIND.DEPLOYER_CONFIRMED:REFRESHER_SOURCE_KIND.LEGACY_SOURCE,sourceHash,
    ordinal,lastConfirmedAt:null,confirmedCount:0,operation:Object.freeze({sequence:0,operationId:null,status:REFRESH_OPERATION_STATUS.IDLE,budgetDayStart:null,release:null}),
    createdAt:now,updatedAt:now});
}

// Read-only view of the Deployer's confirmed release, supplied by Core integration (P040).
// The Refresher never stores release content; it reads it only to dispatch.
function normalizeReleaseSource(value){
  if(value===null||value===undefined)return null;
  return snapshotMethods(value,["confirmedRelease","readRelease"],"Refresher release source",{allowExtra:true});
}

export function createRefresherStore({stateStore,accountsService,providerGateResolver,remoteOperationReader,releaseSource=null,remoteOperationCanceller=null,clock=()=>new Date().toISOString()}={}){
  const store=snapshotMethods(stateStore,["read","compareAndSwap"],"Refresher state store");
  const accounts=snapshotMethods(accountsService,["getAccount"],"Refresher Accounts service",{allowExtra:true});
  const gates=snapshotMethods(providerGateResolver,["get"],"Refresher ProviderGate resolver",{allowExtra:true});
  const remote=snapshotMethods(remoteOperationReader,["get"],"Refresher RemoteOperation reader",{allowExtra:true});
  const releases=normalizeReleaseSource(releaseSource);
  const canceller=remoteOperationCanceller===null?null:snapshotMethods(remoteOperationCanceller,["cancel"],"Refresher RemoteOperation canceller",{allowExtra:true});
  if(typeof clock!=="function")throw new TypeError("Refresher clock must be a function");if(REFRESHER_PROVIDER_ID!==PERCHANCE_PROVIDER_ID)throw new TypeError("Refresher provider identity is incompatible");
  async function read(){let raw;try{raw=await store.read();}catch{fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);}return publicState(raw);}
  async function commit(expectedRevision,value){
    let result;try{result=await store.compareAndSwap(Object.freeze({expectedRevision,value}));}catch{fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);}
    if(!plain(result)||Object.getOwnPropertySymbols(result).length)fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);const d=Object.getOwnPropertyDescriptors(result);for(const x of Object.values(d))if(!x.enumerable||!Object.hasOwn(x,"value"))fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);
    if(d.ok?.value===false){if(Object.keys(d).length!==2||!Object.hasOwn(d,"currentRevision")||!Number.isSafeInteger(d.currentRevision.value)||d.currentRevision.value<0)fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);fail(REFRESHER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:d.currentRevision.value});}
    if(d.ok?.value!==true||Object.keys(d).length!==3||!Object.hasOwn(d,"revision")||!Object.hasOwn(d,"value"))fail(REFRESHER_ERROR_CODES.CORRUPT_STATE);
    return publicState({revision:d.revision.value,value:d.value.value});
  }
  async function requireAccount(accountId){let raw;try{raw=await accounts.getAccount(accountId);}catch{fail(REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE);}if(raw===null)fail(REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE);return normalizeAccountSnapshot(raw,accountId);}
  async function gateFor(accountId){let raw;try{raw=await gates.get(accountId);}catch{fail(REFRESHER_ERROR_CODES.PROVIDER_UNAVAILABLE);}if(raw===null)fail(REFRESHER_ERROR_CODES.PROVIDER_UNAVAILABLE);try{return snapshotMethods(raw,["mutate","reconcile"],"Account ProviderGate",{allowExtra:true});}catch{fail(REFRESHER_ERROR_CODES.PROVIDER_UNAVAILABLE);}}
  async function remoteState(operationId){let raw;try{raw=await remote.get(operationId);}catch{fail(REFRESHER_ERROR_CODES.REMOTE_STATE);}return normalizeRemoteRow(raw,operationId);}
  // {release, accountId, refreshable, reason} for the Deployer-confirmed release of a target.
  async function confirmedRelease(generatorId){
    if(!releases)return Object.freeze({release:null,accountId:null,refreshable:false,reason:"NO_RELEASE_SOURCE"});
    let raw;try{raw=await releases.confirmedRelease(generatorId);}catch{fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);}
    if(raw===null)return Object.freeze({release:null,accountId:null,refreshable:false,reason:"NOT_DEPLOYED"});
    if(!plain(raw)||typeof raw.refreshable!=="boolean")fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);
    const release=raw.release===null?null:normalizeRelease(raw.release,REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);
    if(raw.refreshable&&release===null)fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);
    return Object.freeze({release,accountId:typeof raw.accountId==="string"?raw.accountId:null,refreshable:raw.refreshable,
      reason:typeof raw.reason==="string"?raw.reason.slice(0,48):null});
  }
  async function readRelease(generatorId,release){
    if(!releases)fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);
    let raw;try{raw=await releases.readRelease(generatorId,release);}catch{fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);}
    if(!plain(raw)||typeof raw.code!=="string"||typeof raw.html!=="string"||(raw.thumbnail!==null&&typeof raw.thumbnail!=="string"))fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);
    return Object.freeze({code:raw.code,html:raw.html,thumbnail:raw.thumbnail});
  }
  async function cancelRemote(operationId){
    if(!canceller)fail(REFRESHER_ERROR_CODES.OPERATION_BUSY);
    try{await canceller.cancel(operationId);}catch{fail(REFRESHER_ERROR_CODES.REMOTE_STATE);}
  }
  function assertTargetsFree(state,generatorIds,exceptCohortId=null){
    const targets=new Set(state.value.cohorts.filter(x=>x.cohortId!==exceptCohortId).flatMap(x=>x.members.map(m=>m.generatorId)));
    for(const id of generatorIds)if(targets.has(id))fail(REFRESHER_ERROR_CODES.TARGET_CONFLICT);
  }
  async function createCohort(input,{expectedRevision}={}){
    const draft=normalizeCohortCreateInput(input);const expected=revision(expectedRevision);const current=await read();if(current.revision!==expected)fail(REFRESHER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.cohorts.length>=REFRESHER_MAX_COHORTS)fail(REFRESHER_ERROR_CODES.CAPACITY);if(current.value.cohorts.some(x=>x.cohortId===draft.cohortId))fail(REFRESHER_ERROR_CODES.INVALID_ARGUMENT);
    assertTargetsFree(current,draft.members.map(m=>m.generatorId));
    await requireAccount(draft.accountId);
    for(const member of draft.members.filter(m=>m.sourceHash===null)){
      const confirmed=await confirmedRelease(member.generatorId);
      if(confirmed.accountId===null||confirmed.accountId!==draft.accountId)fail(REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
    }
    const now=isoNow(clock);
    const cohort=Object.freeze({schemaVersion:REFRESHER_SCHEMA_VERSION,kind:REFRESHER_COHORT_KIND,cohortId:draft.cohortId,name:draft.name,providerId:REFRESHER_PROVIDER_ID,accountId:draft.accountId,enabled:draft.enabled,policy:draft.policy,
      nextOrdinal:draft.members.length+1,members:Object.freeze(draft.members.map((m,i)=>memberRecord(m,i+1,now))),createdAt:now,updatedAt:now});
    const saved=await commit(current.revision,makeRefresherState([...current.value.cohorts,cohort]));return Object.freeze({revision:saved.revision,cohort:saved.value.cohorts.find(x=>x.cohortId===draft.cohortId)});
  }
  async function getCohort(rawCohortId){const cohortId=normalizeCohortId(rawCohortId);const current=await read();return current.value.cohorts.find(x=>x.cohortId===cohortId)||null;}
  async function listCohorts(){const current=await read();return Object.freeze({revision:current.revision,cohorts:current.value.cohorts});}
  function cohortAt(current,cohortId,expected){
    if(current.revision!==expected)fail(REFRESHER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    const cohort=current.value.cohorts.find(x=>x.cohortId===cohortId);if(!cohort)fail(REFRESHER_ERROR_CODES.NOT_FOUND);return cohort;
  }
  async function updatePolicy(rawCohortId,{expectedRevision,enabled,policy}={}){
    const cohortId=normalizeCohortId(rawCohortId);const expected=revision(expectedRevision);if(typeof enabled!=="boolean")fail(REFRESHER_ERROR_CODES.INVALID_ARGUMENT);const normalizedPolicy=normalizePolicy(policy);const current=await read();
    const cohort=cohortAt(current,cohortId,expected);if(cohort.members.some(m=>REFRESH_UNRESOLVED_STATUSES.has(m.operation.status)))fail(REFRESHER_ERROR_CODES.OPERATION_BUSY);
    const next=Object.freeze({...cohort,enabled,policy:normalizedPolicy,updatedAt:isoNow(clock)});const saved=await commit(current.revision,replaceCohort(current,cohortId,next));return Object.freeze({revision:saved.revision,cohort:saved.value.cohorts.find(x=>x.cohortId===cohortId)});
  }
  async function renameCohort(rawCohortId,{expectedRevision,name}={}){
    const cohortId=normalizeCohortId(rawCohortId);const expected=revision(expectedRevision);const safeName=normalizeCohortName(name);const current=await read();
    const cohort=cohortAt(current,cohortId,expected);if(cohort.name===safeName)return Object.freeze({revision:current.revision,cohort});
    const saved=await commit(current.revision,replaceCohort(current,cohortId,Object.freeze({...cohort,name:safeName,updatedAt:isoNow(clock)})));
    return Object.freeze({revision:saved.revision,cohort:saved.value.cohorts.find(x=>x.cohortId===cohortId)});
  }
  // Adds a generator that follows its Deployer-confirmed release. Membership is explicit; the
  // generator must be deployed for this cohort's account.
  async function addMember(rawCohortId,{expectedRevision,generatorId:rawGeneratorId}={}){
    const cohortId=normalizeCohortId(rawCohortId),generatorId=normalizeGeneratorId(rawGeneratorId),expected=revision(expectedRevision);const current=await read();
    const cohort=cohortAt(current,cohortId,expected);if(cohort.members.length>=REFRESHER_MAX_MEMBERS)fail(REFRESHER_ERROR_CODES.CAPACITY);
    assertTargetsFree(current,[generatorId]);
    const confirmed=await confirmedRelease(generatorId);
    if(confirmed.accountId===null||confirmed.accountId!==cohort.accountId)fail(REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
    const now=isoNow(clock);
    const next=Object.freeze({...cohort,nextOrdinal:cohort.nextOrdinal+1,members:Object.freeze([...cohort.members,memberRecord({generatorId,sourceHash:null},cohort.nextOrdinal,now)]),updatedAt:now});
    const saved=await commit(current.revision,replaceCohort(current,cohortId,next));
    return Object.freeze({revision:saved.revision,cohort:saved.value.cohorts.find(x=>x.cohortId===cohortId)});
  }
  async function removeMember(rawCohortId,rawGeneratorId,{expectedRevision}={}){
    const cohortId=normalizeCohortId(rawCohortId),generatorId=normalizeGeneratorId(rawGeneratorId),expected=revision(expectedRevision);const current=await read();
    const cohort=cohortAt(current,cohortId,expected);const member=cohort.members.find(x=>x.generatorId===generatorId);if(!member)fail(REFRESHER_ERROR_CODES.NOT_FOUND);
    if(REFRESH_UNRESOLVED_STATUSES.has(member.operation.status))fail(REFRESHER_ERROR_CODES.OPERATION_BUSY);
    const next=Object.freeze({...cohort,members:Object.freeze(cohort.members.filter(x=>x.generatorId!==generatorId)),updatedAt:isoNow(clock)});
    const saved=await commit(current.revision,replaceCohort(current,cohortId,next));
    return Object.freeze({revision:saved.revision,cohort:saved.value.cohorts.find(x=>x.cohortId===cohortId)});
  }
  async function setMemberSourceHash(rawCohortId,rawGeneratorId,{expectedRevision,sourceHash}={}){
    const cohortId=normalizeCohortId(rawCohortId),generatorId=normalizeGeneratorId(rawGeneratorId),hash=normalizeSourceHash(sourceHash),expected=revision(expectedRevision);const current=await read();
    const cohort=cohortAt(current,cohortId,expected);const member=cohort.members.find(x=>x.generatorId===generatorId);if(!member)fail(REFRESHER_ERROR_CODES.NOT_FOUND);if(REFRESH_UNRESOLVED_STATUSES.has(member.operation.status))fail(REFRESHER_ERROR_CODES.OPERATION_BUSY);
    if(member.sourceKind!==REFRESHER_SOURCE_KIND.LEGACY_SOURCE)fail(REFRESHER_ERROR_CODES.INVALID_TRANSITION);
    if(member.sourceHash===hash)return Object.freeze({revision:current.revision,changed:false,member});
    const nextMember=Object.freeze({...member,sourceHash:hash,updatedAt:isoNow(clock)});const nextCohort=Object.freeze({...replaceMember(cohort,generatorId,nextMember),updatedAt:nextMember.updatedAt});const saved=await commit(current.revision,replaceCohort(current,cohortId,nextCohort));return Object.freeze({revision:saved.revision,changed:true,member:saved.value.cohorts.find(x=>x.cohortId===cohortId).members.find(x=>x.generatorId===generatorId)});
  }
  return Object.freeze({read,commit,requireAccount,gateFor,remoteState,confirmedRelease,readRelease,cancelRemote,createCohort,getCohort,listCohorts,updatePolicy,renameCohort,addMember,removeMember,setMemberSourceHash,clock});
}
