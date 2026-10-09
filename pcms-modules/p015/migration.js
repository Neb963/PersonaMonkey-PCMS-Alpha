// MIG-P036-deployer-state-v2 (04 §E.7.1): mechanical, lossless v1 → v2.
//
// - desired.payloadKind = "v1-source", payloadHash = sourceHash, origin MANUAL, listing null;
// - confirmed = observed (+ baselineHash null); the confirming operationId is the current one
//   when the v1 record is SUCCEEDED (v1 did not record it otherwise, so it stays null);
// - policy.paused = false;
// - deploymentId, desired revision and operation sequence are unchanged, so every existing
//   RemoteOperation id ("deploy:<id>:<rev>:<seq>") and its v1 intent fingerprint stay linked.
//
// The migration is applied on read; the next Deployer write persists v2. `projectV1` is the
// exact inverse for v1-source records and is what the lossless regression checks.
import { DEPLOYER_ERROR_CODES, deployerError } from "./errors.js";
import {
  DEPLOYER_SCHEMA_VERSION,
  DEPLOYER_SCHEMA_VERSION_V1,
  DEPLOYER_STATE_KIND,
  DEPLOYMENT_OPERATION_STATUS,
  DEPLOYMENT_PAYLOAD_KINDS,
  EMPTY_CONFIRMED,
  makeDeployerState,
  normalizeDeployerState,
  normalizeDeployerStateV1,
  normalizeDeploymentRecord,
  normalizeDeploymentRecordV1
} from "./schema.js";

export const DEPLOYER_MIGRATION_ID = "MIG-P036-deployer-state-v2";

export function migrateDeploymentRecordV1(raw) {
  const v1 = normalizeDeploymentRecordV1(raw);
  const confirmed = v1.observed.sourceHash === null ? EMPTY_CONFIRMED : {
    payloadHash:v1.observed.sourceHash,
    thumbnailHash:null,
    listing:null,
    confirmedAt:v1.observed.confirmedAt,
    operationId:v1.operation.status === DEPLOYMENT_OPERATION_STATUS.SUCCEEDED ? v1.operation.operationId : null,
    baselineHash:null
  };
  return normalizeDeploymentRecord({
    schemaVersion:DEPLOYER_SCHEMA_VERSION,
    kind:v1.kind,
    deploymentId:v1.deploymentId,
    providerId:v1.providerId,
    accountId:v1.accountId,
    targetRef:{...v1.targetRef},
    desired:{revision:v1.desired.revision,payloadKind:DEPLOYMENT_PAYLOAD_KINDS.V1_SOURCE,payloadHash:v1.desired.sourceHash,
      thumbnailHash:null,listing:null,origin:{kind:"MANUAL"}},
    confirmed:{...confirmed},
    operation:{...v1.operation},
    policy:{paused:false,pauseReason:null},
    createdAt:v1.createdAt,
    updatedAt:v1.updatedAt
  });
}

export function migrateDeployerStateV1(raw) {
  const v1 = normalizeDeployerStateV1(raw);
  return makeDeployerState(v1.deployments.map(migrateDeploymentRecordV1));
}

// Reads either version. Returns {value, migrated}.
export function readDeployerState(raw) {
  if (raw && typeof raw === "object" && raw.schemaVersion === DEPLOYER_SCHEMA_VERSION_V1 && raw.kind === DEPLOYER_STATE_KIND) {
    return Object.freeze({ value:migrateDeployerStateV1(raw), migrated:true });
  }
  return Object.freeze({ value:normalizeDeployerState(raw), migrated:false });
}

// Inverse for v1-source records (the lossless check). A v2-release record has no v1 form.
export function projectDeploymentV1(record) {
  const v2 = normalizeDeploymentRecord(record);
  if (v2.desired.payloadKind !== DEPLOYMENT_PAYLOAD_KINDS.V1_SOURCE || v2.confirmed.listing !== null || v2.confirmed.thumbnailHash !== null) {
    throw deployerError(DEPLOYER_ERROR_CODES.INVALID_TRANSITION);
  }
  return Object.freeze({
    schemaVersion:DEPLOYER_SCHEMA_VERSION_V1,
    kind:v2.kind,
    deploymentId:v2.deploymentId,
    providerId:v2.providerId,
    accountId:v2.accountId,
    targetRef:v2.targetRef,
    desired:Object.freeze({revision:v2.desired.revision,sourceHash:v2.desired.payloadHash}),
    observed:Object.freeze({sourceHash:v2.confirmed.payloadHash,confirmedAt:v2.confirmed.confirmedAt}),
    operation:v2.operation,
    createdAt:v2.createdAt,
    updatedAt:v2.updatedAt
  });
}
