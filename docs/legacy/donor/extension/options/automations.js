import { WORKFLOW_PACKAGE_LIMITS } from "../lib/package-limits.js";
import { MAX_WORKFLOW_STEP_TIMEOUT_MS } from "../lib/constants.js";
import { toast } from "./toast.js";
import { confirmAction } from "./confirm-dialog.js";
import { confirmWorkflowControlOverride } from "./workflow-control.js";
import { normalizeWorkflow } from "../lib/storage.js";
import {
  collectWorkflowValidationIssues,
  createStarterWorkflow,
  createWorkflowStep,
  duplicateWorkflow,
  moveWorkflowStep,
  validateWorkflowForRun
} from "../lib/workflow-model.js";
import {
  exportWorkflowPackage,
  importWorkflowPackage,
  inspectWorkflowPackage
} from "../lib/workflow-package.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
})[ch]);

let snapshot = null;
let selectedWorkflowId = null;
let syncPromise = null;
let mutationChain = Promise.resolve();
let packagePreview = null;
let workflowFilterText = "";

function lines(text) {
  return [...new Set(String(text || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
}

async function msg(type, extra = {}) {
  return browser.runtime.sendMessage({ type, ...extra });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getSnapshotWithRetry() {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { return await msg("GET_SNAPSHOT"); }
    catch (error) {
      lastError = error;
      if (attempt < 7) await sleep(Math.min(1000, 100 * (2 ** attempt)));
    }
  }
  throw lastError || new Error("Extension background is unavailable");
}

async function saveState(nextState) {
  try {
    return await msg("SAVE_STATE", { state: nextState });
  } catch (error) {
    const conflict = error?.code === "STATE_CONFLICT" || /state revision conflict/i.test(String(error?.message || error));
    try { snapshot = await getSnapshotWithRetry(); render(); } catch {}
    if (conflict) throw new Error("State changed in another surface. Latest state reloaded; retry your edit.");
    throw error;
  }
}

function queueMutation(operation) {
  const run = mutationChain.then(operation, operation);
  mutationChain = run.catch(() => {});
  return run;
}

function queueUiOperation(operation) {
  void queueMutation(operation).catch((error) => toast(error?.message || String(error), true));
}

function managedProfiles() {
  return Object.values(snapshot?.state?.profiles || {})
    .filter((profile) => profile?.managed)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function profileOptions(selected = "") {
  const profiles = managedProfiles();
  const emptyLabel = profiles.length ? "Choose persona…" : "No managed personas available";
  return `<option value="">${emptyLabel}</option>` + profiles.map((profile) =>
    `<option value="${esc(profile.containerId)}"${profile.containerId === selected ? " selected" : ""}>${esc(profile.name)}</option>`
  ).join("");
}

function scriptChecks(selected = []) {
  const chosen = new Set(selected || []);
  const scripts = Object.values(snapshot?.state?.scripts || {})
    .filter((script) => script?.enabled)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!scripts.length) return `<span class="muted">No enabled userscripts.</span>`;
  return scripts.map((script) =>
    `<label data-script-search="${esc(`${script.name} ${script.id}`.toLowerCase())}"><input type="checkbox" class="wfScript" value="${esc(script.id)}"${chosen.has(script.id) ? " checked" : ""}> <span title="${esc(script.name)}">${esc(script.name)}</span></label>`
  ).join("");
}

function completionValueAttributes(mode) {
  if (mode === "delay") return `type="number" min="0" max="600000" step="1" placeholder="Milliseconds, e.g. 5000" title="Delay after page load, in milliseconds"`;
  if (mode === "selector") return `type="text" placeholder="CSS selector, e.g. #ready" title="CSS selector to wait for"`;
  const placeholder = mode === "signal"
    ? "Not used — selected userscripts call Persona.complete()"
    : "Not used for page-load completion";
  return `type="text" disabled placeholder="${esc(placeholder)}" title="${esc(placeholder)}"`;
}

function ensurePackageUi() {
  if ($("workflowPackagePanel")) return;
  const tab = $("tab-automations");
  if (!tab) return;
  const panel = document.createElement("details");
  panel.id = "workflowPackagePanel";
  panel.className = "panel workflow-package-panel secondary-feature";
  panel.innerHTML = `<summary><span>Portable workflow packages</span><small>Import/export workflow ZIPs</small></summary>
    <div class="workflow-package-body">
      <div class="inline spread workflow-package-header">
        <p class="hint">Packages contain a workflow definition plus required userscripts. Imports are previewed before state changes.</p>
        <label class="package-file-label">Import package<input id="workflowPackageFile" type="file" accept=".zip,.personamonkey.zip,application/zip"></label>
      </div>
      <div id="workflowPackagePreview" class="hidden"></div>
    </div>`;
  const workflowLayout = tab.querySelector(".scripts-layout");
  if (workflowLayout) workflowLayout.after(panel); else tab.append(panel);
}
function renderPackagePreview() {
  ensurePackageUi();
  const el = $("workflowPackagePreview");
  if (!el) return;
  if (!packagePreview) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const manifest = packagePreview.manifest;
  const personaRows = packagePreview.personas.map((persona) => {
    const options = persona.candidates.length
      ? persona.candidates.map((candidate) => `<option value="${esc(candidate.id)}"${candidate.id === persona.suggestedProfileId ? " selected" : ""}>${esc(candidate.name)} · ${esc(candidate.routeId || "route unknown")}</option>`).join("")
      : `<option value="">No compatible managed persona</option>`;
    return `<label>${esc(persona.label)} <span class="route-meta">${esc(persona.routeRequirement || "any")}</span>
      <select class="package-persona-binding" data-persona-key="${esc(persona.key)}"><option value="">Choose persona…</option>${options}</select>
      ${persona.description ? `<small>${esc(persona.description)}</small>` : ""}
    </label>`;
  }).join("");
  const scripts = packagePreview.scripts.length
    ? packagePreview.scripts.map((script) => {
      const grants = script.metadata.grants || [];
      const connects = script.metadata.connects || [];
      const highImpact = new Set(["unsafeWindow", "GM_cookie", "GM.cookie", "GM_xmlhttpRequest", "GM.xmlHttpRequest", "GM.xmlhttpRequest", "GM_download", "GM.download", "GM_setClipboard", "GM.setClipboard", "window.close", "Persona.signal"]);
      const sensitive = grants.filter((grant) => highImpact.has(grant));
      return `<li><strong>${esc(script.metadata.name)}</strong> · ${script.reuseScriptId ? "reuse identical installed script" : "import new script"}<div class="route-meta">@grant: ${grants.length ? esc(grants.join(", ")) : "none declared"}</div><div class="route-meta">@connect: ${connects.length ? esc(connects.join(", ")) : "none declared"}</div><div class="route-meta">High-impact grants: ${sensitive.length ? esc(sensitive.join(", ")) : "none detected"}</div></li>`;
    }).join("")
    : `<li>No userscripts required.</li>`;
  el.innerHTML = `<div class="workflow-package-preview-card">
      <div class="inline spread"><div><strong>${esc(manifest.package.name)}</strong><div class="route-meta">${esc(manifest.package.id)} · ${manifest.workflow.steps.length} step${manifest.workflow.steps.length === 1 ? "" : "s"}</div></div><button id="cancelPackageImport" class="small">Cancel</button></div>
      ${manifest.package.description ? `<p class="hint">${esc(manifest.package.description)}</p>` : ""}
      <h4>Persona mapping</h4>
      <div class="package-persona-grid">${personaRows || `<p class="muted">No persona slots.</p>`}</div>
      <h4>Userscripts</h4><ul class="package-script-list">${scripts}</ul>
      <div class="workflow-notice"><strong>Review before import.</strong> Userscripts are executable code. PersonaMonkey validates supported grants and package hashes, but importing does not imply that you trust the package author.</div>
      <button id="confirmPackageImport" class="primary">Import workflow + userscripts</button>
    </div>`;
  el.classList.remove("hidden");
}

function renderWorkflowList() {
  const list = $("workflowList");
  if (!list || !snapshot) return;
  const all = Object.values(snapshot.state.workflows || {})
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const query = workflowFilterText.trim().toLowerCase();
  const workflows = query
    ? all.filter((workflow) => `${workflow.name} ${workflow.id}`.toLowerCase().includes(query))
    : all;
  list.innerHTML = workflows.length
    ? workflows.map((workflow) => `<button class="${workflow.id === selectedWorkflowId ? "active" : ""}" data-workflow-id="${esc(workflow.id)}" aria-pressed="${workflow.id === selectedWorkflowId ? "true" : "false"}">
        <strong title="${esc(workflow.name)}">${esc(workflow.name)}</strong>
        <div class="route-meta">${workflow.enabled ? "Enabled" : "Disabled"} · ${workflow.steps.length} step${workflow.steps.length === 1 ? "" : "s"}</div>
      </button>`).join("")
    : `<p class="muted">${all.length ? "No workflows match this filter." : "No workflows yet."}</p>`;
}

function readEditorWorkflow(workflow, normalize = false) {
  const elements = [...document.querySelectorAll("#workflowSteps .workflow-step")];
  const steps = elements.map((element, index) => ({
    id: workflow.steps?.[index]?.id || `step-${crypto.randomUUID().slice(0, 8)}`,
    profileId: element.querySelector(".wfProfile")?.value || "",
    urls: lines(element.querySelector(".wfUrls")?.value),
    concurrency: Number(element.querySelector(".wfConcurrency")?.value),
    scriptIds: [...element.querySelectorAll(".wfScript:checked")].map((input) => input.value),
    completion: {
      mode: element.querySelector(".wfCompletion")?.value || "load",
      value: element.querySelector(".wfCompletionValue")?.value || "",
      timeoutMs: Number(element.querySelector(".wfTimeout")?.value)
    },
    retries: Number(element.querySelector(".wfRetries")?.value),
    retryDelayMs: Number(element.querySelector(".wfRetryDelay")?.value),
    closeTabs: element.querySelector(".wfClose")?.checked !== false,
    stopOnError: element.querySelector(".wfStopError")?.checked !== false
  }));
  const draft = {
    ...workflow,
    name: $("wfName")?.value.trim() || workflow.name,
    enabled: $("wfEnabled")?.checked !== false,
    steps,
    updatedAt: new Date().toISOString()
  };
  return normalize ? normalizeWorkflow(draft, workflow.id) : draft;
}

function issueTarget(issue) {
  const selectorByCode = {
    "workflow-disabled":"#wfEnabled",
    "persona-required":".wfProfile",
    "persona-missing":".wfProfile",
    "route-blocked":".wfProfile",
    "route-unavailable":".wfProfile",
    "urls-required":".wfUrls",
    "url-invalid":".wfUrls",
    "concurrency-invalid":".wfConcurrency",
    "script-missing":".wfScriptFilter",
    "script-persona-mismatch":".wfScriptFilter",
    "delay-invalid":".wfCompletionValue",
    "selector-required":".wfCompletionValue",
    "signal-script-required":".wfScriptFilter",
    "timeout-invalid":".wfTimeout",
    "retries-invalid":".wfRetries",
    "retry-delay-invalid":".wfRetryDelay"
  };
  return selectorByCode[issue.code] || null;
}

function clearWorkflowValidationFields() {
  document.querySelectorAll("#workflowEditor .field-invalid").forEach((node) => {
    node.classList.remove("field-invalid");
    node.removeAttribute("aria-invalid");
  });
}

function focusWorkflowIssue(issue) {
  const selector = issueTarget(issue);
  if (!selector) return;
  const scope = Number.isInteger(issue.stepIndex)
    ? document.querySelector(`#workflowSteps .workflow-step[data-step-index="${issue.stepIndex}"]`)
    : document.getElementById("workflowEditor");
  const target = scope?.querySelector(selector);
  if (!target) return;
  const advanced = target.closest(".workflow-step-advanced");
  if (advanced) advanced.open = true;
  target.classList.add("field-invalid");
  target.setAttribute("aria-invalid","true");
  target.scrollIntoView({behavior:"smooth",block:"center"});
  target.focus?.();
}
function renderValidation(workflow) {
  const el = $("workflowValidation");
  if (!el || !snapshot) return;
  const issues = collectWorkflowValidationIssues(workflow, snapshot.state);
  clearWorkflowValidationFields();
  if (!issues.length) {
    el.className = "workflow-validation goodbox";
    el.innerHTML = `<strong>Ready to run.</strong> Steps execute sequentially; URLs inside each step may run concurrently.`;
  } else {
    el.className = "workflow-validation badbox";
    el.innerHTML = `<strong>${issues.length} issue${issues.length === 1 ? "" : "s"} to fix before Run</strong><ul>${issues.map((entry, index) => {
      const clean = String(entry.message || "").replace(/^Step\s+\d+:\s*/i, "");
      const prefix = Number.isInteger(entry.stepIndex) ? `Step ${entry.stepIndex + 1} · ` : "";
      return `<li><button type="button" class="workflow-validation-link" data-validation-index="${index}">${esc(prefix + clean)}</button></li>`;
    }).join("")}</ul>`;
    for (const issue of issues) {
      const selector = issueTarget(issue);
      if (!selector) continue;
      const scope = Number.isInteger(issue.stepIndex)
        ? document.querySelector(`#workflowSteps .workflow-step[data-step-index="${issue.stepIndex}"]`)
        : document.getElementById("workflowEditor");
      const target = scope?.querySelector(selector);
      if (target) {
        target.classList.add("field-invalid");
        target.setAttribute("aria-invalid","true");
        const advanced = target.closest(".workflow-step-advanced");
        if (advanced) advanced.open = true;
      }
    }
  }
  el._issues = issues;
  const run = $("runWorkflow");
  if (run) run.disabled = issues.length > 0;
}

function renderWorkflowEditor() {
  const editor = $("workflowEditor");
  if (!editor || !snapshot) return;
  const workflow = snapshot.state.workflows?.[selectedWorkflowId];
  if (!workflow) {
    editor.innerHTML = `<div class="empty-state workflow-empty-state"><strong>No workflow selected</strong><p class="muted">Select a workflow from the list, or create one to define persona steps and completion rules.</p><button type="button" data-create-workflow class="primary">Create workflow</button></div>`;
    return;
  }

  const profiles = managedProfiles();
  const notice = profiles.length ? "" : `<div id="workflowPersonaNotice" class="workflow-notice"><strong>No managed persona is available.</strong> You can edit and save this workflow as a draft, but it cannot run until a managed Firefox container is selected in every step.</div>`;
  const steps = workflow.steps.map((step, index) => {
    const mode = step.completion?.mode || "load";
    return `<div class="workflow-step" data-step-index="${index}">
      <div class="inline spread">
        <div><h3>Step ${index + 1}</h3><span class="route-meta">Runs after step ${index || "start"} finishes</span></div>
        <div class="inline step-actions">
          <button class="small move-step" data-direction="-1"${index === 0 ? " disabled" : ""}>↑</button>
          <button class="small move-step" data-direction="1"${index === workflow.steps.length - 1 ? " disabled" : ""}>↓</button>
          <button class="small danger remove-step"${workflow.steps.length <= 1 ? " disabled" : ""}>Remove</button>
        </div>
      </div>
      <div class="form-grid workflow-step-core">
        <label>Persona<select class="wfProfile">${profileOptions(step.profileId)}</select></label>
        <label>Concurrency within this step<input class="wfConcurrency" type="number" min="1" max="200" value="${esc(step.concurrency)}"></label>
      </div>
      <label>URLs — one per line<textarea class="wfUrls" rows="7">${esc((step.urls || []).join("\n"))}</textarea></label>
      <details class="workflow-script-assignment">
        <summary>Userscripts — ${(step.scriptIds || []).length} selected</summary>
        <div class="workflow-script-assignment-body">
          <div class="inline spread"><label>Userscripts to run in this step</label><input class="wfScriptFilter collection-filter compact-filter" type="search" placeholder="Filter scripts…" aria-label="Filter workflow scripts"></div>
          <div class="profile-checks wf-scripts">${scriptChecks(step.scriptIds)}</div>
        </div>
      </details>
      <details class="workflow-step-advanced">
        <summary>Advanced execution</summary>
        <div class="form-grid">
          <label>Completion<select class="wfCompletion">
            <option value="load"${mode === "load" ? " selected" : ""}>Page load</option>
            <option value="delay"${mode === "delay" ? " selected" : ""}>Delay after page load</option>
            <option value="selector"${mode === "selector" ? " selected" : ""}>Wait for CSS selector</option>
            <option value="signal"${mode === "signal" ? " selected" : ""}>Userscript Persona.complete() signal</option>
          </select></label>
          <label>Completion value<input class="wfCompletionValue" value="${esc(step.completion?.value || "")}" ${completionValueAttributes(mode)}></label>
          <label>Timeout (ms)<input class="wfTimeout" type="number" min="1000" max="${MAX_WORKFLOW_STEP_TIMEOUT_MS}" value="${esc(step.completion?.timeoutMs || 60000)}"></label>
          <label>Retries<input class="wfRetries" type="number" min="0" max="10" value="${esc(step.retries || 0)}"></label>
          <label>Retry delay (ms)<input class="wfRetryDelay" type="number" min="0" max="600000" value="${esc(step.retryDelayMs ?? 1000)}"></label>
          <label class="check"><input class="wfClose" type="checkbox"${step.closeTabs !== false ? " checked" : ""}> Close each job tab after completion</label>
          <label class="check"><input class="wfStopError" type="checkbox"${step.stopOnError !== false ? " checked" : ""}> Stop workflow on final task failure</label>
        </div>
        <p class="hint">Completion can wait for load, delay, a selector, or <code>Persona.complete()</code>/<code>Persona.fail()</code> from selected isolated-world userscripts that declare <code>@grant Persona.signal</code>.</p>
      </details>
    </div>`;
  }).join("");

  editor.innerHTML = `<div class="script-editor-grid">
      <label>Name<input id="wfName" value="${esc(workflow.name)}"></label>
      <label class="check"><input id="wfEnabled" type="checkbox"${workflow.enabled ? " checked" : ""}> Enabled</label>
    </div>
    ${notice}
    <div id="workflowValidation" class="workflow-validation"></div>
    <div id="workflowSteps">${steps}</div>
    <div class="workflow-editor-actions">
      <div class="action-row workflow-primary-actions">
        <button id="addWorkflowStep">+ Add step</button>
        <button id="saveWorkflow" class="primary">Save workflow</button>
        <button id="runWorkflow" class="primary">Run</button>
      </div>
      <details class="secondary-controls destructive-disclosure">
        <summary>More actions</summary>
        <div class="action-row">
          <button id="duplicateWorkflow">Duplicate</button>
          <button id="exportWorkflowPackage">Export package ZIP</button>
          <button id="deleteWorkflow" class="danger">Delete workflow</button>
        </div>
      </details>
    </div>`;
  renderValidation(workflow);
}

function render() {
  ensurePackageUi();
  renderPackagePreview();
  renderWorkflowList();
  renderWorkflowEditor();
}

function refreshValidationFromEditor() {
  const workflow = snapshot?.state?.workflows?.[selectedWorkflowId];
  if (!workflow || !$("workflowSteps")) return;
  renderValidation(readEditorWorkflow(workflow, false));
}

async function sync({ createStarter = false } = {}) {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    snapshot = await getSnapshotWithRetry();
    if (selectedWorkflowId && !snapshot.state.workflows?.[selectedWorkflowId]) selectedWorkflowId = null;
    if (createStarter && !Object.keys(snapshot.state.workflows || {}).length) {
      const starter = createStarterWorkflow(snapshot.state.profiles || {});
      if (starter) {
        snapshot.state.workflows[starter.id] = starter;
        selectedWorkflowId = starter.id;
        const saved = await saveState(snapshot.state);
        snapshot.state = saved.state;
      }
    }
    render();
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

async function saveSelected(message = "Workflow saved") {
  const workflow = snapshot?.state?.workflows?.[selectedWorkflowId];
  if (!workflow) throw new Error("Select a workflow first");
  snapshot.state.workflows[selectedWorkflowId] = readEditorWorkflow(workflow, true);
  const saved = await saveState(snapshot.state);
  snapshot.state = saved.state;
  render();
  toast(message);
  return snapshot.state.workflows[selectedWorkflowId];
}

async function createWorkflow() {
  if (!snapshot) await sync();
  const id = `workflow-${crypto.randomUUID().slice(0, 8)}`;
  const firstProfile = managedProfiles()[0]?.containerId || "";
  snapshot.state.workflows[id] = normalizeWorkflow({ id, name: "New workflow", enabled: true, steps: [createWorkflowStep({ profileId: firstProfile })] }, id);
  selectedWorkflowId = id;
  render();
  const saved = await saveState(snapshot.state);
  snapshot.state = saved.state;
  render();
  toast("Workflow created");
}

async function addStep() {
  const workflow = snapshot?.state?.workflows?.[selectedWorkflowId];
  if (!workflow) throw new Error("Select a workflow first");
  const edited = readEditorWorkflow(workflow, true);
  const currentProfile = edited.steps.at(-1)?.profileId || managedProfiles()[0]?.containerId || "";
  edited.steps.push(createWorkflowStep({ profileId: currentProfile }));
  edited.updatedAt = new Date().toISOString();
  snapshot.state.workflows[selectedWorkflowId] = edited;
  render();
}

async function removeStep(index) {
  const workflow = snapshot?.state?.workflows?.[selectedWorkflowId];
  if (!workflow) return;
  const edited = readEditorWorkflow(workflow, true);
  if (edited.steps.length <= 1 || !Number.isInteger(index) || index < 0 || index >= edited.steps.length) return;
  edited.steps.splice(index, 1);
  edited.updatedAt = new Date().toISOString();
  snapshot.state.workflows[selectedWorkflowId] = normalizeWorkflow(edited, edited.id);
  render();
}

async function moveStep(index, direction) {
  const workflow = snapshot?.state?.workflows?.[selectedWorkflowId];
  if (!workflow) return;
  const edited = readEditorWorkflow(workflow, true);
  snapshot.state.workflows[selectedWorkflowId] = moveWorkflowStep(edited, index, direction);
  render();
}

async function duplicateSelected() {
  const workflow = snapshot?.state?.workflows?.[selectedWorkflowId];
  if (!workflow) throw new Error("Select a workflow first");
  const edited = readEditorWorkflow(workflow, true);
  snapshot.state.workflows[selectedWorkflowId] = edited;
  const copy = duplicateWorkflow(edited);
  snapshot.state.workflows[copy.id] = copy;
  selectedWorkflowId = copy.id;
  const saved = await saveState(snapshot.state);
  snapshot.state = saved.state;
  render();
  toast("Workflow duplicated");
}

async function runSelected() {
  const workflow = snapshot?.state?.workflows?.[selectedWorkflowId];
  if (!workflow) throw new Error("Select a workflow first");
  const draft = readEditorWorkflow(workflow, false);
  validateWorkflowForRun(draft, snapshot.state);
  snapshot.state.workflows[selectedWorkflowId] = normalizeWorkflow(draft, workflow.id);
  const saved = await saveState(snapshot.state);
  snapshot.state = saved.state;
  const normalized = snapshot.state.workflows[selectedWorkflowId];
  const usesScripts = normalized.steps.some((step) => step.scriptIds.length);
  if (usesScripts) {
    const granted = await browser.permissions.contains({ permissions: ["userScripts"] });
    if (!granted) throw new Error("Enable userscript permission before running a workflow that uses scripts");
  }
  const overrideConfirmation = await confirmWorkflowControlOverride(normalized, snapshot.state);
  if (overrideConfirmation === null) return;
  const result = await msg("RUN_WORKFLOW", { workflowId: normalized.id, overrideConfirmation });
  toast(`Started ${result.job.id}`);
  document.querySelector('[data-tab="activity"]')?.click();
}

async function exportSelectedPackage() {
  const workflow = snapshot?.state?.workflows?.[selectedWorkflowId];
  if (!workflow) throw new Error("Select a workflow first");
  const edited = readEditorWorkflow(workflow, true);
  const exported = await exportWorkflowPackage(edited, snapshot.state);
  const blob = new Blob([exported.bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = exported.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${exported.filename}`);
}

async function inspectPackageFile(file) {
  if (!file) return;
  if (!snapshot) await sync();
  if (file.size > WORKFLOW_PACKAGE_LIMITS.maxCompressedBytes) throw new Error("Workflow package is too large");
  packagePreview = await inspectWorkflowPackage(new Uint8Array(await file.arrayBuffer()), snapshot.state);
  renderPackagePreview();
  toast(`Package inspected: ${packagePreview.manifest.package.name}`);
}

async function confirmPackageImport() {
  if (!packagePreview) throw new Error("Choose a workflow package first");
  const bindings = {};
  document.querySelectorAll(".package-persona-binding").forEach((select) => { bindings[select.dataset.personaKey] = select.value; });
  const imported = importWorkflowPackage(packagePreview, snapshot.state, bindings);
  const saved = await saveState(imported.state);
  snapshot.state = saved.state;
  selectedWorkflowId = imported.workflow.id;
  const importedCount = imported.importedScripts.length;
  const reusedCount = imported.reusedScripts.length;
  packagePreview = null;
  if ($("workflowPackageFile")) $("workflowPackageFile").value = "";
  render();
  toast(`Imported workflow · ${importedCount} userscript${importedCount === 1 ? "" : "s"} added${reusedCount ? ` · ${reusedCount} reused` : ""}`);
}

async function deleteSelected() {
  const workflow = snapshot?.state?.workflows?.[selectedWorkflowId];
  if (!workflow) return;
  if (!await confirmAction(`Delete ${workflow.name}? This removes the workflow definition and cannot be undone.`, {title:"Delete workflow",confirmLabel:"Delete workflow"})) return;
  delete snapshot.state.workflows[selectedWorkflowId];
  selectedWorkflowId = null;
  render();
  const saved = await saveState(snapshot.state);
  snapshot.state = saved.state;
  render();
  toast("Workflow deleted");
}

function configureCompletionControl(select) {
  const step = select.closest(".workflow-step");
  const value = step?.querySelector(".wfCompletionValue");
  if (!value) return;
  const mode = select.value;
  value.disabled = !["delay", "selector"].includes(mode);
  if (mode === "delay") {
    value.type = "number";
    value.min = "0";
    value.max = "600000";
    value.step = "1";
    value.placeholder = "Milliseconds, e.g. 5000";
    value.title = "Delay after page load, in milliseconds";
  } else if (mode === "selector") {
    value.type = "text";
    value.removeAttribute("min");
    value.removeAttribute("max");
    value.removeAttribute("step");
    value.placeholder = "CSS selector, e.g. #ready";
    value.title = "CSS selector to wait for";
  } else {
    value.type = "text";
    value.removeAttribute("min");
    value.removeAttribute("max");
    value.removeAttribute("step");
    value.placeholder = mode === "signal"
      ? "Not used — selected userscripts call Persona.complete()"
      : "Not used for page-load completion";
    value.title = value.placeholder;
  }
  refreshValidationFromEditor();
}

function ownEvent(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

document.addEventListener("click", (event) => {
  const automationTab = event.target.closest('[data-tab="automations"]');
  if (automationTab) {
    queueUiOperation(() => sync());
    return;
  }
  if (event.target.closest("#newWorkflow") || event.target.closest("[data-create-workflow]")) {
    ownEvent(event);
    queueUiOperation(createWorkflow);
    return;
  }
  const validationLink = event.target.closest(".workflow-validation-link");
  if (validationLink) {
    ownEvent(event);
    const issues = $("workflowValidation")?._issues || [];
    const issue = issues[Number(validationLink.dataset.validationIndex)];
    if (issue) focusWorkflowIssue(issue);
    return;
  }
  const workflowButton = event.target.closest("#workflowList [data-workflow-id]");
  if (workflowButton) {
    ownEvent(event);
    const workflowId = workflowButton.dataset.workflowId;
    queueUiOperation(async () => { selectedWorkflowId = workflowId; render(); });
    return;
  }
  const remove = event.target.closest("#workflowEditor .remove-step");
  if (remove) {
    ownEvent(event);
    const index = Number(remove.closest(".workflow-step")?.dataset.stepIndex);
    queueUiOperation(() => removeStep(index));
    return;
  }
  const move = event.target.closest("#workflowEditor .move-step");
  if (move) {
    ownEvent(event);
    const index = Number(move.closest(".workflow-step")?.dataset.stepIndex);
    const direction = Number(move.dataset.direction);
    queueUiOperation(() => moveStep(index, direction));
    return;
  }
  if (event.target.closest("#addWorkflowStep")) {
    ownEvent(event);
    queueUiOperation(addStep);
    return;
  }
  if (event.target.closest("#saveWorkflow")) {
    ownEvent(event);
    queueUiOperation(() => saveSelected());
    return;
  }
  if (event.target.closest("#runWorkflow")) {
    ownEvent(event);
    queueUiOperation(runSelected);
    return;
  }
  if (event.target.closest("#duplicateWorkflow")) {
    ownEvent(event);
    queueUiOperation(duplicateSelected);
    return;
  }
  if (event.target.closest("#exportWorkflowPackage")) {
    ownEvent(event);
    queueUiOperation(exportSelectedPackage);
    return;
  }
  if (event.target.closest("#confirmPackageImport")) {
    ownEvent(event);
    queueUiOperation(confirmPackageImport);
    return;
  }
  if (event.target.closest("#cancelPackageImport")) {
    ownEvent(event);
    packagePreview = null;
    if ($("workflowPackageFile")) $("workflowPackageFile").value = "";
    renderPackagePreview();
    return;
  }
  if (event.target.closest("#deleteWorkflow")) {
    ownEvent(event);
    queueUiOperation(deleteSelected);
  }
}, true);

document.addEventListener("change", (event) => {
  const completion = event.target.closest("#workflowEditor .wfCompletion");
  if (completion) {
    configureCompletionControl(completion);
    return;
  }
  const packageFile = event.target.closest("#workflowPackageFile");
  if (packageFile) {
    const file = packageFile.files?.[0];
    queueUiOperation(() => inspectPackageFile(file));
    return;
  }
  if (event.target.closest("#workflowEditor")) refreshValidationFromEditor();
}, true);

document.addEventListener("input", (event) => {
  if (event.target.id === "workflowFilter") {
    workflowFilterText = event.target.value;
    renderWorkflowList();
    return;
  }
  const scriptFilter = event.target.closest(".wfScriptFilter");
  if (scriptFilter) {
    const query = scriptFilter.value.trim().toLowerCase();
    scriptFilter.closest(".workflow-step")?.querySelectorAll(".wf-scripts [data-script-search]").forEach((label) => {
      label.hidden = Boolean(query) && !String(label.dataset.scriptSearch || "").includes(query);
    });
    return;
  }
  if (event.target.closest("#workflowEditor")) refreshValidationFromEditor();
}, true);

mutationChain = sync({ createStarter: true })
  .catch((error) => toast(`Unable to load workflows: ${error.message || error}`, true));
