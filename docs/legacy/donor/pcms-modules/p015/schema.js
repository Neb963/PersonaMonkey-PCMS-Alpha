import { DEPLOYER_ERROR_CODES, deployerError } from "./errors.js";

// pcms.deployer.state/v2 (04 §E.7.1). v1 records (accepted P015) are still read and are
// migrated by MIG-P036-deployer-state-v2 (migration.js); every write is v2.
export const DEPLOYER_SCHEMA_VERSION = 2;
export const DEPLOYER_SCHEMA_VERSION_V1 = 1;
export const DEPLOYER_STATE_CONTRACT = "pcms.deployer.state/v2";
export const DEPLOYER_PROVIDER_ID = "perchance";
export const DEPLOYER_TARGET_KIND = "generator";
export const DEPLOYER_STATE_KIND = "deployer-state";
export const DEPLOYMENT_KIND = "deployment";
export const DEPLOYER_MAX_DEPLOYMENTS = 4096;

export const DEPLOYMENT_OPERATION_STATUS = Object.freeze({
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  RECONCILE: "RECONCILE",
  RETRYABLE: "RETRYABLE",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  SUCCEEDED: "SUCCEEDED"
});
export const DEPLOYMENT_PAYLOAD_KINDS = Object.freeze({ V1_SOURCE: "v1-source", V2_RELEASE: "v2-release" });
export const DEPLOYMENT_LISTINGS = Object.freeze(["PUBLICLY_LISTED", "UNLISTED"]);
export const DEPLOYMENT_ORIGIN_KINDS = Object.freeze(["MANUAL", "REPOSITORY"]);
export const DEPLOYMENT_PAUSE_REASONS = Object.freeze(["OPERATOR", "DRIFT", "REPEATED_FAILURE"]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;
const PATH_PATTERN = /^[A-Za-z0-9._@/-]{1,512}$/;
const STATUS_SET = new Set(Object.values(DEPLOYMENT_OPERATION_STATUS));
const BUSY = new Set([DEPLOYMENT_OPERATION_STATUS.ACTIVE, DEPLOYMENT_OPERATION_STATUS.RECONCILE, DEPLOYMENT_OPERATION_STATUS.RETRYABLE]);

function fail(code = DEPLOYER_ERROR_CODES.INVALID_ARGUMENT) { throw deployerError(code); }
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
export function hasExactKeys(value, names) {
  try { exact(value, names, DEPLOYER_ERROR_CODES.INVALID_ARGUMENT); return true; } catch { return false; }
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
function boundedId(value, pattern = ID_PATTERN, code = DEPLOYER_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}
export function normalizeDeploymentId(value, code = DEPLOYER_ERROR_CODES.INVALID_ARGUMENT) {
  return boundedId(value, DEPLOYMENT_ID_PATTERN, code);
}
export function normalizeAccountId(value, code = DEPLOYER_ERROR_CODES.INVALID_ARGUMENT) {
  return boundedId(value, ID_PATTERN, code);
}
export function normalizeGeneratorId(value, code = DEPLOYER_ERROR_CODES.INVALID_ARGUMENT) {
  return boundedId(value, ID_PATTERN, code);
}
// v1 name kept: a v1 sourceHash and a v2 payloadHash are both lower-case SHA-256 hex.
export function normalizeSourceHash(value, code = DEPLOYER_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code);
  return value;
}
export const normalizePayloadHash = normalizeSourceHash;
function nullableHash(value, code) { return value === null ? null : normalizeSourceHash(value, code); }
export function normalizeTimestamp(value, code = DEPLOYER_ERROR_CODES.CORRUPT_STATE) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || Number.isNaN(Date.parse(value))) fail(code);
  return value;
}
export function normalizeListing(value, code = DEPLOYER_ERROR_CODES.INVALID_ARGUMENT) {
  if (!DEPLOYMENT_LISTINGS.includes(value)) fail(code);
  return value;
}
export function operationIdFor(deploymentId, desiredRevision, sequence) {
  const id = normalizeDeploymentId(deploymentId);
  if (!Number.isSafeInteger(desiredRevision) || desiredRevision < 1 || !Number.isSafeInteger(sequence) || sequence < 1) fail();
  const operationId = "deploy:" + id + ":" + desiredRevision + ":" + sequence;
  if (!ID_PATTERN.test(operationId)) fail();
  return operationId;
}

export function normalizeOrigin(value, code = DEPLOYER_ERROR_CODES.INVALID_ARGUMENT) {
  if (!plain(value)) fail(code);
  if (value.kind === "MANUAL") {
    exact(value, ["kind"], code);
    return Object.freeze({ kind:"MANUAL" });
  }
  if (value.kind !== "REPOSITORY") fail(code);
  exact(value, ["kind","commitId","path","version"], code);
  if (typeof value.commitId !== "string" || !COMMIT_PATTERN.test(value.commitId)) fail(code);
  if (typeof value.path !== "string" || !PATH_PATTERN.test(value.path) || value.path.split("/").some((part) => part === "" || part === "." || part === "..")) fail(code);
  if (typeof value.version !== "string" || !VERSION_PATTERN.test(value.version)) fail(code);
  return Object.freeze({ kind:"REPOSITORY", commitId:value.commitId, path:value.path, version:value.version });
}

// Desired intent (04 §E.4.2). v1-source carries no thumbnail or listing (not managed by PCMS).
export function normalizeDesiredIntent(value, code = DEPLOYER_ERROR_CODES.INVALID_ARGUMENT) {
  exact(value, ["payloadKind","payloadHash","thumbnailHash","listing","origin"], code);
  const payloadHash = normalizeSourceHash(value.payloadHash, code);
  if (value.payloadKind === DEPLOYMENT_PAYLOAD_KINDS.V1_SOURCE) {
    if (value.thumbnailHash !== null || value.listing !== null) fail(code);
    const origin = normalizeOrigin(value.origin, code);
    if (origin.kind !== "MANUAL") fail(code);
    return Object.freeze({ payloadKind:value.payloadKind, payloadHash, thumbnailHash:null, listing:null, origin });
  }
  if (value.payloadKind !== DEPLOYMENT_PAYLOAD_KINDS.V2_RELEASE) fail(code);
  return Object.freeze({
    payloadKind:value.payloadKind,
    payloadHash,
    thumbnailHash:nullableHash(value.thumbnailHash, code),
    listing:normalizeListing(value.listing, code),
    origin:normalizeOrigin(value.origin, code)
  });
}

export function sameIntent(left, right) {
  return left.payloadKind === right.payloadKind && left.payloadHash === right.payloadHash
    && left.thumbnailHash === right.thumbnailHash && left.listing === right.listing;
}

export const EMPTY_CONFIRMED = Object.freeze({
  payloadHash:null, thumbnailHash:null, listing:null, confirmedAt:null, operationId:null, baselineHash:null
});

export function isConfirmed(confirmed) { return confirmed.payloadHash !== null; }

// Confirmed matches desired intent (payload, thumbnail, listing). payloadKind is implied:
// a v1 confirmation is a plain source hash without listing.
export function confirmedMatchesDesired(confirmed, desired) {
  return confirmed.payloadHash === desired.payloadHash && confirmed.thumbnailHash === desired.thumbnailHash && confirmed.listing === desired.listing;
}

// --- v1 (accepted P015) ---------------------------------------------------------------------

export function normalizeDeploymentRecordV1(value) {
  exact(value, ["schemaVersion","kind","deploymentId","providerId","accountId","targetRef","desired","observed","operation","createdAt","updatedAt"], DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== DEPLOYER_SCHEMA_VERSION_V1 || value.kind !== DEPLOYMENT_KIND || value.providerId !== DEPLOYER_PROVIDER_ID) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const deploymentId = normalizeDeploymentId(value.deploymentId, DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const accountId = normalizeAccountId(value.accountId, DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  exact(value.targetRef, ["kind","id"], DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (value.targetRef.kind !== DEPLOYER_TARGET_KIND) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const generatorId = normalizeGeneratorId(value.targetRef.id, DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  exact(value.desired, ["revision","sourceHash"], DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (!Number.isSafeInteger(value.desired.revision) || value.desired.revision < 1) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const desiredHash = normalizeSourceHash(value.desired.sourceHash, DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  exact(value.observed, ["sourceHash","confirmedAt"], DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const observedNull = value.observed.sourceHash === null && value.observed.confirmedAt === null;
  const observedSet = value.observed.sourceHash !== null && value.observed.confirmedAt !== null;
  if (!observedNull && !observedSet) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const observedHash = observedNull ? null : normalizeSourceHash(value.observed.sourceHash, DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const confirmedAt = observedNull ? null : normalizeTimestamp(value.observed.confirmedAt);
  exact(value.operation, ["sequence","operationId","status"], DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (!Number.isSafeInteger(value.operation.sequence) || value.operation.sequence < 1 || !STATUS_SET.has(value.operation.status)) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const expectedOperationId = operationIdFor(deploymentId, value.desired.revision, value.operation.sequence);
  if (value.operation.operationId !== expectedOperationId) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (value.operation.status === DEPLOYMENT_OPERATION_STATUS.SUCCEEDED && (observedHash !== desiredHash || confirmedAt === null)) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({
    schemaVersion:DEPLOYER_SCHEMA_VERSION_V1,
    kind:DEPLOYMENT_KIND,
    deploymentId,
    providerId:DEPLOYER_PROVIDER_ID,
    accountId,
    targetRef:Object.freeze({kind:DEPLOYER_TARGET_KIND,id:generatorId}),
    desired:Object.freeze({revision:value.desired.revision,sourceHash:desiredHash}),
    observed:Object.freeze({sourceHash:observedHash,confirmedAt}),
    operation:Object.freeze({sequence:value.operation.sequence,operationId:expectedOperationId,status:value.operation.status}),
    createdAt:normalizeTimestamp(value.createdAt),
    updatedAt:normalizeTimestamp(value.updatedAt)
  });
}

export function normalizeDeployerStateV1(value) {
  exact(value, ["schemaVersion","kind","deployments"], DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== DEPLOYER_SCHEMA_VERSION_V1 || value.kind !== DEPLOYER_STATE_KIND) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  denseArray(value.deployments, DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (value.deployments.length > DEPLOYER_MAX_DEPLOYMENTS) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const deployments = value.deployments.map((raw) => normalizeDeploymentRecordV1(raw));
  return Object.freeze({schemaVersion:DEPLOYER_SCHEMA_VERSION_V1,kind:DEPLOYER_STATE_KIND,deployments:Object.freeze(deployments)});
}

// --- v2 ----------------------------------------------------------------------------------------

function normalizeConfirmed(value, desired) {
  exact(value, ["payloadHash","thumbnailHash","listing","confirmedAt","operationId","baselineHash"], DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (value.payloadHash === null) {
    if (Object.values(value).some((item) => item !== null)) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
    return EMPTY_CONFIRMED;
  }
  const C = DEPLOYER_ERROR_CODES.CORRUPT_STATE;
  return Object.freeze({
    payloadHash:normalizeSourceHash(value.payloadHash, C),
    thumbnailHash:nullableHash(value.thumbnailHash, C),
    listing:value.listing === null ? null : normalizeListing(value.listing, C),
    confirmedAt:normalizeTimestamp(value.confirmedAt),
    // null only for a v1 confirmation whose confirming operation v1 did not record.
    operationId:value.operationId === null ? null : boundedId(value.operationId, ID_PATTERN, C),
    baselineHash:nullableHash(value.baselineHash, C)
  });
}

export function normalizeDeploymentRecord(value) {
  const C = DEPLOYER_ERROR_CODES.CORRUPT_STATE;
  exact(value, ["schemaVersion","kind","deploymentId","providerId","accountId","targetRef","desired","confirmed","operation","policy","createdAt","updatedAt"], C);
  if (value.schemaVersion !== DEPLOYER_SCHEMA_VERSION || value.kind !== DEPLOYMENT_KIND || value.providerId !== DEPLOYER_PROVIDER_ID) fail(C);
  const deploymentId = normalizeDeploymentId(value.deploymentId, C);
  const accountId = normalizeAccountId(value.accountId, C);
  exact(value.targetRef, ["kind","id"], C);
  if (value.targetRef.kind !== DEPLOYER_TARGET_KIND) fail(C);
  const generatorId = normalizeGeneratorId(value.targetRef.id, C);
  if (!plain(value.desired) || !Number.isSafeInteger(value.desired.revision) || value.desired.revision < 1) fail(C);
  const { revision, ...intentFields } = value.desired;
  exact(value.desired, ["revision","payloadKind","payloadHash","thumbnailHash","listing","origin"], C);
  const intent = normalizeDesiredIntent(intentFields, C);
  const desired = Object.freeze({ revision, ...intent });
  const confirmed = normalizeConfirmed(value.confirmed, desired);
  exact(value.operation, ["sequence","operationId","status"], C);
  if (!Number.isSafeInteger(value.operation.sequence) || value.operation.sequence < 1 || !STATUS_SET.has(value.operation.status)) fail(C);
  const expectedOperationId = operationIdFor(deploymentId, revision, value.operation.sequence);
  if (value.operation.operationId !== expectedOperationId) fail(C);
  if (value.operation.status === DEPLOYMENT_OPERATION_STATUS.SUCCEEDED
      && (!isConfirmed(confirmed) || !confirmedMatchesDesired(confirmed, desired) || confirmed.operationId !== expectedOperationId)) fail(C);
  exact(value.policy, ["paused","pauseReason"], C);
  if (value.policy.paused === false ? value.policy.pauseReason !== null
      : value.policy.paused !== true || !DEPLOYMENT_PAUSE_REASONS.includes(value.policy.pauseReason)) fail(C);
  return Object.freeze({
    schemaVersion:DEPLOYER_SCHEMA_VERSION,
    kind:DEPLOYMENT_KIND,
    deploymentId,
    providerId:DEPLOYER_PROVIDER_ID,
    accountId,
    targetRef:Object.freeze({kind:DEPLOYER_TARGET_KIND,id:generatorId}),
    desired,
    confirmed,
    operation:Object.freeze({sequence:value.operation.sequence,operationId:expectedOperationId,status:value.operation.status}),
    policy:Object.freeze({paused:value.policy.paused,pauseReason:value.policy.pauseReason}),
    createdAt:normalizeTimestamp(value.createdAt),
    updatedAt:normalizeTimestamp(value.updatedAt)
  });
}

export function isOperationBusy(status) { return BUSY.has(status); }

// Create input: the accepted v1 shape (a manual single-source deployment), or v2 with an
// explicit intent. IDs are generated by callers (UI and repository apply), never typed.
export function normalizeDeploymentCreateInput(value) {
  if (hasExactKeys(value, ["deploymentId","accountId","generatorId","sourceHash"])) {
    return Object.freeze({
      deploymentId:normalizeDeploymentId(value.deploymentId),
      accountId:normalizeAccountId(value.accountId),
      generatorId:normalizeGeneratorId(value.generatorId),
      intent:normalizeDesiredIntent({payloadKind:DEPLOYMENT_PAYLOAD_KINDS.V1_SOURCE,payloadHash:value.sourceHash,thumbnailHash:null,listing:null,origin:{kind:"MANUAL"}})
    });
  }
  exact(value, ["deploymentId","accountId","generatorId","payloadHash","thumbnailHash","listing","origin"], DEPLOYER_ERROR_CODES.INVALID_ARGUMENT);
  return Object.freeze({
    deploymentId:normalizeDeploymentId(value.deploymentId),
    accountId:normalizeAccountId(value.accountId),
    generatorId:normalizeGeneratorId(value.generatorId),
    intent:normalizeDesiredIntent({payloadKind:DEPLOYMENT_PAYLOAD_KINDS.V2_RELEASE,payloadHash:value.payloadHash,
      thumbnailHash:value.thumbnailHash,listing:value.listing,origin:value.origin})
  });
}

export function emptyDeployerState() {
  return Object.freeze({schemaVersion:DEPLOYER_SCHEMA_VERSION,kind:DEPLOYER_STATE_KIND,deployments:Object.freeze([])});
}
export function normalizeDeployerState(value) {
  exact(value, ["schemaVersion","kind","deployments"], DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== DEPLOYER_SCHEMA_VERSION || value.kind !== DEPLOYER_STATE_KIND) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  denseArray(value.deployments, DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  if (value.deployments.length > DEPLOYER_MAX_DEPLOYMENTS) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const deployments=[]; const ids=new Set(); const targets=new Set(); let previous=null;
  for (const raw of value.deployments) {
    const deployment=normalizeDeploymentRecord(raw);
    if (ids.has(deployment.deploymentId) || targets.has(deployment.targetRef.id)) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
    if (previous !== null && previous.localeCompare(deployment.deploymentId) >= 0) fail(DEPLOYER_ERROR_CODES.CORRUPT_STATE);
    ids.add(deployment.deploymentId); targets.add(deployment.targetRef.id); deployments.push(deployment); previous=deployment.deploymentId;
  }
  return Object.freeze({schemaVersion:DEPLOYER_SCHEMA_VERSION,kind:DEPLOYER_STATE_KIND,deployments:Object.freeze(deployments)});
}
export function makeDeployerState(deployments) {
  if (!Array.isArray(deployments)) fail();
  const normalized=deployments.map((deployment)=>normalizeDeploymentRecord(deployment));
  normalized.sort((left,right)=>left.deploymentId.localeCompare(right.deploymentId));
  return normalizeDeployerState({schemaVersion:DEPLOYER_SCHEMA_VERSION,kind:DEPLOYER_STATE_KIND,deployments:normalized});
}
