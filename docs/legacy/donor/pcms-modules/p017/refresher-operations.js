import { generatorPayloadHash, sha256Hex, thumbnailHash } from "../../extension/pcms/providers/perchance/contract.js";
import { REFRESHER_ERROR_CODES } from "./errors.js";
import { REFRESH_OPERATION_STATUS, REFRESH_RELEASE_KIND, normalizeCohortId, normalizeGeneratorId, sameRelease } from "./schema.js";
import { REMOTE_STATES, fail, plain, revision, isoNow, replaceCohort, replaceMember, operationDraft } from "./refresher-helpers.js";

export function createRefreshOperations({read,commit,requireAccount,gateFor,remoteState,confirmedRelease,readRelease,cancelRemote,clock}){
  async function settle(cohortId,generatorId,operationId,remoteStatus,{fallbackStatus=null}={}){
    for(let attempt=0;attempt<8;attempt+=1){const current=await read();const cohort=current.value.cohorts.find(x=>x.cohortId===cohortId);if(!cohort)fail(REFRESHER_ERROR_CODES.NOT_FOUND);const member=cohort.members.find(x=>x.generatorId===generatorId);if(!member)fail(REFRESHER_ERROR_CODES.NOT_FOUND);if(member.operation.operationId!==operationId)return Object.freeze({revision:current.revision,member});
      let status,lastConfirmedAt=member.lastConfirmedAt,confirmedCount=member.confirmedCount;
      if(remoteStatus===null)status=fallbackStatus||REFRESH_OPERATION_STATUS.RECONCILE;else if(remoteStatus==="PREPARED")status=REFRESH_OPERATION_STATUS.PENDING;else if(remoteStatus==="UNCERTAIN"||remoteStatus==="DISPATCHING")status=REFRESH_OPERATION_STATUS.RECONCILE;else if(remoteStatus==="RETRYABLE")status=REFRESH_OPERATION_STATUS.RETRYABLE;else if(remoteStatus==="FAILED")status=REFRESH_OPERATION_STATUS.FAILED;else if(remoteStatus==="CANCELLED")status=REFRESH_OPERATION_STATUS.CANCELLED;else if(remoteStatus==="SUCCEEDED"){status=REFRESH_OPERATION_STATUS.SUCCEEDED;if(member.operation.status!==REFRESH_OPERATION_STATUS.SUCCEEDED){lastConfirmedAt=isoNow(clock);confirmedCount+=1;}}else fail(REFRESHER_ERROR_CODES.REMOTE_STATE);
      const now=isoNow(clock);const nextMember=Object.freeze({...member,lastConfirmedAt,confirmedCount,operation:Object.freeze({...member.operation,status}),updatedAt:now});const nextCohort=Object.freeze({...replaceMember(cohort,generatorId,nextMember),updatedAt:now});try{const saved=await commit(current.revision,replaceCohort(current,cohortId,nextCohort));return Object.freeze({revision:saved.revision,member:saved.value.cohorts.find(x=>x.cohortId===cohortId).members.find(x=>x.generatorId===generatorId)});}catch(error){if(error?.code!==REFRESHER_ERROR_CODES.REVISION_CONFLICT)throw error;}}
    fail(REFRESHER_ERROR_CODES.REVISION_CONFLICT);
  }
  // Legacy members dispatch operator-supplied source (accepted P017 API only). A Deployer-confirmed
  // member never takes source: its content is read from the pinned release, which must still be
  // the Deployer's confirmed release, so a refresh can never roll Perchance back.
  async function dispatchInputFor(cohort,member,source){
    const release=member.operation.release;
    if(release.payloadKind===REFRESH_RELEASE_KIND.V1_SOURCE){
      let actualHash;try{actualHash=await sha256Hex(source);}catch{fail(REFRESHER_ERROR_CODES.INVALID_ARGUMENT);}if(actualHash!==release.payloadHash)fail(REFRESHER_ERROR_CODES.SOURCE_MISMATCH);
      return Object.freeze({sourceHash:release.payloadHash,source});
    }
    if(source!==undefined)fail(REFRESHER_ERROR_CODES.INVALID_ARGUMENT);
    const confirmed=await confirmedRelease(member.generatorId);
    if(!confirmed.refreshable||confirmed.accountId!==cohort.accountId||!sameRelease(confirmed.release,release))fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);
    const content=await readRelease(member.generatorId,release);
    let payloadHash,thumb=null;
    try{payloadHash=await generatorPayloadHash(content.code,content.html);if(content.thumbnail!==null)thumb=await thumbnailHash(content.thumbnail);}catch{fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);}
    if(payloadHash!==release.payloadHash||thumb!==release.thumbnailHash)fail(REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);
    return Object.freeze({payloadHash,thumbnailHash:thumb,listing:release.listing,code:content.code,html:content.html,thumbnail:content.thumbnail});
  }
  async function dispatchRefresh(rawCohortId,rawGeneratorId,{expectedRevision,source}={}){
    const cohortId=normalizeCohortId(rawCohortId),generatorId=normalizeGeneratorId(rawGeneratorId),expected=revision(expectedRevision);const current=await read();if(current.revision!==expected)fail(REFRESHER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});const cohort=current.value.cohorts.find(x=>x.cohortId===cohortId);if(!cohort)fail(REFRESHER_ERROR_CODES.NOT_FOUND);const member=cohort.members.find(x=>x.generatorId===generatorId);if(!member)fail(REFRESHER_ERROR_CODES.NOT_FOUND);const previousStatus=member.operation.status;if(![REFRESH_OPERATION_STATUS.PENDING,REFRESH_OPERATION_STATUS.RETRYABLE].includes(previousStatus))fail(REFRESHER_ERROR_CODES.INVALID_TRANSITION);await requireAccount(cohort.accountId);const gate=await gateFor(cohort.accountId);
    const dispatchInput=await dispatchInputFor(cohort,member,source);const operation=await operationDraft(cohort,member);
    const now=isoNow(clock);const activeMember=Object.freeze({...member,operation:Object.freeze({...member.operation,status:REFRESH_OPERATION_STATUS.ACTIVE}),updatedAt:now});const activeCohort=Object.freeze({...replaceMember(cohort,generatorId,activeMember),updatedAt:now});const activeState=await commit(current.revision,replaceCohort(current,cohortId,activeCohort));const active=activeState.value.cohorts.find(x=>x.cohortId===cohortId).members.find(x=>x.generatorId===generatorId);let result;
    try{result=await gate.mutate(Object.freeze({operation,dispatchInput}));}catch(error){let snapshot;try{snapshot=await remoteState(active.operation.operationId);}catch{try{await settle(cohortId,generatorId,active.operation.operationId,"UNCERTAIN");}catch{}throw error;}try{await settle(cohortId,generatorId,active.operation.operationId,snapshot?.state||null,{fallbackStatus:previousStatus});}catch{}throw error;}
    if(!plain(result)||!["APPLIED","NOT_APPLIED","ALREADY_APPLIED"].includes(result.status))fail(REFRESHER_ERROR_CODES.REMOTE_STATE);const settled=await settle(cohortId,generatorId,active.operation.operationId,result.status==="NOT_APPLIED"?"FAILED":"SUCCEEDED");return Object.freeze({revision:settled.revision,status:result.status,member:settled.member});
  }
  async function reconcileRefresh(rawCohortId,rawGeneratorId,{expectedRevision}={}){
    const cohortId=normalizeCohortId(rawCohortId),generatorId=normalizeGeneratorId(rawGeneratorId),expected=revision(expectedRevision);const current=await read();if(current.revision!==expected)fail(REFRESHER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});const cohort=current.value.cohorts.find(x=>x.cohortId===cohortId);if(!cohort)fail(REFRESHER_ERROR_CODES.NOT_FOUND);const member=cohort.members.find(x=>x.generatorId===generatorId);if(!member)fail(REFRESHER_ERROR_CODES.NOT_FOUND);if(![REFRESH_OPERATION_STATUS.RECONCILE,REFRESH_OPERATION_STATUS.ACTIVE].includes(member.operation.status))fail(REFRESHER_ERROR_CODES.INVALID_TRANSITION);const snapshot=await remoteState(member.operation.operationId);if(snapshot===null)return settle(cohortId,generatorId,member.operation.operationId,null,{fallbackStatus:REFRESH_OPERATION_STATUS.PENDING});if(snapshot.state==="DISPATCHING")fail(REFRESHER_ERROR_CODES.OPERATION_BUSY);if(snapshot.state==="UNCERTAIN"){await requireAccount(cohort.accountId);const gate=await gateFor(cohort.accountId);let reconciled;try{reconciled=await gate.reconcile(member.operation.operationId);}catch{return settle(cohortId,generatorId,member.operation.operationId,"UNCERTAIN");}const state=reconciled?.value?.state;if(!REMOTE_STATES.has(state))fail(REFRESHER_ERROR_CODES.REMOTE_STATE);return settle(cohortId,generatorId,member.operation.operationId,state);}return settle(cohortId,generatorId,member.operation.operationId,snapshot.state);
  }
  // Discards a prepared refresh that provably never reached Perchance (no RemoteOperation, or one
  // still PREPARED/RETRYABLE). Anything that may have been dispatched must be reconciled instead.
  async function cancelRefresh(rawCohortId,rawGeneratorId,{expectedRevision}={}){
    const cohortId=normalizeCohortId(rawCohortId),generatorId=normalizeGeneratorId(rawGeneratorId),expected=revision(expectedRevision);const current=await read();if(current.revision!==expected)fail(REFRESHER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});const cohort=current.value.cohorts.find(x=>x.cohortId===cohortId);if(!cohort)fail(REFRESHER_ERROR_CODES.NOT_FOUND);const member=cohort.members.find(x=>x.generatorId===generatorId);if(!member)fail(REFRESHER_ERROR_CODES.NOT_FOUND);
    if(![REFRESH_OPERATION_STATUS.PENDING,REFRESH_OPERATION_STATUS.RETRYABLE].includes(member.operation.status))fail(REFRESHER_ERROR_CODES.INVALID_TRANSITION);
    const operationId=member.operation.operationId;const snapshot=await remoteState(operationId);
    if(snapshot===null)return settle(cohortId,generatorId,operationId,null,{fallbackStatus:REFRESH_OPERATION_STATUS.CANCELLED});
    if(snapshot.state==="PREPARED"||snapshot.state==="RETRYABLE"){await cancelRemote(operationId);return settle(cohortId,generatorId,operationId,"CANCELLED");}
    if(snapshot.state==="FAILED"||snapshot.state==="CANCELLED")return settle(cohortId,generatorId,operationId,snapshot.state);
    fail(REFRESHER_ERROR_CODES.OPERATION_BUSY);
  }
  return Object.freeze({dispatchRefresh,reconcileRefresh,cancelRefresh});
}
