// Runtime-module schedules over the Core durable timer service (ADR-003 §5).
//
// A module schedule `name` is the Core timer `module.<moduleId>/<name>`, delivered by the
// module's scheduler service `module.<moduleId>.scheduler`. A module re-declares its next
// occurrence from inside onTimer, while the Core timer is still DISPATCHING. pcms.timers.ensure/v1
// refuses to move a DISPATCHING timer, so that declaration is kept here as a durable pending
// ensure and applied as soon as the timer leaves DISPATCHING (FIRED or MISSED).
import { assertModuleId } from "../../modules/package.js";

export const MODULE_SCHEDULE_NAMESPACE = "core.module-schedules";
export const MODULE_SCHEDULER_GENERATION = 0;

const SERVICE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const PENDING_PREFIX = "pending:";

export function assertModuleScheduleName(value) {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) throw new TypeError("Module schedule name is invalid");
  return value;
}

// null when the module id cannot name a Core service (a segment starting with a digit).
export function moduleSchedulerServiceName(moduleId) {
  const name = "module." + assertModuleId(moduleId) + ".scheduler";
  return name.length <= 128 && SERVICE_PATTERN.test(name) ? name : null;
}

export function moduleSchedulerOwnerId(moduleId) {
  return "module." + assertModuleId(moduleId);
}

export function moduleTimerPrefix(moduleId) {
  return "module." + assertModuleId(moduleId) + "/";
}

export function moduleTimerId(moduleId, name) {
  return moduleTimerPrefix(moduleId) + assertModuleScheduleName(name);
}

// { moduleId, name } for a Core timer id this module runtime owns, else null.
export function parseModuleTimerId(timerId) {
  if (typeof timerId !== "string" || !timerId.startsWith("module.")) return null;
  const slash = timerId.indexOf("/");
  if (slash < 0) return null;
  const moduleId = timerId.slice("module.".length, slash);
  const name = timerId.slice(slash + 1);
  try {
    assertModuleId(moduleId);
    assertModuleScheduleName(name);
  } catch {
    return null;
  }
  return Object.freeze({ moduleId, name });
}

function normalizePending(row) {
  const value = row?.value;
  if (!value || value.schemaVersion !== 1 || value.kind !== "module-timer-pending"
      || typeof value.timerId !== "string" || row.key !== PENDING_PREFIX + value.timerId
      || !parseModuleTimerId(value.timerId) || !Number.isFinite(Date.parse(value.dueAt))) return null;
  return Object.freeze({ revision: row.revision, timerId: value.timerId, dueAt: new Date(Date.parse(value.dueAt)).toISOString() });
}

export function createModuleScheduleStore({ storageBroker } = {}) {
  if (!storageBroker || typeof storageBroker.namespace !== "function") throw new TypeError("Module schedules require PCMS storage");
  const store = storageBroker.namespace(MODULE_SCHEDULE_NAMESPACE);

  async function getPending(timerId) {
    return normalizePending(await store.get(PENDING_PREFIX + timerId));
  }

  // Last declaration wins, like a repeated ensure after the occurrence completes.
  async function putPending(timerId, dueAt) {
    if (!parseModuleTimerId(timerId)) throw new TypeError("Module timer id is invalid");
    const due = new Date(Date.parse(dueAt)).toISOString();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await store.get(PENDING_PREFIX + timerId);
      try {
        await store.compareAndSwap(PENDING_PREFIX + timerId, {
          expectedRevision: current?.revision ?? 0,
          value: { schemaVersion: 1, kind: "module-timer-pending", timerId, dueAt: due }
        });
        return due;
      } catch (error) {
        if (error?.code !== "PCMS_STORAGE_CAS_MISMATCH") throw error;
      }
    }
    throw new Error("Module schedule pending declaration conflict");
  }

  async function deletePending(timerId, { revision = null } = {}) {
    const current = await store.get(PENDING_PREFIX + timerId);
    if (!current) return false;
    if (revision !== null && current.revision !== revision) return false;
    try {
      await store.deleteCompareAndSwap(PENDING_PREFIX + timerId, { expectedRevision: current.revision });
      return true;
    } catch {
      return false;
    }
  }

  async function listPending(moduleId = null) {
    const prefix = moduleId === null ? null : moduleTimerPrefix(moduleId);
    const out = [];
    for (const row of await store.list()) {
      const pending = normalizePending(row);
      if (pending && (prefix === null || pending.timerId.startsWith(prefix))) out.push(pending);
    }
    return Object.freeze(out.sort((a, b) => a.timerId.localeCompare(b.timerId)));
  }

  return Object.freeze({ getPending, putPending, deletePending, listPending });
}
