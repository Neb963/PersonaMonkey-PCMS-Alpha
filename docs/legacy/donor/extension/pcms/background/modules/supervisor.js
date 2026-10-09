// Module supervisor (ADR-003 §2, §3, §5): runtime-module lifecycle executed live in the
// background Core, lazy rehydration after event-page unload or browser restart, and
// delivery of module schedules through the Core durable timer service.
//
// Durable truth stays where P008/P011/P022 put it (registry, lifecycle, runtime record).
// The supervisor adds only bounded activation-failure state (backoff + Attention) and the
// in-memory scheduler service registrations, which every Core context re-creates.
import { MODULE_CANDIDATE_STATES } from "../../modules/registry.js";
import { MODULE_LIFECYCLE_STATES } from "../../modules/lifecycle.js";
import { MODULE_LIFECYCLE_ERROR_CODES } from "../../modules/lifecycle-errors.js";
import { MODULE_MAX_ARCHIVE_BYTES, assertModuleId, assertModulePackageHash, parseModuleArchive } from "../../modules/package.js";
import { MODULE_RUNTIME_STATES } from "../../runtime/module-runtime.js";
import { MODULE_RUNTIME_AVAILABILITY } from "../../runtime/browser-floor.js";
import { HUMAN_TASK_PRIORITIES, HUMAN_TASK_STATES } from "../../services/human-tasks.js";
import { TIMER_STATES } from "../../services/timers.js";
import {
  MODULE_SCHEDULER_GENERATION,
  moduleSchedulerOwnerId,
  moduleSchedulerServiceName,
  moduleTimerPrefix,
  parseModuleTimerId
} from "./schedules.js";

export const MODULE_SUPERVISOR_NAMESPACE = "core.module-supervisor";
export const MODULE_ACTIVATION_BACKOFF_MIN_MS = 60 * 1000;
export const MODULE_ACTIVATION_BACKOFF_MAX_MS = 30 * 60 * 1000;

export const MODULE_SUPERVISOR_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "PCMS_MODULE_SUPERVISOR_INVALID_ARGUMENT",
  NOT_INSTALLED: "PCMS_MODULE_SUPERVISOR_NOT_INSTALLED",
  NOT_RUNNABLE: "PCMS_MODULE_SUPERVISOR_NOT_RUNNABLE",
  BACKOFF: "PCMS_MODULE_SUPERVISOR_BACKOFF",
  RUNTIME_UNAVAILABLE: "PCMS_MODULE_RUNTIME_UNAVAILABLE"
});

export const MODULE_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  READY: "READY",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  DISABLED: "DISABLED",
  REMOVED: "REMOVED",
  UNAVAILABLE: "UNAVAILABLE"
});

const MESSAGES = Object.freeze({
  [MODULE_SUPERVISOR_ERROR_CODES.INVALID_ARGUMENT]: "Module request is invalid",
  [MODULE_SUPERVISOR_ERROR_CODES.NOT_INSTALLED]: "Module is not installed",
  [MODULE_SUPERVISOR_ERROR_CODES.NOT_RUNNABLE]: "Module is not enabled and admitted",
  [MODULE_SUPERVISOR_ERROR_CODES.BACKOFF]: "Module is unavailable after a failed activation; retry is backing off",
  [MODULE_SUPERVISOR_ERROR_CODES.RUNTIME_UNAVAILABLE]: "Module runtime is unavailable · Requires Firefox 154+"
});

export class ModuleSupervisorError extends Error {
  constructor(code) {
    super(MESSAGES[code] || code);
    this.name = "ModuleSupervisorError";
    this.code = code;
  }
}

const E = MODULE_SUPERVISOR_ERROR_CODES;
const TEXT_ENCODER = new TextEncoder();
const UI_METHOD_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
const RESERVED_UI_METHODS = new Set(["start", "dispose", "onTimer"]);

function fail(code) { throw new ModuleSupervisorError(code); }

function requireMethods(value, names, label) {
  if (!value || typeof value !== "object" || !names.every((name) => typeof value[name] === "function")) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function healthKey(moduleId) { return "health:" + moduleId; }

export function moduleActivationBackoffMs(failures) {
  if (!Number.isSafeInteger(failures) || failures < 1) return 0;
  return Math.min(MODULE_ACTIVATION_BACKOFF_MAX_MS, MODULE_ACTIVATION_BACKOFF_MIN_MS * 2 ** Math.min(failures - 1, 16));
}

export function createModuleSupervisor({
  moduleRegistry,
  moduleRuntime,
  moduleLifecycle,
  timerServices,
  timers,
  humanTasks,
  auditJournal = null,
  storageBroker,
  schedules,
  clock = () => new Date().toISOString()
} = {}) {
  const registry = requireMethods(moduleRegistry, ["getModule", "listModules", "getPackage", "rejectCandidate"], "Module registry");
  const runtime = requireMethods(moduleRuntime, ["getState", "activate", "invoke", "isRunning", "getSupport"], "Module runtime");
  const lifecycle = requireMethods(moduleLifecycle, ["stageInstall", "stageRollback", "applyCandidate", "disable", "enable", "remove", "purge", "getState"], "Module lifecycle");
  const services = requireMethods(timerServices, ["register", "unregister", "describe"], "Timer service registry");
  requireMethods(timers, ["ensure", "get", "cancel", "list"], "Timer service");
  requireMethods(humanTasks, ["open", "get", "resolve", "cancel"], "HumanTask service");
  requireMethods(schedules, ["getPending", "deletePending", "listPending"], "Module schedules");
  if (!storageBroker || typeof storageBroker.namespace !== "function") throw new TypeError("Module supervisor requires PCMS storage");
  if (auditJournal !== null) requireMethods(auditJournal, ["append"], "Audit Journal");
  if (typeof clock !== "function") throw new TypeError("Module supervisor clock is invalid");

  const store = storageBroker.namespace(MODULE_SUPERVISOR_NAMESPACE);
  const schedulerTokens = new Map();
  const locks = new Map();

  function nowMs() {
    const parsed = Date.parse(clock());
    if (!Number.isFinite(parsed)) throw new TypeError("Module supervisor clock is invalid");
    return parsed;
  }

  // One lifecycle step or delivery per module at a time; other modules run independently.
  function withModule(moduleId, run) {
    const previous = locks.get(moduleId) || Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => {});
    locks.set(moduleId, tail);
    void tail.then(() => { if (locks.get(moduleId) === tail) locks.delete(moduleId); });
    return next;
  }

  async function audit(type, moduleId, data) {
    if (!auditJournal) return;
    try { await auditJournal.append({ type: "module.lifecycle." + type, subject: { kind: "module", id: moduleId }, data }); } catch {}
  }

  // --- activation failure state -------------------------------------------------------

  async function readHealth(moduleId) {
    const row = await store.get(healthKey(moduleId));
    const value = row?.value;
    if (!row || value?.kind !== "module-health" || value.moduleId !== moduleId || !Number.isSafeInteger(value.failures)) {
      return { revision: row?.revision ?? 0, failures: 0, episode: null, nextAttemptAt: null, lastErrorCode: null };
    }
    return { revision: row.revision, failures: value.failures, episode: value.episode, nextAttemptAt: value.nextAttemptAt, lastErrorCode: value.lastErrorCode };
  }

  function unavailableTaskId(moduleId, episode) { return "module-unavailable:" + moduleId + ":" + episode; }

  async function recordFailure(moduleId, code) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const health = await readHealth(moduleId);
      const failures = health.failures + 1;
      const now = nowMs();
      const episode = health.episode || now.toString(36);
      const value = {
        schemaVersion: 1,
        kind: "module-health",
        moduleId,
        failures,
        episode,
        nextAttemptAt: new Date(now + moduleActivationBackoffMs(failures)).toISOString(),
        lastErrorCode: typeof code === "string" ? code.slice(0, 96) : "PCMS_MODULE_FAILED"
      };
      try {
        await store.compareAndSwap(healthKey(moduleId), { expectedRevision: health.revision, value });
      } catch (error) {
        if (error?.code === "PCMS_STORAGE_CAS_MISMATCH") continue;
        throw error;
      }
      const taskId = unavailableTaskId(moduleId, episode);
      try {
        if (!(await humanTasks.get(taskId))) {
          await humanTasks.open({
            taskId,
            taskKind: "module.unavailable",
            title: "Module " + moduleId + " is unavailable",
            instructions: "The module failed to start or to handle its work (" + value.lastErrorCode + "). PCMS retries with backoff; disable, roll back or update the module if it keeps failing.",
            priority: HUMAN_TASK_PRIORITIES.HIGH,
            subjectRef: { kind: "module", id: moduleId }
          });
        }
      } catch {}
      await audit("unavailable", moduleId, { failures, nextAttemptAt: value.nextAttemptAt, code: value.lastErrorCode });
      return value;
    }
    return null;
  }

  async function clearFailure(moduleId) {
    const health = await readHealth(moduleId);
    if (health.revision === 0) return false;
    try { await store.deleteCompareAndSwap(healthKey(moduleId), { expectedRevision: health.revision }); } catch {}
    if (health.episode) {
      try {
        const task = await humanTasks.get(unavailableTaskId(moduleId, health.episode));
        if (task?.value?.state === HUMAN_TASK_STATES.OPEN) {
          await humanTasks.resolve(task.value.taskId, { expectedRevision: task.revision, resolutionCode: "recovered" });
        }
      } catch {}
    }
    return true;
  }

  // --- approval HumanTasks ------------------------------------------------------------

  function approvalTaskId(moduleId, candidate) {
    const staged = Date.parse(candidate.stagedAt);
    return "module-approval:" + moduleId + ":" + candidate.packageHash.slice(7, 23) + ":" + (Number.isFinite(staged) ? staged.toString(36) : "0");
  }

  async function openApprovalTask(moduleId, candidate) {
    const taskId = approvalTaskId(moduleId, candidate);
    try {
      if (await humanTasks.get(taskId)) return taskId;
      await humanTasks.open({
        taskId,
        taskKind: "module.approval",
        title: "Approve capabilities for module " + moduleId,
        instructions: "Version " + candidate.version + " requests: " + candidate.authorityDelta.added.join(", ") + ".",
        priority: HUMAN_TASK_PRIORITIES.NORMAL,
        subjectRef: { kind: "module", id: moduleId }
      });
    } catch {}
    return taskId;
  }

  async function settleApprovalTask(moduleId, candidate, outcome) {
    if (!candidate?.stagedAt) return;
    try {
      const task = await humanTasks.get(approvalTaskId(moduleId, candidate));
      if (task?.value?.state !== HUMAN_TASK_STATES.OPEN) return;
      if (outcome === "resolved") await humanTasks.resolve(task.value.taskId, { expectedRevision: task.revision, resolutionCode: "approved" });
      else await humanTasks.cancel(task.value.taskId, { expectedRevision: task.revision, resolutionCode: outcome });
    } catch {}
  }

  // --- schedules ----------------------------------------------------------------------

  function ensureScheduler(moduleId) {
    const serviceName = moduleSchedulerServiceName(moduleId);
    if (!serviceName) return null;
    if (services.describe(serviceName)) return serviceName;
    const registration = services.register(serviceName, Object.freeze({
      onTimer: (input) => deliverTimer(moduleId, input)
    }), { ownerId: moduleSchedulerOwnerId(moduleId), generation: MODULE_SCHEDULER_GENERATION });
    schedulerTokens.set(moduleId, registration.token);
    return serviceName;
  }

  function releaseScheduler(moduleId) {
    const serviceName = moduleSchedulerServiceName(moduleId);
    const token = schedulerTokens.get(moduleId);
    schedulerTokens.delete(moduleId);
    if (!serviceName || !token) return false;
    try { return services.unregister(serviceName, { token }); } catch { return false; }
  }

  async function moduleTimerRows(moduleId) {
    const prefix = moduleTimerPrefix(moduleId);
    return (await timers.list()).filter((row) => row.value.timerId.startsWith(prefix));
  }

  async function cancelModuleTimers(moduleId) {
    let cancelled = 0;
    for (const row of await moduleTimerRows(moduleId)) {
      if (row.value.state !== TIMER_STATES.SCHEDULED) continue;
      try { await timers.cancel(row.value.timerId, { expectedRevision: row.revision }); cancelled += 1; } catch {}
    }
    for (const pending of await schedules.listPending(moduleId)) await schedules.deletePending(pending.timerId);
    return cancelled;
  }

  async function ensureModuleTimer(moduleId, timerId, dueAt) {
    const serviceName = ensureScheduler(moduleId);
    if (!serviceName) return null;
    return timers.ensure({
      name: timerId,
      serviceName,
      ownerId: moduleSchedulerOwnerId(moduleId),
      generation: MODULE_SCHEDULER_GENERATION,
      dueAt
    });
  }

  async function supportAvailable() {
    const status = await runtime.getSupport();
    return !status || status.state === MODULE_RUNTIME_AVAILABILITY.AVAILABLE;
  }

  // Bounded catch-up: a module occurrence that did not run is delivered once more,
  // immediately after an interruption or overdue restart, after backoff after a failure.
  async function catchUp(moduleId, row) {
    if (!(await desired(moduleId)).desired || !(await supportAvailable())) return null;
    const health = await readHealth(moduleId);
    const now = nowMs();
    let due = now;
    if (row.value.missedReason === "delivery-failed") due = now + MODULE_ACTIVATION_BACKOFF_MIN_MS;
    const backoffUntil = Date.parse(health.nextAttemptAt || "");
    if (Number.isFinite(backoffUntil) && backoffUntil > due) due = backoffUntil;
    return ensureModuleTimer(moduleId, row.value.timerId, new Date(due).toISOString());
  }

  async function applyPending(moduleId, pending) {
    const current = await timers.get(pending.timerId);
    if (current?.value?.state === TIMER_STATES.DISPATCHING) return false;
    if ((await desired(moduleId)).desired) await ensureModuleTimer(moduleId, pending.timerId, pending.dueAt);
    await schedules.deletePending(pending.timerId, { revision: pending.revision });
    return true;
  }

  // Timer service change hook: completes declarations made while an occurrence ran.
  async function afterTimerChange(change) {
    const parsed = parseModuleTimerId(change?.timerId);
    const state = change?.state?.value?.state;
    if (!parsed || (state !== TIMER_STATES.FIRED && state !== TIMER_STATES.MISSED)) return null;
    const pending = await schedules.getPending(change.timerId);
    if (pending) return applyPending(parsed.moduleId, pending);
    if (state === TIMER_STATES.MISSED) return catchUp(parsed.moduleId, change.state);
    return null;
  }

  // Due-pass hook (cold start, warm wake, every alarm): finish anything a previous
  // context left half-done before the pass delivers due work.
  async function declare() {
    const applied = [];
    for (const pending of await schedules.listPending()) {
      const parsed = parseModuleTimerId(pending.timerId);
      try { if (await applyPending(parsed.moduleId, pending)) applied.push(pending.timerId); } catch {}
    }
    for (const row of await timers.list()) {
      const parsed = parseModuleTimerId(row.value.timerId);
      if (!parsed || row.value.state !== TIMER_STATES.MISSED) continue;
      try { if (await catchUp(parsed.moduleId, row)) applied.push(row.value.timerId); } catch {}
    }
    return Object.freeze(applied);
  }

  // --- running ------------------------------------------------------------------------

  async function desired(moduleId) {
    const [module, lifecycleState, runtimeState] = await Promise.all([
      registry.getModule(moduleId),
      lifecycle.getState(moduleId),
      runtime.getState(moduleId)
    ]);
    const present = ![MODULE_LIFECYCLE_STATES.REMOVED, MODULE_LIFECYCLE_STATES.PURGING, MODULE_LIFECYCLE_STATES.PURGED]
      .includes(lifecycleState.value.state);
    return {
      desired: Boolean(module?.value?.activePackageHash) && present && runtimeState.value.state !== MODULE_RUNTIME_STATES.DISABLED,
      module,
      lifecycle: lifecycleState,
      runtime: runtimeState
    };
  }

  // Lazy activation (ADR-003 §3): only right before work addressed to the module.
  async function activateIfNeeded(moduleId) {
    if (runtime.isRunning(moduleId)) return null;
    const current = await desired(moduleId);
    if (!current.desired) fail(E.NOT_RUNNABLE);
    if (!(await supportAvailable())) fail(E.RUNTIME_UNAVAILABLE);
    const health = await readHealth(moduleId);
    const backoffUntil = Date.parse(health.nextAttemptAt || "");
    if (Number.isFinite(backoffUntil) && backoffUntil > nowMs()) fail(E.BACKOFF);
    if (current.runtime.value.state !== MODULE_RUNTIME_STATES.IDLE) fail(E.NOT_RUNNABLE);
    ensureScheduler(moduleId);
    try {
      const activated = await runtime.activate(moduleId, { expectedRevision: current.runtime.revision });
      await clearFailure(moduleId);
      await audit("activated", moduleId, { generation: activated.generation, packageHash: activated.packageHash });
      return activated;
    } catch (error) {
      await recordFailure(moduleId, error?.code);
      throw error;
    }
  }

  async function deliverTimer(moduleId, input) {
    const parsed = parseModuleTimerId(input?.timerId);
    if (!parsed || parsed.moduleId !== moduleId) fail(E.INVALID_ARGUMENT);
    return withModule(moduleId, async () => {
      await activateIfNeeded(moduleId);
      try {
        const result = await runtime.invoke(moduleId, "onTimer", { name: parsed.name, dueAt: input.dueAt ?? null });
        await clearFailure(moduleId);
        return result;
      } catch (error) {
        await recordFailure(moduleId, error?.code);
        throw error;
      }
    });
  }

  // Core init (cold or warm): every admitted module needs its scheduler service before
  // the first due pass, whether or not it is activated in this context.
  async function initialize() {
    const registered = [];
    for (const module of await registry.listModules()) {
      if (!module.value.activePackageHash) continue;
      if (ensureScheduler(module.moduleId)) registered.push(module.moduleId);
    }
    return Object.freeze(registered);
  }

  // --- lifecycle commands -------------------------------------------------------------

  function moduleIdArg(value) {
    try { return assertModuleId(value); } catch { return fail(E.INVALID_ARGUMENT); }
  }
  function packageHashArg(value) {
    try { return assertModulePackageHash(value); } catch { return fail(E.INVALID_ARGUMENT); }
  }

  async function applyOrAwait(moduleId, packageHash, approve, verb) {
    const module = await registry.getModule(moduleId);
    const candidate = module?.value?.candidate;
    if (!candidate || candidate.packageHash !== packageHash) {
      const error = new ModuleSupervisorError(E.INVALID_ARGUMENT);
      error.code = MODULE_LIFECYCLE_ERROR_CODES.CANDIDATE_MISMATCH;
      throw error;
    }
    if (candidate.state === MODULE_CANDIDATE_STATES.AWAITING_APPROVAL && !approve) {
      await openApprovalTask(moduleId, candidate);
      return describe(moduleId);
    }
    if (!(await supportAvailable())) fail(E.RUNTIME_UNAVAILABLE);
    const wasRemoved = (await lifecycle.getState(moduleId)).value.state === MODULE_LIFECYCLE_STATES.REMOVED;
    ensureScheduler(moduleId);
    const runtimeBefore = await runtime.getState(moduleId);
    let result;
    try {
      result = await lifecycle.applyCandidate(moduleId, packageHash, {
        expectedModuleRevision: module.revision,
        expectedRuntimeRevision: runtimeBefore.revision,
        approveAuthority: approve
      });
    } catch (error) {
      if (error?.code === MODULE_LIFECYCLE_ERROR_CODES.ACTIVATION_FAILED) await recordFailure(moduleId, error.code);
      throw error;
    }
    if (result.approvalRequired) {
      await openApprovalTask(moduleId, candidate);
      return describe(moduleId);
    }
    await settleApprovalTask(moduleId, candidate, "resolved");
    let activated = result.activated;
    if (!activated && wasRemoved) {
      // Installing a removed module again brings it back running.
      const disabled = await runtime.getState(moduleId);
      if (disabled.value.state === MODULE_RUNTIME_STATES.DISABLED) {
        try {
          await lifecycle.enable(moduleId, { expectedRuntimeRevision: disabled.revision });
          activated = true;
        } catch (error) {
          await recordFailure(moduleId, error?.code);
          throw error;
        }
      }
    }
    if (activated) await clearFailure(moduleId);
    await audit(verb, moduleId, { packageHash, version: candidate.version, activated });
    return describe(moduleId);
  }

  async function install(archiveText) {
    if (typeof archiveText !== "string") fail(E.INVALID_ARGUMENT);
    const bytes = TEXT_ENCODER.encode(archiveText);
    if (bytes.byteLength > MODULE_MAX_ARCHIVE_BYTES) fail(E.INVALID_ARGUMENT);
    const parsed = await parseModuleArchive(bytes);
    const moduleId = parsed.manifest.moduleId;
    return withModule(moduleId, async () => {
      const before = await registry.getModule(moduleId);
      const isUpdate = Boolean(before?.value?.activePackageHash);
      await lifecycle.stageInstall(bytes, { expectedModuleRevision: before?.revision ?? 0 });
      return applyOrAwait(moduleId, parsed.packageHash, false, isUpdate ? "updated" : "installed");
    });
  }

  function approve(moduleId, packageHash) {
    const id = moduleIdArg(moduleId);
    const hash = packageHashArg(packageHash);
    return withModule(id, () => applyOrAwait(id, hash, true, "approved"));
  }

  function reject(moduleId, packageHash) {
    const id = moduleIdArg(moduleId);
    const hash = packageHashArg(packageHash);
    return withModule(id, async () => {
      const module = await registry.getModule(id);
      if (!module) fail(E.NOT_INSTALLED);
      const candidate = module.value.candidate;
      await registry.rejectCandidate(id, hash, { expectedModuleRevision: module.revision });
      await settleApprovalTask(id, candidate, "rejected");
      await audit("rejected", id, { packageHash: hash });
      return describe(id);
    });
  }

  function disable(moduleId) {
    const id = moduleIdArg(moduleId);
    return withModule(id, async () => {
      const current = await runtime.getState(id);
      await lifecycle.disable(id, { expectedRuntimeRevision: current.revision });
      await cancelModuleTimers(id);
      await audit("disabled", id, null);
      return describe(id);
    });
  }

  function enable(moduleId) {
    const id = moduleIdArg(moduleId);
    return withModule(id, async () => {
      if (!(await supportAvailable())) fail(E.RUNTIME_UNAVAILABLE);
      const current = await runtime.getState(id);
      if (current.value.state !== MODULE_RUNTIME_STATES.DISABLED) fail(E.NOT_RUNNABLE);
      ensureScheduler(id);
      // An explicit operator enable starts a fresh attempt, outside any backoff.
      await clearFailure(id);
      try {
        await lifecycle.enable(id, { expectedRuntimeRevision: current.revision });
      } catch (error) {
        await recordFailure(id, error?.code);
        throw error;
      }
      await audit("enabled", id, null);
      return describe(id);
    });
  }

  function rollback(moduleId, packageHash) {
    const id = moduleIdArg(moduleId);
    const hash = packageHashArg(packageHash);
    return withModule(id, async () => {
      const module = await registry.getModule(id);
      if (!module) fail(E.NOT_INSTALLED);
      await lifecycle.stageRollback(id, hash, { expectedModuleRevision: module.revision });
      return applyOrAwait(id, hash, false, "rolled-back");
    });
  }

  function remove(moduleId) {
    const id = moduleIdArg(moduleId);
    return withModule(id, async () => {
      const module = await registry.getModule(id);
      if (!module) fail(E.NOT_INSTALLED);
      const current = await runtime.getState(id);
      await lifecycle.remove(id, { expectedModuleRevision: module.revision, expectedRuntimeRevision: current.revision });
      await cancelModuleTimers(id);
      releaseScheduler(id);
      await clearFailure(id);
      await audit("removed", id, null);
      return describe(id);
    });
  }

  function purge(moduleId) {
    const id = moduleIdArg(moduleId);
    return withModule(id, async () => {
      const module = await registry.getModule(id);
      const current = await runtime.getState(id);
      const result = await lifecycle.purge(id, { expectedModuleRevision: module?.revision ?? 0, expectedRuntimeRevision: current.revision });
      await cancelModuleTimers(id);
      releaseScheduler(id);
      await clearFailure(id);
      const data = storageBroker.namespace("module." + id + ".data");
      let deleted = 0;
      for (const row of await data.list()) {
        try { await data.deleteCompareAndSwap(row.key, { expectedRevision: row.revision }); deleted += 1; } catch {}
      }
      await audit("purged", id, { dataKeysDeleted: deleted });
      return Object.freeze({ moduleId: id, purged: result.purged === true, dataKeysDeleted: deleted });
    });
  }

  // A UI command addressed to a module (ADR-003 §3): lazily activates it, then invokes.
  function call(moduleId, method, input = null) {
    const id = moduleIdArg(moduleId);
    if (typeof method !== "string" || !UI_METHOD_PATTERN.test(method) || RESERVED_UI_METHODS.has(method)) fail(E.INVALID_ARGUMENT);
    return withModule(id, async () => {
      await activateIfNeeded(id);
      return runtime.invoke(id, method, input);
    });
  }

  // --- projections --------------------------------------------------------------------

  async function describe(moduleId, { includeTimers = true } = {}) {
    const id = moduleIdArg(moduleId);
    const current = await desired(id);
    const module = current.module;
    if (!module) {
      return Object.freeze({ moduleId: id, installed: false, lifecycleState: current.lifecycle.value.state });
    }
    const [health, support] = await Promise.all([readHealth(id), runtime.getSupport()]);
    const supported = !support || support.state === MODULE_RUNTIME_AVAILABILITY.AVAILABLE;
    let manifest = null;
    if (module.value.activePackageHash) {
      try {
        const pkg = await registry.getPackage(module.value.activePackageHash);
        manifest = { version: pkg.manifest.version, capabilities: [...pkg.manifest.authority.capabilities] };
      } catch {}
    }
    const candidate = module.value.candidate
      ? Object.freeze({
        packageHash: module.value.candidate.packageHash,
        version: module.value.candidate.version,
        state: module.value.candidate.state,
        addedCapabilities: Object.freeze([...module.value.candidate.authorityDelta.added])
      })
      : null;
    const backoffUntil = Date.parse(health.nextAttemptAt || "");
    const backingOff = Number.isFinite(backoffUntil) && backoffUntil > nowMs();
    let status;
    if (!module.value.activePackageHash && candidate) status = MODULE_STATUS.AWAITING_APPROVAL;
    else if (current.lifecycle.value.state === MODULE_LIFECYCLE_STATES.REMOVED) status = MODULE_STATUS.REMOVED;
    else if (current.runtime.value.state === MODULE_RUNTIME_STATES.DISABLED) status = MODULE_STATUS.DISABLED;
    else if (!supported || backingOff) status = MODULE_STATUS.UNAVAILABLE;
    else if (runtime.isRunning(id)) status = MODULE_STATUS.ACTIVE;
    else status = MODULE_STATUS.READY;
    const timersView = includeTimers
      ? (await moduleTimerRows(id)).map((row) => Object.freeze({
        name: parseModuleTimerId(row.value.timerId).name,
        state: row.value.state,
        dueAt: row.value.dueAt,
        missedReason: row.value.missedReason
      }))
      : null;
    return Object.freeze({
      moduleId: id,
      installed: true,
      status,
      reason: !supported ? (support?.message ?? null) : (backingOff ? health.lastErrorCode : null),
      version: manifest?.version ?? null,
      capabilities: Object.freeze(manifest?.capabilities ?? []),
      activePackageHash: module.value.activePackageHash,
      lastKnownGoodPackageHash: module.value.lastKnownGoodPackageHash,
      candidate,
      lifecycleState: current.lifecycle.value.state,
      retainedPackageHashes: Object.freeze([...current.lifecycle.value.retainedPackageHashes]),
      runtimeState: current.runtime.value.state,
      generation: current.runtime.value.generation,
      running: runtime.isRunning(id),
      failures: health.failures,
      nextAttemptAt: backingOff ? health.nextAttemptAt : null,
      timers: timersView === null ? null : Object.freeze(timersView)
    });
  }

  async function list() {
    const out = [];
    for (const module of await registry.listModules()) out.push(await describe(module.moduleId, { includeTimers: false }));
    const support = await runtime.getSupport();
    return Object.freeze({
      runtime: Object.freeze({
        state: support?.state ?? MODULE_RUNTIME_AVAILABILITY.AVAILABLE,
        reason: support?.reason ?? null,
        message: support?.message ?? null
      }),
      modules: Object.freeze(out)
    });
  }

  return Object.freeze({
    initialize,
    declare,
    afterTimerChange,
    activateIfNeeded: (moduleId) => withModule(moduleIdArg(moduleId), () => activateIfNeeded(moduleIdArg(moduleId))),
    api: Object.freeze({
      list,
      get: (moduleId) => describe(moduleId),
      install,
      approve,
      reject,
      disable,
      enable,
      rollback,
      remove,
      purge,
      call
    })
  });
}
