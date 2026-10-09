import { createPcmsClient } from "../lib/pcms-client.js";

const MAX_ACTIVITY = 500;
const client = createPcmsClient();
const state = { personas: [], routes: [], workflows: [], jobs: [], available: {}, activity: [], routeTests: new Map(), selectedPersonaIds: new Set(), jobQuery: "", jobFilter: "all", jobHistoryLimit: 20, eventConnection: null, refreshPromise: null, refreshQueued: false, eventBootId: null, eventSequence: null, reconnectTimer: null };
const $ = (id) => document.getElementById(id);

function text(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function asList(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function setError(error) {
  const target = $("error");
  if (!error) { target.classList.add("hidden"); target.textContent = ""; return; }
  const issueText = Array.isArray(error?.details?.issues)
    ? error.details.issues.map((issue) => issue?.message).filter(Boolean).join(" · ")
    : "";
  target.textContent = issueText || error.message || text(error, "Management request failed");
  target.classList.remove("hidden");
}

async function command(name, params = {}) {
  const response = await client.request(name, params);
  return response.result;
}

function selectedIds() { return [...state.selectedPersonaIds]; }
function selectedRoute() { return state.routes.find((item) => item.id === $("routeSelect").value); }
function isDirectSelection() {
  const route = selectedRoute();
  return route?.mode === "direct" || route?.type === "direct" || route?.id === "__direct__";
}
function selectedSummary() {
  const count = selectedIds().length;
  const routeChosen = Boolean($("routeSelect").value);
  const direct = isDirectSelection();
  const warning = $("directRouteWarning");
  const acknowledgement = $("confirmDirectRoute");
  warning?.classList.toggle("hidden", !direct || !count);
  if (!direct && acknowledgement) acknowledgement.checked = false;
  for (const card of document.querySelectorAll(".persona")) {
    const input = card.querySelector(".persona-select");
    card.classList.toggle("selected", Boolean(input?.checked));
  }
  let summary = "Select one or more personas to enable batch actions.";
  if (!state.available.routes || !state.available.batch) summary = "Route batch actions unavailable.";
  else if (count && !routeChosen) summary = `${count} persona${count === 1 ? "" : "s"} selected · choose a route to assign, or verify their current routes.`;
  else if (count && direct && acknowledgement?.checked !== true) summary = `${count} persona${count === 1 ? "" : "s"} selected · acknowledge the Direct-network warning to enable assignment.`;
  else if (count) summary = `${count} persona${count === 1 ? "" : "s"} selected · batch actions are ready.`;
  $("selectionSummary").textContent = summary;
  $("assignRoute").textContent = direct ? "Assign Direct network" : "Assign route";
  $("assignRoute").disabled = !state.available.routes || !state.available.batch || !count || !routeChosen || (direct && acknowledgement?.checked !== true);
  $("assignRoute").title = !$("assignRoute").disabled ? "" : summary;
  $("testRoutes").disabled = !state.available.routes || !state.available.batch || !count;
  $("testRoutes").title = count ? "" : "Select one or more personas to verify their current routes";
}
function statusClass(value) {
  const valueText = String(value || "").toLowerCase();
  if (/fail|error|unhealthy|unsafe/.test(valueText)) return "bad";
  if (/block|warn|unknown|pending|degrad|direct/.test(valueText)) return "warn";
  return "";
}
function friendlyStatus(value) {
  const raw = String(value || "unknown").replace(/[_-]+/g, " ").trim().toLowerCase();
  if (raw === "healthy") return "Network verified";
  if (raw === "blocked" || raw === "block") return "Network blocked";
  if (raw === "direct") return "Direct network";
  if (raw === "active") return "Protection enforced";
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Unknown";
}
function isRunning(job) { return ["running", "queued", "preparing", "stopping", "retrying"].includes(String(job?.state || "").toLowerCase()); }
function clearChildren(element) { element.replaceChildren(); }
function empty(element, label) { const item = document.createElement("p"); item.className = "empty"; item.textContent = label; element.append(item); }

function renderOverview(describe, systemStatus) {
  $("protocol").textContent = `Protocol v${text(describe?.protocolVersion, "1")}`;
  const security = systemStatus?.security || systemStatus?.protection || systemStatus?.system?.security || {};
  const protection = security.status || (security.ready === false ? "Needs attention" : security.privacySafe === false ? "Needs attention" : "Active");
  $("protection").textContent = state.available.diagnostics ? text(protection) : "Unavailable";
  $("personaCount").textContent = state.available.personas ? String(state.personas.length) : "Unavailable";
  const reportedHealth = systemStatus?.routeHealth;
  const healthy = Number.isFinite(reportedHealth?.healthy)
    ? reportedHealth.healthy
    : state.personas.filter((persona) => /healthy|ready|protected/i.test(String(persona.health?.status || persona.protection || ""))).length;
  $("routeHealth").textContent = state.available.personas && state.available.diagnostics ? (state.personas.length ? `${healthy}/${state.personas.length} healthy` : "—") : "Unavailable";
  $("runningJobs").textContent = state.available["workflow-jobs"] ? String(state.jobs.filter(isRunning).length) : "Unavailable";
}

function renderRoutes() {
  const select = $("routeSelect"); const previous = select.value;
  clearChildren(select);
  const initial = document.createElement("option"); initial.value = ""; initial.textContent = state.available.routes ? "Choose a route…" : "Routes unavailable"; select.append(initial);
  select.disabled = !state.available.routes;
  for (const route of state.routes) {
    const option = document.createElement("option"); option.value = route.id;
    const special = route.mode === "direct" || route.type === "direct" || route.id === "__direct__"
      ? " — bypasses protected routing"
      : route.mode === "block" || route.type === "block" || route.id === "__block__"
        ? " — no network"
        : "";
    option.textContent = `${text(route.name, route.id)}${special}${route.enabled === false ? " (disabled)" : ""}`;
    option.disabled = route.enabled === false;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  selectedSummary();
}

function personaRoute(persona) { return persona.route?.name || persona.routeName || persona.health?.routeName || persona.routeId || persona.health?.routeId || "Block"; }
function renderPersonas() {
  const target = $("personas"); clearChildren(target);
  if (!state.available.personas) { empty(target, "Personas unavailable."); return; }
  if (!state.personas.length) { empty(target, "No managed personas are available."); return; }
  for (const persona of state.personas) {
    const id = persona.id || persona.containerId || persona.personaId;
    if (!id) continue;
    const card = document.createElement("article"); card.className = "persona";
    const check = document.createElement("input"); check.type = "checkbox"; check.className = "persona-select"; check.value = id; check.checked = state.selectedPersonaIds.has(id); check.setAttribute("aria-label", `Select ${text(persona.name, "persona")}`); check.addEventListener("change", () => {
      if (check.checked) state.selectedPersonaIds.add(id); else state.selectedPersonaIds.delete(id);
      selectedSummary();
    });
    const main = document.createElement("div"); main.className = "persona-main";
    const title = document.createElement("div"); title.className = "persona-title";
    const name = document.createElement("strong"); name.textContent = text(persona.name, id); name.title = text(persona.name, id);
    const network = persona.health?.status || persona.status || "Unknown";
    const status = document.createElement("span"); status.className = `status ${statusClass(network)}`; status.textContent = friendlyStatus(network);
    title.append(name, status);

    const meta = document.createElement("p"); meta.className = "persona-meta";
    const activeTabs = persona.activeTabs ?? persona.tabs?.active ?? 0;
    const expiry = persona.expiresAt || persona.expiry;
    meta.textContent = `Route: ${personaRoute(persona)} · ${activeTabs} active tab${activeTabs === 1 ? "" : "s"}${expiry ? ` · Expires ${new Date(expiry).toLocaleString()}` : ""}`;

    const protectionValue = persona.protection || (persona.health?.protected === true ? "enforced" : persona.health?.protected === false ? "relaxed" : "");
    if (protectionValue) {
      const protection = document.createElement("p");
      protection.className = "persona-protection";
      protection.textContent = `Protection: ${/active|enforced|protected|ready/i.test(String(protectionValue)) ? "enforced" : text(protectionValue)}`;
      main.append(title, meta, protection);
    } else {
      main.append(title, meta);
    }

    if (persona.health?.checkedAt) {
      const testStatus = document.createElement("p"); testStatus.className = "persona-test-result";
      testStatus.textContent = `Route test: ${friendlyStatus(persona.health.status)}`;
      main.append(testStatus);
    }

    const actions = document.createElement("div"); actions.className = "persona-actions";
    const open = document.createElement("button"); open.type = "button"; open.textContent = "Open"; open.className = "primary-action"; open.addEventListener("click", () => runAction(async () => { await command("persona.open", { profileId: id }); addActivity("persona.open", id); }));
    const test = document.createElement("button"); test.type = "button"; test.textContent = "Verify route"; test.addEventListener("click", () => runAction(async () => {
      const result = await command("route.test", { profileId: id });
      addActivity("route.test.completed", id, result?.status || (result?.ok === false ? "failed" : "completed"));
      await refresh();
      scheduleRefresh();
    }));
    test.disabled = !state.available.routes;
    actions.append(open, test);

    const more = document.createElement("details"); more.className = "persona-more";
    const summary = document.createElement("summary"); summary.textContent = "More";
    const secondary = document.createElement("div"); secondary.className = "persona-secondary-actions";
    const inspect = document.createElement("button"); inspect.type = "button"; inspect.textContent = "Inspect in activity"; inspect.addEventListener("click", () => runAction(async () => { const details = await command("persona.get", { profileId: id }); addActivity("persona.inspected", id, details?.name || ""); }));
    secondary.append(inspect); more.append(summary, secondary);

    main.append(actions, more); card.append(check, main); target.append(card);
  }
  const validIds = new Set(state.personas.map((persona) => persona.id || persona.containerId || persona.personaId).filter(Boolean));
  for (const id of [...state.selectedPersonaIds]) if (!validIds.has(id)) state.selectedPersonaIds.delete(id);
  selectedSummary();
}

function renderWorkflows() {
  const select = $("workflowSelect"); const previous = select.value; clearChildren(select);
  const initial = document.createElement("option"); initial.value = ""; initial.textContent = state.available.workflows ? "Choose a workflow…" : "Workflows unavailable"; select.append(initial);
  select.disabled = !state.available.workflows;
  for (const workflow of state.workflows) { const option = document.createElement("option"); option.value = workflow.id; option.textContent = text(workflow.name, workflow.id); option.disabled = workflow.enabled === false; select.append(option); }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  $("runWorkflow").disabled = !state.available.workflows || !select.value;
}

function friendlyJobState(value) {
  const raw = String(value || "unknown").replace(/[_-]+/g, " ").trim().toLowerCase();
  if (raw === "stopping") return "Stopping";
  if (raw === "retrying") return "Retrying";
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Unknown";
}

function jobMatchesView(job) {
  const query = state.jobQuery.trim().toLowerCase();
  if (query && !`${job.workflowName || ""} ${job.workflowId || ""} ${job.id || ""} ${job.state || ""}`.toLowerCase().includes(query)) return false;
  if (state.jobFilter === "active") return isRunning(job);
  if (state.jobFilter === "failed") return /fail|error/i.test(String(job.state || "")) || Boolean(job.error);
  return true;
}

function renderJobs() {
  const target = $("jobs"); clearChildren(target);
  if (!state.available["workflow-jobs"]) { empty(target, "Workflow jobs unavailable."); return; }
  const matching = state.jobs.filter(jobMatchesView);
  if (!matching.length) {
    empty(target, state.jobs.length ? "No workflow jobs match this view." : "No workflow jobs yet.");
    return;
  }

  const active = matching.filter(isRunning);
  const historical = matching.filter((job) => !isRunning(job));
  const visible = state.jobFilter === "active"
    ? active
    : [...active, ...historical.slice(0, Math.max(0, state.jobHistoryLimit - active.length))];

  for (const job of visible) {
    const item = document.createElement("article"); item.className = `job${isRunning(job) ? " active" : ""}`;
    const details = document.createElement("div"); details.className = "job-main";
    const title = document.createElement("h3"); title.textContent = text(job.workflowName || job.workflowId, "Workflow");
    title.title = text(job.workflowName || job.workflowId, "Workflow");
    const context = job.personaName || (job.currentStep != null ? `Step ${Number(job.currentStep || 0) + 1}` : "No active step");
    const progress = Array.isArray(job.stepProgress)
      ? job.stepProgress.reduce((sum, step) => sum + Number(step.completed || 0) + Number(step.failed || 0) + Number(step.stopped || 0), 0)
      : Math.max(0, Number(job.currentStep || 0));
    const total = Array.isArray(job.stepProgress)
      ? job.stepProgress.reduce((sum, step) => sum + Number(step.total || 0), 0)
      : Number(job.totalSteps || 0);
    const copy = document.createElement("p");
    copy.textContent = `${friendlyJobState(job.state)} · ${context}${job.error ? " · needs attention" : ""}`;
    details.append(title, copy);
    if (total > 0) {
      const progressWrap = document.createElement("div"); progressWrap.className = "job-progress";
      const progressElement = document.createElement("progress"); progressElement.max = Math.max(1, total); progressElement.value = Math.min(total, progress);
      const label = document.createElement("span"); label.textContent = `${progress}/${total} finished`;
      progressWrap.append(progressElement, label); details.append(progressWrap);
    }
    if (job.error) {
      const error = document.createElement("p"); error.className = "job-inline-error"; error.textContent = text(job.error); details.append(error);
    }
    item.append(details);
    if (isRunning(job)) {
      const stop = document.createElement("button"); stop.type = "button"; stop.textContent = "Stop";
      stop.addEventListener("click", async () => {
        stop.disabled = true;
        stop.textContent = "Stopping…";
        stop.setAttribute("aria-busy","true");
        const ok = await runAction(async () => {
          await command("workflow.jobs.stop", { jobId: job.id });
          addActivity("workflow.job.stop", job.id);
          scheduleRefresh();
        });
        if (!ok && stop.isConnected) {
          stop.disabled = false;
          stop.textContent = "Stop";
          stop.removeAttribute("aria-busy");
        }
      });
      item.append(stop);
    }
    target.append(item);
  }

  const hiddenCount = matching.length - visible.length;
  if (hiddenCount > 0) {
    const footer = document.createElement("div"); footer.className = "job-history-control";
    const label = document.createElement("span"); label.textContent = `Showing ${visible.length} of ${matching.length} jobs. Active jobs are always shown.`;
    const more = document.createElement("button"); more.type = "button"; more.id = "showMoreJobs"; more.textContent = `Show ${Math.min(20, hiddenCount)} more`;
    footer.append(label, more); target.append(footer);
  }
}

function friendlyActivityType(type) {
  const labels = {
    "workflow.job.started":"Workflow started",
    "workflow.job.stop":"Workflow stop requested",
    "workflow.job.changed":"Workflow job updated",
    "workflow.job.finished":"Workflow job finished",
    "pcms.batch.completed":"Batch action completed",
    "pcms.batch.partial":"Batch action incomplete",
    "route.test.completed":"Route verification completed",
    "route.assignment.changed":"Route assignment changed",
    "persona.changed":"Persona updated",
    "persona.removed":"Persona removed",
    "state.changed":"PersonaMonkey state changed",
    "diagnostics.changed":"Diagnostics updated"
  };
  return labels[type] || String(type || "Management event").replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function addActivity(type, entityId = "", detail = "") {
  state.activity.unshift({ at: new Date().toISOString(), type, entityId, detail });
  if (state.activity.length > MAX_ACTIVITY) state.activity.length = MAX_ACTIVITY;
  renderActivity();
}
function renderActivity() {
  const target = $("activity"); clearChildren(target);
  const split = document.querySelector(".split");
  split?.classList.toggle("activity-empty", !state.activity.length);
  if (!state.activity.length) { empty(target, "Recent management activity will appear here."); return; }
  for (const event of state.activity.slice(0, 100)) {
    const item = document.createElement("li");
    const title = document.createElement("strong"); title.textContent = friendlyActivityType(event.type);
    const summary = document.createElement("span"); summary.className = "activity-summary"; summary.textContent = event.detail || (event.entityId ? "Related control-plane object updated" : "Control-plane state updated");
    const timestamp = document.createElement("time"); timestamp.textContent = new Date(event.at).toLocaleString();
    item.append(title, summary, timestamp);
    if (event.type || event.entityId) {
      const technical = document.createElement("details"); technical.className = "activity-technical";
      const technicalSummary = document.createElement("summary"); technicalSummary.textContent = "Technical";
      const code = document.createElement("code"); code.textContent = `${event.type || "pcms.event"}${event.entityId ? ` · ${event.entityId}` : ""}`;
      technical.append(technicalSummary, code); item.append(technical);
    }
    target.append(item);
  }
}

function setConnection(status) {
  status = typeof status === "object" ? (status.connected ? "connected" : "disconnected") : status;
  const value = status === "connected" ? "Connected" : status === "disconnected" ? "Disconnected — refreshing" : "Connecting…";
  $("connectionState").textContent = value;
  $("connectionDot").className = `dot ${status === "connected" ? "connected" : status === "disconnected" ? "disconnected" : "pending"}`;
}
function scheduleRefresh() {
  state.refreshQueued = true;
  if (state.refreshPromise) return;
  queueMicrotask(() => { void refresh(); });
}
async function refresh() {
  if (state.refreshPromise) {
    state.refreshQueued = true;
    return state.refreshPromise;
  }
  state.refreshPromise = (async () => {
    do {
      state.refreshQueued = false;
      try {
        setError(null);
        const describe = await command("system.describe");
        const capabilities = new Set(describe?.capabilities || []);
        const families = [
          ["diagnostics", "system.status"], ["personas", "persona.list"],
          ["routes", "route.list"], ["workflows", "workflow.list"],
          ["workflow-jobs", "workflow.jobs.list"]
        ];
        const responses = await Promise.allSettled(families.map(([capability, name]) => capabilities.has(capability)
          ? (name.endsWith(".list") ? client.listAll(name) : command(name)) : Promise.resolve(null)));
        state.available = Object.fromEntries(families.map(([capability], index) => [capability, capabilities.has(capability) && responses[index].status === "fulfilled"]));
        state.available.batch = capabilities.has("batch");
        const result = (index) => responses[index].status === "fulfilled" ? responses[index].value : null;
        state.personas = asList(result(1), ["personas", "items"]);
        state.routes = asList(result(2), ["routes", "items"]);
        state.workflows = asList(result(3), ["workflows", "items"]);
        state.jobs = asList(result(4), ["jobs", "items"]);
        renderOverview(describe, result(0)); renderRoutes(); renderPersonas(); renderWorkflows(); renderJobs();
        const failures = responses.filter((response) => response.status === "rejected");
        if (failures.length) setError(failures[0].reason);
      } catch (error) {
        setError(error);
      }
    } while (state.refreshQueued);
  })();
  try {
    await state.refreshPromise;
  } finally {
    state.refreshPromise = null;
    if (state.refreshQueued) scheduleRefresh();
  }
}
async function runAction(action) {
  try {
    setError(null);
    await action();
    return true;
  } catch (error) {
    setError(error);
    return false;
  }
}

async function runButtonAction(button, pendingLabel, action, restore) {
  if (!button || button.disabled) return false;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = pendingLabel;
  button.setAttribute("aria-busy","true");
  const ok = await runAction(action);
  if (button.isConnected) {
    button.textContent = label;
    button.removeAttribute("aria-busy");
    restore?.();
  }
  return ok;
}

$("refresh").addEventListener("click", () => runButtonAction($("refresh"), "Refreshing…", refresh, () => { $("refresh").disabled = false; }));
$("routeSelect").addEventListener("change", selectedSummary);
$("confirmDirectRoute")?.addEventListener("change", selectedSummary);
$("workflowSelect").addEventListener("change", () => { $("runWorkflow").disabled = !$("workflowSelect").value; });
$("jobSearch").addEventListener("input", (event) => { state.jobQuery = event.target.value; state.jobHistoryLimit = 20; renderJobs(); });
$("jobFilter").addEventListener("change", (event) => { state.jobFilter = event.target.value; state.jobHistoryLimit = 20; renderJobs(); });
$("jobs").addEventListener("click", (event) => {
  if (event.target.closest("#showMoreJobs")) {
    state.jobHistoryLimit += 20;
    renderJobs();
  }
});
$("assignRoute").addEventListener("click", () => {
  const button = $("assignRoute");
  const routeId = $("routeSelect").value;
  const personaIds = selectedIds();
  if (!routeId || !personaIds.length) return;
  const direct = isDirectSelection();
  const pendingLabel = direct ? "Assigning Direct…" : "Assigning…";
  void runButtonAction(button, pendingLabel, async () => {
    const params = { routeId };
    if (direct) {
      if ($("confirmDirectRoute")?.checked !== true) throw new Error("Acknowledge the Direct routing warning before assigning Direct");
      params.options = { allowDirect: true };
    }
    $("selectionSummary").textContent = `Assigning route to ${personaIds.length} persona${personaIds.length === 1 ? "" : "s"}…`;
    const batch = await command("batch.execute", { command: "route.assign", personaIds, params, concurrency: 4, failurePolicy: "continue" });
    const failures = (batch?.results || []).filter((row) => !row.ok);
    if (failures.length) {
      const succeeded = Math.max(0, personaIds.length - failures.length);
      const details = failures.map((row) => {
        const persona = state.personas.find((item) => (item.id || item.containerId || item.personaId) === row.personaId);
        const reason = row.error?.message || row.error?.code || (typeof row.error === "string" ? row.error : "assignment failed");
        return `${text(persona?.name, row.personaId)}: ${reason}`;
      }).join(" · ");
      addActivity("pcms.batch.partial", "route.assign", `${succeeded}/${personaIds.length} assigned · ${details}`);
      throw new Error(`Route assignment incomplete: ${succeeded} of ${personaIds.length} succeeded. ${details}`);
    }
    if ($("confirmDirectRoute")) $("confirmDirectRoute").checked = false;
    addActivity("pcms.batch.completed", "route.assign", `${personaIds.length} selected`);
    await refresh();
  }, selectedSummary);
});
$("testRoutes").addEventListener("click", () => {
  const button = $("testRoutes");
  const personaIds = selectedIds();
  if (!personaIds.length) return;
  void runButtonAction(button, "Verifying…", async () => {
    $("selectionSummary").textContent = `Verifying ${personaIds.length} persona route${personaIds.length === 1 ? "" : "s"}…`;
    const batch = await command("batch.execute", { command: "route.test", personaIds, params: {}, concurrency: 4, failurePolicy: "continue" });
    addActivity("pcms.batch.completed", "route.test", `${personaIds.length} selected · ${(batch?.results || []).filter((row) => !row.ok).length} failed`);
    await refresh();
  }, selectedSummary);
});
$("runWorkflow").addEventListener("click", () => {
  const button = $("runWorkflow");
  const workflowId = $("workflowSelect").value;
  if (!workflowId) return;
  void runButtonAction(button, "Starting…", async () => {
    await command("workflow.run", { workflowId });
    addActivity("workflow.job.started", workflowId);
    scheduleRefresh();
  }, () => { button.disabled = !$("workflowSelect").value; });
});
$("clearActivity").addEventListener("click", () => { state.activity = []; renderActivity(); });

function attachEventStream() {
  clearTimeout(state.reconnectTimer);
  state.eventConnection?.disconnect?.();
  state.eventConnection = client.connectEvents((event) => {
    const bootChanged = state.eventBootId !== null && event.bootId !== state.eventBootId;
    const duplicateOrOld = !bootChanged && state.eventSequence !== null && event.sequence <= state.eventSequence;
    const gap = !bootChanged && state.eventSequence !== null && event.sequence !== state.eventSequence + 1;
    if (duplicateOrOld) {
      scheduleRefresh();
      return;
    }
    state.eventBootId = event.bootId;
    state.eventSequence = event.sequence;
    addActivity(event.type || "pcms.event", event.entityId || event.entity || "", event.data?.message || "");
    if (bootChanged || gap || ["state.changed", "persona.changed", "persona.removed", "route.assignment.changed", "route.test.completed", "workflow.job.changed", "workflow.job.finished", "pcms.batch.completed"].includes(event.type)) scheduleRefresh();
  }, { onStatus: (status) => {
    setConnection(status);
    if (status?.connected === false || status === "disconnected") {
      scheduleRefresh();
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(attachEventStream, 750);
    }
  } });
  setConnection(state.eventConnection?.connected ? "connected" : "pending");
}

attachEventStream();
renderActivity();
refresh();
window.addEventListener("unload", () => { clearTimeout(state.reconnectTimer); state.eventConnection?.disconnect?.(); }, { once: true });
