import { isSecretRef } from "../../extension/pcms/secrets/secret-ref.js";
import {
  ACCOUNTS_PROVIDER_ID,
  normalizeAccountId,
  normalizeDisplayName,
  normalizePersonaUid
} from "../p014/schema.js";
import { PROVISIONING_ERROR_CODES, provisioningError } from "./errors.js";

export const PROVISIONING_SCHEMA_VERSION = 1;
export const PROVISIONING_KIND = "account-provisioning-attempt";
export const PROVISIONING_PROVIDER_ID = ACCOUNTS_PROVIDER_ID;
export const PROVISIONING_REMOTE_ACTION = "account.provision";
export const PROVISIONING_REMOTE_TARGET_KIND = "account";
export const PROVISIONING_MAX_ATTEMPTS = 1024;

export const PROVISIONING_STATES = Object.freeze({
  SESSION_REQUIRED: "SESSION_REQUIRED",
  SESSION_ACTIVE: "SESSION_ACTIVE",
  WAITING_HUMAN: "WAITING_HUMAN",
  READY_TO_PROVISION: "READY_TO_PROVISION",
  PROVISIONING: "PROVISIONING",
  RETRYABLE: "RETRYABLE",
  UNCERTAIN: "UNCERTAIN",
  FINALIZING: "FINALIZING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED"
});

export const PROVISIONING_HUMAN_REASONS = Object.freeze({
  CAPTCHA: "CAPTCHA",
  OPERATOR_ACTION: "OPERATOR_ACTION"
});

const STATE_SET = new Set(Object.values(PROVISIONING_STATES));
const HUMAN_REASON_SET = new Set(Object.values(PROVISIONING_HUMAN_REASONS));
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

function fail(code = PROVISIONING_ERROR_CODES.INVALID_ARGUMENT, options = {}) {
  throw provisioningError(code, options);
}

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value, names, code) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== names.length || !names.every((name) => Object.hasOwn(descriptors, name))) fail(code);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
  }
}

function mapAccountNormalizer(fn, value, code) {
  try { return fn(value); } catch { fail(code); }
}

export function normalizeAttemptId(value, code = PROVISIONING_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(code);
  return value;
}

export function normalizeTimestamp(value, code = PROVISIONING_ERROR_CODES.CORRUPT_STATE) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || Number.isNaN(Date.parse(value))) fail(code);
  return value;
}

export function normalizeProvisioningCreateInput(value) {
  exact(value, ["attemptId", "accountId", "displayName", "personaUid", "credentialRef"], PROVISIONING_ERROR_CODES.INVALID_ARGUMENT);
  if (!isSecretRef(value.credentialRef)) fail();
  return Object.freeze({
    attemptId: normalizeAttemptId(value.attemptId),
    accountId: mapAccountNormalizer(normalizeAccountId, value.accountId, PROVISIONING_ERROR_CODES.INVALID_ARGUMENT),
    displayName: mapAccountNormalizer(normalizeDisplayName, value.displayName, PROVISIONING_ERROR_CODES.INVALID_ARGUMENT),
    personaUid: mapAccountNormalizer(normalizePersonaUid, value.personaUid, PROVISIONING_ERROR_CODES.INVALID_ARGUMENT),
    credentialRef: value.credentialRef.toLowerCase()
  });
}

export function provisioningOperationId(attemptId, operationEpoch) {
  const id = normalizeAttemptId(attemptId);
  if (!Number.isSafeInteger(operationEpoch) || operationEpoch < 1) fail();
  return `p019:${id}:op:${operationEpoch}`;
}

export function provisioningIntentFingerprint(attemptId, operationEpoch) {
  const id = normalizeAttemptId(attemptId);
  if (!Number.isSafeInteger(operationEpoch) || operationEpoch < 1) fail();
  return `p019:account-provision:v1:${id}:${operationEpoch}`;
}

export function provisioningHumanTaskId(attemptId, humanTaskEpoch) {
  const id = normalizeAttemptId(attemptId);
  if (!Number.isSafeInteger(humanTaskEpoch) || humanTaskEpoch < 1) fail();
  return `p019:${id}:human:${humanTaskEpoch}`;
}

export function normalizeAttempt(value) {
  const code = PROVISIONING_ERROR_CODES.CORRUPT_STATE;
  exact(value, [
    "schemaVersion", "kind", "attemptId", "providerId", "accountId", "displayName", "personaUid", "credentialRef",
    "state", "sessionEpoch", "sessionKey", "sessionGeneration", "humanTaskEpoch", "humanTaskId", "humanReason",
    "operationEpoch", "remoteOperationId", "createdAt", "updatedAt", "completedAt"
  ], code);
  if (value.schemaVersion !== PROVISIONING_SCHEMA_VERSION || value.kind !== PROVISIONING_KIND || value.providerId !== PROVISIONING_PROVIDER_ID) fail(code);
  if (!STATE_SET.has(value.state)) fail(code);
  const attemptId = normalizeAttemptId(value.attemptId, code);
  const accountId = mapAccountNormalizer(normalizeAccountId, value.accountId, code);
  const displayName = mapAccountNormalizer(normalizeDisplayName, value.displayName, code);
  const personaUid = mapAccountNormalizer(normalizePersonaUid, value.personaUid, code);
  if (!isSecretRef(value.credentialRef)) fail(code);
  if (!Number.isSafeInteger(value.sessionEpoch) || value.sessionEpoch < 0) fail(code);
  if (!Number.isSafeInteger(value.humanTaskEpoch) || value.humanTaskEpoch < 0) fail(code);
  if (!Number.isSafeInteger(value.operationEpoch) || value.operationEpoch < 0) fail(code);
  if (value.sessionKey !== null && (typeof value.sessionKey !== "string" || !SESSION_KEY_PATTERN.test(value.sessionKey))) fail(code);
  if (value.sessionGeneration !== null && (!Number.isSafeInteger(value.sessionGeneration) || value.sessionGeneration < 1)) fail(code);
  if ((value.sessionKey === null) !== (value.sessionGeneration === null)) fail(code);
  if (value.humanTaskId !== null && typeof value.humanTaskId !== "string") fail(code);
  if (value.humanReason !== null && !HUMAN_REASON_SET.has(value.humanReason)) fail(code);
  if ((value.humanTaskId === null) !== (value.humanReason === null)) fail(code);
  if (value.humanTaskId !== null && value.humanTaskId !== provisioningHumanTaskId(attemptId, value.humanTaskEpoch)) fail(code);
  if (value.remoteOperationId !== null && value.remoteOperationId !== provisioningOperationId(attemptId, value.operationEpoch)) fail(code);
  if ((value.operationEpoch === 0) !== (value.remoteOperationId === null)) fail(code);
  normalizeTimestamp(value.createdAt, code); normalizeTimestamp(value.updatedAt, code);
  if (value.completedAt !== null) normalizeTimestamp(value.completedAt, code);

  const sessionRequired = new Set([
    PROVISIONING_STATES.SESSION_ACTIVE,
    PROVISIONING_STATES.WAITING_HUMAN,
    PROVISIONING_STATES.READY_TO_PROVISION,
    PROVISIONING_STATES.PROVISIONING,
    PROVISIONING_STATES.RETRYABLE
  ]);
  if (sessionRequired.has(value.state) && value.sessionKey === null) fail(code);
  if ([PROVISIONING_STATES.SESSION_REQUIRED, PROVISIONING_STATES.COMPLETED, PROVISIONING_STATES.CANCELLED].includes(value.state)
      && value.sessionKey !== null) fail(code);
  if (value.state === PROVISIONING_STATES.WAITING_HUMAN) {
    if (value.humanTaskId === null || value.humanTaskEpoch < 1) fail(code);
  } else if (value.humanTaskId !== null) fail(code);
  if ([PROVISIONING_STATES.PROVISIONING, PROVISIONING_STATES.RETRYABLE, PROVISIONING_STATES.UNCERTAIN, PROVISIONING_STATES.FINALIZING, PROVISIONING_STATES.COMPLETED].includes(value.state)
      && value.remoteOperationId === null) fail(code);
  if ([PROVISIONING_STATES.COMPLETED, PROVISIONING_STATES.CANCELLED].includes(value.state)) {
    if (value.completedAt === null) fail(code);
  } else if (value.completedAt !== null) fail(code);

  return Object.freeze({
    schemaVersion: PROVISIONING_SCHEMA_VERSION,
    kind: PROVISIONING_KIND,
    attemptId,
    providerId: PROVISIONING_PROVIDER_ID,
    accountId,
    displayName,
    personaUid,
    credentialRef: value.credentialRef.toLowerCase(),
    state: value.state,
    sessionEpoch: value.sessionEpoch,
    sessionKey: value.sessionKey,
    sessionGeneration: value.sessionGeneration,
    humanTaskEpoch: value.humanTaskEpoch,
    humanTaskId: value.humanTaskId,
    humanReason: value.humanReason,
    operationEpoch: value.operationEpoch,
    remoteOperationId: value.remoteOperationId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt
  });
}

export function newAttempt(input, now) {
  const draft = normalizeProvisioningCreateInput(input);
  const timestamp = normalizeTimestamp(now, PROVISIONING_ERROR_CODES.INVALID_ARGUMENT);
  return normalizeAttempt({
    schemaVersion: PROVISIONING_SCHEMA_VERSION,
    kind: PROVISIONING_KIND,
    ...draft,
    providerId: PROVISIONING_PROVIDER_ID,
    state: PROVISIONING_STATES.SESSION_REQUIRED,
    sessionEpoch: 0,
    sessionKey: null,
    sessionGeneration: null,
    humanTaskEpoch: 0,
    humanTaskId: null,
    humanReason: null,
    operationEpoch: 0,
    remoteOperationId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null
  });
}
