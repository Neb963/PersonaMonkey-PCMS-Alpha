import { createPcmsStorageBroker } from "../storage/storage-broker.js";
import { REMOTE_OP_ERROR_CODES, remoteOpError } from "./errors.js";

export const RECOVERY_NAMESPACE = "core.recovery";
export const RECOVERY_KEY = "hold";
export const RECOVERY_REQUIRED_CHECKS = Object.freeze(["moduleGenerations", "personaBindings", "providerCapabilities"]);

function fail(code, options = {}) { throw remoteOpError(code, options); }

function normalize(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(REMOTE_OP_ERROR_CODES.CORRUPT_STATE);
  const keys = Object.keys(value);
  const expected = ["schemaVersion", "kind", "state", "reason", "enteredAt", "releasedAt"];
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) fail(REMOTE_OP_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== 1 || value.kind !== "recovery-hold" || !["NORMAL", "RECOVERY_HOLD"].includes(value.state)) fail(REMOTE_OP_ERROR_CODES.CORRUPT_STATE);
  for (const key of ["enteredAt", "releasedAt"]) if (value[key] !== null && (typeof value[key] !== "string" || Number.isNaN(Date.parse(value[key])))) fail(REMOTE_OP_ERROR_CODES.CORRUPT_STATE);
  if (value.reason !== null && (typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 256)) fail(REMOTE_OP_ERROR_CODES.CORRUPT_STATE);
  if (value.state === "RECOVERY_HOLD" && value.enteredAt === null) fail(REMOTE_OP_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({ ...value });
}

function publicStatus(record) {
  if (!record) return Object.freeze({ revision: 0, value: Object.freeze({ schemaVersion:1, kind:"recovery-hold", state:"NORMAL", reason:null, enteredAt:null, releasedAt:null }) });
  return Object.freeze({ revision: record.revision, updatedAt: record.updatedAt, value: normalize(record.value) });
}

function validateChecks(checks) {
  if (checks === null || typeof checks !== "object" || Array.isArray(checks)) fail(REMOTE_OP_ERROR_CODES.RECOVERY_INCOMPLETE);
  const keys = Object.keys(checks);
  if (keys.length !== RECOVERY_REQUIRED_CHECKS.length || !RECOVERY_REQUIRED_CHECKS.every((key) => Object.hasOwn(checks, key) && checks[key] === true)) {
    fail(REMOTE_OP_ERROR_CODES.RECOVERY_INCOMPLETE);
  }
}

export function createRecoveryHoldController({ storageBroker = createPcmsStorageBroker(), remoteOps, clock = () => new Date().toISOString() } = {}) {
  if (!remoteOps || typeof remoteOps.listUnresolved !== "function" || typeof remoteOps.recoverInterruptedDispatches !== "function") {
    throw new TypeError("Recovery hold requires RemoteOps");
  }
  const store = storageBroker.namespace(RECOVERY_NAMESPACE);

  async function getStatus() { return publicStatus(await store.get(RECOVERY_KEY)); }

  async function enterRecoveryHold({ reason = "restore" } = {}) {
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 256) fail(REMOTE_OP_ERROR_CODES.INVALID_OPERATION);
    const current = await getStatus();
    let held = current;
    if (current.value.state !== "RECOVERY_HOLD") {
      const now = new Date(clock()).toISOString();
      try {
        held = publicStatus(await store.compareAndSwap(RECOVERY_KEY, {
          expectedRevision: current.revision,
          value: { schemaVersion:1, kind:"recovery-hold", state:"RECOVERY_HOLD", reason, enteredAt:now, releasedAt:null }
        }));
      } catch (error) {
        if (error?.code === "PCMS_STORAGE_CAS_MISMATCH") fail(REMOTE_OP_ERROR_CODES.REVISION_CONFLICT, { currentRevision:error.currentRevision });
        throw error;
      }
    }
    const recoveredOperationIds = await remoteOps.recoverInterruptedDispatches();
    return Object.freeze({ hold: held, recoveredOperationIds });
  }

  async function assertMutationAllowed() {
    const status = await getStatus();
    if (status.value.state === "RECOVERY_HOLD") fail(REMOTE_OP_ERROR_CODES.RECOVERY_HOLD);
    return status;
  }

  async function releaseRecoveryHold({ expectedRevision, checks } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail(REMOTE_OP_ERROR_CODES.REVISION_CONFLICT);
    validateChecks(checks);
    const current = await getStatus();
    if (current.revision !== expectedRevision) fail(REMOTE_OP_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    if (current.value.state !== "RECOVERY_HOLD") fail(REMOTE_OP_ERROR_CODES.INVALID_TRANSITION);
    const unresolved = await remoteOps.listUnresolved();
    if (unresolved.length) fail(REMOTE_OP_ERROR_CODES.RECOVERY_INCOMPLETE);
    const now = new Date(clock()).toISOString();
    try {
      return publicStatus(await store.compareAndSwap(RECOVERY_KEY, {
        expectedRevision,
        value: { ...current.value, state:"NORMAL", reason:null, releasedAt:now }
      }));
    } catch (error) {
      if (error?.code === "PCMS_STORAGE_CAS_MISMATCH") fail(REMOTE_OP_ERROR_CODES.REVISION_CONFLICT, { currentRevision:error.currentRevision });
      throw error;
    }
  }

  return Object.freeze({ getStatus, enterRecoveryHold, assertMutationAllowed, releaseRecoveryHold });
}
