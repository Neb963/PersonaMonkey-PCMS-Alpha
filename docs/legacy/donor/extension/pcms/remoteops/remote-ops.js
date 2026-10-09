import { createPcmsStorageBroker } from "../storage/storage-broker.js";
import { REMOTE_OP_ERROR_CODES, remoteOpError } from "./errors.js";
import {
  REMOTE_OP_SCHEMA_VERSION,
  REMOTE_OP_STATES,
  REMOTE_OP_UNRESOLVED_STATES,
  normalizeRemoteOperationDraft,
  normalizeRemoteOperationRecord,
  normalizeTimestamp,
  remoteOperationKey,
  sameRemoteOperationIdentity
} from "./schema.js";

export const REMOTE_OP_NAMESPACE = "core.remoteops";

function fail(code, options = {}) { throw remoteOpError(code, options); }

function publicRecord(record, expectedOperationId = null) {
  if (!record) return null;
  const value = normalizeRemoteOperationRecord(record.value);
  if (record.key !== remoteOperationKey(value.operationId) || (expectedOperationId !== null && value.operationId !== expectedOperationId)) {
    fail(REMOTE_OP_ERROR_CODES.CORRUPT_STATE);
  }
  return Object.freeze({ key: record.key, revision: record.revision, updatedAt: record.updatedAt, value });
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(REMOTE_OP_ERROR_CODES.REVISION_CONFLICT);
  return value;
}

function mapCas(error) {
  if (error?.code === "PCMS_STORAGE_CAS_MISMATCH") {
    fail(REMOTE_OP_ERROR_CODES.REVISION_CONFLICT, { currentRevision: error.currentRevision });
  }
  throw error;
}

export function createRemoteOps({ storageBroker = createPcmsStorageBroker(), clock = () => new Date().toISOString() } = {}) {
  const store = storageBroker.namespace(REMOTE_OP_NAMESPACE);

  async function get(operationId) {
    const row = await store.get(remoteOperationKey(operationId));
    if (!row) return null;
    return publicRecord(row, operationId);
  }

  async function requireOperation(operationId) {
    const row = await get(operationId);
    if (!row) fail(REMOTE_OP_ERROR_CODES.NOT_FOUND);
    return row;
  }

  async function prepare(rawDraft) {
    const draft = normalizeRemoteOperationDraft(rawDraft);
    const key = remoteOperationKey(draft.operationId);
    const existing = await store.get(key);
    if (existing) {
      const normalized = publicRecord(existing);
      if (!sameRemoteOperationIdentity(normalized.value, draft)) fail(REMOTE_OP_ERROR_CODES.OPERATION_CONFLICT);
      return normalized;
    }
    const now = normalizeTimestamp(clock());
    const value = {
      schemaVersion: REMOTE_OP_SCHEMA_VERSION,
      kind: "remote-operation",
      ...draft,
      targetRef: { ...draft.targetRef },
      state: REMOTE_OP_STATES.PREPARED,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      lastDispatchAt: null,
      resolvedAt: null,
      resolution: null
    };
    try {
      return publicRecord(await store.compareAndSwap(key, { expectedRevision: 0, value }));
    } catch (error) {
      if (error?.code !== "PCMS_STORAGE_CAS_MISMATCH") throw error;
      const raced = await store.get(key);
      const normalized = publicRecord(raced);
      if (!normalized || !sameRemoteOperationIdentity(normalized.value, draft)) fail(REMOTE_OP_ERROR_CODES.OPERATION_CONFLICT);
      return normalized;
    }
  }

  async function transition(operationId, rawExpectedRevision, allowedStates, next) {
    const revision = expectedRevision(rawExpectedRevision);
    const current = await requireOperation(operationId);
    if (current.revision !== revision) fail(REMOTE_OP_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    if (!allowedStates.includes(current.value.state)) {
      if (current.value.state === REMOTE_OP_STATES.UNCERTAIN || current.value.state === REMOTE_OP_STATES.DISPATCHING) {
        fail(REMOTE_OP_ERROR_CODES.RECONCILE_REQUIRED);
      }
      fail(REMOTE_OP_ERROR_CODES.INVALID_TRANSITION);
    }
    const now = normalizeTimestamp(clock());
    const value = next(current.value, now);
    normalizeRemoteOperationRecord(value);
    try {
      return publicRecord(await store.compareAndSwap(current.key, { expectedRevision: revision, value }));
    } catch (error) { mapCas(error); }
  }

  async function beginDispatch(operationId, { expectedRevision: revision } = {}) {
    return transition(operationId, revision, [REMOTE_OP_STATES.PREPARED, REMOTE_OP_STATES.RETRYABLE], (value, now) => ({
      ...value,
      state: REMOTE_OP_STATES.DISPATCHING,
      attempt: value.attempt + 1,
      updatedAt: now,
      lastDispatchAt: now,
      resolvedAt: null,
      resolution: null
    }));
  }

  async function markSucceeded(operationId, { expectedRevision: revision } = {}) {
    return transition(operationId, revision, [REMOTE_OP_STATES.DISPATCHING], (value, now) => ({
      ...value, state: REMOTE_OP_STATES.SUCCEEDED, updatedAt: now, resolvedAt: now, resolution: "APPLIED"
    }));
  }

  async function markFailed(operationId, { expectedRevision: revision } = {}) {
    return transition(operationId, revision, [REMOTE_OP_STATES.DISPATCHING], (value, now) => ({
      ...value, state: REMOTE_OP_STATES.FAILED, updatedAt: now, resolvedAt: now, resolution: "NOT_APPLIED"
    }));
  }

  async function markUncertain(operationId, { expectedRevision: revision, resolution = "AMBIGUOUS" } = {}) {
    if (!new Set(["AMBIGUOUS", "INTERRUPTED"]).has(resolution)) fail(REMOTE_OP_ERROR_CODES.INVALID_OPERATION);
    return transition(operationId, revision, [REMOTE_OP_STATES.DISPATCHING], (value, now) => ({
      ...value, state: REMOTE_OP_STATES.UNCERTAIN, updatedAt: now, resolvedAt: null, resolution
    }));
  }

  async function reconcile(operationId, { expectedRevision: revision, outcome } = {}) {
    if (!["APPLIED", "NOT_APPLIED", "UNKNOWN"].includes(outcome)) fail(REMOTE_OP_ERROR_CODES.INVALID_OPERATION);
    return transition(operationId, revision, [REMOTE_OP_STATES.UNCERTAIN], (value, now) => {
      if (outcome === "APPLIED") return { ...value, state: REMOTE_OP_STATES.SUCCEEDED, updatedAt: now, resolvedAt: now, resolution: "RECONCILED_APPLIED" };
      if (outcome === "NOT_APPLIED") return { ...value, state: REMOTE_OP_STATES.RETRYABLE, updatedAt: now, resolvedAt: null, resolution: "RECONCILED_NOT_APPLIED" };
      return { ...value, state: REMOTE_OP_STATES.UNCERTAIN, updatedAt: now, resolvedAt: null, resolution: "RECONCILED_UNKNOWN" };
    });
  }

  async function cancel(operationId, { expectedRevision: revision } = {}) {
    return transition(operationId, revision, [REMOTE_OP_STATES.PREPARED, REMOTE_OP_STATES.RETRYABLE], (value, now) => ({
      ...value, state: REMOTE_OP_STATES.CANCELLED, updatedAt: now, resolvedAt: now, resolution: "CANCELLED"
    }));
  }

  async function list() {
    const rows = await store.list();
    return Object.freeze(rows.filter((row) => row.key.startsWith("operation:")).map((row) => publicRecord(row)).sort((a, b) => a.value.operationId.localeCompare(b.value.operationId)));
  }

  async function listUnresolved() {
    const rows = await list();
    const unresolved = new Set(REMOTE_OP_UNRESOLVED_STATES);
    return Object.freeze(rows.filter((row) => unresolved.has(row.value.state)));
  }

  async function recoverInterruptedDispatches() {
    const rows = await list();
    const recovered = [];
    for (const row of rows) {
      if (row.value.state !== REMOTE_OP_STATES.DISPATCHING) continue;
      try {
        const next = await markUncertain(row.value.operationId, { expectedRevision: row.revision, resolution: "INTERRUPTED" });
        recovered.push(next.value.operationId);
      } catch (error) {
        if (error?.code !== REMOTE_OP_ERROR_CODES.REVISION_CONFLICT) throw error;
      }
    }
    return Object.freeze(recovered.sort());
  }

  return Object.freeze({ prepare, get, list, listUnresolved, beginDispatch, markSucceeded, markFailed, markUncertain, reconcile, cancel, recoverInterruptedDispatches });
}
