// MIG-P040-refresher-state-v2: mechanical, lossless v1 → v2.
//
// - cohort.name = cohortId; nextOrdinal = members.length + 1 (v1 ordinals are 1..n);
// - every v1 member keeps its pasted-source hash as a LEGACY_SOURCE member;
// - an unresolved v1 operation pins its v1-source intent (the member's sourceHash, which v1
//   fenced against change while unresolved), so its RemoteOperation id and intent fingerprint
//   ("refresh:<cohort>:<ordinal>:<sequence>", perchance:generator-source:v1:<hash>) stay linked;
// - resolved operations pin nothing (v1 did not record which hash they used).
//
// The migration is applied on read; the next Refresher write persists v2. `projectRefresherStateV1`
// is the exact inverse for migrated state and is what the lossless regression checks.
import { REFRESHER_ERROR_CODES, refresherError } from "./errors.js";
import {
  REFRESHER_COHORT_KIND,
  REFRESHER_MEMBER_KIND,
  REFRESHER_PROVIDER_ID,
  REFRESHER_SCHEMA_VERSION,
  REFRESHER_SCHEMA_VERSION_V1,
  REFRESHER_SOURCE_KIND,
  REFRESHER_STATE_KIND,
  REFRESH_RELEASE_KIND,
  REFRESH_UNRESOLVED_STATUSES,
  makeRefresherState,
  normalizeRefresherState,
  normalizeRefresherStateV1
} from "./schema.js";

export const REFRESHER_MIGRATION_ID = "MIG-P040-refresher-state-v2";

function migrateMember(member) {
  const unresolved = REFRESH_UNRESOLVED_STATUSES.has(member.operation.status);
  return {
    schemaVersion:REFRESHER_SCHEMA_VERSION,
    kind:REFRESHER_MEMBER_KIND,
    generatorId:member.generatorId,
    sourceKind:REFRESHER_SOURCE_KIND.LEGACY_SOURCE,
    sourceHash:member.sourceHash,
    ordinal:member.ordinal,
    lastConfirmedAt:member.lastConfirmedAt,
    confirmedCount:member.confirmedCount,
    operation:{...member.operation,release:unresolved?{payloadKind:REFRESH_RELEASE_KIND.V1_SOURCE,payloadHash:member.sourceHash,thumbnailHash:null,listing:null}:null},
    createdAt:member.createdAt,
    updatedAt:member.updatedAt
  };
}

export function migrateRefresherStateV1(raw) {
  const v1 = normalizeRefresherStateV1(raw);
  return makeRefresherState(v1.cohorts.map((cohort) => ({
    schemaVersion:REFRESHER_SCHEMA_VERSION,
    kind:REFRESHER_COHORT_KIND,
    cohortId:cohort.cohortId,
    name:cohort.cohortId,
    providerId:REFRESHER_PROVIDER_ID,
    accountId:cohort.accountId,
    enabled:cohort.enabled,
    policy:{...cohort.policy},
    nextOrdinal:cohort.members.length + 1,
    members:cohort.members.map(migrateMember),
    createdAt:cohort.createdAt,
    updatedAt:cohort.updatedAt
  })));
}

// Reads either version. Returns {value, migrated}.
export function readRefresherState(raw) {
  if (raw && typeof raw === "object" && raw.schemaVersion === REFRESHER_SCHEMA_VERSION_V1 && raw.kind === REFRESHER_STATE_KIND) {
    return Object.freeze({ value:migrateRefresherStateV1(raw), migrated:true });
  }
  return Object.freeze({ value:normalizeRefresherState(raw), migrated:false });
}

// Inverse for state whose cohorts hold only legacy members with dense ordinals.
export function projectRefresherStateV1(raw) {
  const v2 = normalizeRefresherState(raw);
  return Object.freeze({
    schemaVersion:REFRESHER_SCHEMA_VERSION_V1,
    kind:REFRESHER_STATE_KIND,
    cohorts:Object.freeze(v2.cohorts.map((cohort) => {
      if (cohort.name !== cohort.cohortId || cohort.members.length < 1 || cohort.nextOrdinal !== cohort.members.length + 1
          || cohort.members.some((member, index) => member.sourceKind !== REFRESHER_SOURCE_KIND.LEGACY_SOURCE || member.ordinal !== index + 1)) {
        throw refresherError(REFRESHER_ERROR_CODES.INVALID_TRANSITION);
      }
      return Object.freeze({
        schemaVersion:REFRESHER_SCHEMA_VERSION_V1,kind:REFRESHER_COHORT_KIND,cohortId:cohort.cohortId,providerId:cohort.providerId,
        accountId:cohort.accountId,enabled:cohort.enabled,policy:cohort.policy,
        members:Object.freeze(cohort.members.map((member) => {
          const { release, ...operation } = member.operation;
          return Object.freeze({
            schemaVersion:REFRESHER_SCHEMA_VERSION_V1,kind:REFRESHER_MEMBER_KIND,generatorId:member.generatorId,sourceHash:member.sourceHash,
            ordinal:member.ordinal,lastConfirmedAt:member.lastConfirmedAt,confirmedCount:member.confirmedCount,
            operation:Object.freeze(operation),createdAt:member.createdAt,updatedAt:member.updatedAt
          });
        })),
        createdAt:cohort.createdAt,updatedAt:cohort.updatedAt
      });
    }))
  });
}
