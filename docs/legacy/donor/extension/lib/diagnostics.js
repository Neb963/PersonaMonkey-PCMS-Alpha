import { filterOrdinaryAutomationJobs } from "./automation-history.js";

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function text(value, max = 256) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function count(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.floor(number))) : 0;
}

export function diagnosticProfile(profile = {}) {
  return {
    containerId: profile.containerId ?? null,
    name: profile.name ?? "",
    managed: profile.managed === true,
    owned: profile.owned === true,
    routeId: profile.routeId ?? null,
    killSwitch: profile.killSwitch !== false,
    blockLocalNetwork: profile.blockLocalNetwork !== false,
    domainMode: profile.domainMode ?? "any"
  };
}

export function diagnosticRoute(route = {}) {
  return {
    id: route.id ?? null,
    name: route.name ?? "",
    provider: route.provider ?? "",
    type: route.type ?? "",
    host: route.host ?? "",
    port: route.port ?? null,
    proxyDNS: route.proxyDNS !== false,
    country: route.country ?? "",
    city: route.city ?? "",
    server: route.server ?? "",
    enabled: route.enabled !== false
  };
}

export function diagnosticMullvadStatus(status = {}) {
  const activeExits = Array.isArray(status.active_exits) ? status.active_exits.slice(0, 100).map((exit) => ({
    route_id: typeof exit?.route_id === "string" ? text(exit.route_id, 128) : null,
    relay_ip: typeof exit?.relay_ip === "string" ? text(exit.relay_ip, 64) : null,
    relay_port: Number.isInteger(exit?.relay_port) && exit.relay_port >= 1 && exit.relay_port <= 65535
      ? exit.relay_port
      : null,
    local_host: typeof exit?.local_host === "string" ? text(exit.local_host, 64) : null,
    local_port: Number.isInteger(exit?.local_port) && exit.local_port >= 1 && exit.local_port <= 65535
      ? exit.local_port
      : null
  })) : [];
  return {
    installed: status.installed === true,
    ready: status.ready === true,
    interface_up: status.interface_up === true,
    interface: typeof status.interface === "string" ? text(status.interface, 64) : null,
    base_proxy_reachable: status.base_proxy_reachable === true,
    selected_entry: typeof status.selected_entry === "string" ? text(status.selected_entry, 128) : null,
    active_exits: activeExits,
    latest_handshake_age_seconds: Number.isFinite(status.latest_handshake_age_seconds)
      ? Math.max(0, status.latest_handshake_age_seconds)
      : null,
    mullvad_app_connected: status.mullvad_app_connected === true,
    error: status.error ? "Native bridge error" : null
  };
}

export function diagnosticWorkflow(workflow = {}) {
  return {
    id: workflow.id ?? null,
    name: text(workflow.name, 200),
    enabled: workflow.enabled !== false,
    createdAt: workflow.createdAt ?? null,
    updatedAt: workflow.updatedAt ?? null,
    steps: (Array.isArray(workflow.steps) ? workflow.steps : []).slice(0, 200).map((step, index) => ({
      id: text(step?.id || `step-${index + 1}`, 100),
      profileId: text(step?.profileId, 256),
      urlCount: Array.isArray(step?.urls) ? step.urls.length : 0,
      concurrency: count(step?.concurrency, 200),
      scriptIds: Array.isArray(step?.scriptIds) ? step.scriptIds.slice(0, 200).map((id) => text(id, 256)) : [],
      completion: step?.completion ? {
        mode: text(step.completion.mode || "load", 32),
        timeoutMs: count(step.completion.timeoutMs, 3_600_000)
      } : null,
      retries: count(step?.retries, 100),
      retryDelayMs: count(step?.retryDelayMs, 600_000),
      closeTabs: step?.closeTabs !== false,
      stopOnError: step?.stopOnError !== false
    }))
  };
}

export function diagnosticJob(job = {}) {
  return {
    id: text(job.id, 128),
    workflowId: text(job.workflowId, 256),
    workflowName: text(job.workflowName, 200),
    state: text(job.state, 32),
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    currentStep: Number.isInteger(job.currentStep) ? job.currentStep : -1,
    totalSteps: count(job.totalSteps, 1000),
    failed: Boolean(job.error),
    stepProgress: (Array.isArray(job.stepProgress) ? job.stepProgress : []).slice(0, 200).map((step) => ({
      index: count(step?.index, 1000),
      state: text(step?.state, 32),
      profileId: text(step?.profileId, 256),
      personaName: text(step?.personaName, 128),
      route: step?.route ? {
        mode: text(step.route.mode, 32),
        id: step.route.id == null ? null : text(step.route.id, 256),
        name: step.route.name == null ? null : text(step.route.name, 128),
        provider: step.route.provider == null ? null : text(step.route.provider, 64)
      } : null,
      total: count(step?.total, 100000),
      completed: count(step?.completed, 100000),
      failed: count(step?.failed, 100000),
      stopped: count(step?.stopped, 100000),
      retrying: count(step?.retrying, 100000),
      active: count(step?.active, 100000),
      startedAt: step?.startedAt ?? null,
      finishedAt: step?.finishedAt ?? null
    })),
    tasks: (Array.isArray(job.tasks) ? job.tasks : []).slice(-200).map((task) => ({
      id: text(task?.id, 128),
      stepIndex: count(task?.stepIndex, 1000),
      profileId: text(task?.profileId, 256),
      personaName: text(task?.personaName, 128),
      state: text(task?.state, 32),
      attempts: count(task?.attempts, 100),
      retryPolicy: task?.retryPolicy ? { maxRetries: count(task.retryPolicy.maxRetries, 100) } : null,
      completion: task?.completion ? { mode: text(task.completion.mode, 32) } : null,
      startedAt: task?.startedAt ?? null,
      finishedAt: task?.finishedAt ?? null,
      nextRetryAt: task?.nextRetryAt ?? null,
      hadError: Boolean(task?.error),
      attemptHistory: (Array.isArray(task?.attemptHistory) ? task.attemptHistory : []).slice(-100).map((attempt) => ({
        attempt: count(attempt?.attempt, 100),
        state: text(attempt?.state, 32),
        startedAt: attempt?.startedAt ?? null,
        finishedAt: attempt?.finishedAt ?? null,
        hadError: Boolean(attempt?.error)
      }))
    }))
  };
}

function diagnosticSecurity(security = {}) {
  return {
    ready: security.ready === true,
    privacySafe: security.privacySafe === true,
    networkPredictionSafe: security.networkPredictionSafe === true,
    webRTCSafe: security.webRTCSafe === true,
    proxyControl: security.proxyControl == null ? null : text(security.proxyControl, 64),
    initializedAt: security.initializedAt ?? null,
    lastProxyError: security.lastProxyError ? { at: security.lastProxyError.at ?? null, present: true } : null,
    lastBlock: security.lastBlock ? {
      at: security.lastBlock.at ?? null,
      reason: text(security.lastBlock.reason, 128),
      tabId: security.lastBlock.tabId ?? null,
      cookieStoreId: security.lastBlock.cookieStoreId == null ? null : text(security.lastBlock.cookieStoreId, 256)
    } : null
  };
}

export function buildDiagnosticsBundle({ snapshot = {}, jobs = [], version = null, generatedAt = new Date().toISOString() } = {}) {
  const state = snapshot.state || {};
  return {
    generatedAt,
    extensionVersion: version,
    security: diagnosticSecurity(snapshot.security || {}),
    mullvadNative: diagnosticMullvadStatus(snapshot.mullvadNative || {}),
    profiles: Object.fromEntries(Object.entries(state.profiles || {}).map(([id, profile]) => [id, diagnosticProfile(profile)])),
    routes: Object.fromEntries(Object.entries(state.routes || {}).map(([id, route]) => [id, diagnosticRoute(route)])),
    workflows: Object.fromEntries(Object.entries(state.workflows || {}).map(([id, workflow]) => [id, diagnosticWorkflow(workflow)])),
    jobs: filterOrdinaryAutomationJobs(jobs).map(diagnosticJob)
  };
}
