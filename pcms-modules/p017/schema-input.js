import {
  PERCHANCE_GENERATOR_TARGET_KIND,
  PERCHANCE_PROVIDER_ID
} from "../../extension/pcms/providers/perchance/contract.js";
import { REFRESHER_ERROR_CODES, refresherError } from "./errors.js";

export const REFRESHER_SCHEMA_VERSION = 2;
export const REFRESHER_SCHEMA_VERSION_V1 = 1;
export const REFRESHER_PROVIDER_ID = PERCHANCE_PROVIDER_ID;
export const REFRESHER_TARGET_KIND = PERCHANCE_GENERATOR_TARGET_KIND;
export const REFRESHER_STATE_KIND = "refresher-state";
export const REFRESHER_COHORT_KIND = "refresher-cohort";
export const REFRESHER_MEMBER_KIND = "refresher-member";
export const REFRESHER_MAX_COHORTS = 1024;
export const REFRESHER_MAX_MEMBERS = 8192;
export const REFRESHER_MAX_DAILY_BUDGET = 8192;

export const REFRESHER_MODE = Object.freeze({
  AUTO_RECENT: "AUTO_RECENT",
  MANUAL: "MANUAL"
});
// Where a member's refresh content comes from (MIG-P040-refresher-state-v2).
export const REFRESHER_SOURCE_KIND = Object.freeze({
  DEPLOYER_CONFIRMED: "DEPLOYER_CONFIRMED",
  LEGACY_SOURCE: "LEGACY_SOURCE"
});
export const REFRESH_RELEASE_KIND = Object.freeze({ V1_SOURCE: "v1-source", V2_RELEASE: "v2-release" });
export const REFRESH_OPERATION_STATUS = Object.freeze({
  IDLE: "IDLE",
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  RECONCILE: "RECONCILE",
  RETRYABLE: "RETRYABLE",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  SUCCEEDED: "SUCCEEDED"
});

const ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const COHORT_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/;
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const MODE_SET=new Set(Object.values(REFRESHER_MODE));
export const REFRESH_OPERATION_STATUS_SET=new Set(Object.values(REFRESH_OPERATION_STATUS));
export const REFRESH_UNRESOLVED_STATUSES=new Set([
  REFRESH_OPERATION_STATUS.PENDING,
  REFRESH_OPERATION_STATUS.ACTIVE,
  REFRESH_OPERATION_STATUS.RECONCILE,
  REFRESH_OPERATION_STATUS.RETRYABLE
]);

export function fail(code=REFRESHER_ERROR_CODES.INVALID_ARGUMENT){ throw refresherError(code); }
export function plain(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const proto=Object.getPrototypeOf(value);return proto===Object.prototype||proto===null;
}
export function exact(value,names,code){
  if(!plain(value)||Object.getOwnPropertySymbols(value).length)fail(code);
  const d=Object.getOwnPropertyDescriptors(value);const keys=Object.keys(d);
  if(keys.length!==names.length||!names.every(name=>Object.hasOwn(d,name)))fail(code);
  for(const x of Object.values(d))if(!x.enumerable||!Object.hasOwn(x,"value"))fail(code);
}
export function denseArray(value,code){
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||Object.getOwnPropertySymbols(value).length)fail(code);
  const d=Object.getOwnPropertyDescriptors(value);
  for(let i=0;i<value.length;i+=1){const x=d[String(i)];if(!x||!x.enumerable||!Object.hasOwn(x,"value"))fail(code);}
  const allowed=new Set(["length",...Array.from({length:value.length},(_,i)=>String(i))]);
  if(Object.keys(d).some(k=>!allowed.has(k)))fail(code);
}
function boundedId(value,pattern=ID_PATTERN,code=REFRESHER_ERROR_CODES.INVALID_ARGUMENT){
  if(typeof value!=="string"||!pattern.test(value))fail(code);return value;
}
export function normalizeCohortId(value,code=REFRESHER_ERROR_CODES.INVALID_ARGUMENT){return boundedId(value,COHORT_ID_PATTERN,code);}
export function normalizeAccountId(value,code=REFRESHER_ERROR_CODES.INVALID_ARGUMENT){return boundedId(value,ID_PATTERN,code);}
export function normalizeGeneratorId(value,code=REFRESHER_ERROR_CODES.INVALID_ARGUMENT){return boundedId(value,ID_PATTERN,code);}
export function normalizeSourceHash(value,code=REFRESHER_ERROR_CODES.INVALID_ARGUMENT){if(typeof value!=="string"||!SHA256_PATTERN.test(value))fail(code);return value;}
export function normalizeTimestamp(value,code=REFRESHER_ERROR_CODES.CORRUPT_STATE){
  if(typeof value!=="string"||value.length<1||value.length>64||Number.isNaN(Date.parse(value)))fail(code);
  return new Date(value).toISOString();
}
export function operationIdFor(cohortId,ordinal,sequence){
  const id=normalizeCohortId(cohortId);
  if(!Number.isSafeInteger(ordinal)||ordinal<1||ordinal>REFRESHER_MAX_MEMBERS||!Number.isSafeInteger(sequence)||sequence<1)fail();
  const operationId="refresh:"+id+":"+ordinal+":"+sequence;
  if(!ID_PATTERN.test(operationId))fail();return operationId;
}
export function normalizePolicy(value,code=REFRESHER_ERROR_CODES.INVALID_ARGUMENT){
  exact(value,["mode","dailyBudget","dayOffsetMinutes","activeHours","sleepDays","anchorAt"],code);
  if(!MODE_SET.has(value.mode)
      ||!Number.isSafeInteger(value.dailyBudget)||value.dailyBudget<1||value.dailyBudget>REFRESHER_MAX_DAILY_BUDGET
      ||!Number.isSafeInteger(value.dayOffsetMinutes)||value.dayOffsetMinutes<0||value.dayOffsetMinutes>1439
      ||!Number.isSafeInteger(value.activeHours)||value.activeHours<1||value.activeHours>24
      ||!Number.isSafeInteger(value.sleepDays)||value.sleepDays<0||value.sleepDays>365)fail(code);
  return Object.freeze({
    mode:value.mode,dailyBudget:value.dailyBudget,dayOffsetMinutes:value.dayOffsetMinutes,
    activeHours:value.activeHours,sleepDays:value.sleepDays,anchorAt:normalizeTimestamp(value.anchorAt,code)
  });
}
// A member either follows the Deployer's confirmed release (P040, the normal case) or keeps an
// accepted P017 legacy source hash that only the service API (never the UI) can still supply.
function normalizeMemberInput(value){
  if(plain(value)&&Object.keys(value).length===1){
    exact(value,["generatorId"],REFRESHER_ERROR_CODES.INVALID_ARGUMENT);
    return Object.freeze({generatorId:normalizeGeneratorId(value.generatorId),sourceHash:null});
  }
  exact(value,["generatorId","sourceHash"],REFRESHER_ERROR_CODES.INVALID_ARGUMENT);
  return Object.freeze({generatorId:normalizeGeneratorId(value.generatorId),sourceHash:normalizeSourceHash(value.sourceHash)});
}
export const REFRESHER_MAX_NAME=80;
export function normalizeCohortName(value,code=REFRESHER_ERROR_CODES.INVALID_ARGUMENT){
  if(typeof value!=="string"||value.length<1||value.length>REFRESHER_MAX_NAME||value.trim()!==value||/[\u0000-\u001f\u007f]/.test(value))fail(code);
  return value;
}
export function normalizeCohortCreateInput(value){
  const named=plain(value)&&Object.hasOwn(value,"name");
  exact(value,named?["cohortId","name","accountId","enabled","policy","members"]:["cohortId","accountId","enabled","policy","members"],REFRESHER_ERROR_CODES.INVALID_ARGUMENT);
  if(typeof value.enabled!=="boolean")fail();
  denseArray(value.members,REFRESHER_ERROR_CODES.INVALID_ARGUMENT);
  if(value.members.length<1||value.members.length>REFRESHER_MAX_MEMBERS)fail();
  const members=value.members.map(normalizeMemberInput);const ids=new Set();
  for(const member of members){if(ids.has(member.generatorId))fail(REFRESHER_ERROR_CODES.TARGET_CONFLICT);ids.add(member.generatorId);}
  const cohortId=normalizeCohortId(value.cohortId);
  return Object.freeze({
    cohortId,name:named?normalizeCohortName(value.name):cohortId,accountId:normalizeAccountId(value.accountId),enabled:value.enabled,
    policy:normalizePolicy(value.policy),members:Object.freeze(members)
  });
}
