import { toast } from "./toast.js";
import { confirmAction } from "./confirm-dialog.js";
import { authorizeSecurityPreview } from "./security-review.js";
import {
  createPortableBackupPayload,
  encodeBackupEnvelope,
  decodeBackupEnvelope,
  suggestPersonaBindings,
  backupInventory
} from "../lib/backup-package.js";
import { backupComponents, buildImportedState, remapAutomationHistory } from "../lib/backup-import.js";
import { filterOrdinaryAutomationJobs, preserveExternalAutomationJobs } from "../lib/automation-history.js";
import { clearRecoverySnapshot, enableRecoverySnapshot, readRecoverySnapshot, writeRecoverySnapshot, RECOVERY_LOCAL_CONSENT_KEY } from "../lib/recovery-sync.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
})[ch]);
const clone = (value) => { try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); } };

let lastSnapshot = null;
let activeProfileId = null;
let cookieRows = [];
let cookieFilter = "";
let selectedCookieIndex = -1;
let pendingBackup = null;
let cookieService = null;

async function msg(type, extra = {}) {
  return browser.runtime.sendMessage({ type, ...extra });
}

async function getSnapshot() {
  lastSnapshot = await msg("GET_SNAPSHOT");
  return lastSnapshot;
}

function getCookieService() {
  if (cookieService) return cookieService;
  const call = (type, payload) => msg(type, payload);
  cookieService = {
    list: (profileId) => call("PERSONA_COOKIES_LIST", { profileId }),
    set: (profileId, cookie, original) => call("PERSONA_COOKIES_SET", { profileId, cookie, original }),
    remove: (profileId, cookie) => call("PERSONA_COOKIES_REMOVE", { profileId, cookie }),
    clear: (profileId, options = {}) => call("PERSONA_COOKIES_CLEAR", { profileId, options }),
    importRecords: (profileId, records, mode) => call("PERSONA_COOKIES_IMPORT", { profileId, records, mode })
  };
  return cookieService;
}

function download(filename, value, type = "application/json") {
  const blob = value instanceof Blob ? value : new Blob([value], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilePart(value) {
  return String(value || "item").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "item";
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function cookieMatches(cookie) {
  const q = cookieFilter.trim().toLowerCase();
  return !q || `${cookie.name} ${cookie.domain} ${cookie.path} ${cookie.value}`.toLowerCase().includes(q);
}

function cookieExpiry(cookie) {
  if (cookie.session || !cookie.expirationDate) return "session";
  const date = new Date(cookie.expirationDate * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "invalid";
}

function renderCookies() {
  const el = $("personaCookieTable");
  if (!el) return;
  const visible = cookieRows.map((cookie, index) => ({ cookie, index })).filter(({ cookie }) => cookieMatches(cookie));
  el.innerHTML = `<table class="cookie-table"><thead><tr><th>Name</th><th>Domain / path</th><th>Value</th><th>Flags</th><th>Expires</th><th></th></tr></thead><tbody>${visible.map(({ cookie, index }) => `<tr data-cookie-index="${index}">
    <td><strong>${esc(cookie.name)}</strong></td>
    <td><code>${esc(cookie.domain)}${esc(cookie.path)}</code>${cookie.firstPartyDomain ? `<div class="route-meta">first party: ${esc(cookie.firstPartyDomain)}</div>` : ""}${cookie.partitionKey?.topLevelSite ? `<div class="route-meta">partition: ${esc(cookie.partitionKey.topLevelSite)}</div>` : ""}</td>
    <td><code class="cookie-value-preview">${esc(cookie.value.length > 80 ? `${cookie.value.slice(0, 77)}…` : cookie.value)}</code></td>
    <td>${[cookie.secure && "Secure", cookie.httpOnly && "HttpOnly", cookie.sameSite && cookie.sameSite !== "unspecified" && cookie.sameSite].filter(Boolean).map(esc).join(" · ") || "—"}</td>
    <td>${esc(cookieExpiry(cookie))}</td>
    <td><button class="small edit-persona-cookie">Edit</button> <button class="small danger delete-persona-cookie">Delete</button></td>
  </tr>`).join("") || `<tr><td colspan="6">No matching cookies in this persona.</td></tr>`}</tbody></table>`;
  if ($("personaCookieCount")) $("personaCookieCount").textContent = `${cookieRows.length} cookie${cookieRows.length === 1 ? "" : "s"}`;
}

async function refreshCookies() {
  if (!activeProfileId || !$("personaCookieManager")) return;
  cookieRows = await getCookieService().list(activeProfileId);
  cookieRows.sort((a, b) => `${a.domain}\n${a.path}\n${a.name}`.localeCompare(`${b.domain}\n${b.path}\n${b.name}`));
  renderCookies();
  if (selectedCookieIndex >= cookieRows.length) selectedCookieIndex = -1;
  if (selectedCookieIndex < 0 && $("personaCookieEditor")) $("personaCookieEditor").innerHTML = "";
}

function renderCookieEditor(index) {
  selectedCookieIndex = index;
  const cookie = cookieRows[index];
  const el = $("personaCookieEditor");
  if (!el || !cookie) return;
  el.innerHTML = `<div class="cookie-edit-card"><h4>Edit cookie</h4><div class="form-grid">
    <label>Name<input id="cookieEditName" value="${esc(cookie.name)}"></label>
    <label>Domain<input id="cookieEditDomain" value="${esc(cookie.domain)}"></label>
    <label>Path<input id="cookieEditPath" value="${esc(cookie.path)}"></label>
    <label>SameSite<select id="cookieEditSameSite"><option value="unspecified"${cookie.sameSite === "unspecified" ? " selected" : ""}>unspecified</option><option value="lax"${cookie.sameSite === "lax" ? " selected" : ""}>lax</option><option value="strict"${cookie.sameSite === "strict" ? " selected" : ""}>strict</option><option value="no_restriction"${cookie.sameSite === "no_restriction" ? " selected" : ""}>no restriction</option></select></label>
    <label class="span-all">Value<textarea id="cookieEditValue" rows="4">${esc(cookie.value)}</textarea></label>
    <label>Expiration Unix seconds<input id="cookieEditExpiry" type="number" step="1" value="${cookie.expirationDate || ""}"${cookie.session ? " disabled" : ""}></label>
    <label class="check"><input id="cookieEditSession" type="checkbox"${cookie.session ? " checked" : ""}> Session cookie</label>
    <label class="check"><input id="cookieEditSecure" type="checkbox"${cookie.secure ? " checked" : ""}> Secure</label>
    <label class="check"><input id="cookieEditHttpOnly" type="checkbox"${cookie.httpOnly ? " checked" : ""}> HttpOnly</label>
  </div><p class="hint">Firefox first-party and partition isolation metadata is preserved automatically.</p><div class="inline"><button id="savePersonaCookie" class="primary">Save cookie</button><button id="cancelPersonaCookie">Cancel</button></div></div>`;
  $("cookieEditSession").onchange = () => { $("cookieEditExpiry").disabled = $("cookieEditSession").checked; };
  $("cancelPersonaCookie").onclick = () => { selectedCookieIndex = -1; el.innerHTML = ""; };
  $("savePersonaCookie").onclick = async () => {
    try {
      const original = cookieRows[selectedCookieIndex];
      const session = $("cookieEditSession").checked;
      const updated = {
        ...original,
        name: $("cookieEditName").value.trim(),
        domain: $("cookieEditDomain").value.trim(),
        path: $("cookieEditPath").value.trim() || "/",
        value: $("cookieEditValue").value,
        sameSite: $("cookieEditSameSite").value,
        session,
        expirationDate: session ? null : Number($("cookieEditExpiry").value),
        secure: $("cookieEditSecure").checked,
        httpOnly: $("cookieEditHttpOnly").checked
      };
      if (!session && (!Number.isFinite(updated.expirationDate) || updated.expirationDate <= Date.now() / 1000)) throw new Error("Persistent cookie expiration must be in the future");
      await getCookieService().set(activeProfileId, updated, original);
      await refreshCookies();
      toast("Cookie updated in this persona only");
    } catch (error) { toast(error.message || String(error), true); }
  };
}

async function mountCookieManager(profileId) {
  activeProfileId = profileId;
  const host = $("profileEditor");
  if (!host || host.classList.contains("hidden")) return;
  let panel = $("personaCookieManager");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "personaCookieManager";
    panel.className = "profile-cookie-manager";
    host.append(panel);
  }
  panel.innerHTML = `<hr><div class="inline spread"><div><h3>Persona cookies</h3><p class="hint">Every operation below targets only this Firefox container. Other personas are never included.</p></div><span id="personaCookieCount" class="badge neutral">Loading…</span></div>
    <div class="toolbar cookie-toolbar"><input id="personaCookieFilter" type="search" placeholder="Filter name, domain or value…"><button id="refreshPersonaCookies">Refresh</button><button id="clearAllPersonaCookies" class="danger">Clear all in this persona</button></div>
    <div class="inline cookie-domain-clear"><input id="clearPersonaCookieDomain" placeholder="example.com"><button id="clearPersonaCookieDomainButton">Clear domain + subdomains</button></div>
    <div id="personaCookieTable" class="table-wrap"></div><div id="personaCookieEditor"></div>`;
  $("personaCookieFilter").value = cookieFilter;
  $("personaCookieFilter").oninput = (event) => { cookieFilter = event.target.value; renderCookies(); };
  $("refreshPersonaCookies").onclick = () => void refreshCookies().catch((error) => toast(error.message || String(error), true));
  $("clearAllPersonaCookies").onclick = async () => {
    if (!await confirmAction("Clear every cookie in this persona only? Other personas are not affected.")) return;
    try { const result = await getCookieService().clear(activeProfileId); await refreshCookies(); toast(`Removed ${result.removed} cookies from this persona`); }
    catch (error) { toast(error.message || String(error), true); }
  };
  $("clearPersonaCookieDomainButton").onclick = async () => {
    const domain = $("clearPersonaCookieDomain").value.trim();
    if (!domain) return toast("Enter a domain first", true);
    if (!await confirmAction(`Clear cookies for ${domain} and its subdomains in this persona only?`)) return;
    try { const result = await getCookieService().clear(activeProfileId, { domain }); await refreshCookies(); toast(`Removed ${result.removed} matching cookies`); }
    catch (error) { toast(error.message || String(error), true); }
  };
  $("personaCookieTable").onclick = async (event) => {
    const row = event.target.closest("tr[data-cookie-index]");
    if (!row) return;
    const index = Number(row.dataset.cookieIndex);
    if (event.target.closest(".edit-persona-cookie")) renderCookieEditor(index);
    if (event.target.closest(".delete-persona-cookie")) {
      try { await getCookieService().remove(activeProfileId, cookieRows[index]); await refreshCookies(); toast("Cookie deleted from this persona"); }
      catch (error) { toast(error.message || String(error), true); }
    }
  };
  await refreshCookies();
}

function selectedValues(selector) {
  return [...document.querySelectorAll(selector)].filter((el) => el.checked).map((el) => el.value);
}

async function renderBackupSelectors() {
  const snap = await getSnapshot();
  const profiles = Object.values(snap.state.profiles || {}).filter((p) => p.managed).sort((a, b) => a.name.localeCompare(b.name));
  const scripts = Object.values(snap.state.scripts || {}).sort((a, b) => a.name.localeCompare(b.name));
  const workflows = Object.values(snap.state.workflows || {}).sort((a, b) => a.name.localeCompare(b.name));
  if ($("backupPersonaChoices")) $("backupPersonaChoices").innerHTML = profiles.map((p) => `<label data-backup-search="${esc(`${p.name} ${p.containerId}`.toLowerCase())}"><input type="checkbox" class="backupPersona" value="${esc(p.containerId)}"> <span title="${esc(p.name)}">${esc(p.name)}</span></label>`).join("") || `<span class="muted">No managed personas.</span>`;
  if ($("backupScriptChoices")) $("backupScriptChoices").innerHTML = scripts.map((s) => `<label data-backup-search="${esc(`${s.name} ${s.id}`.toLowerCase())}"><input type="checkbox" class="backupScript" value="${esc(s.id)}"> <span title="${esc(s.name)}">${esc(s.name)}</span></label>`).join("") || `<span class="muted">No userscripts.</span>`;
  if ($("backupWorkflowChoices")) $("backupWorkflowChoices").innerHTML = workflows.map((w) => `<label data-backup-search="${esc(`${w.name} ${w.id}`.toLowerCase())}"><input type="checkbox" class="backupWorkflow" value="${esc(w.id)}"> <span title="${esc(w.name)}">${esc(w.name)}</span></label>`).join("") || `<span class="muted">No workflows.</span>`;
}

async function collectBackup(selection) {
  const snap = await getSnapshot();
  const allStorage = await browser.storage.local.get(null);
  const jobs = filterOrdinaryAutomationJobs(Object.values(allStorage.automationJobs || {}));
  const preliminary = createPortableBackupPayload({ state: snap.state, containers: snap.containers, userscriptData: allStorage, automationHistory: jobs, selection });
  const cookiesByProfile = {};
  if (selection.kind === "full" || selection.cookies) {
    for (const persona of preliminary.personas) cookiesByProfile[persona.sourceId] = await getCookieService().list(persona.sourceId);
  }
  const payload = createPortableBackupPayload({ state: snap.state, containers: snap.containers, cookiesByProfile, userscriptData: allStorage, automationHistory: jobs, selection });
  return { snap, payload };
}

function scopeFromPayload(selection, payload) {
  return { kind: selection.kind || "selection", components: [...backupComponents(payload)] };
}

async function exportBackup(selection, password) {
  const { snap, payload } = await collectBackup(selection);
  const sensitive = selection.kind === "full" || selection.cookies || selection.gmValues || selection.routeSecrets;
  if (sensitive && !password) {
    throw new Error(selection.kind === "full"
      ? "Complete backups require a password because they contain private session data"
      : "This selection contains sensitive data. Enter a backup password to encrypt it before export");
  }
  const encoded = await encodeBackupEnvelope({
    payload,
    appVersion: browser.runtime.getManifest().version,
    stateSchemaVersion: snap.state.schemaVersion,
    scope: scopeFromPayload(selection, payload),
    password
  });
  const label = selection.kind === "full" ? "complete" : "selection";
  download(`personamonkey-${label}-${new Date().toISOString().slice(0, 10)}.personamonkey-backup.json`, encoded);
  const inventory = backupInventory(payload);
  toast(`Backup exported · ${inventory.personas} personas · ${inventory.userscripts} userscripts · ${inventory.cookies} cookies`);
}

async function renderRecoveryStatus() {
  const el = $("recoveryStatus");
  if (!el) return;
  const localSettings = await browser.storage.local.get(RECOVERY_LOCAL_CONSENT_KEY);
  const locallyEnabled = localSettings?.[RECOVERY_LOCAL_CONSENT_KEY]?.enabled === true;
  const consentCheckbox = $("enableRecoverySync");
  const saveButton = $("saveRecoveryNow");
  let recovery;
  try { recovery = await readRecoverySnapshot({ syncStorage: browser.storage?.sync }); }
  catch (error) {
    consentCheckbox.checked = false;
    saveButton.disabled = true;
    el.innerHTML = `<b>Firefox Sync recovery</b><span>Snapshot error: ${esc(error.message || String(error))}</span>`;
    return;
  }
  const syncEnabled = recovery.syncConsentEnabled === true;
  // A local opt-in alone is not enough to write. In particular, another
  // device may have published a synced opt-out that must remain authoritative
  // until the user explicitly reviews and opts in again.
  consentCheckbox.checked = locallyEnabled && syncEnabled;
  saveButton.disabled = !(locallyEnabled && syncEnabled);
  const restored = (await browser.storage.local.get("personaRecoveryRestore")).personaRecoveryRestore;
  if (recovery.available) {
    const meta = recovery.meta || {};
    const restoredText = restored?.restoredAt ? ` · last auto-restored ${new Date(restored.restoredAt).toLocaleString()}` : "";
    const localText = locallyEnabled ? "Enabled here" : "Saved in Sync; this installation is not enabled for updates";
    el.innerHTML = `<b>Firefox Sync recovery</b><span>${localText} · ${meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : "saved"} · ${formatBytes(meta.rawBytes)} source${restoredText}</span>`;
  } else if (recovery.meta?.tooLarge) {
    el.innerHTML = `<b>Firefox Sync recovery</b><span>Unavailable: ${formatBytes(recovery.meta.rawBytes)} exceeds the safe Sync quota. Use an encrypted complete backup.</span>`;
  } else if (!syncEnabled) {
    let consentText;
    if (recovery.reason === "Firefox Sync recovery is disabled in Firefox Sync") {
      consentText = locallyEnabled
        ? "Disabled in Firefox Sync. This installation's prior opt-in remains local; select the checkbox and confirm to opt in again."
        : "Disabled in Firefox Sync. No recovery snapshot is being written from this installation.";
    } else if (recovery.reason === "storage.sync unavailable") {
      consentText = "Firefox Sync storage is unavailable. No recovery snapshot can be written from this installation.";
    } else {
      consentText = locallyEnabled
        ? "Firefox Sync consent is missing or invalid. This installation's prior opt-in remains local; review Sync and explicitly opt in again if appropriate."
        : "Firefox Sync consent is missing or invalid. Enable Add-ons Sync and explicitly opt in before saving a snapshot.";
    }
    el.innerHTML = `<b>Firefox Sync recovery</b><span>${consentText}</span>`;
  } else {
    const localText = locallyEnabled
      ? "Enabled here; waiting for the first snapshot."
      : "Enabled in Sync; this installation is not enabled to write snapshot updates.";
    el.innerHTML = `<b>Firefox Sync recovery</b><span>${localText} Firefox Add-ons Sync must be enabled.</span>`;
  }
}

async function saveRecoveryNow() {
  const localSettings = await browser.storage.local.get(RECOVERY_LOCAL_CONSENT_KEY);
  if (localSettings?.[RECOVERY_LOCAL_CONSENT_KEY]?.enabled !== true) {
    await renderRecoveryStatus();
    toast("Enable Firefox Sync recovery before saving a snapshot", true);
    return;
  }
  const snap = await getSnapshot();
  const result = await writeRecoverySnapshot({ syncStorage: browser.storage?.sync, state: snap.state, containers: snap.containers, appVersion: browser.runtime.getManifest().version });
  await renderRecoveryStatus();
  if (result.consentRequired) return toast("Firefox Sync recovery is disabled; opt in before saving a snapshot", true);
  if (result.tooLarge) toast("Control-plane data exceeds Firefox Sync quota; create an encrypted complete backup instead", true);
  else toast(result.unchanged ? "Recovery snapshot is already current" : "Recovery snapshot saved to Firefox Sync");
}

async function enableRecoveryFromUi() {
  const approved = await confirmAction(
    "Firefox Sync recovery includes global settings, persona names/descriptions/notes/policies, route endpoints (host and port), userscript source and metadata, and workflow definitions including URLs. These fields can contain sensitive information if you put it in them. Cookies, route credentials, Integration API authority, GM values, and automation history are excluded. Enable this only if storing that snapshot in Firefox Sync is acceptable.",
    { title: "Review Firefox Sync recovery contents", confirmLabel: "Enable recovery", danger: false }
  );
  if (!approved) return false;
  await enableRecoverySnapshot({ syncStorage: browser.storage?.sync, localStorage: browser.storage.local });
  await saveRecoveryNow();
  return true;
}

async function disableAndClearRecovery() {
  await clearRecoverySnapshot({ syncStorage: browser.storage?.sync, localStorage: browser.storage.local });
  await renderRecoveryStatus();
  toast("Firefox Sync recovery turned off and its snapshot cleared");
}

async function resolvePersonaBindings(payload) {
  const snap = lastSnapshot || await getSnapshot();
  const existing = new Map((snap.containers || []).filter((c) => c?.cookieStoreId).map((c) => [c.cookieStoreId, c]));
  const map = new Map();
  const created = [];
  const used = new Set();
  try {
    for (const persona of payload.personas || []) {
      const select = document.querySelector(`.backupPersonaBinding[data-persona-key="${CSS.escape(persona.key)}"]`);
      let id = select?.value || "__create__";
      if (id === "__create__") {
        let item;
        try { item = await browser.contextualIdentities.create({ name: persona.name || "Imported persona", color: persona.color || "blue", icon: persona.icon || "fingerprint" }); }
        catch { item = await browser.contextualIdentities.create({ name: persona.name || "Imported persona", color: "blue", icon: "fingerprint" }); }
        id = item.cookieStoreId;
        existing.set(id, item);
        created.push(id);
      }
      if (used.has(id)) throw new Error("Two imported personas cannot map to the same Firefox container");
      used.add(id);
      map.set(persona.key, id);
    }
  } catch (error) {
    if (created.length && browser.contextualIdentities.remove) {
      await Promise.allSettled(created.map((id) => browser.contextualIdentities.remove(id)));
    }
    throw error;
  }
  return { map, created, containers: existing };
}

async function importGmValues(payload, scriptMap, replace) {
  if (replace) {
    const all = await browser.storage.local.get(null);
    const remove = Object.keys(all).filter((key) => key.startsWith("gm-values:"));
    if (remove.length) await browser.storage.local.remove(remove);
  }
  const values = {};
  for (const [key, data] of Object.entries(payload.gmValues || {})) {
    const scriptId = scriptMap.get(key);
    if (scriptId) values[`gm-values:${scriptId}`] = clone(data);
  }
  if (Object.keys(values).length) await browser.storage.local.set(values);
}

function comparableImportedJob(job) {
  const copy = clone(job || {});
  if (copy.state === "interrupted" && copy.error === "Imported historical job was active in the source backup") {
    delete copy.finishedAt;
  }
  return copy;
}

async function importAutomationHistory(payload, result, replace) {
  const current = await browser.storage.local.get("automationJobs");
  const currentJobs = current.automationJobs || {};
  const jobs = replace
    ? clone(preserveExternalAutomationJobs(currentJobs))
    : clone(currentJobs);
  const profileSource = new Map((payload.personas || []).map((persona) => [persona.sourceId, result.maps.profile.get(persona.key)]));
  const incoming = filterOrdinaryAutomationJobs(remapAutomationHistory(payload.automationHistory || [], { workflow: result.maps.workflow, profileSource }));
  for (const job of incoming) {
    let id = job.id || `job-import-${crypto.randomUUID().slice(0, 8)}`;
    if (jobs[id]) {
      const same = JSON.stringify(comparableImportedJob(jobs[id])) === JSON.stringify(comparableImportedJob({ ...job, id }));
      if (same) continue;
      id = `job-import-${crypto.randomUUID().slice(0, 8)}`;
    }
    jobs[id] = { ...job, id };
  }
  await msg("IMPORT_AUTOMATION_HISTORY", { jobs });
}

async function applyPendingBackup() {
  if (!pendingBackup) throw new Error("Inspect a backup first");
  const { payload } = pendingBackup;
  const mode = $("advancedImportMode")?.value || "merge";
  const replace = mode === "replace";
  if (replace) {
    const components = [...backupComponents(payload)];
    if (!await confirmAction(
      `Replace the component classes carried by this backup (${components.join(", ") || "selected data"})? Existing Firefox containers are kept, but matching PersonaMonkey configuration/data will be replaced.`,
      {title:"Replace imported components",confirmLabel:"Replace and import"}
    )) return;
  }
  const snap = await getSnapshot();
  const binding = await resolvePersonaBindings(payload);
  let saved = false;
  try {
    const result = await buildImportedState({ payload, currentState: snap.state, profileBindings: binding.map, mode });
    if (snap.state?.__stateMeta) result.state.__stateMeta = clone(snap.state.__stateMeta);
    for (const [personaKey, profileId] of result.maps.profile) {
      const container = binding.containers.get(profileId);
      if (container && result.state.profiles[profileId]) result.state.profiles[profileId].name = container.name;
    }
    const preview = await msg("PREVIEW_STATE_CHANGE", { state: result.state });
    const authorizationId = await authorizeSecurityPreview(preview, "backup import");
    if (!authorizationId) {
      if (binding.created.length && browser.contextualIdentities.remove) {
        await Promise.allSettled(binding.created.map((id) => browser.contextualIdentities.remove(id)));
      }
      return;
    }
    await msg("COMMIT_STATE_PREVIEW", { authorizationId });
    saved = true;

    const failures = [];
    if (result.components.has("cookies")) {
      for (const [personaKey, records] of Object.entries(payload.cookies || {})) {
        const profileId = result.maps.profile.get(personaKey);
        if (!profileId) continue;
        const imported = await getCookieService().importRecords(profileId, records, replace ? "replace" : "merge");
        failures.push(...imported.failures.map((entry) => `${entry.cookie?.domain || "cookie"}: ${entry.error}`));
      }
    }
    if (result.components.has("gm-values")) await importGmValues(payload, result.maps.script, replace);
    if (result.components.has("automation-history")) await importAutomationHistory(payload, result, replace);

    pendingBackup = null;
    renderImportPreview();
    await renderBackupSelectors();
    const uidRemaps = result.diagnostics?.personaUidRemaps?.length || 0;
    if (failures.length) toast(`Backup imported, but ${failures.length} cookies could not be restored`, true);
    else if (uidRemaps) toast(`Backup imported; ${uidRemaps} colliding Persona UID${uidRemaps === 1 ? "" : "s"} remapped`);
    else toast("Backup imported successfully");
  } catch (error) {
    if (!saved && binding.created.length && browser.contextualIdentities.remove) {
      await Promise.allSettled(binding.created.map((id) => browser.contextualIdentities.remove(id)));
    }
    throw error;
  }
}

function renderImportPreview() {
  const el = $("advancedImportPreview");
  if (!el) return;
  if (!pendingBackup) { el.innerHTML = ""; return; }
  const { envelope, payload } = pendingBackup;
  const inventory = envelope.inventory || backupInventory(payload);
  const suggestions = suggestPersonaBindings(payload, lastSnapshot?.containers || []);
  const suggestionMap = new Map(suggestions.map((entry) => [entry.key, entry]));
  const existingOptions = (lastSnapshot?.containers || []).filter((c) => c?.cookieStoreId).map((c) => `<option value="${esc(c.cookieStoreId)}">Reuse ${esc(c.name)} · ${esc(c.cookieStoreId)}</option>`).join("");
  const mappings = (payload.personas || []).map((persona) => `<label>${esc(persona.name)}<select class="backupPersonaBinding" data-persona-key="${esc(persona.key)}"><option value="__create__">Create new Firefox container</option>${existingOptions}</select><small>${esc(suggestionMap.get(persona.key)?.reason || "")}</small></label>`).join("");
  el.innerHTML = `<div class="backup-preview-card"><h3>Backup preview</h3>
    <div class="status-grid">${Object.entries(inventory).map(([key, value]) => `<div class="status-card"><b>${esc(key)}</b><span>${esc(value)}</span></div>`).join("")}</div>
    <p class="hint">Created ${esc(envelope.createdAt || "unknown")} · extension ${esc(envelope.appVersion || "unknown")} · ${envelope.encryption ? "encrypted" : "plaintext"}</p>
    ${inventory.cookies ? `<div class="warning-text"><strong>Session data included.</strong> This backup contains ${esc(inventory.cookies)} cookie${Number(inventory.cookies) === 1 ? "" : "s"} and may restore signed-in sessions into mapped personas.</div>` : ""}
    ${mappings ? `<h4>Persona mapping</h4><div class="package-persona-grid">${mappings}</div>` : ""}
    <p class="notice info"><strong>Import scope.</strong> Existing Firefox containers are never deleted. Merge adds/reuses data; Replace resets only component classes carried by this backup.</p>
    <div class="inline"><button id="confirmAdvancedImport" class="primary">Import inspected backup</button><button id="cancelAdvancedImport">Cancel</button></div></div>`;
  for (const select of el.querySelectorAll(".backupPersonaBinding")) {
    const suggestion = suggestionMap.get(select.dataset.personaKey);
    if (suggestion?.suggestedId && [...select.options].some((option) => option.value === suggestion.suggestedId)) select.value = suggestion.suggestedId;
  }
  $("cancelAdvancedImport").onclick = () => { pendingBackup = null; el.innerHTML = ""; };
  $("confirmAdvancedImport").onclick = () => void applyPendingBackup().catch((error) => toast(error.message || String(error), true));
}

async function inspectBackup() {
  const file = $("advancedImportFile")?.files?.[0];
  if (!file) throw new Error("Choose a PersonaMonkey backup file first");
  pendingBackup = await decodeBackupEnvelope(await file.text(), $("advancedImportPassword")?.value || "");
  await getSnapshot();
  renderImportPreview();
  toast("Backup inspected; review mappings before import");
}

function injectBackupUi() {
  const tab = $("tab-backup");
  if (!tab || $("advancedBackupPanel")) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `<nav id="backupSectionNav" class="backup-subnav" role="tablist" aria-label="Backup and recovery sections"><button type="button" class="active" data-backup-view="backup" aria-selected="true">Backup</button><button type="button" data-backup-view="restore" aria-selected="false">Restore</button><button type="button" data-backup-view="recovery" aria-selected="false">Recovery</button><button type="button" data-backup-view="legacy" aria-selected="false">Legacy</button></nav>
  <div id="advancedBackupPanel" class="panel backup-subview" data-backup-section="backup">
    <div class="inline spread backup-primary-head"><div><span class="eyebrow">Backup</span><h2>Back up PersonaMonkey</h2><p class="hint">Use a complete encrypted backup for disaster recovery, or export only the components you need.</p></div><button id="exportCompleteBackup" class="primary">Export complete backup</button></div>
    <label class="backup-password-field">Backup password<input id="advancedBackupPassword" type="password" autocomplete="new-password" placeholder="Required whenever sensitive data is included"><small>Sensitive exports are refused until a password is provided.</small></label>
    <details class="selective-backup" open><summary>Selective export</summary>
      <div class="form-grid backup-component-grid">
        <label class="check"><input id="backupIncludeSettings" type="checkbox"> Global settings</label>
        <label class="check"><input id="backupIncludeHistory" type="checkbox"> Automation history</label>
      </div>
      <details class="sensitive-backup-options"><summary>Sensitive data</summary><div class="form-grid">
        <label class="check"><input id="backupIncludeCookies" type="checkbox"> Cookies for selected/dependency personas</label>
        <label class="check"><input id="backupIncludeGm" type="checkbox"> Persistent userscript values</label>
        <label class="check"><input id="backupIncludeRouteSecrets" type="checkbox"> Route credentials</label>
      </div><p class="warning-text"><strong>Encryption required.</strong> Selecting any item in this group requires the backup password above.</p></details>
      <div class="backup-selection-grid">
        <div><div class="inline spread"><h4>Personas</h4><div class="row-actions"><button class="small backup-select-all" data-kind="Persona">All</button><button class="small backup-select-none" data-kind="Persona">None</button></div></div><input class="backup-filter" data-kind="Persona" type="search" placeholder="Filter personas…" aria-label="Filter backup personas"><div id="backupPersonaChoices" class="profile-checks"></div></div>
        <div><div class="inline spread"><h4>Userscripts</h4><div class="row-actions"><button class="small backup-select-all" data-kind="Script">All</button><button class="small backup-select-none" data-kind="Script">None</button></div></div><input class="backup-filter" data-kind="Script" type="search" placeholder="Filter userscripts…" aria-label="Filter backup userscripts"><div id="backupScriptChoices" class="profile-checks"></div></div>
        <div><div class="inline spread"><h4>Workflows</h4><div class="row-actions"><button class="small backup-select-all" data-kind="Workflow">All</button><button class="small backup-select-none" data-kind="Workflow">None</button></div></div><input class="backup-filter" data-kind="Workflow" type="search" placeholder="Filter workflows…" aria-label="Filter backup workflows"><div id="backupWorkflowChoices" class="profile-checks"></div></div>
      </div>
      <button id="exportSelectedBackup">Export selected data</button>
    </details>
  </div>
  <div id="advancedImportPanel" class="panel backup-subview hidden" data-backup-section="restore"><span class="eyebrow">Restore</span><h2>Import backup</h2><p class="hint">Inspect first; no import is applied until you review scope and persona mappings.</p><div class="form-grid"><label>Backup file<input id="advancedImportFile" type="file" accept=".json,.personamonkey-backup.json,application/json"></label><label>Password<input id="advancedImportPassword" type="password" autocomplete="current-password"></label><label>Mode<select id="advancedImportMode"><option value="merge">Merge with current data</option><option value="replace">Replace component classes present in backup</option></select></label></div><button id="inspectAdvancedImport" class="primary">Inspect backup</button><div id="advancedImportPreview"></div></div>
  <div id="recoveryPanel" class="panel backup-subview hidden" data-backup-section="recovery"><span class="eyebrow">Recovery</span><h2>Update / reinstall recovery</h2><p class="hint">Ordinary updates preserve extension storage automatically. Firefox Sync recovery is off until you opt in. The snapshot includes settings, persona names/descriptions/notes/policies, route hosts and ports, userscript source and metadata, and workflow URLs. Those fields may contain sensitive information. Cookies, route credentials, Integration API authority, GM values, and automation history are excluded. After reinstall, personas start Block and recovered routes remain disabled until you review and enable them locally.</p><label class="check"><input id="enableRecoverySync" type="checkbox"> Store recovery snapshots in Firefox Sync</label><div id="recoveryStatus" class="status-card"><b>Firefox Sync recovery</b><span>Checking…</span></div><div class="action-row"><button id="saveRecoveryNow" disabled>Save / refresh snapshot now</button><button id="clearRecoveryVault" class="danger">Turn off and clear snapshot</button></div></div>`;
  tab.prepend(...wrapper.children);
  const backupNav = $("backupSectionNav");
  const backupButtons = [...(backupNav?.querySelectorAll("[data-backup-view]") || [])];
  const backupPanels = new Map([...tab.querySelectorAll("[data-backup-section]")].map((panel) => [panel.dataset.backupSection, panel]));
  for (const button of backupButtons) {
    const view = button.dataset.backupView;
    const panel = backupPanels.get(view);
    button.id = `backup-nav-${view}`;
    button.setAttribute("role","tab");
    button.setAttribute("aria-controls", panel?.id || "");
    if (panel) {
      panel.setAttribute("role","tabpanel");
      panel.setAttribute("aria-labelledby", button.id);
    }
  }
  const showBackupSection = (view, { focus = false } = {}) => {
    for (const [section, panel] of backupPanels) {
      const active = section === view;
      panel.classList.toggle("hidden", !active);
      panel.setAttribute("aria-hidden", active ? "false" : "true");
    }
    for (const button of backupButtons) {
      const active = button.dataset.backupView === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
  };
  backupNav?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-backup-view]");
    if (button) showBackupSection(button.dataset.backupView);
  });
  backupNav?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
    const current = backupButtons.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const index = event.key === "Home" ? 0
      : event.key === "End" ? backupButtons.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + backupButtons.length) % backupButtons.length;
    const target = backupButtons[index];
    if (target) showBackupSection(target.dataset.backupView, { focus:true });
  });
  showBackupSection("backup");

  $("exportCompleteBackup").onclick = () => void exportBackup({ kind: "full" }, $("advancedBackupPassword").value).catch((error) => toast(error.message || String(error), true));
  $("exportSelectedBackup").onclick = () => {
    const selection = {
      kind: "selection",
      settings: $("backupIncludeSettings").checked,
      profileIds: selectedValues(".backupPersona"),
      scriptIds: selectedValues(".backupScript"),
      workflowIds: selectedValues(".backupWorkflow"),
      cookies: $("backupIncludeCookies").checked,
      gmValues: $("backupIncludeGm").checked,
      automationHistory: $("backupIncludeHistory").checked,
      routeSecrets: $("backupIncludeRouteSecrets").checked
    };
    if (!selection.settings && !selection.profileIds.length && !selection.scriptIds.length && !selection.workflowIds.length && !selection.automationHistory) return toast("Select settings, a persona, userscript, workflow, or history first", true);
    void exportBackup(selection, $("advancedBackupPassword").value).catch((error) => toast(error.message || String(error), true));
  };
  // The generated panels have already been moved out of the temporary
  // wrapper and into the live backup tab above, so bind collection controls
  // against their actual DOM owner rather than the now-empty wrapper.
  tab.querySelectorAll(".backup-select-all").forEach((button) => button.onclick = () => document.querySelectorAll(`.backup${button.dataset.kind}`).forEach((box) => { box.checked = true; }));
  tab.querySelectorAll(".backup-select-none").forEach((button) => button.onclick = () => document.querySelectorAll(`.backup${button.dataset.kind}`).forEach((box) => { box.checked = false; }));
  tab.querySelectorAll(".backup-filter").forEach((input) => input.oninput = () => {
    const query = input.value.trim().toLowerCase();
    const host = $(`backup${input.dataset.kind}Choices`);
    host?.querySelectorAll("[data-backup-search]").forEach((label) => {
      label.hidden = Boolean(query) && !String(label.dataset.backupSearch || "").includes(query);
    });
  });
  $("inspectAdvancedImport").onclick = () => void inspectBackup().catch((error) => toast(error.message || String(error), true));
  $("saveRecoveryNow").onclick = () => void saveRecoveryNow().catch((error) => toast(error.message || String(error), true));
  $("enableRecoverySync").onchange = () => void (async () => {
    if ($("enableRecoverySync").checked) {
      try {
        if (!await enableRecoveryFromUi()) $("enableRecoverySync").checked = false;
      } catch (error) {
        $("enableRecoverySync").checked = false;
        throw error;
      }
    } else {
      if (!await confirmAction("Turn off Firefox Sync recovery and remove the saved snapshot from this Sync account? Local PersonaMonkey data will remain unchanged.", { title: "Turn off and clear recovery", confirmLabel: "Turn off and clear" })) {
        $("enableRecoverySync").checked = true;
        return;
      }
      await disableAndClearRecovery();
    }
    await renderRecoveryStatus();
  })().catch((error) => toast(error.message || String(error), true));
  $("clearRecoveryVault").onclick = () => void (async () => {
    if (!await confirmAction("Turn off Firefox Sync recovery and remove the saved snapshot from this Sync account? Local PersonaMonkey data will remain unchanged.", {title:"Turn off and clear recovery",confirmLabel:"Turn off and clear"})) return;
    await disableAndClearRecovery();
  })().catch((error) => toast(error.message || String(error), true));
  void renderBackupSelectors();
  void renderRecoveryStatus();
}

function injectScriptExport(scriptId) {
  setTimeout(async () => {
    if (!$("scriptEditor") || !$("saveScript") || $("exportUserscriptFile")) return;
    const snap = await getSnapshot();
    const script = snap.state.scripts?.[scriptId];
    if (!script) return;
    const button = document.createElement("button");
    button.id = "exportUserscriptFile";
    button.textContent = "Export .user.js";
    button.onclick = () => download(`${safeFilePart(script.name)}.user.js`, script.code, "text/javascript");
    $("saveScript").parentElement?.append(button);
  }, 0);
}

document.addEventListener("click", (event) => {
  const edit = event.target.closest(".edit-profile");
  if (edit) {
    const row = edit.closest("tr[data-id]");
    if (row) setTimeout(() => void mountCookieManager(row.dataset.id).catch((error) => toast(error.message || String(error), true)), 0);
  }
  if (event.target.closest("#saveProfileEditor") && activeProfileId) setTimeout(() => void mountCookieManager(activeProfileId).catch(() => {}), 250);
  const script = event.target.closest("[data-script-id]");
  if (script) injectScriptExport(script.dataset.scriptId);
  if (event.target.closest('[data-tab="backup"]')) setTimeout(() => void renderBackupSelectors(), 0);
}, true);

injectBackupUi();
