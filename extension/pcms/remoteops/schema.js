import { REMOTE_OP_ERROR_CODES, remoteOpError } from "./errors.js";

export const REMOTE_OP_SCHEMA_VERSION = 1;
export const REMOTE_OP_STATES = Object.freeze({
  PREPARED: "PREPARED",
  DISPATCHING: "DISPATCHING",
  UNCERTAIN: "UNCERTAIN",
  RETRYABLE: "RETRYABLE",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED"
});

export const REMOTE_OP_UNRESOLVED_STATES = Object.freeze([
  REMOTE_OP_STATES.PREPARED,
  REMOTE_OP_STATES.DISPATCHING,
  REMOTE_OP_STATES.UNCERTAIN,
  REMOTE_OP_STATES.RETRYABLE
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:=+/-]{0,255}$/;
const STATE_SET = new Set(Object.values(REMOTE_OP_STATES));
const RESOLUTIONS = new Set([
  null,
  "APPLIED",
  "NOT_APPLIED",
  "AMBIGUOUS",
  "INTERRUPTED",
  "RECONCILED_APPLIED",
  "RECONCILED_NOT_APPLIED",
  "RECONCILED_UNKNOWN",
  "CANCELLED"
]);

function fail() {
  throw remoteOpError(REMOTE_OP_ERROR_CODES.INVALID_OPERATION);
}

function corrupt() {
  throw remoteOpError(REMOTE_OP_ERROR_CODES.CORRUPT_STATE);
}

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value, keys, onError) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) onError();
}

function boundedId(value, onError = fail) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) onError();
  return value;
}

function timestamp(value, onError = corrupt) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || Number.isNaN(Date.parse(value))) onError();
  return value;
}

export function normalizeRemoteTargetRef(value, onError = fail) {
  if (!plain(value)) onError();
  exactKeys(value, ["kind", "id"], onError);
  return Object.freeze({ kind: boundedId(value.kind, onError), id: boundedId(value.id, onError) });
}

export function normalizeRemoteOperationDraft(value) {
  if (!plain(value)) fail();
  exactKeys(value, ["operationId", "providerId", "action", "targetRef", "intentFingerprint"], fail);
  if (typeof value.intentFingerprint !== "string" || !FINGERPRINT_PATTERN.test(value.intentFingerprint)) fail();
  return Object.freeze({
    operationId: boundedId(value.operationId),
    providerId: boundedId(value.providerId),
    action: boundedId(value.action),
    targetRef: normalizeRemoteTargetRef(value.targetRef),
    intentFingerprint: value.intentFingerprint
  });
}

export function normalizeRemoteOperationRecord(value) {
  if (!plain(value)) corrupt();
  exactKeys(value, [
    "schemaVersion", "kind", "operationId", "providerId", "action", "targetRef", "intentFingerprint",
    "state", "attempt", "createdAt", "updatedAt", "lastDispatchAt", "resolvedAt", "resolution"
  ], corrupt);
  if (value.schemaVersion !== REMOTE_OP_SCHEMA_VERSION || value.kind !== "remote-operation") corrupt();
  if (!STATE_SET.has(value.state) || !Number.isSafeInteger(value.attempt) || value.attempt < 0) corrupt();
  if (!RESOLUTIONS.has(value.resolution)) corrupt();
  if (value.lastDispatchAt !== null) timestamp(value.lastDispatchAt);
  if (value.resolvedAt !== null) timestamp(value.resolvedAt);
  const record = {
    schemaVersion: REMOTE_OP_SCHEMA_VERSION,
    kind: "remote-operation",
    operationId: boundedId(value.operationId, corrupt),
    providerId: boundedId(value.providerId, corrupt),
    action: boundedId(value.action, corrupt),
    targetRef: normalizeRemoteTargetRef(value.targetRef, corrupt),
    intentFingerprint: typeof value.intentFingerprint === "string" && FINGERPRINT_PATTERN.test(value.intentFingerprint)
      ? value.intentFingerprint
      : (() => { corrupt(); })(),
    state: value.state,
    attempt: value.attempt,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    lastDispatchAt: value.lastDispatchAt,
    resolvedAt: value.resolvedAt,
    resolution: value.resolution
  };
  if (record.state === REMOTE_OP_STATES.PREPARED && (record.attempt !== 0 || record.lastDispatchAt !== null || record.resolvedAt !== null || record.resolution !== null)) corrupt();
  if (record.state === REMOTE_OP_STATES.DISPATCHING && (record.attempt < 1 || record.lastDispatchAt === null || record.resolvedAt !== null || record.resolution !== null)) corrupt();
  if (record.state === REMOTE_OP_STATES.UNCERTAIN && (record.attempt < 1 || record.resolvedAt !== null || !["AMBIGUOUS", "INTERRUPTED", "RECONCILED_UNKNOWN"].includes(record.resolution))) corrupt();
  if (record.state === REMOTE_OP_STATES.RETRYABLE && (record.attempt < 1 || record.resolvedAt !== null || record.resolution !== "RECONCILED_NOT_APPLIED")) corrupt();
  if (record.state === REMOTE_OP_STATES.SUCCEEDED && (record.resolvedAt === null || !["APPLIED", "RECONCILED_APPLIED"].includes(record.resolution))) corrupt();
  if (record.state === REMOTE_OP_STATES.FAILED && (record.resolvedAt === null || record.resolution !== "NOT_APPLIED")) corrupt();
  if (record.state === REMOTE_OP_STATES.CANCELLED && (record.resolvedAt === null || record.resolution !== "CANCELLED")) corrupt();
  return Object.freeze(record);
}

export function sameRemoteOperationIdentity(record, draft) {
  return record.operationId === draft.operationId
    && record.providerId === draft.providerId
    && record.action === draft.action
    && record.targetRef.kind === draft.targetRef.kind
    && record.targetRef.id === draft.targetRef.id
    && record.intentFingerprint === draft.intentFingerprint;
}

export function remoteOperationKey(operationId) {
  return "operation:" + boundedId(operationId);
}

export function normalizeTimestamp(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || Number.isNaN(Date.parse(value))) fail();
  return value;
}
