import { toast } from "./toast.js";
import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "../lib/constants.js";
import { buildDiagnosticsBundle } from "../lib/diagnostics.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
})[ch]);

let lastSnapshot = null;
let lastJobs = [];
let refreshPromise = null;
let visibleJobLimit = 25;

function isActiveJob(job) {
  return ["queued", "preparing", "running", "stopping", "retrying"].includes(String(job?.state || "").toLowerCase());
}

async function msg(type, extra = {}) {
  return browser.runtime.sendMessage({ type, ...extra });
}

function formatDuration(start, end) {
  const startMs = Date.parse(start || "");
  if (!Number.isFinite(startMs)) return "—";
  const endMs = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(endMs)) return "—";
  const ms = Math.max(0, endMs - startMs);
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
}

function friendlyState(value) {
  const raw = String(value || "unknown").replace(/[_-]+/g, " ").trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Unknown";
}

function friendlyRoute(value) {
  if (value === "DIRECT") return "Direct network";
  if (value === "BLOCK") return "Blocked";
  return value || "Unknown";
}

function completionLabel(value) {
  const completion = value?.completion || value || {};
  const mode = completion.mode || "load";
  const raw = String(completion.value || "").trim();
  if (mode === "delay") return `Delay ${raw || "1000"} ms after load`;
  if (mode === "selector") return `Selector ${raw || "(missing)"}`;
  if (mode === "signal") return "Userscript Persona.complete() signal";
  return "Page load";
}

function stepForTask(job, task) {
  const workflow = lastSnapshot?.state?.workflows?.[job.workflowId];
  const stepIndex = Number.isInteger(task.stepIndex)
    ? task.stepIndex
    : Math.max(0, Number(String(task.id || "1").split("-")[0] || 1) - 1);
  return { workflow, step: workflow?.steps?.[stepIndex] || null, stepIndex };
}

function currentRouteInfo(step) {
  if (!step) return { persona: "Unknown", route: "Unknown", routeId: null, provider: null, containerId: null };
  const profile = lastSnapshot?.state?.profiles?.[step.profileId];
  if (!profile) return { persona: step.profileId || "Unassigned", route: "Persona unavailable", routeId: null, provider: null, containerId: step.profileId || null };
  if (profile.routeId === BLOCK_ROUTE_ID) return { persona: profile.name || profile.containerId, route: "BLOCK", routeId: BLOCK_ROUTE_ID, provider: "block", containerId: profile.containerId };
  if (profile.routeId === DIRECT_ROUTE_ID) return { persona: profile.name || profile.containerId, route: "DIRECT", routeId: DIRECT_ROUTE_ID, provider: "direct", containerId: profile.containerId };
  const route = lastSnapshot?.state?.routes?.[profile.routeId];
  if (!route) return { persona: profile.name || profile.containerId, route: `Missing route (${profile.routeId})`, routeId: profile.routeId, provider: null, containerId: profile.containerId };
  return {
    persona: profile.name || profile.containerId,
    route: route.name || route.id,
    routeId: route.id,
    provider: route.provider || route.type || null,
    containerId: profile.containerId
  };
}

function routeInfoForTask(task, step) {
  if (task?.route || task?.personaName || task?.profileId) {
    const route = task.route || {};
    const routeName = route.name || (route.mode === "direct" ? "DIRECT" : route.mode === "block" ? "BLOCK" : route.id || "Unknown");
    return {
      persona: task.personaName || task.profileId || "Unknown",
      route: routeName,
      routeId: route.id || null,
      provider: route.provider || route.mode || null,
      containerId: task.profileId || null
    };
  }
  return currentRouteInfo(step);
}

function renderSummary() {
  const el = $("diagnosticsSummary");
  if (!el || !lastSnapshot) return;
  const security = lastSnapshot.security || {};
  const active = lastJobs.filter((job) => ["queued", "preparing", "running", "stopping"].includes(job.state)).length;
  const failed = lastJobs.filter((job) => job.state === "failed").length;
  const lastProxy = security.lastProxyError;
  const lastBlock = security.lastBlock;
  el.innerHTML = [
    ["Fail-closed policy", security.ready && (!lastSnapshot.state.global.enforcePrivacyControls || security.privacySafe) ? "Ready" : "Not ready"],
    ["Automation jobs", `${active} active · ${failed} failed · ${lastJobs.length} shown`],
    ["Last proxy error", lastProxy ? `${lastProxy.message} · ${formatTime(lastProxy.at)}` : "None"],
    ["Last blocked request", lastBlock ? `${lastBlock.reason} · ${formatTime(lastBlock.at)}` : "None"]
  ].map(([label, value]) => `<div class="status-card"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join("");
}

function renderAttemptHistory(task) {
  const attempts = task.attemptHistory || [];
  if (!attempts.length) return "";
  return `<details class="attempt-history diagnostic-technical"><summary>${attempts.length} attempt${attempts.length === 1 ? "" : "s"}</summary>
    <div class="attempt-list">${attempts.map((attempt) => `<div class="attempt-row">
      <span><b>#${esc(attempt.attempt)}</b> ${esc(friendlyState(attempt.state))}</span>
      <span>tab ${attempt.tabId == null ? "—" : esc(attempt.tabId)}</span>
      <span>${esc(formatDuration(attempt.startedAt, attempt.finishedAt))}</span>
      ${attempt.error ? `<small>${esc(attempt.error)}</small>` : ""}
    </div>`).join("")}</div>
  </details>`;
}

function renderStepProgress(job) {
  const progress = job.stepProgress || [];
  if (!progress.length) return "";
  const totalTasks = progress.reduce((sum, step) => sum + Number(step.total || 0), 0);
  const finishedTasks = progress.reduce((sum, step) => sum + Number(step.completed || 0) + Number(step.failed || 0) + Number(step.stopped || 0), 0);
  const percent = totalTasks ? Math.min(100, Math.round((finishedTasks / totalTasks) * 100)) : 0;
  return `<div class="job-progress">
      <div class="inline spread"><span>${finishedTasks}/${totalTasks} tasks finished</span><strong>${percent}%</strong></div>
      <progress max="${Math.max(1, totalTasks)}" value="${Math.min(totalTasks, finishedTasks)}"></progress>
      <div class="step-progress-grid">${progress.map((step) => `<div class="step-progress-card ${esc(step.state)}">
        <div class="inline spread"><strong>Step ${Number(step.index) + 1}</strong><span>${esc(friendlyState(step.state))}</span></div>
        <div class="route-meta">${esc(step.personaName || step.profileId || "persona pending")}${step.route?.name ? ` · ${esc(step.route.name)}` : step.route?.mode ? ` · ${esc(step.route.mode)}` : ""}</div>
        <div class="route-meta">${step.completed || 0}/${step.total || 0} completed${step.failed ? ` · ${step.failed} failed` : ""}${step.retrying ? ` · ${step.retrying} retrying` : ""}${step.active ? ` · ${step.active} active` : ""}</div>
      </div>`).join("")}</div>
    </div>`;
}

function renderJobs() {
  const el = $("diagnosticsJobs");
  if (!el) return;
  if (!lastJobs.length) {
    el.innerHTML = `<p class="muted">No automation jobs recorded.</p>`;
    return;
  }

  // Always show active jobs; progressively disclose retained history so a
  // large history does not create thousands of DOM nodes.
  const activeJobs = lastJobs.filter(isActiveJob);
  const historicalJobs = lastJobs.filter((job) => !isActiveJob(job));
  const historicalSlots = Math.max(0, visibleJobLimit - activeJobs.length);
  const visibleJobs = [...activeJobs, ...historicalJobs.slice(0, historicalSlots)];
  const hiddenCount = Math.max(0, lastJobs.length - visibleJobs.length);

  el.innerHTML = visibleJobs.map((job) => {
    const tasks = job.tasks || [];
    const completed = tasks.filter((task) => task.state === "completed").length;
    const failed = tasks.filter((task) => task.state === "failed").length;
    const workflow = lastSnapshot?.state?.workflows?.[job.workflowId];
    const active = isActiveJob(job);
    const taskRows = tasks.slice(-80).map((task) => {
      const { step, stepIndex } = stepForTask(job, task);
      const route = routeInfoForTask(task, step);
      return `<div class="diagnostic-task ${task.state === "failed" ? "failed" : ""}">
        <div class="diagnostic-task-head"><strong>${esc(friendlyState(task.state))}</strong><code title="${esc(task.url)}">${esc(task.url)}</code></div>
        <div class="diagnostic-summary-line"><span>Step ${stepIndex + 1}</span><span>${esc(route.persona)}</span><span>${esc(friendlyRoute(route.route))}</span><span>${esc(formatDuration(task.startedAt, task.finishedAt))}</span></div>
        ${task.error ? `<div class="job-error"><strong>Task error:</strong> ${esc(task.error)}</div>` : ""}
        <details class="diagnostic-technical">
          <summary>Technical details</summary>
          <div class="diagnostic-meta">
            <span><b>Container</b> <code>${esc(route.containerId || "—")}</code></span>
            <span><b>Route ID</b> <code>${esc(route.routeId || route.route || "—")}</code></span>
            <span><b>Provider</b> ${esc(route.provider || "—")}</span>
            <span><b>Completion</b> ${esc(completionLabel(task.completion || step))}</span>
            <span><b>Attempts</b> ${esc(task.attempts || 0)}${task.retryPolicy ? ` / ${Number(task.retryPolicy.maxRetries || 0) + 1}` : ""}</span>
            <span><b>Tab</b> ${task.tabId == null ? "—" : esc(task.tabId)}</span>
            ${task.nextRetryAt ? `<span><b>Next retry</b> ${esc(formatTime(task.nextRetryAt))}</span>` : ""}
          </div>
        </details>
        ${renderAttemptHistory(task)}
        ${task.result != null ? `<details class="diagnostic-technical"><summary>Result</summary><pre>${esc(JSON.stringify(task.result, null, 2))}</pre></details>` : ""}
      </div>`;
    }).join("");

    return `<article class="job-card diagnostic-job" data-diagnostic-job-id="${esc(job.id)}">
      <div class="inline spread diagnostic-job-head">
        <div>
          <strong>${esc(job.workflowName || workflow?.name || job.workflowId)}</strong>
          <div class="route-meta">${esc(friendlyState(job.state))} · ${completed} completed${failed ? ` · ${failed} failed` : ""}</div>
        </div>
        <div class="inline"><div class="diagnostic-job-time">${esc(formatDuration(job.startedAt || job.createdAt, job.finishedAt))}</div>${active ? `<button class="small danger stop-diagnostic-job"${job.state === "stopping" ? " disabled" : ""}>${job.state === "stopping" ? "Stopping…" : "Stop"}</button>` : ""}</div>
      </div>
      ${renderStepProgress(job)}
      ${job.error ? `<div class="job-error"><strong>Job error:</strong> ${esc(job.error)}</div>` : ""}
      <details class="diagnostic-technical job-technical">
        <summary>Job technical details</summary>
        <div class="diagnostic-meta job-meta">
          <span><b>Job ID</b> <code>${esc(job.id)}</code></span>
          <span><b>Created</b> ${esc(formatTime(job.createdAt))}</span>
          <span><b>Started</b> ${esc(formatTime(job.startedAt))}</span>
          <span><b>Finished</b> ${esc(formatTime(job.finishedAt))}</span>
          <span><b>Current step</b> ${job.currentStep == null || job.currentStep < 0 ? "—" : `${Number(job.currentStep) + 1} / ${job.totalSteps || job.stepProgress?.length || workflow?.steps?.length || "?"}`}</span>
        </div>
      </details>
      <div class="diagnostic-tasks">${taskRows || `<p class="muted">No tasks have started yet.</p>`}</div>
    </article>`;
  }).join("");

  if (hiddenCount) {
    el.insertAdjacentHTML("beforeend", `<div class="diagnostic-history-control"><span>Showing ${visibleJobs.length} of ${lastJobs.length} jobs. Active jobs are always shown.</span><button id="showMoreDiagnostics" type="button">Show ${Math.min(25, hiddenCount)} more</button></div>`);
  } else if (lastJobs.length > 25) {
    el.insertAdjacentHTML("beforeend", `<div class="diagnostic-history-control"><span>Showing all ${lastJobs.length} jobs.</span></div>`);
  }
}

function downloadDiagnostics() {
  const payload = buildDiagnosticsBundle({
    snapshot: lastSnapshot || {},
    jobs: lastJobs,
    version: browser.runtime.getManifest?.().version || null
  });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `persona-route-manager-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const [snapshot, jobResult] = await Promise.all([
      msg("GET_SNAPSHOT"),
      msg("LIST_AUTOMATION_JOBS", { limit: 100 })
    ]);
    lastSnapshot = snapshot;
    lastJobs = jobResult.jobs || [];
    renderSummary();
    renderJobs();
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function clearFinished() {
  await msg("CLEAR_AUTOMATION_JOBS");
  visibleJobLimit = 25;
  await refresh();
  toast("Finished job history cleared");
}

async function stopJob(jobId) {
  if (refreshPromise) await refreshPromise;
  const result = await msg("STOP_AUTOMATION_JOB", { jobId });
  if (result?.job) {
    const index = lastJobs.findIndex((job) => job.id === result.job.id);
    if (index >= 0) lastJobs[index] = result.job;
    else lastJobs.unshift(result.job);
    renderSummary();
    renderJobs();
  }
  await refresh();
  toast("Stop requested");
}

document.addEventListener("click", (event) => {
  if (event.target.closest('[data-tab="activity"]')) {
    queueMicrotask(() => { void refresh().catch((error) => toast(error.message || String(error), true)); });
    return;
  }
  if (event.target.closest("#showMoreDiagnostics")) {
    event.preventDefault();
    visibleJobLimit += 25;
    renderJobs();
    return;
  }
  const stop = event.target.closest("#diagnosticsJobs .stop-diagnostic-job");
  if (stop) {
    event.preventDefault();
    const card = stop.closest("[data-diagnostic-job-id]");
    if (card) void stopJob(card.dataset.diagnosticJobId).catch((error) => toast(error.message || String(error), true));
    return;
  }
  if (event.target.closest("#diagnosticsRefresh")) {
    event.preventDefault();
    void refresh().then(() => toast("Diagnostics refreshed")).catch((error) => toast(error.message || String(error), true));
    return;
  }
  if (event.target.closest("#diagnosticsClear")) {
    event.preventDefault();
    void clearFinished().catch((error) => toast(error.message || String(error), true));
    return;
  }
  if (event.target.closest("#downloadDiagnostics")) {
    event.preventDefault();
    downloadDiagnostics();
    toast("Diagnostics JSON downloaded");
  }
}, true);

setInterval(() => {
  if (!$("tab-activity")?.classList.contains("active")) return;
  if (lastJobs.some((job) => ["queued", "preparing", "running", "stopping"].includes(job.state))) void refresh().catch(() => {});
}, 1000);

void refresh().catch((error) => console.warn("Unable to load diagnostics", error));
