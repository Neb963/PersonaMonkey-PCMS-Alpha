import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID, MAX_WORKFLOW_STEP_TIMEOUT_MS } from "./constants.js";
import { normalizeWorkflow } from "./storage.js";
import { shouldUseMainWorld } from "./userscripts.js";

export const MAX_WORKFLOW_TASKS = 500;

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createWorkflowStep({
  profileId = "",
  urls = [],
  concurrency = 4,
  timeoutMs = 60000,
  retryDelayMs = 1000
} = {}) {
  return normalizeWorkflow({
    steps: [{
      id: newId("step"),
      profileId,
      urls,
      concurrency,
      scriptIds: [],
      completion: { mode: "load", value: "", timeoutMs },
      retries: 0,
      retryDelayMs,
      closeTabs: true,
      stopOnError: true
    }]
  }, "workflow-step-template").steps[0];
}

export function addWorkflowStep(workflow, profileId = "") {
  const current = normalizeWorkflow(workflow, workflow?.id || "workflow");
  current.steps.push(createWorkflowStep({ profileId }));
  current.updatedAt = new Date().toISOString();
  return current;
}

export function removeWorkflowStep(workflow, index) {
  const current = normalizeWorkflow(workflow, workflow?.id || "workflow");
  if (current.steps.length <= 1) return current;
  if (!Number.isInteger(index) || index < 0 || index >= current.steps.length) return current;
  current.steps.splice(index, 1);
  current.updatedAt = new Date().toISOString();
  return current;
}

export function moveWorkflowStep(workflow, index, direction) {
  const current = normalizeWorkflow(workflow, workflow?.id || "workflow");
  const target = index + (direction < 0 ? -1 : 1);
  if (!Number.isInteger(index) || index < 0 || index >= current.steps.length || target < 0 || target >= current.steps.length) return current;
  [current.steps[index], current.steps[target]] = [current.steps[target], current.steps[index]];
  current.updatedAt = new Date().toISOString();
  return current;
}

export function duplicateWorkflow(workflow, { id = newId("workflow"), name } = {}) {
  const source = normalizeWorkflow(workflow, workflow?.id || "workflow");
  const now = new Date().toISOString();
  return normalizeWorkflow({
    ...source,
    id,
    name: String(name || `${source.name} copy`).slice(0, 200),
    createdAt: now,
    updatedAt: now,
    steps: source.steps.map((step) => ({ ...step, id: newId("step") }))
  }, id);
}

function issue(code, message, stepIndex = null) {
  return { level: "error", code, message, stepIndex };
}

export function collectWorkflowValidationIssues(workflow = {}, state = {}) {
  const issues = [];
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (workflow.enabled === false) issues.push(issue("workflow-disabled", "Workflow is disabled"));
  if (!steps.length) {
    issues.push(issue("workflow-empty", "Workflow needs at least one step"));
    return issues;
  }
  if (steps.length > 200) {
    issues.push(issue("workflow-step-limit", "Workflow may contain at most 200 steps"));
  }

  const seenStepIds = new Set();
  steps.forEach((step, index) => {
    const stepId = String(step?.id || "").trim();
    if (!stepId) return;
    if (seenStepIds.has(stepId)) {
      issues.push(issue("step-id-duplicate", `Step ${index + 1}: step id "${stepId.slice(0, 100)}" must be unique`, index));
    } else {
      seenStepIds.add(stepId);
    }
  });

  // Each distinct URL in a step becomes one task; the same URL in a later
  // step is another task. Match orchestrator's per-step URL deduplication.
  const taskCount = steps.reduce((count, step) => count + new Set(
    (Array.isArray(step?.urls) ? step.urls : []).map((url) => String(url || "").trim()).filter(Boolean)
  ).size, 0);
  if (taskCount > MAX_WORKFLOW_TASKS) {
    issues.push(issue("workflow-task-limit", `Workflow has ${taskCount} URL tasks; maximum is ${MAX_WORKFLOW_TASKS}`));
  }

  for (const [index, step] of steps.entries()) {
    const label = `Step ${index + 1}`;
    if (!step?.profileId) {
      issues.push(issue("persona-required", `${label}: choose a persona`, index));
    } else if (state.profiles) {
      const profile = state.profiles[step.profileId];
      if (!profile || profile.managed === false) {
        issues.push(issue("persona-missing", `${label}: managed persona not found`, index));
      } else if (profile.routeId === BLOCK_ROUTE_ID) {
        issues.push(issue("route-blocked", `${label}: selected persona is set to Block`, index));
      } else if (profile.routeId && profile.routeId !== DIRECT_ROUTE_ID) {
        const route = state.routes?.[profile.routeId];
        if (!route || route.enabled === false) issues.push(issue("route-unavailable", `${label}: selected persona route is missing or disabled`, index));
      }
    }

    const urls = Array.isArray(step?.urls) ? step.urls : [];
    if (!urls.length) issues.push(issue("urls-required", `${label}: add at least one URL`, index));
    for (const raw of urls) {
      try {
        const url = new URL(String(raw));
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad protocol");
      } catch { issues.push(issue("url-invalid", `${label}: invalid http/https URL: ${raw}`, index)); }
    }

    const concurrency = Number(step?.concurrency ?? 4);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200) issues.push(issue("concurrency-invalid", `${label}: concurrency must be between 1 and 200`, index));

    for (const scriptId of step?.scriptIds || []) {
      if (!state.scripts) continue;
      const script = state.scripts[scriptId];
      if (!script || script.enabled === false) issues.push(issue("script-missing", `${label}: userscript ${scriptId} is missing or disabled`, index));
      else if (step.profileId && !(script.profileIds || []).includes(step.profileId)) issues.push(issue("script-persona-mismatch", `${label}: userscript ${script.name} is not assigned to the selected persona`, index));
      if (script && step?.completion?.mode === "signal" && !(script.grants || []).includes("Persona.signal")) {
        issues.push(issue("signal-grant-required", `${label}: signal userscript ${script.name || scriptId} must declare @grant Persona.signal`, index));
      }
      if (script && step?.completion?.mode === "signal" && shouldUseMainWorld(script)) {
        issues.push(issue("signal-main-world", `${label}: signal userscript ${script.name || scriptId} runs in MAIN; set @inject-into content or select a USER_SCRIPT-world userscript before running`, index));
      }
    }

    const mode = step?.completion?.mode || "load";
    const rawValue = String(step?.completion?.value ?? "").trim();
    if (mode === "delay" && rawValue) {
      const delay = Number(rawValue);
      if (!Number.isFinite(delay) || delay < 0 || delay > 600000) issues.push(issue("delay-invalid", `${label}: delay must be between 0 and 600000 ms`, index));
    }
    if (mode === "selector" && !rawValue) issues.push(issue("selector-required", `${label}: selector completion requires a CSS selector`, index));
    if (mode === "signal" && !(step?.scriptIds || []).length) issues.push(issue("signal-script-required", `${label}: Persona.complete() signal requires at least one selected userscript`, index));

    const timeout = Number(step?.completion?.timeoutMs ?? 60000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_WORKFLOW_STEP_TIMEOUT_MS) issues.push(issue("timeout-invalid", `${label}: timeout must be between 1000 and ${MAX_WORKFLOW_STEP_TIMEOUT_MS} ms`, index));
    const retries = Number(step?.retries ?? 0);
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) issues.push(issue("retries-invalid", `${label}: retries must be between 0 and 10`, index));
    const retryDelayMs = Number(step?.retryDelayMs ?? 1000);
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 600000) issues.push(issue("retry-delay-invalid", `${label}: retry delay must be between 0 and 600000 ms`, index));
  }
  return issues;
}

export function validateWorkflowForRun(workflow = {}, state = {}) {
  const issues = collectWorkflowValidationIssues(workflow, state);
  if (issues.length) {
    const error = new Error(issues.map((entry) => entry.message).join("\n"));
    error.issues = issues;
    throw error;
  }
  return workflow;
}

export function chooseStarterProfileId(profiles = {}) {
  const managed = Object.values(profiles || {}).filter((profile) => profile?.managed);
  const protectedProfile = managed.find((profile) =>
    profile.routeId && profile.routeId !== BLOCK_ROUTE_ID && profile.routeId !== DIRECT_ROUTE_ID
  );
  const networkedProfile = managed.find((profile) => profile.routeId && profile.routeId !== BLOCK_ROUTE_ID);
  return (protectedProfile || networkedProfile || managed[0])?.containerId || "";
}

export function createStarterWorkflow(profiles = {}) {
  const profileId = chooseStarterProfileId(profiles);
  if (!profileId) return null;
  const id = "workflow-starter-smoke";
  return normalizeWorkflow({
    id,
    name: "Smoke test — example.com",
    enabled: true,
    steps: [createWorkflowStep({
      profileId,
      urls: ["https://example.com/"],
      concurrency: 1,
      timeoutMs: 30000
    })]
  }, id);
}
