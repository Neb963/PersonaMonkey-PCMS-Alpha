// pcms.module-capabilities/v1 — the bounded, PCMS-owned capability set v1 (ADR-003 §4).
//
// A runtime module reaches PCMS only through these handlers, and only for the names its
// admitted package authority grants (the runtime broker exposes nothing else). Every
// handler receives the runtime's frozen context { moduleId, generation, packageHash,
// assertCurrent }; the broker re-checks the generation before and after the call, so a
// fenced generation cannot read, write, schedule or dispatch. Handlers scope everything
// to the calling module: its own storage namespace, timers, HumanTasks and audit subject.
//
// Business outcomes the module must branch on (a storage CAS conflict, an open-task limit)
// are returned as { ok:false, code }. Invalid or out-of-bounds requests throw; the sandbox
// protocol reports those to the module only as a capability failure.
import { HUMAN_TASK_NAMESPACE, HUMAN_TASK_PRIORITIES, HUMAN_TASK_STATES } from "../../services/human-tasks.js";
import { TIMER_STATES } from "../../services/timers.js";
import { assertModuleId } from "../../modules/package.js";
import {
  PERCHANCE_GENERATOR_TARGET_KIND,
  PERCHANCE_GENERATOR_UPDATE_ACTION,
  PERCHANCE_PROVIDER_ID,
  generatorSourceFingerprint,
  sha256Hex
} from "../../providers/perchance/contract.js";
import {
  MODULE_SCHEDULER_GENERATION,
  assertModuleScheduleName,
  moduleSchedulerOwnerId,
  moduleSchedulerServiceName,
  moduleTimerId,
  moduleTimerPrefix,
  parseModuleTimerId
} from "./schedules.js";

export const PCMS_MODULE_CAPABILITIES_CONTRACT = "pcms.module-capabilities/v1";

export const MODULE_CAPABILITY_LIMITS = Object.freeze({
  storageKeyBytes: 256,
  storageValueBytes: 32 * 1024,
  storageKeys: 4096,
  timers: 32,
  timerMinDelayMs: 60 * 1000,
  timerMaxDelayMs: 7 * 24 * 60 * 60 * 1000,
  attentionOpen: 200,
  auditEventBytes: 4 * 1024,
  readPage: 100
});

export const MODULE_CAPABILITY_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_MODULE_CAPABILITY_INVALID_ARGUMENT",
  LIMIT: "PCMS_MODULE_CAPABILITY_LIMIT",
  CONFLICT: "PCMS_MODULE_CAPABILITY_CONFLICT",
  NOT_FOUND: "PCMS_MODULE_CAPABILITY_NOT_FOUND",
  RECOVERY_HOLD: "PCMS_MODULE_CAPABILITY_RECOVERY_HOLD",
  UNAVAILABLE: "PCMS_MODULE_CAPABILITY_UNAVAILABLE"
});

export class ModuleCapabilityError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "ModuleCapabilityError";
    this.code = code;
  }
}

const E = MODULE_CAPABILITY_ERROR_CODES;
const L = MODULE_CAPABILITY_LIMITS;
const TEXT_ENCODER = new TextEncoder();
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const ATTENTION_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const AUDIT_TYPE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const RESOLUTION_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const SECRET_KEY_PATTERN = /secret|passw|token|cookie|credential|api[-_]?key|authori[sz]ation|session|private[-_]?key/i;
const REDACTED = "[REDACTED]";

function fail(code, message) { throw new ModuleCapabilityError(code, message); }
function invalid(message) { fail(E.INVALID_ARGUMENT, message); }

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function args(value, allowed, label) {
  const input = value === null || value === undefined ? {} : value;
  if (!plain(input)) invalid(label + " arguments must be an object");
  for (const key of Object.keys(input)) if (!allowed.includes(key)) invalid(label + " has unexpected argument " + key);
  return input;
}

function bytes(value) {
  return TEXT_ENCODER.encode(value).byteLength;
}

function jsonBytes(value) {
  let text;
  try { text = JSON.stringify(value); } catch { invalid("Value must be JSON data"); }
  if (text === undefined) invalid("Value must be JSON data");
  return bytes(text);
}

function revisionArg(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid("expectedRevision must be a non-negative integer");
  return value;
}

function pageArgs(input) {
  const limit = input.limit ?? L.readPage;
  const cursor = input.cursor ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > L.readPage) invalid("limit is out of bounds");
  if (!Number.isSafeInteger(cursor) || cursor < 0) invalid("cursor is invalid");
  return { limit, cursor };
}

function page(items, { limit, cursor }) {
  const slice = items.slice(cursor, cursor + limit);
  return Object.freeze({
    items: Object.freeze(slice),
    nextCursor: cursor + slice.length < items.length ? cursor + slice.length : null
  });
}

// Keys that name secrets lose their values before anything is journaled (AGENTS §8).
export function redactModuleAuditData(value, depth = 0) {
  if (depth > 16) invalid("Audit data is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("Audit data must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactModuleAuditData(item, depth + 1));
  if (!plain(value)) invalid("Audit data must be plain JSON");
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") invalid("Audit data has an unsafe key");
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactModuleAuditData(item, depth + 1);
  }
  return out;
}

function moduleDataNamespace(moduleId) {
  return "module." + assertModuleId(moduleId) + ".data";
}

export function createModuleCapabilityHandlers({ resolve } = {}) {
  if (typeof resolve !== "function") throw new TypeError("Module capabilities require a dependency resolver");

  // Late-bound: the runtime broker is built before the services it fronts.
  function deps() {
    const value = resolve();
    if (!value || typeof value !== "object") fail(E.UNAVAILABLE, "Module capability services are unavailable");
    return value;
  }

  async function assertMutationAllowed() {
    const { recoveryHold } = deps();
    const status = await recoveryHold?.getStatus?.();
    if (status?.value?.state === "RECOVERY_HOLD") fail(E.RECOVERY_HOLD, "Recovery hold blocks module mutations");
  }

  function now() {
    const parsed = Date.parse(deps().clock());
    if (!Number.isFinite(parsed)) fail(E.UNAVAILABLE, "Clock is unavailable");
    return parsed;
  }

  function storageKey(value) {
    if (typeof value !== "string" || !KEY_PATTERN.test(value) || bytes(value) > L.storageKeyBytes) invalid("Storage key is invalid");
    return value;
  }

  function moduleStore(moduleId) {
    return deps().storageBroker.namespace(moduleDataNamespace(moduleId));
  }

  async function moduleTimers(timers, moduleId) {
    const prefix = moduleTimerPrefix(moduleId);
    return (await timers.list()).filter((row) => row.value.timerId.startsWith(prefix));
  }

  function timerView(row) {
    const parsed = parseModuleTimerId(row.value.timerId);
    return Object.freeze({
      name: parsed.name,
      state: row.value.state,
      dueAt: row.value.dueAt,
      completedAt: row.value.completedAt,
      missedReason: row.value.missedReason
    });
  }

  async function openModuleTaskCount(storageBroker, prefix) {
    let count = 0;
    for (const row of await storageBroker.namespace(HUMAN_TASK_NAMESPACE).list()) {
      if (typeof row.key === "string" && row.key.startsWith(prefix) && row.value?.state === HUMAN_TASK_STATES.OPEN) count += 1;
    }
    return count;
  }

  const handlers = {
    async "module.storage.read"(raw, context) {
      const input = args(raw, ["key"], "module.storage.read");
      const row = await moduleStore(context.moduleId).get(storageKey(input.key));
      return Object.freeze({ key: input.key, revision: row?.revision ?? 0, value: row ? row.value : null });
    },

    async "module.storage.write"(raw, context) {
      const input = args(raw, ["key", "value", "expectedRevision", "delete"], "module.storage.write");
      const key = storageKey(input.key);
      const expectedRevision = revisionArg(input.expectedRevision);
      const remove = input.delete === true;
      if (input.delete !== undefined && typeof input.delete !== "boolean") invalid("delete must be boolean");
      if (remove && Object.hasOwn(input, "value")) invalid("A delete takes no value");
      if (!remove && !Object.hasOwn(input, "value")) invalid("value is required");
      if (!remove && jsonBytes(input.value) > L.storageValueBytes) fail(E.LIMIT, "Storage value exceeds 32 KiB");
      await assertMutationAllowed();
      const store = moduleStore(context.moduleId);
      const current = await store.get(key);
      if ((current?.revision ?? 0) !== expectedRevision) {
        return Object.freeze({ ok: false, code: E.CONFLICT, currentRevision: current?.revision ?? 0 });
      }
      if (remove) {
        if (!current) return Object.freeze({ ok: true, key, revision: 0 });
        await context.assertCurrent();
        try {
          await store.deleteCompareAndSwap(key, { expectedRevision });
        } catch (error) {
          if (error?.code === "PCMS_STORAGE_CAS_MISMATCH") return Object.freeze({ ok: false, code: E.CONFLICT, currentRevision: error.currentRevision ?? null });
          throw error;
        }
        return Object.freeze({ ok: true, key, revision: 0 });
      }
      if (!current && (await store.list()).length >= L.storageKeys) {
        return Object.freeze({ ok: false, code: E.LIMIT, currentRevision: 0 });
      }
      await context.assertCurrent();
      try {
        const saved = await store.compareAndSwap(key, { expectedRevision, value: input.value });
        return Object.freeze({ ok: true, key, revision: saved.revision });
      } catch (error) {
        if (error?.code === "PCMS_STORAGE_CAS_MISMATCH") return Object.freeze({ ok: false, code: E.CONFLICT, currentRevision: error.currentRevision ?? null });
        throw error;
      }
    },

    async "module.timers.ensure"(raw, context) {
      const input = args(raw, ["name", "delayMs"], "module.timers.ensure");
      const name = (() => { try { return assertModuleScheduleName(input.name); } catch { return invalid("Timer name is invalid"); } })();
      if (!Number.isSafeInteger(input.delayMs) || input.delayMs < L.timerMinDelayMs || input.delayMs > L.timerMaxDelayMs) {
        invalid("delayMs must be between 1 minute and 7 days");
      }
      const serviceName = moduleSchedulerServiceName(context.moduleId);
      if (!serviceName) fail(E.UNAVAILABLE, "This module id cannot own Core timers");
      await assertMutationAllowed();
      const { timers, schedules } = deps();
      const timerId = moduleTimerId(context.moduleId, name);
      const active = (await moduleTimers(timers, context.moduleId)).filter((row) =>
        row.value.timerId !== timerId
        && (row.value.state === TIMER_STATES.SCHEDULED || row.value.state === TIMER_STATES.DISPATCHING));
      if (active.length >= L.timers) return Object.freeze({ ok: false, code: E.LIMIT });
      let dueAt = new Date(now() + input.delayMs).toISOString();
      await context.assertCurrent();
      const current = await timers.get(timerId);
      if (current && current.value.dueAt === dueAt
          && (current.value.state === TIMER_STATES.CANCELLED || current.value.state === TIMER_STATES.FIRED)) {
        // pcms.timers.ensure/v1 treats an equal dueAt as the occurrence already settled; a
        // declaration made after a cancel or fire in the same millisecond is a new occurrence.
        dueAt = new Date(Date.parse(dueAt) + 1).toISOString();
      }
      if (current?.value?.state === TIMER_STATES.DISPATCHING) {
        // The occurrence being delivered right now: apply after it completes.
        await schedules.putPending(timerId, dueAt);
        return Object.freeze({ ok: true, name, state: "PENDING", dueAt });
      }
      const row = await timers.ensure({
        name: timerId,
        serviceName,
        ownerId: moduleSchedulerOwnerId(context.moduleId),
        generation: MODULE_SCHEDULER_GENERATION,
        dueAt
      });
      return Object.freeze({ ok: true, name, state: row.value.state, dueAt: row.value.dueAt });
    },

    async "module.timers.cancel"(raw, context) {
      const input = args(raw, ["name"], "module.timers.cancel");
      const name = (() => { try { return assertModuleScheduleName(input.name); } catch { return invalid("Timer name is invalid"); } })();
      await assertMutationAllowed();
      const { timers, schedules } = deps();
      const timerId = moduleTimerId(context.moduleId, name);
      await context.assertCurrent();
      const pendingRemoved = await schedules.deletePending(timerId);
      const current = await timers.get(timerId);
      if (current?.value?.state !== TIMER_STATES.SCHEDULED) return Object.freeze({ ok: true, name, cancelled: pendingRemoved });
      await timers.cancel(timerId, { expectedRevision: current.revision });
      return Object.freeze({ ok: true, name, cancelled: true });
    },

    async "module.timers.list"(raw, context) {
      args(raw, [], "module.timers.list");
      const rows = await moduleTimers(deps().timers, context.moduleId);
      return Object.freeze({ timers: Object.freeze(rows.map(timerView)) });
    },

    async "module.attention.open"(raw, context) {
      const input = args(raw, ["key", "title", "instructions", "priority", "subjectRef"], "module.attention.open");
      if (typeof input.key !== "string" || !ATTENTION_KEY_PATTERN.test(input.key)) invalid("Attention key is invalid");
      if (input.priority !== undefined && !Object.hasOwn(HUMAN_TASK_PRIORITIES, input.priority)) invalid("Attention priority is invalid");
      await assertMutationAllowed();
      const { humanTasks, storageBroker } = deps();
      const prefix = "module:" + context.moduleId + "/";
      const taskId = prefix + input.key;
      const existing = await humanTasks.get(taskId);
      if (existing?.value?.state === HUMAN_TASK_STATES.OPEN) {
        return Object.freeze({ ok: true, key: input.key, state: HUMAN_TASK_STATES.OPEN, created: false });
      }
      if (existing) return Object.freeze({ ok: false, code: E.CONFLICT, state: existing.value.state });
      if (await openModuleTaskCount(storageBroker, prefix) >= L.attentionOpen) return Object.freeze({ ok: false, code: E.LIMIT });
      await context.assertCurrent();
      try {
        const opened = await humanTasks.open({
          taskId,
          taskKind: "module.attention",
          title: input.title,
          instructions: input.instructions ?? "",
          priority: input.priority ?? HUMAN_TASK_PRIORITIES.NORMAL,
          subjectRef: input.subjectRef ?? { kind: "module", id: context.moduleId }
        });
        return Object.freeze({ ok: true, key: input.key, state: opened.value.state, created: true });
      } catch (error) {
        if (error?.code === "PCMS_CORE_SERVICE_INVALID_ARGUMENT") invalid("Attention task is invalid");
        throw error;
      }
    },

    async "module.attention.settle"(raw, context) {
      const input = args(raw, ["key", "outcome", "resolutionCode"], "module.attention.settle");
      if (typeof input.key !== "string" || !ATTENTION_KEY_PATTERN.test(input.key)) invalid("Attention key is invalid");
      if (input.outcome !== "resolved" && input.outcome !== "cancelled") invalid("outcome must be resolved or cancelled");
      if (input.resolutionCode !== undefined && (typeof input.resolutionCode !== "string" || !RESOLUTION_PATTERN.test(input.resolutionCode))) {
        invalid("resolutionCode is invalid");
      }
      await assertMutationAllowed();
      const { humanTasks } = deps();
      const taskId = "module:" + context.moduleId + "/" + input.key;
      const current = await humanTasks.get(taskId);
      if (!current) return Object.freeze({ ok: false, code: E.NOT_FOUND });
      if (current.value.state !== HUMAN_TASK_STATES.OPEN) return Object.freeze({ ok: true, key: input.key, state: current.value.state });
      await context.assertCurrent();
      const settled = input.outcome === "resolved"
        ? await humanTasks.resolve(taskId, { expectedRevision: current.revision, resolutionCode: input.resolutionCode ?? "completed" })
        : await humanTasks.cancel(taskId, { expectedRevision: current.revision, resolutionCode: input.resolutionCode ?? "cancelled" });
      return Object.freeze({ ok: true, key: input.key, state: settled.value.state });
    },

    async "module.audit.append"(raw, context) {
      const input = args(raw, ["type", "data"], "module.audit.append");
      if (typeof input.type !== "string" || input.type.length > 64 || !AUDIT_TYPE_PATTERN.test(input.type)) invalid("Audit type is invalid");
      const data = redactModuleAuditData(input.data ?? null);
      if (jsonBytes(data) > L.auditEventBytes) fail(E.LIMIT, "Audit event exceeds 4 KiB");
      await assertMutationAllowed();
      await context.assertCurrent();
      const event = await deps().auditJournal.append({
        type: "module.event." + input.type,
        subject: { kind: "module", id: context.moduleId },
        data: { generation: context.generation, data }
      });
      return Object.freeze({ ok: true, sequence: event.sequence });
    },

    async "core.accounts.read"(raw) {
      const input = args(raw, ["limit", "cursor"], "core.accounts.read");
      const bounds = pageArgs(input);
      const listed = await deps().accounts.listAccounts();
      const accounts = (listed.accounts || []).map((account) => Object.freeze({
        accountId: String(account.accountId),
        providerId: String(account.providerId),
        displayName: String(account.displayName)
      }));
      return page(accounts, bounds);
    },

    async "core.generators.read"(raw) {
      const input = args(raw, ["limit", "cursor"], "core.generators.read");
      const bounds = pageArgs(input);
      const listed = await deps().deployer.listDeploymentViews();
      const generators = (listed.deployments || []).map((view) => Object.freeze({
        generatorId: String(view.generatorId),
        accountId: String(view.accountId),
        syncState: String(view.syncState),
        desiredSourceHash: view.desiredSourceHash ?? null,
        observedSourceHash: view.observedSourceHash ?? null
      }));
      return page(generators, bounds);
    }
  };

  return handlers;
}

// provider.perchance.<action>: a provider mutation requested by a module goes through the
// Account-bound ProviderGate and RemoteOps exactly like a built-in feature (ADR-003 §4). The
// durable RemoteOperation id is scoped to the module, so a retry with the same operationKey
// reuses it and an UNCERTAIN operation fails closed until it is reconciled.
export function createModuleProviderCapabilityHandlers({ resolve, providerId, actions } = {}) {
  if (typeof resolve !== "function") throw new TypeError("Module provider capabilities require a dependency resolver");
  if (typeof providerId !== "string" || !/^[a-z][a-z0-9-]*$/.test(providerId)) throw new TypeError("Module provider id is invalid");
  if (!plain(actions)) throw new TypeError("Module provider actions are invalid");
  const handlers = {};
  for (const [action, describe] of Object.entries(actions)) {
    if (typeof describe !== "function") throw new TypeError("Module provider action descriptor is invalid");
    const name = "provider." + providerId + "." + action;
    handlers[name] = async (raw, context) => {
      const { gateFor } = resolve();
      const input = args(raw, ["accountId", "operationKey", "request"], name);
      if (typeof input.accountId !== "string" || !KEY_PATTERN.test(input.accountId) || input.accountId.length > 128) invalid("accountId is invalid");
      if (typeof input.operationKey !== "string" || !ATTENTION_KEY_PATTERN.test(input.operationKey)) invalid("operationKey is invalid");
      const described = await describe(input.request, context);
      const gate = await gateFor(input.accountId);
      if (!gate) fail(E.NOT_FOUND, "Account is unavailable");
      const operation = {
        operationId: "module." + context.moduleId + "." + input.operationKey,
        providerId,
        action: described.action,
        targetRef: described.targetRef,
        intentFingerprint: described.intentFingerprint
      };
      await context.assertCurrent();
      const result = await gate.mutate({ operation, dispatchInput: described.dispatchInput });
      return Object.freeze({ ok: true, status: result.status, operationState: result.operation?.value?.state ?? null });
    };
  }
  return handlers;
}

// The provider actions capability set v1 offers, keyed by Perchance action.
export const PERCHANCE_MODULE_ACTIONS = Object.freeze({
  [PERCHANCE_GENERATOR_UPDATE_ACTION]: async (request) => {
    const input = args(request, ["generatorId", "source"], "provider.perchance." + PERCHANCE_GENERATOR_UPDATE_ACTION);
    if (typeof input.generatorId !== "string" || !KEY_PATTERN.test(input.generatorId) || input.generatorId.length > 256) {
      invalid("generatorId is invalid");
    }
    if (typeof input.source !== "string") invalid("source is invalid");
    let sourceHash;
    try { sourceHash = await sha256Hex(input.source); } catch { invalid("source is invalid"); }
    return Object.freeze({
      action: PERCHANCE_GENERATOR_UPDATE_ACTION,
      targetRef: Object.freeze({ kind: PERCHANCE_GENERATOR_TARGET_KIND, id: input.generatorId }),
      intentFingerprint: generatorSourceFingerprint(sourceHash),
      dispatchInput: Object.freeze({ sourceHash, source: input.source })
    });
  }
});

export function createPerchanceModuleCapabilityHandlers({ resolve } = {}) {
  return createModuleProviderCapabilityHandlers({ resolve, providerId: PERCHANCE_PROVIDER_ID, actions: PERCHANCE_MODULE_ACTIONS });
}
