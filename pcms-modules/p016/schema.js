import {
  PERCHANCE_GENERATOR_TARGET_KIND,
  PERCHANCE_PROVIDER_ID
} from "../../extension/pcms/providers/perchance/contract.js";
import { EXPLORER_ERROR_CODES, explorerError } from "./errors.js";

export const EXPLORER_SCHEMA_VERSION = 1;
export const EXPLORER_PROVIDER_ID = PERCHANCE_PROVIDER_ID;
export const EXPLORER_TARGET_KIND = PERCHANCE_GENERATOR_TARGET_KIND;
export const EXPLORER_STATE_KIND = "explorer-state";
export const EXPLORER_SCAN_KIND = "explorer-account-scan";
export const EXPLORER_CANDIDATE_KIND = "explorer-candidate";
export const EXPLORER_CLAIM_KIND = "explorer-claim";
export const EXPLORER_MAX_SCANS = 1024;
export const EXPLORER_MAX_CANDIDATES = 8192;
export const EXPLORER_MAX_CLAIMS = 8192;

export const EXPLORER_CLAIM_STATUS = Object.freeze({
  READY: "READY",
  TARGET_MISSING: "TARGET_MISSING",
  ACCOUNT_UNAVAILABLE: "ACCOUNT_UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
  RELEASED: "RELEASED"
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:%/-]{0,1599}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CLAIM_STATUS_SET = new Set(Object.values(EXPLORER_CLAIM_STATUS));

function fail(code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) { throw explorerError(code); }
function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exact(value, names, code) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== names.length || !names.every((name) => Object.hasOwn(descriptors, name))) fail(code);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
  }
}
function denseArray(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
  }
  const allowed = new Set(["length", ...Array.from({ length:value.length }, (_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) fail(code);
}
function boundedId(value, pattern = ID_PATTERN, code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}
export function normalizeAccountId(value, code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) {
  return boundedId(value, ID_PATTERN, code);
}
export function normalizeGeneratorId(value, code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) {
  return boundedId(value, ID_PATTERN, code);
}
export function normalizeClaimId(value, code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) {
  return boundedId(value, ID_PATTERN, code);
}
export function normalizeDeploymentId(value, code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) {
  return boundedId(value, ID_PATTERN, code);
}
export function normalizeDiscoveryId(value, code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) {
  return boundedId(value, ID_PATTERN, code);
}
export function normalizeCandidateId(value, code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) {
  return boundedId(value, CANDIDATE_ID_PATTERN, code);
}
export function normalizeSourceHash(value, code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) {
  if (value === null) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code);
  return value;
}
export function normalizeTimestamp(value, code = EXPLORER_ERROR_CODES.CORRUPT_STATE) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || Number.isNaN(Date.parse(value))) fail(code);
  return value;
}
export function candidateIdFor(accountId, generatorId) {
  const account = normalizeAccountId(accountId);
  const generator = normalizeGeneratorId(generatorId);
  const id = "explore:" + encodeURIComponent(account) + ":" + encodeURIComponent(generator);
  if (!CANDIDATE_ID_PATTERN.test(id)) fail();
  return id;
}

function normalizeDiscoveryEntry(value, code = EXPLORER_ERROR_CODES.INVALID_ARGUMENT) {
  exact(value, ["generatorId","observedSourceHash"], code);
  return Object.freeze({
    generatorId:normalizeGeneratorId(value.generatorId, code),
    observedSourceHash:normalizeSourceHash(value.observedSourceHash, code)
  });
}
function normalizeDiscoveryEntries(value, code) {
  denseArray(value, code);
  if (value.length > EXPLORER_MAX_CANDIDATES) fail(code);
  const entries = value.map((entry) => normalizeDiscoveryEntry(entry, code));
  entries.sort((left, right) => left.generatorId.localeCompare(right.generatorId));
  let previous = null;
  for (const entry of entries) {
    if (previous !== null && previous === entry.generatorId) fail(code);
    previous = entry.generatorId;
  }
  return Object.freeze(entries);
}
export function normalizeDiscoveryInput(value) {
  exact(value, ["accountId","discoveryId","candidates"], EXPLORER_ERROR_CODES.INVALID_ARGUMENT);
  return Object.freeze({
    accountId:normalizeAccountId(value.accountId),
    discoveryId:normalizeDiscoveryId(value.discoveryId),
    candidates:normalizeDiscoveryEntries(value.candidates, EXPLORER_ERROR_CODES.INVALID_ARGUMENT)
  });
}
export function normalizeClaimInput(value) {
  exact(value, ["claimId","deploymentId"], EXPLORER_ERROR_CODES.INVALID_ARGUMENT);
  return Object.freeze({
    claimId:normalizeClaimId(value.claimId),
    deploymentId:normalizeDeploymentId(value.deploymentId)
  });
}

export function normalizeScanRecord(value) {
  exact(value, ["schemaVersion","kind","accountId","sequence","discoveryId","entries","completedAt"], EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== EXPLORER_SCHEMA_VERSION || value.kind !== EXPLORER_SCAN_KIND) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({
    schemaVersion:EXPLORER_SCHEMA_VERSION,
    kind:EXPLORER_SCAN_KIND,
    accountId:normalizeAccountId(value.accountId, EXPLORER_ERROR_CODES.CORRUPT_STATE),
    sequence:value.sequence,
    discoveryId:normalizeDiscoveryId(value.discoveryId, EXPLORER_ERROR_CODES.CORRUPT_STATE),
    entries:normalizeDiscoveryEntries(value.entries, EXPLORER_ERROR_CODES.CORRUPT_STATE),
    completedAt:normalizeTimestamp(value.completedAt)
  });
}
export function normalizeCandidateRecord(value) {
  exact(value, ["schemaVersion","kind","candidateId","providerId","accountId","targetRef","observedSourceHash","firstSeenAt","lastSeenAt","lastScanSequence","claimId"], EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== EXPLORER_SCHEMA_VERSION || value.kind !== EXPLORER_CANDIDATE_KIND || value.providerId !== EXPLORER_PROVIDER_ID) {
    fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  }
  const accountId = normalizeAccountId(value.accountId, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  exact(value.targetRef, ["kind","id"], EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (value.targetRef.kind !== EXPLORER_TARGET_KIND) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  const generatorId = normalizeGeneratorId(value.targetRef.id, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  const candidateId = normalizeCandidateId(value.candidateId, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (candidateId !== candidateIdFor(accountId, generatorId)) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (!Number.isSafeInteger(value.lastScanSequence) || value.lastScanSequence < 1) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  const claimId = value.claimId === null ? null : normalizeClaimId(value.claimId, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({
    schemaVersion:EXPLORER_SCHEMA_VERSION,
    kind:EXPLORER_CANDIDATE_KIND,
    candidateId,
    providerId:EXPLORER_PROVIDER_ID,
    accountId,
    targetRef:Object.freeze({kind:EXPLORER_TARGET_KIND,id:generatorId}),
    observedSourceHash:normalizeSourceHash(value.observedSourceHash, EXPLORER_ERROR_CODES.CORRUPT_STATE),
    firstSeenAt:normalizeTimestamp(value.firstSeenAt),
    lastSeenAt:normalizeTimestamp(value.lastSeenAt),
    lastScanSequence:value.lastScanSequence,
    claimId
  });
}
export function normalizeClaimRecord(value) {
  exact(value, ["schemaVersion","kind","claimId","providerId","accountId","candidateId","targetRef","deploymentId","status","createdAt","updatedAt","releasedAt"], EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== EXPLORER_SCHEMA_VERSION || value.kind !== EXPLORER_CLAIM_KIND || value.providerId !== EXPLORER_PROVIDER_ID) {
    fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  }
  if (!CLAIM_STATUS_SET.has(value.status)) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  const accountId = normalizeAccountId(value.accountId, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  exact(value.targetRef, ["kind","id"], EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (value.targetRef.kind !== EXPLORER_TARGET_KIND) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  const generatorId = normalizeGeneratorId(value.targetRef.id, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  const candidateId = normalizeCandidateId(value.candidateId, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (candidateId !== candidateIdFor(accountId, generatorId)) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  const releasedAt = value.releasedAt === null ? null : normalizeTimestamp(value.releasedAt);
  if ((value.status === EXPLORER_CLAIM_STATUS.RELEASED) !== (releasedAt !== null)) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({
    schemaVersion:EXPLORER_SCHEMA_VERSION,
    kind:EXPLORER_CLAIM_KIND,
    claimId:normalizeClaimId(value.claimId, EXPLORER_ERROR_CODES.CORRUPT_STATE),
    providerId:EXPLORER_PROVIDER_ID,
    accountId,
    candidateId,
    targetRef:Object.freeze({kind:EXPLORER_TARGET_KIND,id:generatorId}),
    deploymentId:normalizeDeploymentId(value.deploymentId, EXPLORER_ERROR_CODES.CORRUPT_STATE),
    status:value.status,
    createdAt:normalizeTimestamp(value.createdAt),
    updatedAt:normalizeTimestamp(value.updatedAt),
    releasedAt
  });
}

export function emptyExplorerState() {
  return Object.freeze({
    schemaVersion:EXPLORER_SCHEMA_VERSION,
    kind:EXPLORER_STATE_KIND,
    scans:Object.freeze([]),
    candidates:Object.freeze([]),
    claims:Object.freeze([])
  });
}
export function normalizeExplorerState(value) {
  exact(value, ["schemaVersion","kind","scans","candidates","claims"], EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== EXPLORER_SCHEMA_VERSION || value.kind !== EXPLORER_STATE_KIND) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  denseArray(value.scans, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  denseArray(value.candidates, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  denseArray(value.claims, EXPLORER_ERROR_CODES.CORRUPT_STATE);
  if (value.scans.length > EXPLORER_MAX_SCANS || value.candidates.length > EXPLORER_MAX_CANDIDATES || value.claims.length > EXPLORER_MAX_CLAIMS) {
    fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
  }

  const scans=[]; const scanByAccount=new Map(); let previousScan=null;
  for (const raw of value.scans) {
    const scan=normalizeScanRecord(raw);
    if (scanByAccount.has(scan.accountId) || (previousScan !== null && previousScan.localeCompare(scan.accountId) >= 0)) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    scans.push(scan); scanByAccount.set(scan.accountId,scan); previousScan=scan.accountId;
  }

  const candidates=[]; const candidateById=new Map(); let previousCandidate=null;
  for (const raw of value.candidates) {
    const candidate=normalizeCandidateRecord(raw);
    if (candidateById.has(candidate.candidateId) || (previousCandidate !== null && previousCandidate.localeCompare(candidate.candidateId) >= 0)) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    const scan=scanByAccount.get(candidate.accountId);
    if (!scan || candidate.lastScanSequence > scan.sequence) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    const currentEntry=scan.entries.find((entry)=>entry.generatorId===candidate.targetRef.id);
    if (candidate.lastScanSequence === scan.sequence) {
      if (!currentEntry || currentEntry.observedSourceHash !== candidate.observedSourceHash) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    } else if (candidate.claimId === null) {
      fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    }
    candidates.push(candidate); candidateById.set(candidate.candidateId,candidate); previousCandidate=candidate.candidateId;
  }

  const claims=[]; const claimById=new Map(); const activeTargets=new Set(); const activeDeployments=new Set(); let previousClaim=null;
  for (const raw of value.claims) {
    const claim=normalizeClaimRecord(raw);
    if (claimById.has(claim.claimId) || (previousClaim !== null && previousClaim.localeCompare(claim.claimId) >= 0)) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    if (claim.status !== EXPLORER_CLAIM_STATUS.RELEASED) {
      const candidate=candidateById.get(claim.candidateId);
      if (!candidate || candidate.claimId !== claim.claimId || candidate.accountId !== claim.accountId || candidate.targetRef.id !== claim.targetRef.id) {
        fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
      }
      if (activeTargets.has(claim.targetRef.id) || activeDeployments.has(claim.deploymentId)) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
      activeTargets.add(claim.targetRef.id); activeDeployments.add(claim.deploymentId);
    }
    claims.push(claim); claimById.set(claim.claimId,claim); previousClaim=claim.claimId;
  }
  for (const candidate of candidates) {
    if (candidate.claimId !== null) {
      const claim=claimById.get(candidate.claimId);
      if (!claim || claim.status === EXPLORER_CLAIM_STATUS.RELEASED || claim.candidateId !== candidate.candidateId) fail(EXPLORER_ERROR_CODES.CORRUPT_STATE);
    }
  }

  return Object.freeze({
    schemaVersion:EXPLORER_SCHEMA_VERSION,
    kind:EXPLORER_STATE_KIND,
    scans:Object.freeze(scans),
    candidates:Object.freeze(candidates),
    claims:Object.freeze(claims)
  });
}
export function makeExplorerState({scans,candidates,claims}) {
  if (!Array.isArray(scans) || !Array.isArray(candidates) || !Array.isArray(claims)) fail();
  const normalizedScans=scans.map(normalizeScanRecord).sort((left,right)=>left.accountId.localeCompare(right.accountId));
  const normalizedCandidates=candidates.map(normalizeCandidateRecord).sort((left,right)=>left.candidateId.localeCompare(right.candidateId));
  const normalizedClaims=claims.map(normalizeClaimRecord).sort((left,right)=>left.claimId.localeCompare(right.claimId));
  return normalizeExplorerState({
    schemaVersion:EXPLORER_SCHEMA_VERSION,
    kind:EXPLORER_STATE_KIND,
    scans:normalizedScans,
    candidates:normalizedCandidates,
    claims:normalizedClaims
  });
}
