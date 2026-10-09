import { toast } from "./toast.js";
import { confirmAction } from "./confirm-dialog.js";
import { cookieIdentity, normalizeCookieRecord } from "../lib/persona-cookies.js";
import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "../lib/constants.js";
import { encodeCookiePackage, decodeCookiePackage, MAX_COOKIE_PACKAGE_BYTES } from "../lib/cookie-package.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[ch]);
const clone = (value) => { try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); } };
const COLOR_FALLBACKS = {blue:"#37adff",green:"#51cd00",orange:"#ff9f00",pink:"#ff4bda",purple:"#af51f5",red:"#ff613d",cyan:"#00c79a",gray:"#7c8798",violet:"#7f6cff",yellow:"#e0b400"};

let snapshot = null;
let selectedProfileId = "";
let cookies = [];
let selectedKeys = new Set();
let filterText = "";
let personaFilterText = "";
let editingCookie = null;
let pendingImport = null;
let service = null;
let snapshotGeneration = 0;
let cookieRefreshGeneration = 0;

async function getSnapshot() {
  const generation = ++snapshotGeneration;
  const next = await browser.runtime.sendMessage({ type:"GET_SNAPSHOT" });
  if (generation === snapshotGeneration) snapshot = next;
  return snapshot || next;
}

function getService() {
  if (service) return service;
  const call = async (type, payload) => browser.runtime.sendMessage({ type, ...payload });
  service = {
    list: (profileId) => call("PERSONA_COOKIES_LIST", { profileId }),
    set: (profileId, cookie, original) => call("PERSONA_COOKIES_SET", { profileId, cookie, original }),
    remove: (profileId, cookie) => call("PERSONA_COOKIES_REMOVE", { profileId, cookie }),
    clear: (profileId, options = {}) => call("PERSONA_COOKIES_CLEAR", { profileId, options }),
    importRecords: (profileId, records, mode) => call("PERSONA_COOKIES_IMPORT", { profileId, records, mode })
  };
  return service;
}

function safeColor(container = {}) {
  const code = String(container.colorCode || "");
  if (/^#[0-9a-f]{6}$/i.test(code)) return code;
  return COLOR_FALLBACKS[container.color] || "#7c8798";
}

function safeFilePart(value) {
  return String(value || "persona").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "persona";
}

function personaRouteLabel(profile) {
  if (!profile?.routeId || profile.routeId === BLOCK_ROUTE_ID) return "Network blocked";
  if (profile.routeId === DIRECT_ROUTE_ID) return "Direct network";
  const route = snapshot?.state?.routes?.[profile.routeId];
  return route?.name ? `Via ${route.name}` : "Route unavailable";
}

function personaMarkup(container, profile, { compact = false } = {}) {
  const name = profile?.name || container?.name || "Persona";
  const icon = container?.iconUrl
    ? `<img src="${esc(container.iconUrl)}" alt="">`
    : `<span aria-hidden="true">${esc(String(container?.icon || "fingerprint").slice(0, 1).toUpperCase())}</span>`;
  const route = personaRouteLabel(profile);
  const protection = profile?.killSwitch === false ? "Protection relaxed" : "Protection enforced";
  return `<span class="persona-visual${compact ? " compact" : ""}" style="--persona-color:${safeColor(container)}"><span class="persona-icon">${icon}</span><span class="persona-visual-copy"><strong title="${esc(name)}">${esc(name)}</strong>${compact ? "" : `<small><span class="persona-network">${esc(route)}</span> · <span class="persona-protection">${esc(protection)}</span></small>`}</span></span>`;
}

function managedPersonas() {
  if (!snapshot) return [];
  const containers = new Map((snapshot.containers || []).filter((c) => c?.cookieStoreId && !c.error).map((c) => [c.cookieStoreId, c]));
  const profiles = new Map();
  for (const profile of Object.values(snapshot.state.profiles || {})) {
    if (!profile?.managed || !profile.containerId || !containers.has(profile.containerId) || profiles.has(profile.containerId)) continue;
    profiles.set(profile.containerId, profile);
  }
  return [...profiles.values()]
    .map((profile) => ({ profile, container:containers.get(profile.containerId) }))
    .sort((a,b) => String(a.profile.name || a.container.name).localeCompare(String(b.profile.name || b.container.name)));
}

function cookieExpiry(cookie) {
  if (cookie.session || !cookie.expirationDate) return "Session";
  const date = new Date(cookie.expirationDate * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Invalid";
}

function toLocalDateTime(seconds) {
  if (!Number.isFinite(Number(seconds))) return "";
  const date = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
}

function visibleCookies() {
  const query = filterText.trim().toLowerCase();
  if (!query) return cookies;
  return cookies.filter((cookie) => `${cookie.name} ${cookie.domain} ${cookie.path} ${cookie.value} ${cookie.firstPartyDomain || ""}`.toLowerCase().includes(query));
}

function renderPersonaList() {
  const host = $("cookiePersonaList");
  if (!host) return;
  const query = personaFilterText.trim().toLowerCase();
  const all = managedPersonas();
  const personas = query
    ? all.filter(({profile,container}) => `${profile.name || container.name} ${profile.containerId}`.toLowerCase().includes(query))
    : all;
  host.innerHTML = personas.length
    ? personas.map(({profile,container}) => `<button class="cookie-persona-button${profile.containerId === selectedProfileId ? " active" : ""}" data-profile-id="${esc(profile.containerId)}" aria-pressed="${profile.containerId === selectedProfileId ? "true" : "false"}">${personaMarkup(container, profile)}</button>`).join("")
    : `<p class="muted empty-state">${all.length ? "No personas match this filter." : "No managed personas."}</p>`;
}

function renderCookieTable() {
  const host = $("cookieTable");
  if (!host) return;
  const visible = visibleCookies();
  if (!visible.length) {
    const filtered = cookies.length > 0 && Boolean(filterText.trim());
    host.innerHTML = `<div class="cookie-empty-state"><strong>${filtered ? "No cookies match this filter" : "No cookies stored in this persona"}</strong><p>${filtered ? "Adjust or clear the filter to return to the full cookie store." : "This can be normal for a fresh persona. Create a cookie manually or use Import cookies in the toolbar to restore a cookie package."}</p><div class="action-row">${filtered ? `<button id="cookieClearFilter">Clear filter</button>` : `<button id="cookieEmptyCreate" class="primary">New cookie</button>`}</div></div>`;
    if ($("cookieSelectedCount")) $("cookieSelectedCount").textContent = `${selectedKeys.size} selected`;
    return;
  }
  host.innerHTML = `<table class="cookie-table"><thead><tr><th class="cookie-select-col"><input id="cookieSelectVisible" type="checkbox" aria-label="Select visible cookies"></th><th>Name</th><th>Domain / path</th><th>Value</th><th>Flags</th><th>Expires</th><th>Actions</th></tr></thead><tbody>${visible.map((cookie) => {
    const key = cookieIdentity(cookie);
    const index = cookies.findIndex((item) => cookieIdentity(item) === key);
    const flags = [cookie.secure && "Secure", cookie.httpOnly && "HttpOnly", cookie.sameSite && cookie.sameSite !== "unspecified" && cookie.sameSite, cookie.firstPartyDomain && `FPD ${cookie.firstPartyDomain}`, cookie.partitionKey?.topLevelSite && "Partitioned"].filter(Boolean);
    return `<tr data-cookie-index="${index}"><td class="cookie-select-cell" data-label="Select"><input class="cookie-select" type="checkbox"${selectedKeys.has(key) ? " checked" : ""} aria-label="Select ${esc(cookie.name)}"></td><td data-label="Name"><strong title="${esc(cookie.name)}">${esc(cookie.name)}</strong></td><td data-label="Domain / path"><code>${esc(cookie.domain)}${esc(cookie.path)}</code>${cookie.partitionKey?.topLevelSite ? `<div class="route-meta">top-level: ${esc(cookie.partitionKey.topLevelSite)}</div>` : ""}</td><td data-label="Value"><code class="cookie-value-preview">${esc(cookie.value.length > 96 ? `${cookie.value.slice(0, 93)}…` : cookie.value)}</code></td><td data-label="Flags">${flags.length ? esc(flags.join(" · ")) : "—"}</td><td data-label="Expires">${esc(cookieExpiry(cookie))}</td><td data-label="Actions"><div class="row-actions"><button class="small cookie-edit">Edit</button><button class="small danger cookie-delete">Delete</button></div></td></tr>`;
  }).join("") || `<tr><td colspan="7"><div class="table-empty">${cookies.length ? "No cookies match this filter." : "No cookies are stored in this persona."}</div></td></tr>`}</tbody></table>`;
  const selectVisible = $("cookieSelectVisible");
  if (selectVisible && visible.length) {
    const selectedCount = visible.filter((cookie) => selectedKeys.has(cookieIdentity(cookie))).length;
    selectVisible.checked = selectedCount === visible.length;
    selectVisible.indeterminate = selectedCount > 0 && selectedCount < visible.length;
  }
  if ($("cookieSelectedCount")) $("cookieSelectedCount").textContent = `${selectedKeys.size} selected`;
}

function renderCopyTargets() {
  const select = $("cookieCopyTarget");
  if (!select) return;
  const current = select.value;
  const options = managedPersonas().filter(({profile}) => profile.containerId !== selectedProfileId);
  select.innerHTML = `<option value="">Copy to persona…</option>${options.map(({profile}) => `<option value="${esc(profile.containerId)}">${esc(profile.name)}</option>`).join("")}`;
  if (options.some(({profile}) => profile.containerId === current)) select.value = current;
}

function renderWorkspace() {
  const host = $("cookieWorkspace");
  if (!host) return;
  const entry = managedPersonas().find(({profile}) => profile.containerId === selectedProfileId);
  if (!entry) {
    host.innerHTML = `<div class="empty-state"><strong>Select a persona</strong><p class="muted">Choose a managed Firefox container to inspect and edit only that container's cookies.</p></div>`;
    return;
  }
  host.innerHTML = `<div class="cookie-workspace-head"><div>${personaMarkup(entry.container, entry.profile)}<p class="hint">Cookie store <code>${esc(entry.profile.containerId)}</code> · operations here never include another persona unless you explicitly copy cookies.</p></div><span id="cookieCount" class="badge neutral">${cookies.length} cookie${cookies.length === 1 ? "" : "s"}</span></div>
    <div class="toolbar actionbar cookie-actionbar"><input id="cookieFilter" type="search" placeholder="Filter name, domain, path or value…" value="${esc(filterText)}" aria-label="Filter cookies"><div class="toolbar-actions"><button id="cookieRefresh">Refresh</button><button id="cookieNew" class="primary">New cookie</button><button id="cookieExport">Export cookies</button><label class="file-button">Import cookies<input id="cookieImportFile" type="file" accept=".json,.personamonkey-cookies.json,application/json"></label></div></div>
    <details class="cookie-destructive-controls"><summary>Clear cookies…</summary><div class="cookie-secondary-actions"><div class="cookie-domain-action"><input id="cookieClearDomain" placeholder="example.com" aria-label="Domain to clear"><button id="cookieClearDomainButton">Clear domain + subdomains</button></div><button id="cookieClearAll" class="danger secondary-danger">Clear all cookies</button></div></details>
    <div id="cookieImportPreview"></div>
    <div class="cookie-selection-bar"><span id="cookieSelectedCount">${selectedKeys.size} selected</span><select id="cookieCopyTarget"></select><button id="cookieCopySelected" disabled>Copy selected</button><button id="cookieDeleteSelected" class="danger" disabled>Delete selected</button></div>
    <div id="cookieTable" class="table-wrap"></div><div id="cookieEditor"></div>`;
  renderCopyTargets();
  renderCookieTable();
  updateSelectionActions();
  renderImportPreview();
  if (editingCookie) renderEditor(editingCookie);
}

function updateSelectionActions() {
  const copy = $("cookieCopySelected");
  const remove = $("cookieDeleteSelected");
  if (copy) copy.disabled = selectedKeys.size === 0 || !$("cookieCopyTarget")?.value;
  if (remove) remove.disabled = selectedKeys.size === 0;
  if ($("cookieSelectedCount")) $("cookieSelectedCount").textContent = `${selectedKeys.size} selected`;
}

function renderEditor(cookie = null) {
  editingCookie = cookie ? clone(cookie) : normalizeCookieRecord({name:"",value:"",domain:"",hostOnly:true,path:"/",secure:false,httpOnly:false,sameSite:"unspecified",session:true});
  const host = $("cookieEditor");
  if (!host) return;
  const record = editingCookie;
  host.innerHTML = `<div class="cookie-edit-card"><div class="inline spread"><div><span class="eyebrow">${cookie ? "Edit" : "Create"}</span><h3>${cookie ? esc(cookie.name) : "New cookie"}</h3></div><button id="cookieEditorClose" class="small">Close</button></div><div class="form-grid">
    <label>Name<input id="cookieEditName" value="${esc(record.name)}" autocomplete="off" aria-describedby="cookieEditorError"></label><label>Domain<input id="cookieEditDomain" value="${esc(record.domain)}" placeholder="example.com" autocomplete="off" aria-describedby="cookieEditorError"></label>
    <label>Path<input id="cookieEditPath" value="${esc(record.path || "/")}"></label><label>SameSite<select id="cookieEditSameSite"><option value="unspecified"${record.sameSite === "unspecified" ? " selected" : ""}>Unspecified</option><option value="lax"${record.sameSite === "lax" ? " selected" : ""}>Lax</option><option value="strict"${record.sameSite === "strict" ? " selected" : ""}>Strict</option><option value="no_restriction"${record.sameSite === "no_restriction" ? " selected" : ""}>None / no restriction</option></select></label>
    <label class="span-all">Value<textarea id="cookieEditValue" rows="4">${esc(record.value)}</textarea></label>
    <label>Expires (local time)<input id="cookieEditExpiry" type="datetime-local" value="${esc(toLocalDateTime(record.expirationDate))}"${record.session ? " disabled" : ""} aria-describedby="cookieEditorError"></label>
    <div class="cookie-flag-grid"><label class="check"><input id="cookieEditHostOnly" type="checkbox"${record.hostOnly ? " checked" : ""}> Host-only</label><label class="check"><input id="cookieEditSession" type="checkbox"${record.session ? " checked" : ""}> Session</label><label class="check"><input id="cookieEditSecure" type="checkbox"${record.secure ? " checked" : ""}> Secure</label><label class="check"><input id="cookieEditHttpOnly" type="checkbox"${record.httpOnly ? " checked" : ""}> HttpOnly</label></div>
    <details class="cookie-advanced span-all"><summary>Advanced isolation attributes</summary><div class="form-grid"><label>First-party domain<input id="cookieEditFirstParty" value="${esc(record.firstPartyDomain || "")}" placeholder="Leave blank when not isolated" aria-describedby="cookieEditorError"></label><label>Partition top-level site<input id="cookieEditPartition" value="${esc(record.partitionKey?.topLevelSite || "")}" placeholder="https://example.com" aria-describedby="cookieEditorError"></label></div><p class="hint">Firefox first-party isolation and dynamic partitioning are alternative isolation modes. Use either First-party domain or Partition top-level site, not both. Existing isolation metadata is preserved when editing.</p></details>
  </div><p id="cookieEditorError" class="warning-text" role="alert" hidden></p><div class="action-row"><button id="cookieEditorSave" class="primary">${cookie ? "Save cookie" : "Create cookie"}</button><button id="cookieEditorCancel">Cancel</button></div></div>`;
  $("cookieEditSession").onchange = () => { $("cookieEditExpiry").disabled = $("cookieEditSession").checked; };
  host.scrollIntoView({behavior:"smooth",block:"nearest"});
}

function closeEditor() {
  editingCookie = null;
  if ($("cookieEditor")) $("cookieEditor").innerHTML = "";
}

async function saveEditor() {
  const setError = (message = "", control = null) => {
    for (const field of [$("cookieEditName"), $("cookieEditDomain"), $("cookieEditExpiry"), $("cookieEditFirstParty"), $("cookieEditPartition")]) {
      field?.classList.remove("field-invalid");
      field?.removeAttribute("aria-invalid");
    }
    const error = $("cookieEditorError");
    if (error) {
      error.textContent = message;
      error.hidden = !message;
    }
    if (message && control) {
      control.classList.add("field-invalid");
      control.setAttribute("aria-invalid","true");
      control.focus();
    }
  };
  const original = editingCookie?.name ? clone(editingCookie) : null;
  const session = $("cookieEditSession").checked;
  const expiryInput = $("cookieEditExpiry").value;
  const expirationDate = session ? null : new Date(expiryInput).getTime() / 1000;
  if (!session && (!expiryInput || !Number.isFinite(expirationDate) || expirationDate <= Date.now() / 1000)) {
    setError("Persistent cookie expiration must be in the future", $("cookieEditExpiry"));
    return;
  }
  const name = $("cookieEditName").value.trim();
  const domain = $("cookieEditDomain").value.trim();
  if (!name) {
    setError("Cookie name is required", $("cookieEditName"));
    return;
  }
  if (!domain) {
    setError("Cookie domain is required", $("cookieEditDomain"));
    return;
  }
  setError();
  const firstPartyInput = $("cookieEditFirstParty").value.trim();
  const partitionInput = $("cookieEditPartition").value.trim();
  if (firstPartyInput && partitionInput) {
    setError("Choose either First-party domain or Partition top-level site. Firefox first-party isolation takes precedence over dynamic partitioning, so both cannot be set on the same cookie.", $("cookieEditPartition"));
    return;
  }
  const partitionKey = partitionInput ? { ...(editingCookie?.partitionKey || {}), topLevelSite:partitionInput } : null;
  let record;
  try {
    record = normalizeCookieRecord({
      ...editingCookie,
      name,
      value:$("cookieEditValue").value,
      domain,
      path:$("cookieEditPath").value.trim() || "/",
      sameSite:$("cookieEditSameSite").value,
      hostOnly:$("cookieEditHostOnly").checked,
      session,
      expirationDate,
      secure:$("cookieEditSecure").checked,
      httpOnly:$("cookieEditHttpOnly").checked,
      firstPartyDomain:firstPartyInput || (editingCookie?.firstPartyDomain === "" ? "" : null),
      partitionKey
    });
    await getService().set(selectedProfileId, record, original);
  } catch (error) {
    const message = error?.message || String(error);
    const control = /partition/i.test(message) ? $("cookieEditPartition")
      : /first.?party/i.test(message) ? $("cookieEditFirstParty")
      : null;
    setError(message, control);
    return;
  }
  closeEditor();
  await refreshCookies();
  toast(original ? "Cookie updated in this persona" : "Cookie created in this persona");
}

async function refreshCookies() {
  const profileId = selectedProfileId;
  if (!profileId) return;
  const generation = ++cookieRefreshGeneration;
  const nextCookies = await getService().list(profileId);
  if (generation !== cookieRefreshGeneration || selectedProfileId !== profileId) return;
  cookies = nextCookies;
  cookies.sort((a,b) => `${a.domain}\n${a.path}\n${a.name}`.localeCompare(`${b.domain}\n${b.path}\n${b.name}`));
  const existing = new Set(cookies.map(cookieIdentity));
  selectedKeys = new Set([...selectedKeys].filter((key) => existing.has(key)));
  renderWorkspace();
}

async function selectPersona(profileId) {
  await getSnapshot();
  const exists = managedPersonas().some(({profile}) => profile.containerId === profileId);
  selectedProfileId = exists ? profileId : (managedPersonas()[0]?.profile.containerId || "");
  cookieRefreshGeneration++;
  selectedKeys.clear();
  editingCookie = null;
  pendingImport = null;
  renderPersonaList();
  if (selectedProfileId) await refreshCookies(); else renderWorkspace();
}

function download(filename, value, type = "application/json") {
  const blob = value instanceof Blob ? value : new Blob([value], {type});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportCookies() {
  if (!selectedProfileId) return;
  if (!await confirmAction("Cookie exports contain authentication/session values in plaintext. Export this persona's cookies anyway?")) return;
  const entry = managedPersonas().find(({profile}) => profile.containerId === selectedProfileId);
  const encoded = encodeCookiePackage({cookies,persona:entry?.container || entry?.profile || {},appVersion:browser.runtime.getManifest().version});
  download(`${safeFilePart(entry?.profile?.name || entry?.container?.name)}.personamonkey-cookies.json`, encoded);
  toast(`Exported ${cookies.length} cookie${cookies.length === 1 ? "" : "s"} as plaintext`);
}

async function inspectImport(file) {
  if (!file) return;
  if (file.size > MAX_COOKIE_PACKAGE_BYTES) throw new Error("Cookie package is too large");
  pendingImport = decodeCookiePackage(await file.text());
  renderImportPreview();
}

function renderImportPreview() {
  const host = $("cookieImportPreview");
  if (!host) return;
  if (!pendingImport) { host.innerHTML = ""; return; }
  host.innerHTML = `<div class="cookie-import-preview"><div><strong>${pendingImport.cookies.length} cookies ready to import</strong><p class="hint">Exported from ${esc(pendingImport.persona?.name || "another persona")} · ${esc(pendingImport.exportedAt || "unknown time")}. Cookie files are plaintext and may contain active session credentials.</p></div><label>Import mode<select id="cookieImportMode"><option value="merge">Merge / overwrite matching cookies</option><option value="replace">Replace every cookie in this persona</option></select></label><div class="row-actions"><button id="cookieImportApply" class="primary">Import cookies</button><button id="cookieImportCancel">Cancel</button></div></div>`;
}

async function applyImport() {
  if (!pendingImport || !selectedProfileId) throw new Error("Choose a cookie package first");
  const mode = $("cookieImportMode")?.value || "merge";
  if (mode === "replace" && !await confirmAction("Replace all cookies in this persona with the imported cookie set? Other personas are not affected.")) return;
  const result = await getService().importRecords(selectedProfileId, pendingImport.cookies, mode);
  pendingImport = null;
  await refreshCookies();
  toast(result.failed ? `Imported ${result.imported} cookies; ${result.failed} failed` : `Imported ${result.imported} cookies`, result.failed > 0);
}

async function copySelected() {
  const target = $("cookieCopyTarget")?.value;
  if (!target || !selectedKeys.size) return;
  const records = cookies.filter((cookie) => selectedKeys.has(cookieIdentity(cookie)));
  const result = await getService().importRecords(target, records, "merge");
  const targetName = managedPersonas().find(({profile}) => profile.containerId === target)?.profile.name || "target persona";
  toast(result.failed ? `Copied ${result.imported}; ${result.failed} failed` : `Copied ${result.imported} cookies to ${targetName}`, result.failed > 0);
}

async function deleteSelected() {
  const records = cookies.filter((cookie) => selectedKeys.has(cookieIdentity(cookie)));
  if (!records.length || !await confirmAction(`Delete ${records.length} selected cookie${records.length === 1 ? "" : "s"} from this persona?`)) return;
  const results = await Promise.allSettled(records.map((cookie) => getService().remove(selectedProfileId, cookie)));
  const failures = results.filter((result) => result.status === "rejected").length;
  selectedKeys.clear();
  await refreshCookies();
  toast(failures ? `Deleted ${records.length - failures}; ${failures} failed` : `Deleted ${records.length} cookies`, failures > 0);
}

function activateTab(profileId = selectedProfileId) {
  const button = $("cookiesTabButton");
  const section = $("tab-cookies");
  if (!button || !section) return;
  document.querySelectorAll(".tabs button[data-tab]").forEach((item) => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", active ? "true" : "false");
    item.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".tab").forEach((item) => {
    const active = item === section;
    item.classList.toggle("active", active);
    item.setAttribute("aria-hidden", active ? "false" : "true");
  });
  button.focus({preventScroll:true});
  void selectPersona(profileId || managedPersonas()[0]?.profile.containerId || "").catch((error) => toast(error.message || String(error), true));
}

function injectUi() {
  if ($("cookiesTabButton")) return;
  const profilesTab = document.querySelector('.tabs button[data-tab="profiles"]');
  const tabs = profilesTab?.parentElement;
  const profilesSection = $("tab-profiles");
  if (!tabs || !profilesSection?.parentElement) return;
  const button = document.createElement("button");
  button.id = "cookiesTabButton";
  button.dataset.tab = "cookies";
  button.dataset.navGroup = "Operate";
  button.setAttribute("role","tab");
  button.setAttribute("aria-controls","tab-cookies");
  button.setAttribute("aria-selected","false");
  button.tabIndex = -1;
  button.textContent = "Cookies";
  const routesTab = document.querySelector('.tabs button[data-tab="routes"]');
  (routesTab || profilesTab).insertAdjacentElement("afterend", button);

  const section = document.createElement("section");
  section.id = "tab-cookies";
  section.className = "tab";
  section.setAttribute("role","tabpanel");
  section.setAttribute("aria-labelledby","cookiesTabButton");
  section.setAttribute("aria-hidden","true");
  section.innerHTML = `<div class="section-heading"><div><span class="eyebrow">Persona data</span><h2>Cookies</h2><p>Inspect, create, edit, delete, import, export, and explicitly copy cookies between managed Firefox containers.</p></div></div><div class="notice warning-text cookie-sensitive-notice"><strong>Sensitive data.</strong> Cookie values may contain authenticated sessions. Direct cookie exports are plaintext; use an encrypted PersonaMonkey backup when you need protected storage.</div><div class="cookies-layout"><aside class="panel cookie-personas-panel"><div class="panel-heading"><h3>Personas</h3><p class="hint">Choose one isolated cookie store.</p></div><input id="cookiePersonaFilter" type="search" placeholder="Filter personas…" aria-label="Filter cookie personas"><div id="cookiePersonaList" class="cookie-persona-list"></div></aside><div id="cookieWorkspace" class="panel cookie-workspace"><div class="empty-state"><strong>Loading personas…</strong></div></div></div>`;
  profilesSection.insertAdjacentElement("afterend", section);

  button.addEventListener("click", () => activateTab());
  section.addEventListener("click", async (event) => {
    try {
      const persona = event.target.closest(".cookie-persona-button");
      if (persona) return void selectPersona(persona.dataset.profileId);
      if (event.target.closest("#cookieRefresh")) return void selectPersona(selectedProfileId);
      if (event.target.closest("#cookieNew") || event.target.closest("#cookieEmptyCreate")) return renderEditor(null);
      if (event.target.closest("#cookieClearFilter")) {
        filterText = "";
        if ($("cookieFilter")) $("cookieFilter").value = "";
        renderCookieTable();
        updateSelectionActions();
        return;
      }
      if (event.target.closest("#cookieExport")) return void exportCookies();
      if (event.target.closest("#cookieClearDomainButton")) {
        const domain = $("cookieClearDomain")?.value.trim();
        if (!domain) throw new Error("Enter a domain first");
        if (!await confirmAction(`Clear ${domain} and all subdomain cookies from this persona only?`)) return;
        const result = await getService().clear(selectedProfileId, {domain});
        selectedKeys.clear(); await refreshCookies(); toast(`Removed ${result.removed} matching cookies`); return;
      }
      if (event.target.closest("#cookieClearAll")) {
        if (!await confirmAction("Clear every cookie in this persona? Other personas are not affected.")) return;
        const result = await getService().clear(selectedProfileId); selectedKeys.clear(); await refreshCookies(); toast(`Removed ${result.removed} cookies`); return;
      }
      if (event.target.closest("#cookieCopySelected")) return void copySelected();
      if (event.target.closest("#cookieDeleteSelected")) return void deleteSelected();
      if (event.target.closest("#cookieImportApply")) return void applyImport();
      if (event.target.closest("#cookieImportCancel")) { pendingImport = null; renderImportPreview(); return; }
      if (event.target.closest("#cookieEditorSave")) { await saveEditor(); return; }
      if (event.target.closest("#cookieEditorCancel") || event.target.closest("#cookieEditorClose")) { closeEditor(); return; }
      const row = event.target.closest("tr[data-cookie-index]");
      if (row && event.target.closest(".cookie-edit")) return renderEditor(cookies[Number(row.dataset.cookieIndex)]);
      if (row && event.target.closest(".cookie-delete")) {
        const cookie = cookies[Number(row.dataset.cookieIndex)];
        if (!cookie || !await confirmAction(`Delete cookie ${cookie.name} from this persona?`)) return;
        await getService().remove(selectedProfileId, cookie); selectedKeys.delete(cookieIdentity(cookie)); await refreshCookies(); toast("Cookie deleted");
      }
    } catch (error) { toast(error.message || String(error), true); }
  });
  section.addEventListener("input", (event) => {
    if (event.target.id === "cookieFilter") { filterText = event.target.value; renderCookieTable(); updateSelectionActions(); }
    if (event.target.id === "cookiePersonaFilter") { personaFilterText = event.target.value; renderPersonaList(); }
  });
  section.addEventListener("change", (event) => {
    if (event.target.id === "cookieSelectVisible") {
      for (const cookie of visibleCookies()) {
        const key = cookieIdentity(cookie);
        if (event.target.checked) selectedKeys.add(key); else selectedKeys.delete(key);
      }
      renderCookieTable(); updateSelectionActions(); return;
    }
    if (event.target.classList.contains("cookie-select")) {
      const row = event.target.closest("tr[data-cookie-index]");
      const cookie = cookies[Number(row?.dataset.cookieIndex)];
      if (!cookie) return;
      const key = cookieIdentity(cookie);
      if (event.target.checked) selectedKeys.add(key); else selectedKeys.delete(key);
      renderCookieTable(); updateSelectionActions(); return;
    }
    if (event.target.id === "cookieCopyTarget") { updateSelectionActions(); return; }
    if (event.target.id === "cookieImportFile") {
      const file = event.target.files?.[0];
      void inspectImport(file).catch((error) => toast(error.message || String(error), true));
    }
  });

  void getSnapshot().then(() => {
    selectedProfileId = managedPersonas()[0]?.profile.containerId || "";
    renderPersonaList();
    renderWorkspace();
  }).catch((error) => toast(error.message || String(error), true));
}

document.addEventListener("personamonkey-open-cookies", (event) => activateTab(event.detail?.profileId || ""));
window.addEventListener("persona-state-changed", () => {
  void getSnapshot().then(async () => {
    const available = managedPersonas();
    if (!available.some(({profile}) => profile.containerId === selectedProfileId)) {
      selectedProfileId = available[0]?.profile.containerId || "";
      cookieRefreshGeneration++;
      selectedKeys.clear();
      cookies = [];
      editingCookie = null;
    }
    renderPersonaList();
    if (selectedProfileId) await refreshCookies();
    else renderWorkspace();
  }).catch((error) => toast(error.message || String(error), true));
});
injectUi();
