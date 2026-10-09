import {
  EXPLORER_CANDIDATE_KIND,
  EXPLORER_CLAIM_KIND,
  EXPLORER_CLAIM_STATUS,
  EXPLORER_MAX_CANDIDATES,
  EXPLORER_MAX_CLAIMS,
  EXPLORER_PROVIDER_ID,
  EXPLORER_SCAN_KIND,
  EXPLORER_SCHEMA_VERSION,
  EXPLORER_TARGET_KIND,
  candidateIdFor,
  emptyExplorerState,
  makeExplorerState,
  normalizeAccountId,
  normalizeCandidateId,
  normalizeClaimId,
  normalizeClaimInput,
  normalizeDiscoveryInput,
  normalizeExplorerState
} from "./schema.js";
import { EXPLORER_ERROR_CODES, explorerError } from "./errors.js";

function fail(code, options = {}) { throw explorerError(code, options); }
function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype || proto===null;
}
function snapshotMethods(value, names, label, {allowExtra=false}={}) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) throw new TypeError(label + " is invalid");
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if ((!allowExtra && Object.keys(descriptors).length !== names.length)
      || !names.every((name)=>Object.hasOwn(descriptors,name)
        && descriptors[name].enumerable
        && Object.hasOwn(descriptors[name],"value")
        && typeof descriptors[name].value === "function")) {
    throw new TypeError(label + " is invalid");
  }
  return Object.freeze(Object.fromEntries(names.map((name)=>[name,descriptors[name].value])));
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(EXPLORER_ERROR_CODES.REVISION_CONFLICT);
  return value;
}
function isoNow(clock) {
  let date;
  try { date=new Date(clock()); } catch { fail(EXPLORER_ERROR_CODES.CORRUPT_STATE); }
  if (Number.isNaN(date.getTime())) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  return date.toISOString();
}
function publicState(record) {
  if (record === null) return Object.freeze({revision:0,value:emptyExplorerState()});
  if (!plain(record) || Object.getOwnPropertySymbols(record).length) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  const descriptors=Object.getOwnPropertyDescriptors(record);
  if (Object.keys(descriptors).length !== 2
      || !Object.hasOwn(descriptors,"revision")
      || !Object.hasOwn(descriptors,"value")
      || !descriptors.revision.enumerable
      || !descriptors.value.enumerable
      || !Object.hasOwn(descriptors.revision,"value")
      || !Object.hasOwn(descriptors.value,"value")
      || !Number.isSafeInteger(descriptors.revision.value)
      || descriptors.revision.value < 1) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({revision:descriptors.revision.value,value:normalizeExplorerState(descriptors.value.value)});
}
function normalizeAccountSnapshot(raw, expectedAccountId) {
  if (!plain(raw) || Object.getOwnPropertySymbols(raw).length) fail(EXPLORER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
  const descriptors=Object.getOwnPropertyDescriptors(raw);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor,"value")) fail(EXPLORER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
  }
  if (!Object.hasOwn(descriptors,"accountId") || !Object.hasOwn(descriptors,"providerId")
      || descriptors.accountId.value !== expectedAccountId || descriptors.providerId.value !== EXPLORER_PROVIDER_ID) {
    fail(EXPLORER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
  }
  return Object.freeze({accountId:expectedAccountId,providerId:EXPLORER_PROVIDER_ID});
}
function sameEntries(left,right) {
  return left.length===right.length && left.every((entry,index)=>
    entry.generatorId===right[index].generatorId && entry.observedSourceHash===right[index].observedSourceHash);
}
function currentCandidate(candidate, scan) {
  return Boolean(scan && candidate.lastScanSequence===scan.sequence
    && scan.entries.some((entry)=>entry.generatorId===candidate.targetRef.id));
}
function candidateView(state,candidate) {
  const scan=state.value.scans.find((item)=>item.accountId===candidate.accountId) || null;
  const claim=candidate.claimId===null ? null : state.value.claims.find((item)=>item.claimId===candidate.claimId) || null;
  const freshness=currentCandidate(candidate,scan) ? "CURRENT" : "STALE";
  return Object.freeze({
    candidateId:candidate.candidateId,
    accountId:candidate.accountId,
    providerId:candidate.providerId,
    generatorId:candidate.targetRef.id,
    observedSourceHash:candidate.observedSourceHash,
    freshness,
    discoverySequence:scan?.sequence || null,
    claimId:claim?.claimId || null,
    deploymentId:claim?.deploymentId || null,
    claimStatus:claim?.status || null,
    actions:Object.freeze({
      canClaim:freshness==="CURRENT" && claim===null,
      canRelease:claim!==null && claim.status!==EXPLORER_CLAIM_STATUS.RELEASED,
      needsReconcile:claim!==null && claim.status!==EXPLORER_CLAIM_STATUS.READY
    })
  });
}
function reservationView(state,claim) {
  const candidate=state.value.candidates.find((item)=>item.candidateId===claim.candidateId) || null;
  const scan=candidate ? state.value.scans.find((item)=>item.accountId===candidate.accountId) || null : null;
  const current=Boolean(candidate && currentCandidate(candidate,scan));
  const ready=claim.status===EXPLORER_CLAIM_STATUS.READY && current;
  return Object.freeze({
    claimId:claim.claimId,
    deploymentId:claim.deploymentId,
    providerId:claim.providerId,
    accountId:claim.accountId,
    targetRef:claim.targetRef,
    observedSourceHash:candidate?.observedSourceHash || null,
    status:claim.status,
    ready,
    actions:Object.freeze({
      canCreateDeployment:ready,
      canRelease:claim.status!==EXPLORER_CLAIM_STATUS.RELEASED,
      needsReconcile:claim.status!==EXPLORER_CLAIM_STATUS.READY && claim.status!==EXPLORER_CLAIM_STATUS.RELEASED
    })
  });
}

export function createExplorerService({stateStore,accountsService,clock=()=>new Date().toISOString()}={}) {
  const store=snapshotMethods(stateStore,["read","compareAndSwap"],"Explorer state store");
  const accounts=snapshotMethods(accountsService,["getAccount"],"Explorer Accounts service",{allowExtra:true});
  if (typeof clock!=="function") throw new TypeError("Explorer clock must be a function");

  async function read() {
    let raw;
    try { raw=await store.read(); } catch { fail(EXPLORER_ERROR_CODES.CORRUPT_STATE); }
    return publicState(raw);
  }
  async function commit(expectedRevision,value) {
    let result;
    try { result=await store.compareAndSwap(Object.freeze({expectedRevision,value})); }
    catch { fail(EXPLORER_ERROR_CODES.CORRUPT_STATE); }
    if (!plain(result) || Object.getOwnPropertySymbols(result).length) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    const descriptors=Object.getOwnPropertyDescriptors(result);
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor,"value")) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    }
    if (descriptors.ok?.value===false) {
      if (Object.keys(descriptors).length!==2 || !Object.hasOwn(descriptors,"currentRevision")
          || !Number.isSafeInteger(descriptors.currentRevision.value) || descriptors.currentRevision.value<0) {
        fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
      }
      fail(EXPLORER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:descriptors.currentRevision.value});
    }
    if (descriptors.ok?.value!==true || Object.keys(descriptors).length!==3
        || !Object.hasOwn(descriptors,"revision") || !Object.hasOwn(descriptors,"value")) {
      fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    }
    return publicState({revision:descriptors.revision.value,value:descriptors.value.value});
  }
  async function requireAccount(accountId) {
    let raw;
    try { raw=await accounts.getAccount(accountId); }
    catch { fail(EXPLORER_ERROR_CODES.ACCOUNT_UNAVAILABLE); }
    if (raw===null) fail(EXPLORER_ERROR_CODES.ACCOUNT_UNAVAILABLE);
    return normalizeAccountSnapshot(raw,accountId);
  }
  async function accountHealth(accountId) {
    let raw;
    try { raw=await accounts.getAccount(accountId); }
    catch { return EXPLORER_CLAIM_STATUS.UNKNOWN; }
    if (raw===null) return EXPLORER_CLAIM_STATUS.ACCOUNT_UNAVAILABLE;
    try { normalizeAccountSnapshot(raw,accountId); }
    catch { return EXPLORER_CLAIM_STATUS.UNKNOWN; }
    return EXPLORER_CLAIM_STATUS.READY;
  }

  async function recordDiscovery(input,{expectedRevision}={}) {
    const draft=normalizeDiscoveryInput(input);
    const expected=revision(expectedRevision);
    const current=await read();
    if (current.revision!==expected) fail(EXPLORER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    await requireAccount(draft.accountId);
    const previousScan=current.value.scans.find((item)=>item.accountId===draft.accountId) || null;
    if (previousScan?.discoveryId===draft.discoveryId) {
      if (!sameEntries(previousScan.entries,draft.candidates)) fail(EXPLORER_ERROR_CODES.DISCOVERY_CONFLICT);
      return Object.freeze({
        revision:current.revision,
        changed:false,
        scan:previousScan,
        candidates:Object.freeze(current.value.candidates.filter((item)=>item.accountId===draft.accountId).map((item)=>candidateView(current,item)))
      });
    }
    const sequence=(previousScan?.sequence || 0)+1;
    const now=isoNow(clock);
    const incoming=new Map(draft.candidates.map((entry)=>[entry.generatorId,entry]));
    const candidates=[];
    const existingByGenerator=new Map();
    for (const candidate of current.value.candidates) {
      if (candidate.accountId!==draft.accountId) {
        candidates.push(candidate);
        continue;
      }
      existingByGenerator.set(candidate.targetRef.id,candidate);
      const entry=incoming.get(candidate.targetRef.id);
      if (entry) {
        candidates.push(Object.freeze({
          ...candidate,
          observedSourceHash:entry.observedSourceHash,
          lastSeenAt:now,
          lastScanSequence:sequence
        }));
      } else if (candidate.claimId!==null) {
        candidates.push(candidate);
      }
    }
    for (const entry of draft.candidates) {
      if (existingByGenerator.has(entry.generatorId)) continue;
      const candidateId=candidateIdFor(draft.accountId,entry.generatorId);
      candidates.push(Object.freeze({
        schemaVersion:EXPLORER_SCHEMA_VERSION,
        kind:EXPLORER_CANDIDATE_KIND,
        candidateId,
        providerId:EXPLORER_PROVIDER_ID,
        accountId:draft.accountId,
        targetRef:Object.freeze({kind:EXPLORER_TARGET_KIND,id:entry.generatorId}),
        observedSourceHash:entry.observedSourceHash,
        firstSeenAt:now,
        lastSeenAt:now,
        lastScanSequence:sequence,
        claimId:null
      }));
    }
    if (candidates.length>EXPLORER_MAX_CANDIDATES) fail(EXPLORER_ERROR_CODES.CAPACITY);
    const claims=current.value.claims.map((claim)=>{
      if (claim.accountId!==draft.accountId || claim.status===EXPLORER_CLAIM_STATUS.RELEASED) return claim;
      const status=incoming.has(claim.targetRef.id) ? EXPLORER_CLAIM_STATUS.READY : EXPLORER_CLAIM_STATUS.TARGET_MISSING;
      return status===claim.status ? claim : Object.freeze({...claim,status,updatedAt:now});
    });
    const scan=Object.freeze({
      schemaVersion:EXPLORER_SCHEMA_VERSION,
      kind:EXPLORER_SCAN_KIND,
      accountId:draft.accountId,
      sequence,
      discoveryId:draft.discoveryId,
      entries:draft.candidates,
      completedAt:now
    });
    const scans=current.value.scans.filter((item)=>item.accountId!==draft.accountId);
    scans.push(scan);
    const saved=await commit(current.revision,makeExplorerState({scans,candidates,claims}));
    return Object.freeze({
      revision:saved.revision,
      changed:true,
      scan:saved.value.scans.find((item)=>item.accountId===draft.accountId),
      candidates:Object.freeze(saved.value.candidates.filter((item)=>item.accountId===draft.accountId).map((item)=>candidateView(saved,item)))
    });
  }

  async function listCandidates(rawAccountId=null) {
    const accountId=rawAccountId===null ? null : normalizeAccountId(rawAccountId);
    const current=await read();
    const candidates=current.value.candidates.filter((item)=>accountId===null || item.accountId===accountId).map((item)=>candidateView(current,item));
    return Object.freeze({revision:current.revision,candidates:Object.freeze(candidates)});
  }

  async function claimCandidate(rawCandidateId,input,{expectedRevision}={}) {
    const candidateId=normalizeCandidateId(rawCandidateId);
    const draft=normalizeClaimInput(input);
    const expected=revision(expectedRevision);
    const current=await read();
    if (current.revision!==expected) fail(EXPLORER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    const candidate=current.value.candidates.find((item)=>item.candidateId===candidateId);
    if (!candidate) fail(EXPLORER_ERROR_CODES.NOT_FOUND);
    const scan=current.value.scans.find((item)=>item.accountId===candidate.accountId) || null;
    if (!currentCandidate(candidate,scan)) fail(EXPLORER_ERROR_CODES.INVALID_TRANSITION);
    await requireAccount(candidate.accountId);
    if (candidate.claimId!==null) {
      const existing=current.value.claims.find((item)=>item.claimId===candidate.claimId);
      if (existing && existing.claimId===draft.claimId && existing.deploymentId===draft.deploymentId && existing.status!==EXPLORER_CLAIM_STATUS.RELEASED) {
        return Object.freeze({revision:current.revision,changed:false,claim:existing,reservation:reservationView(current,existing)});
      }
      fail(EXPLORER_ERROR_CODES.CLAIM_CONFLICT);
    }
    if (current.value.claims.length>=EXPLORER_MAX_CLAIMS) fail(EXPLORER_ERROR_CODES.CAPACITY);
    if (current.value.claims.some((claim)=>claim.claimId===draft.claimId)) fail(EXPLORER_ERROR_CODES.CLAIM_CONFLICT);
    if (current.value.claims.some((claim)=>claim.status!==EXPLORER_CLAIM_STATUS.RELEASED
        && (claim.deploymentId===draft.deploymentId || claim.targetRef.id===candidate.targetRef.id))) {
      fail(EXPLORER_ERROR_CODES.CLAIM_CONFLICT);
    }
    const now=isoNow(clock);
    const claim=Object.freeze({
      schemaVersion:EXPLORER_SCHEMA_VERSION,
      kind:EXPLORER_CLAIM_KIND,
      claimId:draft.claimId,
      providerId:EXPLORER_PROVIDER_ID,
      accountId:candidate.accountId,
      candidateId:candidate.candidateId,
      targetRef:candidate.targetRef,
      deploymentId:draft.deploymentId,
      status:EXPLORER_CLAIM_STATUS.READY,
      createdAt:now,
      updatedAt:now,
      releasedAt:null
    });
    const candidates=current.value.candidates.map((item)=>item.candidateId===candidate.candidateId ? Object.freeze({...item,claimId:claim.claimId}) : item);
    const claims=[...current.value.claims,claim];
    const saved=await commit(current.revision,makeExplorerState({scans:current.value.scans,candidates,claims}));
    const stored=saved.value.claims.find((item)=>item.claimId===claim.claimId);
    return Object.freeze({revision:saved.revision,changed:true,claim:stored,reservation:reservationView(saved,stored)});
  }

  async function releaseClaim(rawClaimId,{expectedRevision}={}) {
    const claimId=normalizeClaimId(rawClaimId);
    const expected=revision(expectedRevision);
    const current=await read();
    if (current.revision!==expected) fail(EXPLORER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    const claim=current.value.claims.find((item)=>item.claimId===claimId);
    if (!claim) fail(EXPLORER_ERROR_CODES.NOT_FOUND);
    if (claim.status===EXPLORER_CLAIM_STATUS.RELEASED) {
      return Object.freeze({revision:current.revision,changed:false,claim,reservation:reservationView(current,claim)});
    }
    const now=isoNow(clock);
    const released=Object.freeze({...claim,status:EXPLORER_CLAIM_STATUS.RELEASED,updatedAt:now,releasedAt:now});
    const claims=current.value.claims.map((item)=>item.claimId===claimId ? released : item);
    const candidates=[];
    for (const item of current.value.candidates) {
      if (item.claimId!==claimId) { candidates.push(item); continue; }
      const scan=current.value.scans.find((candidateScan)=>candidateScan.accountId===item.accountId) || null;
      if (currentCandidate(item,scan)) candidates.push(Object.freeze({...item,claimId:null}));
    }
    const saved=await commit(current.revision,makeExplorerState({scans:current.value.scans,candidates,claims}));
    const stored=saved.value.claims.find((item)=>item.claimId===claimId);
    return Object.freeze({revision:saved.revision,changed:true,claim:stored,reservation:reservationView(saved,stored)});
  }

  async function reconcileClaims({expectedRevision}={}) {
    const expected=revision(expectedRevision);
    const current=await read();
    if (current.revision!==expected) fail(EXPLORER_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    let changed=false;
    let now=null;
    const accountStatuses=new Map();
    const claims=[];
    for (const claim of current.value.claims) {
      if (claim.status===EXPLORER_CLAIM_STATUS.RELEASED) {
        claims.push(claim);
        continue;
      }
      let accountStatus=accountStatuses.get(claim.accountId);
      if (!accountStatus) {
        accountStatus=await accountHealth(claim.accountId);
        accountStatuses.set(claim.accountId,accountStatus);
      }
      const candidate=current.value.candidates.find((item)=>item.candidateId===claim.candidateId);
      const scan=candidate ? current.value.scans.find((item)=>item.accountId===candidate.accountId) || null : null;
      let status=accountStatus;
      if (accountStatus===EXPLORER_CLAIM_STATUS.READY && !currentCandidate(candidate,scan)) status=EXPLORER_CLAIM_STATUS.TARGET_MISSING;
      if (status===claim.status) {
        claims.push(claim);
        continue;
      }
      if (now===null) now=isoNow(clock);
      claims.push(Object.freeze({...claim,status,updatedAt:now}));
      changed=true;
    }
    if (!changed) {
      return Object.freeze({revision:current.revision,changed:false,claims:Object.freeze(current.value.claims.map((claim)=>reservationView(current,claim)))});
    }
    const saved=await commit(current.revision,makeExplorerState({scans:current.value.scans,candidates:current.value.candidates,claims}));
    return Object.freeze({revision:saved.revision,changed:true,claims:Object.freeze(saved.value.claims.map((claim)=>reservationView(saved,claim)))});
  }

  async function listReservations() {
    const current=await read();
    return Object.freeze({revision:current.revision,reservations:Object.freeze(current.value.claims.map((claim)=>reservationView(current,claim)))});
  }
  async function getDeploymentReservation(rawClaimId) {
    const claimId=normalizeClaimId(rawClaimId);
    const current=await read();
    const claim=current.value.claims.find((item)=>item.claimId===claimId);
    if (!claim) return null;
    return reservationView(current,claim);
  }

  return Object.freeze({recordDiscovery,listCandidates,claimCandidate,releaseClaim,reconcileClaims,listReservations,getDeploymentReservation});
}

export { EXPLORER_CLAIM_STATUS };
