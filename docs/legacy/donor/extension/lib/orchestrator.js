import { validateWorkflowForRun } from "./workflow-model.js";
import { MAX_WORKFLOW_STEP_TIMEOUT_MS } from "./constants.js";

const JOBS_KEY = "automationJobs";
const MAX_STORED_JOBS = 100;
const MAX_SIGNAL_RESULT_BYTES = 64 * 1024;
const MAX_EXTERNAL_RESULT_BYTES = 64 * 1024;
const MAX_STRUCTURED_FAILURE_BYTES = 16 * 1024;
const MAX_JOB_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
// Leave one job-sized reserve for JSON framing and historical records. Each
// admitted active job is independently bounded by MAX_JOB_BYTES.
const MAX_CONCURRENT_JOBS = Math.max(1, Math.floor(MAX_HISTORY_BYTES / MAX_JOB_BYTES) - 1);
const MAX_WORKFLOW_INPUT_BYTES = 256 * 1024;
const TAB_OWNER_KEY = "personaAutomationOwner";

let getStateFn = null;
let ensureProfileReadyFn = null;
let configured = false;
let jobs = {};
let jobsLoaded = false;
const tabPolicies = new Map();
const signalWaiters = new Map();
const activeRunners = new Map();
let activeTabSlots = 0;
let eventSink = null;
let persistenceTail = Promise.resolve();

function iso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clone(v) { try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); } }
function text(value, max = 256) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max); }
function count(value, max = Number.MAX_SAFE_INTEGER) { return Math.max(0, Math.min(max, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0)); }

function serializedBytes(value, label = "value") {
  let json;
  try { json = JSON.stringify(value); } catch { throw new Error(`${label} must be JSON-serializable`); }
  if (typeof json !== "string") throw new Error(`${label} must be JSON-serializable`);
  return new TextEncoder().encode(json).byteLength;
}

// Kept self-contained so the same validation runs before userscript messaging
// (which can erase prototypes) and again at the trusted runner boundary.
export function normalizeStructuredAutomationFailure(value) {
  const invalid = () => { throw new Error("Invalid structured userscript failure"); };
  const ancestors = new Set();
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 512 || depth > 6) return invalid();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") return item.length <= 4096 ? item : invalid();
    if (typeof item === "number") return Number.isFinite(item) ? item : invalid();
    if (typeof item !== "object" || ancestors.has(item)) return invalid();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) return invalid();
    if (array && prototype !== Array.prototype) return invalid();
    const keys = Reflect.ownKeys(item);
    if (keys.length > 512) return invalid();
    ancestors.add(item);
    const out = array ? [] : {};
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || key.length > 128 || ["__proto__", "prototype", "constructor"].includes(key)) return invalid();
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
      out[key] = visit(descriptor.value, depth + 1);
    }
    if (array && out.length !== keys.length - 1) return invalid();
    ancestors.delete(item);
    return out;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 16 * 1024) return invalid();
  return result;
}

function automationFailure(error, external) {
  if (external && error && typeof error === "object") {
    try {
      const failure = normalizeStructuredAutomationFailure(error);
      const result = new Error("Userscript failed");
      result.structuredFailure = failure;
      return result;
    } catch { return new Error("Invalid structured userscript failure"); }
  }
  return new Error(text(error || "Userscript failed", 512));
}

function compactHistoricalJob(job) {
  const note = "Older diagnostic details were omitted to bring this saved job within the current storage limit.";
  for (const task of job.tasks || []) {
    if (task?.structuredFailure !== undefined) {
      delete task.structuredFailure;
      task.failureOmitted = true;
    }
    if (task?.result !== undefined) {
      delete task.result;
      task.resultOmitted = true;
    }
  }
  job.storageNote = note;
  if (serializedBytes(trustedJob(job), "Automation job") <= MAX_JOB_BYTES) return;
  for (const task of job.tasks || []) {
    if (task?.attemptHistory) {
      delete task.attemptHistory;
      task.attemptHistoryOmitted = true;
    }
  }
  if (serializedBytes(trustedJob(job), "Automation job") <= MAX_JOB_BYTES) return;
  for (const task of job.tasks || []) {
    if (task?.url) {
      delete task.url;
      task.urlOmitted = true;
    }
  }
  if (serializedBytes(trustedJob(job), "Automation job") <= MAX_JOB_BYTES) return;
  if ((job.tasks || []).length > 200) job.tasks = job.tasks.slice(-200);
  if (serializedBytes(trustedJob(job), "Automation job") > MAX_JOB_BYTES) {
    const summary = {
      id: text(job.id, 128),
      workflowId: text(job.workflowId, 256),
      workflowName: text(job.workflowName, 200),
      state: text(job.state, 32),
      createdAt: job.createdAt ? text(job.createdAt, 64) : null,
      startedAt: job.startedAt ? text(job.startedAt, 64) : null,
      finishedAt: job.finishedAt ? text(job.finishedAt, 64) : null,
      currentStep: Number.isInteger(job.currentStep) ? job.currentStep : -1,
      totalSteps: count(job.totalSteps, 1000),
      error: job.error ? text(job.error, 2048) : null,
      storageNote: "Task details were omitted to bring this saved job within the current storage limit.",
      ...(job.externalOwner ? { externalOwner: clone(job.externalOwner) } : {}),
      ...(job.acknowledgedAt !== undefined ? { acknowledgedAt: job.acknowledgedAt } : {})
    };
    for (const key of Object.keys(job)) delete job[key];
    Object.assign(job, summary);
  }
}

async function cleanupPersistedOwnedTabs(jobIds) {
  if (!jobIds.size || !browser.sessions?.getTabValue) return;
  let openTabs = [];
  try { openTabs = await browser.tabs.query({}); } catch { return; }
  await Promise.allSettled(openTabs.map(async (tab) => {
    if (tab.id == null) return;
    let owner;
    try { owner = await browser.sessions.getTabValue(tab.id, TAB_OWNER_KEY); } catch { return; }
    if (owner?.jobId && jobIds.has(owner.jobId)) {
      try { await browser.tabs.remove(tab.id); } catch {}
    }
  }));
}

async function loadJobs() {
  if (jobsLoaded) return jobs;
  const obj = await browser.storage.local.get(JOBS_KEY);
  jobs = obj[JOBS_KEY] && typeof obj[JOBS_KEY] === "object" ? obj[JOBS_KEY] : {};
  const interrupted = new Set();
  for (const job of Object.values(jobs)) {
    if (["queued", "preparing", "running", "stopping"].includes(job.state)) {
      interrupted.add(job.id);
      job.state = "interrupted";
      job.finishedAt = iso();
      job.error = "LibreWolf/extension stopped while this job was running";
      if (job.stepProgress?.[job.currentStep]) {
        job.stepProgress[job.currentStep].state = "interrupted";
        job.stepProgress[job.currentStep].finishedAt ||= job.finishedAt;
      }
      for (const task of job.tasks || []) {
        if (["queued", "preparing", "loading", "waiting", "retrying", "running"].includes(task.state)) {
          task.state = "interrupted";
          task.finishedAt ||= job.finishedAt;
          task.error ||= "Extension stopped while this task was running";
        }
      }
    }
  }
  jobsLoaded = true;
  await cleanupPersistedOwnedTabs(interrupted);
  await persistJobs();
  return jobs;
}

function trustedJob(job) {
  if (!job) return null;
  const out = clone(job);
  // Runtime coordination flags are never persisted or exposed to local UI.
  delete out._cancelled;
  delete out._deadline;
  return out;
}

function publicErrorLabel(state, kind = "workflow", hasError = false) {
  const value = String(state || "").toLowerCase();
  if (value === "stopped" || value === "stopping") return kind === "task" ? "Task stopped" : "Workflow stopped";
  if (value === "interrupted") return kind === "task" ? "Task interrupted" : "Workflow interrupted";
  if (value === "failed" || hasError) return kind === "task" ? "Task failed" : "Workflow failed";
  return null;
}

function publicJob(job) {
  if (!job) return null;
  // Jobs may include arbitrary workflow URLs, userscript return values, and
  // browser-derived error text while executing. PCMS-facing job views are an
  // explicit allowlist. Trusted extension diagnostics use trustedJob() instead.
  const stepProgress = Array.isArray(job.stepProgress) ? job.stepProgress.slice(0, 100).map((step) => ({
    index: count(step?.index, 1000),
    state: text(step?.state, 32),
    profileId: text(step?.profileId, 256),
    personaName: text(step?.personaName, 128),
    total: count(step?.total, 100000),
    completed: count(step?.completed, 100000),
    failed: count(step?.failed, 100000),
    stopped: count(step?.stopped, 100000),
    retrying: count(step?.retrying, 100000),
    active: count(step?.active, 100000),
    startedAt: step?.startedAt ? text(step.startedAt, 64) : null,
    finishedAt: step?.finishedAt ? text(step.finishedAt, 64) : null
  })) : [];
  const tasks = Array.isArray(job.tasks) ? job.tasks.slice(-200).map((task) => ({
    id: text(task?.id, 128),
    stepIndex: count(task?.stepIndex, 1000),
    profileId: text(task?.profileId, 256),
    personaName: text(task?.personaName, 128),
    state: text(task?.state, 32),
    attempts: count(task?.attempts, 100),
    retryPolicy: task?.retryPolicy ? { maxRetries: count(task.retryPolicy.maxRetries, 100) } : null,
    completion: task?.completion ? { mode: text(task.completion.mode, 32) } : null,
    startedAt: task?.startedAt ? text(task.startedAt, 64) : null,
    finishedAt: task?.finishedAt ? text(task.finishedAt, 64) : null,
    nextRetryAt: task?.nextRetryAt ? text(task.nextRetryAt, 64) : null,
    error: publicErrorLabel(task?.state, "task", Boolean(task?.error)),
    attemptHistory: Array.isArray(task?.attemptHistory) ? task.attemptHistory.slice(-100).map((attempt) => ({
      attempt: count(attempt?.attempt, 100),
      state: text(attempt?.state, 32),
      startedAt: attempt?.startedAt ? text(attempt.startedAt, 64) : null,
      finishedAt: attempt?.finishedAt ? text(attempt.finishedAt, 64) : null,
      error: attempt?.error ? "Attempt failed" : null
    })) : []
  })) : [];
  return {
    id: text(job.id, 128),
    workflowId: text(job.workflowId, 256),
    workflowName: text(job.workflowName, 200),
    state: text(job.state, 32),
    createdAt: job.createdAt ? text(job.createdAt, 64) : null,
    startedAt: job.startedAt ? text(job.startedAt, 64) : null,
    finishedAt: job.finishedAt ? text(job.finishedAt, 64) : null,
    currentStep: Number.isInteger(job.currentStep) ? job.currentStep : -1,
    totalSteps: count(job.totalSteps, 1000),
    failed: String(job.state || "").toLowerCase() === "failed",
    error: publicErrorLabel(job.state, "workflow", Boolean(job.error)),
    stepProgress,
    tasks
  };
}

function publicJobEvent(job) {
  if (!job) return null;
  return {
    id: text(job.id, 128),
    workflowId: text(job.workflowId, 256),
    workflowName: text(job.workflowName, 200),
    state: text(job.state, 32),
    createdAt: job.createdAt ? text(job.createdAt, 64) : null,
    startedAt: job.startedAt ? text(job.startedAt, 64) : null,
    finishedAt: job.finishedAt ? text(job.finishedAt, 64) : null,
    currentStep: Number.isInteger(job.currentStep) ? job.currentStep : -1,
    totalSteps: count(job.totalSteps, 1000),
    stepProgress: (job.stepProgress || []).map((step) => ({
      index: step.index,
      state: text(step.state, 32),
      profileId: text(step.profileId, 256),
      personaName: text(step.personaName, 128),
      total: count(step.total, 100000),
      completed: count(step.completed, 100000),
      failed: count(step.failed, 100000),
      stopped: count(step.stopped, 100000),
      retrying: count(step.retrying, 100000),
      active: count(step.active, 100000),
      startedAt: step.startedAt ? text(step.startedAt, 64) : null,
      finishedAt: step.finishedAt ? text(step.finishedAt, 64) : null
    }))
  };
}

function emitJobEvent(job) {
  // External executions have a private owner-scoped query surface. Never
  // mirror their progress onto the ordinary workflow event channel.
  if (typeof eventSink !== "function" || !job || job.externalOwner) return;
  try {
    Promise.resolve(eventSink({
      type: ["completed", "failed", "stopped", "interrupted"].includes(job.state) ? "workflow.job.finished" : "workflow.job.changed",
      entity: "workflow.job",
      entityId: job.id,
      data: publicJobEvent(job)
    })).catch(() => {});
  } catch {}
}

async function writeJobs(changedJob = null) {
  const list = Object.values(jobs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const limit = Math.max(10, Math.min(500, Number((await getStateFn?.())?.global?.automation?.historyLimit || MAX_STORED_JOBS)));
  const active = (job) => ["queued", "preparing", "running", "stopping"].includes(job.state);
  const activeCount = list.filter(active).length;
  for (const old of list.filter((job) => !active(job)).slice(Math.max(0, limit - activeCount))) delete jobs[old.id];
  // storage.local is the trusted local diagnostic/history record. Public PCMS
  // queries/events are projected separately through publicJob/publicJobEvent.
  const storedJobs = Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, trustedJob(job)]));
  for (const [id, job] of Object.entries(storedJobs)) {
    if (serializedBytes(job, "Automation job") > MAX_JOB_BYTES) {
      if (jobs[id] === changedJob) throw new Error(`Automation job ${id} exceeds the ${MAX_JOB_BYTES}-byte storage limit`);
      compactHistoricalJob(jobs[id]);
      storedJobs[id] = trustedJob(jobs[id]);
      if (serializedBytes(storedJobs[id], "Automation job") > MAX_JOB_BYTES) {
        throw new Error(`Automation job ${id} exceeds the ${MAX_JOB_BYTES}-byte storage limit after compacting saved details`);
      }
    }
  }
  let historySize = serializedBytes(storedJobs, "Automation history");
  for (const old of [...list].reverse()) {
    if (historySize <= MAX_HISTORY_BYTES) break;
    if (old === changedJob || ["queued", "preparing", "running", "stopping"].includes(old.state)) continue;
    delete jobs[old.id];
    delete storedJobs[old.id];
    historySize = serializedBytes(storedJobs, "Automation history");
  }
  if (historySize > MAX_HISTORY_BYTES) {
    throw new Error(`Automation history exceeds the ${MAX_HISTORY_BYTES}-byte storage limit`);
  }
  await browser.storage.local.set({ [JOBS_KEY]: storedJobs });
  emitJobEvent(changedJob);
}

function persistJobs(changedJob = null) {
  // Every call writes a complete snapshot of the same storage key. Start the
  // next snapshot only after the previous write settles, including failures.
  const pending = persistenceTail.then(() => writeJobs(changedJob));
  persistenceTail = pending.catch(() => {});
  return pending;
}

function normalizeUrls(step) {
  return [...new Set((step.urls || []).map((u) => String(u || "").trim()).filter(Boolean))];
}

function validateHttpUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Automation URL must be http/https: ${raw}`);
  return url.href;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(updated);
      browser.tabs.onRemoved?.removeListener?.(removed);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    function updated(id, changeInfo, tab) {
      if (id === tabId && changeInfo.status === "complete") finish(resolve, tab);
    }
    function removed(id) {
      if (id === tabId) finish(reject, new Error("Automation tab was closed before page load completed"));
    }
    browser.tabs.onUpdated.addListener(updated);
    browser.tabs.onRemoved?.addListener?.(removed);
    timer = setTimeout(() => finish(reject, new Error(`Page load timed out after ${timeoutMs}ms`)), timeoutMs);
    void browser.tabs.get(tabId).then(
      (tab) => { if (tab.status === "complete") finish(resolve, tab); },
      (error) => finish(reject, error)
    );
  });
}

async function waitForSelector(tabId, selector, timeoutMs) {
  if (!selector) throw new Error("Selector completion mode requires a CSS selector");
  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    args: [selector, timeoutMs],
    func: async (sel, timeout) => {
      const find = () => document.querySelector(sel);
      if (find()) return true;
      return new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (find()) { observer.disconnect(); clearTimeout(timer); resolve(true); }
        });
        observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`Selector not found: ${sel}`)); }, timeout);
      });
    }
  });
  return result?.result === true;
}

function makeSignalWaiter(policy, timeoutMs) {
  const expected = new Set(policy.allowedScriptIds || []);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signalWaiters.delete(policy.automationToken);
      reject(new Error(`Userscript completion signal timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signalWaiters.set(policy.automationToken, {
      policy,
      expected,
      completed: new Map(),
      completedBytes: 0,
      resolve: (value) => { clearTimeout(timer); signalWaiters.delete(policy.automationToken); resolve(value); },
      reject: (error) => { clearTimeout(timer); signalWaiters.delete(policy.automationToken); reject(error); }
    });
    const early = [...(policy.earlySignals || [])];
    policy.earlySignals = [];
    if (early.length) queueMicrotask(() => {
      for (const item of early) handleAutomationSignal(item);
    });
  });
}

export function handleAutomationSignal(signal = {}) {
  const policy = tabPolicies.get(Number(signal.tabId));
  if (!policy) return false;
  const scriptId = text(signal.scriptId || "page", 256);
  const expected = new Set(policy.allowedScriptIds || []);
  if (expected.size && !expected.has(scriptId)) return false;
  const waiter = signalWaiters.get(policy.automationToken);
  const failure = signal.status === "failed"
    ? automationFailure(signal.error, Boolean(jobs[policy.jobId]?.externalOwner)) : null;
  if (!waiter) {
    if (policy.completionMode === "signal") {
      policy.earlySignals ||= [];
      if (policy.earlySignals.some((item) => item.status === "failed" || item.scriptId === scriptId) || policy.earlySignals.length >= Math.max(1, expected.size)) return false;
      if (signal.status === "failed") {
        policy.earlySignals = [{ tabId: Number(signal.tabId), scriptId, status: "failed", error: failure.structuredFailure || failure.message }];
        policy.earlySignalBytes = 0;
        return true;
      }
      let json;
      try { json = JSON.stringify(signal.result === undefined ? null : signal.result); }
      catch { json = null; }
      if (typeof json !== "string" || new TextEncoder().encode(json).byteLength > MAX_SIGNAL_RESULT_BYTES) {
        policy.earlySignals = [{ tabId: Number(signal.tabId), scriptId, status: "failed", error: `Userscript completion result exceeds the ${MAX_SIGNAL_RESULT_BYTES}-byte limit` }];
        policy.earlySignalBytes = 0;
        return true;
      }
      const result = JSON.parse(json);
      const packedSize = serializedBytes({ scriptId, result }, "Userscript completion result");
      if ((policy.earlySignalBytes || 0) + packedSize > MAX_SIGNAL_RESULT_BYTES) {
        policy.earlySignals = [{ tabId: Number(signal.tabId), scriptId, status: "failed", error: `Combined userscript completion result exceeds the ${MAX_SIGNAL_RESULT_BYTES}-byte limit` }];
        policy.earlySignalBytes = 0;
        return true;
      }
      policy.earlySignals.push({ tabId: Number(signal.tabId), scriptId, status: "complete", result });
      policy.earlySignalBytes = (policy.earlySignalBytes || 0) + packedSize;
      return true;
    }
    return false;
  }
  if (signal.status === "failed") {
    waiter.reject(failure);
    return true;
  }
  let json;
  try { json = JSON.stringify(signal.result === undefined ? null : signal.result); }
  catch { json = null; }
  if (typeof json !== "string") {
    waiter.reject(new Error("Userscript completion result must be JSON-serializable"));
    return true;
  }
  const result = JSON.parse(json);
  const packedSize = serializedBytes({ scriptId, result }, "Userscript completion result");
  const previous = waiter.completed.has(scriptId)
    ? serializedBytes({ scriptId, result: waiter.completed.get(scriptId) }, "Userscript completion result")
    : 0;
  if (packedSize > MAX_SIGNAL_RESULT_BYTES || waiter.completedBytes - previous + packedSize > MAX_SIGNAL_RESULT_BYTES) {
    waiter.reject(new Error(`Combined userscript completion result exceeds the ${MAX_SIGNAL_RESULT_BYTES}-byte limit`));
    return true;
  }
  waiter.completedBytes = waiter.completedBytes - previous + packedSize;
  waiter.completed.set(scriptId, result);
  if (!waiter.expected.size || [...waiter.expected].every((id) => waiter.completed.has(id))) {
    waiter.resolve(Object.fromEntries(waiter.completed));
  }
  return true;
}

export function handlePageAutomationSignal(sender, message = {}) {
  // Page-world postMessage data is controlled by the site. Completion may only
  // arrive over the isolated user-script runtime port.
  void sender;
  void message;
  return false;
}

export function getAutomationTabPolicy(tabId) {
  const p = tabPolicies.get(Number(tabId));
  return p ? { ...p, allowedScriptIds: [...p.allowedScriptIds] } : null;
}

// Read-only context bridge for an already-running external artifact. The
// browser tab ID is used only to locate and verify the live in-memory policy;
// it is never included in the returned context.
export async function getExternalExecutionContext(tabId, scriptId) {
  const id = Number(tabId);
  const sourceId = String(scriptId || "");
  if (!Number.isSafeInteger(id) || id < 0 || !sourceId || sourceId.length > 256) return null;
  const policy = tabPolicies.get(id);
  if (!policy || !policy.allowedScriptIds?.includes(sourceId)) return null;
  const job = jobs[policy.jobId];
  if (!job?.externalOwner) return null;
  const task = (job.tasks || []).find((entry) => entry.id === policy.taskId && entry.tabId === id);
  if (!task || !["loading", "waiting", "running"].includes(task.state)) return null;
  const state = await getStateFn();
  const artifactId = state.scripts?.[sourceId]?.externalArtifact?.artifactId;
  if (typeof artifactId !== "string" || !artifactId) return null;
  return {
    senderId: job.externalOwner.senderId,
    executionId: job.externalOwner.executionId,
    taskId: task.id,
    stepId: policy.stepId,
    artifactId
  };
}

async function tagAutomationTab(tabId, policy) {
  if (typeof browser.sessions?.setTabValue !== "function") {
    throw new Error("Automation requires Firefox tab session ownership tagging");
  }
  await browser.sessions.setTabValue(tabId, TAB_OWNER_KEY, {
    jobId: policy.jobId,
    taskId: policy.taskId,
    profileId: policy.profileId,
    createdAt: iso()
  });
}

async function untagAutomationTab(tabId) {
  if (!browser.sessions?.removeTabValue) return;
  try { await browser.sessions.removeTabValue(tabId, TAB_OWNER_KEY); } catch {}
}

async function releaseAutomationOwnership(tabId) {
  clearAutomationTab(tabId);
  await untagAutomationTab(tabId);
}

async function acquireGlobalTabSlot(job, limit) {
  const cap = Math.max(1, Number(limit) || 1);
  while (activeTabSlots >= cap) {
    if (job._cancelled) throw new Error("Job stopped");
    if (job._deadline && Date.now() >= job._deadline) throw new Error("Job exceeded maximum runtime");
    await sleep(50);
  }
  activeTabSlots += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeTabSlots = Math.max(0, activeTabSlots - 1);
  };
}

function remainingTimeout(job, requestedMs) {
  const requested = Math.max(1, Number(requestedMs) || 1);
  if (!job._deadline) return requested;
  const remaining = job._deadline - Date.now();
  if (remaining <= 0) throw new Error("Job exceeded maximum runtime");
  return Math.max(1, Math.min(requested, remaining));
}

async function interruptibleSleep(job, ms) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < end) {
    if (job._cancelled) throw new Error("Job stopped");
    const remaining = remainingTimeout(job, end - Date.now());
    await sleep(Math.min(250, remaining));
  }
}

export function clearAutomationTab(tabId) {
  const id = Number(tabId);
  const policy = tabPolicies.get(id);
  if (policy) {
    const waiter = signalWaiters.get(policy.automationToken);
    if (waiter) waiter.reject(new Error("Automation tab was closed"));
  }
  tabPolicies.delete(id);
}

async function closeOwnedTab(tabId) {
  clearAutomationTab(tabId);
  await untagAutomationTab(tabId);
  try { await browser.tabs.remove(tabId); } catch {}
}

function syncStepProgress(job, stepIndex) {
  const progress = job.stepProgress?.[stepIndex];
  if (!progress) return;
  const tasks = (job.tasks || []).filter((task) => task.stepIndex === stepIndex);
  progress.completed = tasks.filter((task) => task.state === "completed").length;
  progress.failed = tasks.filter((task) => task.state === "failed").length;
  progress.stopped = tasks.filter((task) => task.state === "stopped").length;
  progress.retrying = tasks.filter((task) => task.state === "retrying").length;
  progress.active = tasks.filter((task) => ["opening", "loading", "waiting"].includes(task.state)).length;
}

function readinessSnapshot(readiness, step) {
  const profile = readiness?.profile || null;
  const route = readiness?.route || null;
  return {
    profileId: step.profileId,
    personaName: profile?.name || step.profileId,
    route: {
      mode: readiness?.mode || (route ? "proxy" : "unknown"),
      id: route?.id || null,
      name: route?.name || (readiness?.mode === "direct" ? "DIRECT" : null),
      provider: route?.provider || (readiness?.mode === "direct" ? "direct" : null),
      host: route?.host || null,
      port: route?.port || null
    }
  };
}

async function processTask(job, step, stepIndex, url, taskIndex, globalLimit, stepContext) {
  const taskId = `${stepIndex + 1}-${taskIndex + 1}`;
  const retries = Math.max(0, Math.min(10, Number(step.retries || 0)));
  const retryDelayMs = Math.max(0, Math.min(10 * 60_000, Number(step.retryDelayMs ?? 1000)));
  const configuredTimeout = Math.max(1000, Math.min(MAX_WORKFLOW_STEP_TIMEOUT_MS, Number(step.completion?.timeoutMs || 60_000)));
  const task = {
    id: taskId,
    stepIndex,
    url,
    profileId: step.profileId,
    personaName: stepContext?.personaName || step.profileId,
    route: clone(stepContext?.route || null),
    completion: clone(step.completion || { mode: "load", value: "", timeoutMs: configuredTimeout }),
    retryPolicy: { maxRetries: retries, retryDelayMs },
    state: "queued",
    attempts: 0,
    attemptHistory: [],
    nextRetryAt: null,
    tabId: null,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null
  };
  job.tasks.push(task);
  syncStepProgress(job, stepIndex);

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (job._cancelled) throw new Error("Job stopped");
    remainingTimeout(job, configuredTimeout);
    task.attempts = attempt + 1;
    task.startedAt ||= iso();
    task.state = "opening";
    task.error = null;
    delete task.structuredFailure;
    delete task.failureOmitted;
    task.nextRetryAt = null;
    const attemptRecord = { attempt: attempt + 1, state: "opening", startedAt: iso(), finishedAt: null, tabId: null, error: null };
    task.attemptHistory.push(attemptRecord);
    syncStepProgress(job, stepIndex);
    await persistJobs(job);

    const releaseSlot = await acquireGlobalTabSlot(job, globalLimit);
    let tab = null;
    let policy = null;
    let ownershipTagged = false;
    try {
      const href = validateHttpUrl(url);
      tab = await browser.tabs.create({ url: "about:blank", active: false, cookieStoreId: step.profileId });
      task.tabId = tab.id;
      attemptRecord.tabId = tab.id;
      if (job._cancelled) throw new Error("Job stopped");
      const token = crypto.randomUUID();
      const mode = step.completion?.mode || "load";
      policy = {
        jobId: job.id,
        taskId,
        stepId: step.id,
        profileId: step.profileId,
        allowedScriptIds: [...(step.scriptIds || [])],
        automationToken: token,
        completionMode: mode,
        keepOnSuccess: step.closeTabs === false,
        earlySignals: [],
        earlySignalBytes: 0
      };
      tabPolicies.set(tab.id, policy);
      await tagAutomationTab(tab.id, policy);
      ownershipTagged = true;
      if (job._cancelled) throw new Error("Job stopped");
      task.state = "loading";
      attemptRecord.state = "loading";
      syncStepProgress(job, stepIndex);
      await browser.tabs.update(tab.id, { url: href });
      if (job._cancelled) throw new Error("Job stopped");

      if (mode === "signal") {
        task.state = "waiting";
        attemptRecord.state = "waiting";
        syncStepProgress(job, stepIndex);
        await persistJobs(job);
        task.result = await makeSignalWaiter(policy, remainingTimeout(job, configuredTimeout));
        if (serializedBytes(trustedJob(job), "Automation job") > MAX_JOB_BYTES) {
          task.result = null;
          throw new Error(`Automation results exceed the ${MAX_JOB_BYTES}-byte job storage limit`);
        }
      } else {
        await waitForTabComplete(tab.id, remainingTimeout(job, configuredTimeout));
        task.state = "waiting";
        attemptRecord.state = "waiting";
        syncStepProgress(job, stepIndex);
        await persistJobs(job);
        if (mode === "delay") {
          const delay = Math.max(0, Math.min(10 * 60_000, Number(step.completion?.value || 1000)));
          await interruptibleSleep(job, delay);
        } else if (mode === "selector") {
          await waitForSelector(tab.id, String(step.completion?.value || ""), remainingTimeout(job, configuredTimeout));
        }
      }

      if (job._cancelled) throw new Error("Job stopped");
      task.state = "completed";
      task.finishedAt = iso();
      attemptRecord.state = "completed";
      attemptRecord.finishedAt = task.finishedAt;
      syncStepProgress(job, stepIndex);
      await persistJobs(job);
      if (job._cancelled) throw new Error("Job stopped");
      if (tab?.id != null) {
        if (step.closeTabs !== false) await closeOwnedTab(tab.id);
        else await releaseAutomationOwnership(tab.id);
      }
      if (job._cancelled) throw new Error("Job stopped");
      return task;
    } catch (error) {
      task.error = text(error?.message || error, 2048);
      if (job.externalOwner && error?.structuredFailure) {
        task.structuredFailure = error.structuredFailure;
        if (serializedBytes(trustedJob(job), "Automation job") > MAX_JOB_BYTES) {
          delete task.structuredFailure;
          task.failureOmitted = true;
        }
      }
      attemptRecord.error = task.error;
      attemptRecord.finishedAt = iso();
      const finalAttempt = attempt >= retries;
      if (tab?.id != null) {
        if (!ownershipTagged || !finalAttempt || step.closeTabs !== false || job._cancelled) await closeOwnedTab(tab.id);
        else await releaseAutomationOwnership(tab.id);
      }
      if (finalAttempt) {
        task.state = job._cancelled ? "stopped" : "failed";
        task.finishedAt = iso();
        attemptRecord.state = task.state;
        syncStepProgress(job, stepIndex);
        await persistJobs(job);
        if (step.stopOnError !== false) throw error;
        return task;
      }
      task.state = "retrying";
      attemptRecord.state = "failed";
      task.nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
      syncStepProgress(job, stepIndex);
      await persistJobs(job);
      try {
        await interruptibleSleep(job, retryDelayMs);
      } catch (sleepError) {
        task.state = "stopped";
        task.finishedAt = iso();
        task.nextRetryAt = null;
        task.error = text(sleepError?.message || sleepError, 2048);
        syncStepProgress(job, stepIndex);
        await persistJobs(job);
        throw sleepError;
      }
    } finally {
      releaseSlot();
    }
  }
  return task;
}

async function runPool(job, step, stepIndex, urls, stepContext) {
  const state = await getStateFn();
  const perStepMax = Math.max(1, Number(state.global?.automation?.maxTabsPerStep || 20));
  const totalMax = Math.max(1, Number(state.global?.automation?.maxTabsTotal || 40));
  const concurrency = Math.max(1, Math.min(perStepMax, totalMax, Number(step.concurrency || 1), urls.length || 1));
  let next = 0;
  let firstError = null;
  async function worker() {
    while (next < urls.length && !job._cancelled && !(firstError && step.stopOnError !== false)) {
      const index = next++;
      try { await processTask(job, step, stepIndex, urls[index], index, totalMax, stepContext); }
      catch (error) { firstError ||= error; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (firstError && step.stopOnError !== false) throw firstError;
}

async function executeJob(job, workflow) {
  const state = await getStateFn();
  const maxMinutes = Math.max(1, Math.min(24 * 60, Number(state.global?.automation?.maxJobRuntimeMinutes || 60)));
  const deadline = Date.now() + maxMinutes * 60_000;
  job._deadline = deadline;
  try {
    job.state = "preparing";
    job.startedAt = iso();
    await persistJobs(job);
    for (let i = 0; i < workflow.steps.length; i++) {
      if (job._cancelled) throw new Error("Job stopped");
      if (Date.now() > deadline) throw new Error(`Job exceeded maximum runtime of ${maxMinutes} minutes`);
      const step = workflow.steps[i];
      const progress = job.stepProgress[i];
      job.currentStep = i;
      job.state = "preparing";
      progress.state = "preparing";
      progress.startedAt ||= iso();
      await persistJobs(job);
      const readiness = await ensureProfileReadyFn(step.profileId);
      if (job._cancelled) throw new Error("Job stopped");
      const stepContext = readinessSnapshot(readiness, step);
      progress.personaName = stepContext.personaName;
      progress.route = clone(stepContext.route);
      job.state = "running";
      progress.state = "running";
      await persistJobs(job);
      await runPool(job, step, i, normalizeUrls(step), stepContext);
      if (job._cancelled) throw new Error("Job stopped");
      progress.state = "completed";
      progress.finishedAt = iso();
      syncStepProgress(job, i);
      await persistJobs(job);
    }
    if (job._cancelled) throw new Error("Job stopped");
    job.state = "completed";
    job.finishedAt = iso();
  } catch (error) {
    job.state = job._cancelled ? "stopped" : "failed";
    job.error = text(error?.message || error, 2048);
    job.finishedAt = iso();
    const progress = job.stepProgress?.[job.currentStep];
    if (progress && (job._cancelled || !["completed", "failed", "stopped"].includes(progress.state))) {
      progress.state = job._cancelled ? "stopped" : "failed";
      progress.finishedAt = iso();
      syncStepProgress(job, job.currentStep);
    }
  } finally {
    for (const [tabId, policy] of [...tabPolicies.entries()]) {
      if (policy.jobId !== job.id) continue;
      if (job.state === "completed" && policy.keepOnSuccess) await releaseAutomationOwnership(tabId);
      else await closeOwnedTab(tabId);
    }
    delete job._deadline;
    activeRunners.delete(job.id);
    await persistJobs(job);
  }
}

async function admitAndRun(workflow, workflowId, externalOwner = null, admissionGuard = null) {
  const state = await getStateFn();
  validateWorkflowForRun(workflow, state);
  if (!externalOwner) {
    // Externally managed code is executable only through the owner-scoped
    // Integration API path, which supplies the trusted externalOwner record.
    // Enforce this at shared admission so saved, local, and API workflows
    // cannot bypass leases, input scoping, or owner-only result handling.
    for (const step of workflow.steps || []) {
      for (const scriptId of step.scriptIds || []) {
        if (!state.scripts?.[scriptId]?.externalArtifact) continue;
        const error = new Error("External artifacts may only run through External Automation");
        error.code = "EXTERNAL_ARTIFACT_REQUIRES_EXTERNAL_EXECUTION";
        throw error;
      }
    }
  }
  if (serializedBytes(workflow, "Workflow definition") > MAX_WORKFLOW_INPUT_BYTES) {
    throw new Error(`Workflow definition exceeds the ${MAX_WORKFLOW_INPUT_BYTES}-byte input limit`);
  }
  const activeJobs = Object.values(jobs).filter((job) => ["queued", "preparing", "running", "stopping"].includes(job.state));
  if (activeJobs.length >= MAX_CONCURRENT_JOBS) {
    throw new Error(`At most ${MAX_CONCURRENT_JOBS} automation jobs may run concurrently; wait for or stop a job before starting another`);
  }
  // External callers may hold Persona locks while admission awaits state and
  // storage. Recheck their fencing condition synchronously at the actual
  // admission boundary, after all validation and immediately before insertion.
  admissionGuard?.();
  const id = `job-${crypto.randomUUID().slice(0, 12)}`;
  const job = jobs[id] = {
    id,
    workflowId,
    workflowName: workflow.name,
    ...(externalOwner ? { externalOwner } : {}),
    state: "queued",
    createdAt: iso(),
    startedAt: null,
    finishedAt: null,
    currentStep: -1,
    totalSteps: workflow.steps.length,
    error: null,
    stepProgress: workflow.steps.map((step, index) => ({
      index,
      id: text(step.id, 128),
      state: "queued",
      profileId: step.profileId,
      personaName: null,
      route: null,
      completion: clone(step.completion || { mode: "load", value: "", timeoutMs: 60000 }),
      total: normalizeUrls(step).length,
      completed: 0,
      failed: 0,
      stopped: 0,
      retrying: 0,
      active: 0,
      startedAt: null,
      finishedAt: null
    })),
    tasks: [],
    _cancelled: false
  };
  try { await persistJobs(job); }
  catch (error) {
    delete jobs[id];
    throw error;
  }
  // Persistence itself can be slow enough for an external lease to expire.
  // Keep the runner from starting if its fence was lost while the queued record
  // was being durably written, and remove that record from saved history.
  try { admissionGuard?.(); }
  catch (error) {
    delete jobs[id];
    try { await persistJobs(); } catch { /* The stale queued record cannot run. */ }
    throw error;
  }
  const runner = executeJob(job, clone(workflow));
  activeRunners.set(id, runner);
  // A failed terminal storage write must not leave an unhandled runner
  // rejection. Retry the terminal state once, then keep the runner settled.
  void runner.catch((error) => {
    job.state = "failed";
    job.error = text(error?.message || error, 2048);
    job.finishedAt ||= iso();
    activeRunners.delete(id);
    void persistJobs(job).catch(() => {});
  });
  return publicJob(job);
}

export async function runWorkflow(workflowId) {
  await loadJobs();
  const state = await getStateFn();
  const workflow = state.workflows?.[workflowId];
  if (!workflow) throw new Error("Workflow not found");
  return admitAndRun(workflow, workflowId);
}

function normalizeExternalOwner(value = {}) {
  const senderId = String(value.senderId || "").trim();
  const executionId = String(value.executionId || "").trim();
  const operationId = String(value.operationId || "").trim();
  const requestFingerprint = String(value.requestFingerprint || "").trim();
  if (!senderId || senderId.length > 256) throw new Error("External execution sender is invalid");
  if (!executionId || executionId.length > 128) throw new Error("External execution ID is invalid");
  if (operationId.length > 256) throw new Error("External operation ID is invalid");
  if (requestFingerprint.length > 256) throw new Error("External request fingerprint is invalid");
  return {
    senderId,
    executionId,
    ...(operationId ? { operationId } : {}),
    ...(requestFingerprint ? { requestFingerprint } : {})
  };
}

function externalJobFor(senderId, executionId) {
  return Object.values(jobs).find((job) => job.externalOwner?.senderId === senderId && job.externalOwner?.executionId === executionId) || null;
}

function externalJobView(job) {
  if (!job) return null;
  const out = publicJob(job);
  out.executionId = job.externalOwner.executionId;
  if (job.externalOwner.operationId) out.operationId = job.externalOwner.operationId;
  out.stepProgress = out.stepProgress.map((stepProgress, index) => ({
    ...stepProgress,
    stepId: text(job.stepProgress?.[index]?.id, 128)
  }));
  if (job.acknowledgedAt) out.acknowledged = true;
  return out;
}

function externalOperationConflict(message = "Operation ID was already used for a different request") {
  const error = new Error(message);
  error.code = "OPERATION_CONFLICT";
  error.status = 409;
  return error;
}

// `plan` is ephemeral and is never inserted into state.workflows. Ownership is
// stamped from this internal argument, not read from plan fields.
export async function runExternalExecution(plan, owner = {}, admissionGuard = null) {
  if (admissionGuard !== null && typeof admissionGuard !== "function") {
    throw new Error("External execution admission guard must be a function");
  }
  await loadJobs();
  const externalOwner = normalizeExternalOwner(owner);
  const existing = externalJobFor(externalOwner.senderId, externalOwner.executionId);
  if (existing) {
    if (existing.externalOwner.operationId !== externalOwner.operationId ||
        existing.externalOwner.requestFingerprint !== externalOwner.requestFingerprint) {
      throw externalOperationConflict("Execution ID was already used for a different request");
    }
    return externalJobView(existing);
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("External execution plan is invalid");
  const workflow = clone(plan);
  const workflowId = `external-${externalOwner.executionId}`;
  workflow.id = workflowId;
  workflow.name = text(workflow.name || `External execution ${externalOwner.executionId}`, 200);
  validateWorkflowForRun(workflow, await getStateFn());
  return admitAndRun(workflow, workflowId, externalOwner, admissionGuard);
}

export async function listExternalExecutions(senderId, limit = 50) {
  await loadJobs();
  const owner = String(senderId || "");
  return Object.values(jobs)
    .filter((job) => job.externalOwner?.senderId === owner)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
    .map(externalJobView);
}

export async function getExternalExecution(senderId, executionId) {
  await loadJobs();
  return externalJobView(externalJobFor(String(senderId || ""), String(executionId || "")));
}

export async function findExternalExecutionByOperation(senderId, operationId, requestFingerprint) {
  await loadJobs();
  const ownerId = String(senderId || "");
  const opId = String(operationId || "");
  if (!ownerId || !opId) return null;
  const job = Object.values(jobs).find((entry) => entry.externalOwner?.senderId === ownerId && entry.externalOwner?.operationId === opId);
  if (!job) return null;
  const fingerprint = String(requestFingerprint || "").trim();
  if (job.externalOwner.requestFingerprint !== fingerprint) throw externalOperationConflict();
  return externalJobView(job);
}

// Compatibility name used by trusted extension call sites.
export const getExternalExecutionByOperation = findExternalExecutionByOperation;

export async function getExternalExecutionResult(senderId, executionId) {
  await loadJobs();
  const job = externalJobFor(String(senderId || ""), String(executionId || ""));
  if (!job) return null;
  const acknowledged = Boolean(job.acknowledgedAt);
  const result = {
    executionId: job.externalOwner.executionId,
    ...(job.externalOwner.operationId ? { operationId: job.externalOwner.operationId } : {}),
    state: text(job.state, 32),
    acknowledged,
    tasks: [],
    truncated: (job.tasks?.length || 0) > 200
  };
  if (acknowledged) return result;
  for (const task of (job.tasks || []).slice(0, 200)) {
    const item = {
      taskId: text(task.id, 128),
      stepIndex: count(task.stepIndex, 1000),
      state: text(task.state, 32),
      error: publicErrorLabel(task.state, "task", Boolean(task.error))
    };
    if (task.structuredFailure !== undefined) {
      let failure;
      try { failure = normalizeStructuredAutomationFailure(task.structuredFailure); } catch {}
      const candidate = { ...item, failure };
      if (failure && serializedBytes(failure) <= MAX_STRUCTURED_FAILURE_BYTES
          && serializedBytes({ ...result, tasks: [...result.tasks, candidate] }) <= MAX_EXTERNAL_RESULT_BYTES) item.failure = failure;
      else { item.failureOmitted = true; result.truncated = true; }
    } else if (task.failureOmitted) { item.failureOmitted = true; result.truncated = true; }
    if (task.result !== undefined && task.result !== null) {
      let value;
      try { value = clone(task.result); } catch { value = null; }
      const candidate = { ...item, result: value };
      const candidateBytes = serializedBytes(candidate, "External execution result");
      if (candidateBytes <= MAX_SIGNAL_RESULT_BYTES && serializedBytes({ ...result, tasks: [...result.tasks, candidate] }) <= MAX_EXTERNAL_RESULT_BYTES) {
        item.result = value;
      } else {
        item.resultOmitted = true;
        result.truncated = true;
      }
    }
    if (serializedBytes({ ...result, tasks: [...result.tasks, item] }) > MAX_EXTERNAL_RESULT_BYTES) {
      result.truncated = true;
      break;
    }
    result.tasks.push(item);
  }
  return result;
}

export async function stopExternalExecution(senderId, executionId) {
  await loadJobs();
  const job = externalJobFor(String(senderId || ""), String(executionId || ""));
  if (!job) throw new Error("Execution not found");
  if (["queued", "preparing", "running"].includes(job.state)) {
    job._cancelled = true;
    job.state = "stopping";
    if (job.stepProgress?.[job.currentStep] && !["completed", "failed", "stopped"].includes(job.stepProgress[job.currentStep].state)) {
      job.stepProgress[job.currentStep].state = "stopping";
    }
    for (const [tabId, policy] of [...tabPolicies.entries()]) if (policy.jobId === job.id) await closeOwnedTab(tabId);
    await persistJobs(job);
  }
  return externalJobView(job);
}

export async function acknowledgeExternalExecution(senderId, executionId) {
  await loadJobs();
  const job = externalJobFor(String(senderId || ""), String(executionId || ""));
  if (!job) throw new Error("Execution not found");
  if (!["completed", "failed", "stopped", "interrupted"].includes(String(job.state).toLowerCase())) {
    const error = new Error("Execution results cannot be acknowledged until the execution is terminal");
    error.code = "EXECUTION_NOT_TERMINAL";
    error.status = 409;
    throw error;
  }
  job.acknowledgedAt ||= iso();
  for (const task of job.tasks || []) {
    if (task.structuredFailure !== undefined) {
      delete task.structuredFailure;
      task.failureOmitted = true;
    }
    if (task.result !== undefined) {
      delete task.result;
      task.resultOmitted = true;
    }
  }
  await persistJobs(job);
  return externalJobView(job);
}

export async function focusExternalExecution(senderId, executionId, taskId = "") {
  await loadJobs();
  const job = externalJobFor(String(senderId || ""), String(executionId || ""));
  if (!job) throw new Error("Execution not found");
  const candidates = (job.tasks || []).filter((entry) => (!taskId || entry.id === taskId)
    && ["opening", "loading", "waiting"].includes(entry.state));
  for (const task of candidates) {
    const tabId = task.tabId;
    const policy = tabPolicies.get(tabId);
    if (tabId == null || policy?.jobId !== job.id || policy?.taskId !== task.id) continue;
    let owner;
    try {
      owner = await browser.sessions.getTabValue(tabId, TAB_OWNER_KEY);
      await browser.tabs.get(tabId);
    } catch { continue; }
    // A completed earlier task may still have a saved tab ID. Focus only a
    // currently owned task, and recheck after the asynchronous browser reads.
    if (owner?.jobId !== job.id || owner?.taskId !== task.id
        || tabPolicies.get(tabId) !== policy || !["opening", "loading", "waiting"].includes(task.state)) continue;
    try { await browser.tabs.update(tabId, { active: true }); }
    catch { continue; }
    // Cancellation or task completion may race the asynchronous focus call.
    // Never report a focus success after ownership has been released.
    if (job._cancelled || tabPolicies.get(tabId) !== policy
        || !["opening", "loading", "waiting"].includes(task.state)) continue;
    return { executionId: job.externalOwner.executionId, focused: true };
  }
  throw new Error("Execution has no active owned tab to focus");
}

export async function stopJob(jobId) {
  await loadJobs();
  const job = jobs[jobId];
  if (!job || job.externalOwner) throw new Error("Job not found");
  if (!["queued", "preparing", "running"].includes(job.state)) return publicJob(job);
  job._cancelled = true;
  job.state = "stopping";
  if (job.stepProgress?.[job.currentStep] && !["completed", "failed", "stopped"].includes(job.stepProgress[job.currentStep].state)) {
    job.stepProgress[job.currentStep].state = "stopping";
  }
  for (const [tabId, policy] of [...tabPolicies.entries()]) if (policy.jobId === jobId) await closeOwnedTab(tabId);
  await persistJobs(job);
  return publicJob(job);
}

export async function listJobs(limit = 50) {
  await loadJobs();
  return Object.values(jobs)
    .filter((job) => !job.externalOwner)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
    .map(publicJob);
}

// Internal control-plane query. This deliberately exposes only the set of
// active Persona container IDs needed to fence lease admission; public job
// projections continue to omit the full workflow's future Persona targets.
export async function listActiveProfileIds() {
  await loadJobs();
  return [...new Set(Object.values(jobs)
    .filter((job) => ["queued", "preparing", "running", "stopping"].includes(String(job.state).toLowerCase()))
    .flatMap((job) => (job.stepProgress || []).map((step) => String(step?.profileId || "")).filter(Boolean)))];
}

export async function getJob(jobId) {
  await loadJobs();
  return jobs[jobId]?.externalOwner ? null : publicJob(jobs[jobId]);
}

export async function listJobsTrusted(limit = 50) {
  await loadJobs();
  return Object.values(jobs)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
    .map(trustedJob);
}

export async function getJobTrusted(jobId) {
  await loadJobs();
  return trustedJob(jobs[jobId]);
}

export async function clearFinishedJobs() {
  await loadJobs();
  for (const [id, job] of Object.entries(jobs)) {
    if (!job.externalOwner && !["queued", "preparing", "running", "stopping"].includes(job.state)) delete jobs[id];
  }
  await persistJobs();
  return [];
}

export async function remapAutomationProfileReferences(sourceProfileId, targetProfileId) {
  const sourceId = String(sourceProfileId || "");
  const targetId = String(targetProfileId || "");
  if (!sourceId || !targetId || sourceId === targetId) return false;
  await loadJobs();
  let changed = false;
  for (const job of Object.values(jobs)) {
    if (job.profileId === sourceId) { job.profileId = targetId; changed = true; }
    for (const task of job.tasks || []) {
      if (task.profileId === sourceId) { task.profileId = targetId; changed = true; }
    }
    for (const progress of job.stepProgress || []) {
      if (progress.profileId === sourceId) { progress.profileId = targetId; changed = true; }
    }
  }
  if (changed) await persistJobs();
  return changed;
}

export async function replaceJobsTrusted(nextJobs = {}) {
  await loadJobs();
  const activeStates = new Set(["queued", "preparing", "running", "stopping"]);
  const preservedJobs = Object.fromEntries(
    Object.entries(jobs)
      .filter(([, job]) => activeStates.has(job?.state) || job?.externalOwner)
      .map(([id, job]) => [id, job])
  );

  const source = Array.isArray(nextJobs) ? nextJobs : Object.values(nextJobs || {});
  const imported = {};
  for (const value of source) {
    // External ownership is admission provenance, never portable history.
    if (value?.externalOwner) continue;
    const job = trustedJob(value);
    const id = String(job?.id || "").trim();
    if (!id || activeStates.has(job?.state)) continue;
    imported[id] = { ...job, id };
  }

  // Ordinary history import must preserve live runners and private external
  // results, including terminal records awaiting owner acknowledgement.
  jobs = { ...imported, ...preservedJobs };
  jobsLoaded = true;
  await persistJobs();
  return listJobs(200);
}

export async function configureOrchestrator({ getState, ensureProfileReady, onJobEvent } = {}) {
  getStateFn = getState || getStateFn;
  ensureProfileReadyFn = ensureProfileReady || ensureProfileReadyFn;
  eventSink = onJobEvent || eventSink;
  if (!getStateFn || !ensureProfileReadyFn) throw new Error("Orchestrator requires getState and ensureProfileReady callbacks");
  if (configured) return;
  configured = true;
  await loadJobs();
}
