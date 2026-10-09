import { PERSONA_PACKAGE_LIMITS } from "../lib/package-limits.js";
import { createPackageInspector } from "../lib/package-inspector-client.js";
import { toast } from "./toast.js";
import { confirmAction } from "./confirm-dialog.js";
const $ = (id) => document.getElementById(id);
const packageInspector = createPackageInspector();
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[ch]);
const COLORS = {blue:"#37adff",green:"#51cd00",orange:"#ff9f00",pink:"#ff4bda",purple:"#af51f5",red:"#ff613d",cyan:"#00c79a",gray:"#7c8798",violet:"#7f6cff",yellow:"#e0b400"};
let personas = [];
let importBytes = null;
let refreshGeneration = 0;
let modalReturnFocus = null;
let personaFilterText = "";
let personaVisibleLimit = 18;

function notifyPersonaStateChanged() {
  window.dispatchEvent(new CustomEvent("persona-state-changed"));
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

function relativeTime(value) {
  if (!value) return "Never opened";
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta) || delta < 0) return "Recently";
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function expiresIn(value) {
  const delta = Date.parse(value) - Date.now();
  if (!Number.isFinite(delta) || delta <= 0) return "expired";
  if (delta < 3_600_000) return `in ${Math.ceil(delta / 60_000)}m`;
  if (delta < 86_400_000) return `in ${Math.ceil(delta / 3_600_000)}h`;
  return `in ${Math.ceil(delta / 86_400_000)}d`;
}

function color(persona) {
  return /^#[0-9a-f]{6}$/i.test(persona.colorCode || "") ? persona.colorCode : (COLORS[persona.color] || COLORS.gray);
}

function icon(persona) {
  return persona.iconUrl
    ? `<img src="${esc(persona.iconUrl)}" alt="">`
    : `<span aria-hidden="true">${esc(String(persona.icon || "fingerprint").slice(0, 1).toUpperCase())}</span>`;
}

function health(persona) {
  const item = persona.health || {};
  const good = item.status === "healthy";
  const blocked = item.status === "blocked";
  const bad = item.status === "error";
  const direct = item.status === "direct";
  const label = good
    ? "Network: verified"
    : blocked
      ? "Network: blocked — fail-closed"
      : bad
        ? "Network: route unavailable"
        : direct
          ? "Network: direct"
          : "Network: not verified";
  const tone = good ? "good" : bad ? "bad" : "warn";
  const symbol = good ? "✓" : bad ? "!" : "○";
  return `<div class="persona-health ${tone}"><strong>${symbol} ${esc(label)}</strong><span>${esc(item.reason || "No diagnostic result")}</span></div>`;
}

function card(persona) {
  const checked = persona.health?.checkedAt ? `Checked ${relativeTime(persona.health.checkedAt)}` : "Not tested yet";
  const lifecycle = persona.status === "temporary"
    ? `<span class="badge warn">Temporary · expires ${esc(expiresIn(persona.expiresAt))}</span>`
    : persona.status === "archived" ? `<span class="badge">Archived</span>` : "";
  return `<article class="persona-card" data-persona-id="${esc(persona.id)}" style="--persona-color:${color(persona)}">
    <header class="persona-card-head"><span class="persona-card-icon">${icon(persona)}</span><div><h3 title="${esc(persona.name)}">${esc(persona.name)}</h3><p>${esc(persona.health?.routeName || "Block")}</p></div><span class="badge ${persona.protection === "active" ? "good" : "warn"}">${persona.protection === "active" ? "Protection: enforced" : "Protection: relaxed"}</span></header>
    ${persona.description ? `<p class="persona-description">${esc(persona.description)}</p>` : ""}${lifecycle}
    ${health(persona)}
    <div class="persona-metrics"><span><b>${persona.cookies?.count || 0}</b> cookies</span><span><b>${persona.activeTabs || 0}</b> open tabs</span><span><b>${persona.storage ? formatBytes(persona.storage.estimated?.usage) : "—"}</b> site data</span></div>
    <p class="persona-check-time">${esc(checked)} · Last used ${esc(relativeTime(persona.lastUsedAt))}</p>
    <div class="persona-primary-actions"><button data-action="open" class="primary">Open</button><button data-action="cookies">Cookies</button><button data-action="test">Verify route</button></div>
    <details class="persona-more"><summary>Manage persona</summary><div><button data-action="identity">Identity</button><button data-action="storage">Storage</button><button data-action="duplicate">Clone</button><button data-action="export">Export</button><button data-action="backup">Backup with cookies</button><button data-action="archive">Archive</button><button data-action="delete" class="danger">Delete</button></div></details>
  </article>`;
}

function dashboardPersonas() {
  const query = personaFilterText.trim().toLowerCase();
  return [...personas]
    .sort((a,b) => {
      const rank = (persona) => persona.status === "temporary" ? 0 : persona.status === "archived" ? 2 : 1;
      const rankDelta = rank(a) - rank(b);
      if (rankDelta) return rankDelta;
      const lastA = Date.parse(a.lastUsedAt || a.health?.checkedAt || 0) || 0;
      const lastB = Date.parse(b.lastUsedAt || b.health?.checkedAt || 0) || 0;
      return lastB - lastA || String(a.name || "").localeCompare(String(b.name || ""));
    })
    .filter((persona) => !query || `${persona.name || ""} ${persona.id || ""} ${persona.health?.routeName || ""} ${persona.status || ""}`.toLowerCase().includes(query));
}

function render() {
  const grid = $("personaDashboardGrid");
  if (!grid) return;
  const matches = dashboardPersonas();
  const visible = matches.slice(0, personaVisibleLimit);
  if (!personas.length) {
    grid.innerHTML = `<div class="empty-state persona-dashboard-empty"><strong>No managed personas yet</strong><p>Create a temporary persona above or open Advanced routing policy &amp; provisioning to manage numbered Firefox containers.</p></div>`;
  } else if (!matches.length) {
    grid.innerHTML = `<div class="empty-state persona-dashboard-empty"><strong>No personas match this filter</strong><p>Search by persona name, route, lifecycle state, or Firefox container ID.</p><button id="clearPersonaDashboardFilter">Clear filter</button></div>`;
  } else {
    grid.innerHTML = visible.map(card).join("");
  }
  const summary = $("personaDashboardSummary");
  if (summary) summary.textContent = matches.length
    ? `Showing ${visible.length} of ${matches.length} matching persona${matches.length === 1 ? "" : "s"}`
    : personas.length ? `0 of ${personas.length} personas match` : "No personas";
  const more = $("showMorePersonas");
  if (more) {
    const hidden = Math.max(0, matches.length - visible.length);
    more.hidden = hidden === 0;
    more.textContent = hidden ? `Show ${Math.min(18, hidden)} more` : "Show more";
  }
}

function showDashboardError(error) {
  const message = error?.message || String(error || "Unable to load personas");
  const summary = $("personaDashboardSummary");
  const grid = $("personaDashboardGrid");
  if (summary) summary.textContent = "Persona dashboard unavailable";
  if (grid) {
    grid.innerHTML = `<div class="empty-state persona-dashboard-empty"><strong>Unable to load personas</strong><p>${esc(message)}</p><button id="retryPersonaDashboard" type="button">Retry</button></div>`;
    $("retryPersonaDashboard").onclick = () => refresh().catch(reportDashboardRefreshFailure);
  }
  $("showMorePersonas")?.setAttribute("hidden", "");
}

function reportDashboardRefreshFailure(error) {
  showDashboardError(error);
  toast(error?.message || String(error), true);
}

async function refresh({ storage = true } = {}) {
  const generation = ++refreshGeneration;
  const result = await browser.runtime.sendMessage({type:"LIST_PERSONAS", includeStorage:storage});
  if (generation !== refreshGeneration) return false;
  personas = result.personas || [];
  render();
  return true;
}

function download(persona, bytes, suffix = ".personamonkey") {
  const safe = String(persona.name || "persona").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "persona";
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], {type:"application/zip"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safe}${suffix}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showModal(title, body, actions = "") {
  const modal = $("personaModal");
  if (!modal) return;
  modalReturnFocus = document.activeElement;
  modal.innerHTML = `<div class="persona-modal-card" role="dialog" aria-modal="true" aria-labelledby="personaModalTitle"><div class="inline spread"><h2 id="personaModalTitle">${esc(title)}</h2><button data-modal-close aria-label="Close">×</button></div>${body}<div class="persona-modal-actions">${actions}</div></div>`;
  modal.classList.remove("hidden");
  modal.querySelector("input,select,textarea,button")?.focus();
}

function closeModal() {
  const modal = $("personaModal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  modal.innerHTML = "";
  const target = modalReturnFocus;
  modalReturnFocus = null;
  if (target?.isConnected && typeof target.focus === "function") target.focus();
}

function trapModalFocus(event) {
  const modal = $("personaModal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hidden && node.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function cloneModal(persona) {
  showModal(`Clone ${persona.name}`, `<label>New persona name<input id="clonePersonaName" value="${esc(`${persona.name} Copy`)}" maxlength="64"></label><div class="persona-clone-options">
    <h3>Identity</h3><label class="check"><input data-clone="copyName" type="checkbox" checked> Name</label><label class="check"><input data-clone="copyIcon" type="checkbox" checked> Icon</label><label class="check"><input data-clone="copyColor" type="checkbox" checked> Color</label>
    <h3>Configuration</h3><label class="check"><input data-clone="copySettings" type="checkbox" checked> Settings</label><label class="check"><input data-clone="copyRoute" type="checkbox" checked> Route</label>${persona.routeId === "__direct__" ? '<label class="check"><input data-clone="allowDirect" type="checkbox"> Explicitly allow Direct for the copy</label>' : ""}<label class="check"><input data-clone="copyScripts" type="checkbox" checked> Userscripts</label><label class="check"><input data-clone="copyWorkflows" type="checkbox" checked> Workflows</label><p class="hint">Copies start with the kill switch and LAN blocking enabled.</p>
    <h3>Data</h3><label class="check"><input data-clone="copyCookies" type="checkbox"> Cookies</label><label class="check" title="Firefox does not expose safe cross-container site-storage cloning"><input data-clone="copyStorage" type="checkbox" disabled> Site storage (not available)</label><label class="check"><input data-clone="copyTabs" type="checkbox"> Open tabs</label>
  </div><p class="hint">Cookies and session state are excluded by default to prevent accidental identity duplication.</p>`, `<button data-modal-close>Cancel</button><button data-confirm-clone="${esc(persona.id)}" class="primary">Create clone</button>`);
}

function identityModal(persona) {
  const option = (values, selected) => values.map((value) => `<option value="${value}"${value === selected ? " selected" : ""}>${value}</option>`).join("");
  showModal(`Edit ${persona.name} identity`, `<div class="form-grid"><label>Name<input id="personaIdentityName" value="${esc(persona.name)}" maxlength="64"></label><label>Firefox color<select id="personaIdentityColor">${option(Object.keys(COLORS), persona.color)}</select></label><label>Firefox icon<select id="personaIdentityIcon">${option(["fingerprint","briefcase","circle","tree","chill","vacation","cart","gift","pet","food","fruit","dollar","fence"], persona.icon)}</select></label><label>Description<textarea id="personaIdentityDescription" maxlength="2048">${esc(persona.description || "")}</textarea></label></div><p class="hint">The selected identity is written to Firefox's contextual identity and appears in the dashboard, popup, tabs, and cookie workspace.</p>`, `<button data-modal-close>Cancel</button><button data-confirm-identity="${esc(persona.id)}" class="primary">Save identity</button>`);
}

function temporaryModal() {
  showModal("Create temporary persona", `<label>Name<input id="temporaryPersonaName" value="Agent-Test-01" maxlength="64" required></label><label>Expires after<select id="temporaryPersonaHours"><option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option></select></label><p class="hint">Temporary personas start fail-closed and are removed automatically after expiry.</p>`, `<button data-modal-close>Cancel</button><button data-confirm-temporary class="primary">Create temporary persona</button>`);
}

async function storageModal(persona) {
  showModal(`${persona.name} storage`, `<p class="persona-modal-loading">Inspecting storage in open persona tabs…</p>`);
  const {storage} = await browser.runtime.sendMessage({type:"GET_PERSONA_STORAGE", profileId:persona.id});
  const row = (name, value, sub = "") => `<div><span>${esc(name)}</span><strong>${esc(value)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  const domains = storage.cookies.byDomain || [];
  showModal(`${persona.name} storage`, `
    <div class="persona-storage-overview">
      ${row("Cookies", storage.cookies.count, formatBytes(storage.cookies.bytes))}
      ${row("Site data", formatBytes(storage.estimated?.usage), `${storage.inspectedOrigins?.length || 0} inspected origin${storage.inspectedOrigins?.length === 1 ? "" : "s"}`)}
      ${row("Open tabs", storage.activeTabs || 0, "in this persona")}
    </div>
    <p class="notice info">${esc(storage.note)}</p>
    <details class="persona-storage-breakdown">
      <summary>Storage breakdown &amp; cookie domains</summary>
      <div class="persona-storage-grid">
        ${row("LocalStorage", storage.localStorage.items, formatBytes(storage.localStorage.bytes))}
        ${row("Session data", storage.sessionStorage.items, formatBytes(storage.sessionStorage.bytes))}
        ${row("IndexedDB", storage.indexedDB.databases, "databases")}
        ${row("CacheStorage", storage.cacheStorage.caches, "open origins")}
        ${row("Cookie bytes", formatBytes(storage.cookies.bytes), `${storage.cookies.count} cookie${storage.cookies.count === 1 ? "" : "s"}`)}
        ${row("Estimated usage", formatBytes(storage.estimated?.usage), storage.estimated?.quota ? `of ${formatBytes(storage.estimated.quota)} quota` : "")}
      </div>
      ${domains.length ? `<div class="persona-cookie-domains"><h3>Cookie domains</h3><ul>${domains.slice(0, 20).map((item) => `<li><span title="${esc(item.domain)}">${esc(item.domain)}</span><strong>${item.count}</strong></li>`).join("")}</ul>${domains.length > 20 ? `<p class="hint">Showing the first 20 of ${domains.length} domains.</p>` : ""}</div>` : ""}
    </details>
    <details class="persona-storage-reset">
      <summary>Factory reset persona</summary>
      <div class="persona-storage-reset-body"><p class="warning-text"><strong>Destructive reset.</strong> PersonaMonkey creates a new clean Firefox container, re-binds this persona's configuration, userscripts and workflow references, closes its current tabs, then removes the old container and its browser data.</p><button data-clear-storage="full" data-persona="${esc(persona.id)}" class="danger">Factory reset persona</button></div>
    </details>`,
    `<button data-modal-close>Close</button><button data-clear-storage="cookies" data-persona="${esc(persona.id)}">Clear cookies</button><button data-clear-storage="siteData" data-persona="${esc(persona.id)}">Clear site data</button>`);
}

async function exportPersona(persona, withCookies) {
  if (withCookies && !await confirmAction(
    `Export ${persona.name} with cookies? The package may contain signed-in sessions and other sensitive identity data.`,
    {title:"Export sensitive persona backup",confirmLabel:"Export with cookies",danger:true}
  )) return;
  const result = await browser.runtime.sendMessage({type:"EXPORT_PERSONA_PACKAGE", profileId:persona.id, include:{cookies:withCookies, userscripts:true, workflows:true}});
  download(persona, result.bytes);
  toast(`${withCookies ? "Backed up" : "Exported"} ${persona.name}`);
}

async function inspectImport(file) {
  if (file.size > PERSONA_PACKAGE_LIMITS.maxCompressedBytes) throw new Error("Persona package is too large");
  importBytes = new Uint8Array(await file.arrayBuffer());
  const preview = await packageInspector.inspectPersonaPackage(importBytes);
  showModal("Import persona package", `<div class="persona-import-identity"><strong>${esc(preview.identity.name || "Imported Persona")}</strong><span>${esc(preview.identity.icon || "fingerprint")} · ${esc(preview.identity.color || "blue")}</span></div><p><strong>Route:</strong> ${esc(preview.route?.route?.name || preview.route?.mode || "Block")}</p><div class="persona-storage-grid"><div><span>Cookies</span><strong>${preview.inventory.cookies}</strong></div><div><span>Userscripts</span><strong>${preview.inventory.userscripts}</strong></div><div><span>Workflows</span><strong>${preview.inventory.workflows}</strong></div><div><span>Package</span><strong>${formatBytes(preview.inventory.bytes)}</strong></div></div><label>Imported name<input id="importPersonaName" value="${esc(preview.identity.name || "Imported Persona")}" maxlength="64"></label>${preview.inventory.cookies ? `<label class="check"><input id="importPersonaCookies" type="checkbox"> Import cookies (may restore signed-in sessions)</label>` : ""}<label class="check"><input id="importAllowDirect" type="checkbox"> Allow a package that requests Direct routing</label><div class="notice info"><div>Imported Personas start with the kill switch and LAN blocking enabled.</div>${(preview.warnings || []).map((warning) => `<div>⚠ ${esc(warning)}</div>`).join("")}</div>`, `<button data-modal-close>Cancel</button><button data-confirm-import class="primary">Import persona</button>`);
}

async function perform(action, persona) {
  if (action === "open") {
    await browser.runtime.sendMessage({type:"OPEN_PERSONA", profileId:persona.id});
    await refresh();
    notifyPersonaStateChanged();
  }
  if (action === "cookies") document.dispatchEvent(new CustomEvent("personamonkey-open-cookies", {detail:{profileId:persona.id}}));
  if (action === "test") {
    toast(`Testing ${persona.name}…`);
    const result = await browser.runtime.sendMessage({type:"TEST_PROFILE", profileId:persona.id});
    toast(result.ok ? `${persona.name} route verified` : (result.error || "Route unavailable"), !result.ok);
    await refresh();
    notifyPersonaStateChanged();
  }
  if (action === "export") await exportPersona(persona, false);
  if (action === "backup") await exportPersona(persona, true);
  if (action === "duplicate") cloneModal(persona);
  if (action === "identity") identityModal(persona);
  if (action === "storage") await storageModal(persona);
  if (action === "archive") {
    if (!await confirmAction(`Archive ${persona.name}? Open tabs will close and routing will be set to Block. The Firefox container is kept.`, {title:"Archive persona",confirmLabel:"Archive persona",danger:true})) return;
    await browser.runtime.sendMessage({type:"ARCHIVE_PERSONA", profileId:persona.id});
    await refresh(); notifyPersonaStateChanged(); toast(`Archived ${persona.name}`);
  }
  if (action === "delete") {
    if (!await confirmAction(`Delete ${persona.name}? This permanently removes its Firefox container and persona-scoped browser data. This cannot be undone.`, {title:"Delete persona",confirmLabel:"Delete persona",danger:true})) return;
    await browser.runtime.sendMessage({type:"DELETE_PERSONA", profileId:persona.id});
    await refresh();
    notifyPersonaStateChanged();
    toast(`Deleted ${persona.name}`);
  }
}

function init() {
  const section = $("tab-profiles");
  const table = $("profilesTable");
  if (!section || !table || $("personaDashboard")) return;
  const dashboard = document.createElement("section");
  dashboard.id = "personaDashboard";
  dashboard.innerHTML = `<div class="persona-dashboard-head"><div><span class="eyebrow">Persona OS</span><h2>Persona dashboard</h2><p>Open, verify and manage isolated identities without exposing advanced routing controls by default.</p></div><div class="inline"><button id="createTemporaryPersona">Create temporary persona</button><label class="file-button">Import persona<input id="personaPackageFile" type="file" accept=".personamonkey,.zip,application/zip"></label><button id="refreshPersonaDashboard">Refresh</button></div></div><div class="persona-dashboard-toolbar"><input id="personaDashboardFilter" type="search" placeholder="Filter personas…" aria-label="Filter persona dashboard"><span id="personaDashboardSummary" class="muted" role="status" aria-live="polite">Loading personas…</span></div><div id="personaDashboardGrid" class="persona-dashboard-grid"><p class="empty-state">Loading personas…</p></div><div class="persona-dashboard-more"><button id="showMorePersonas" type="button" hidden>Show more</button></div>`;
  section.querySelector(".section-heading")?.after(dashboard);

  const modal = document.createElement("div");
  modal.id = "personaModal";
  modal.className = "persona-modal hidden";
  document.body.append(modal);

  $("refreshPersonaDashboard").onclick = () => refresh().catch(reportDashboardRefreshFailure);
  $("createTemporaryPersona").onclick = temporaryModal;
  $("personaDashboardFilter").oninput = (event) => {
    personaFilterText = event.target.value;
    personaVisibleLimit = 18;
    render();
  };
  $("showMorePersonas").onclick = () => { personaVisibleLimit += 18; render(); };
  $("personaPackageFile").onchange = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void inspectImport(file).catch((error) => toast(error.message || String(error), true));
  };
  dashboard.addEventListener("click", (event) => {
    if (event.target.closest("#clearPersonaDashboardFilter")) {
      personaFilterText = "";
      personaVisibleLimit = 18;
      $("personaDashboardFilter").value = "";
      render();
      $("personaDashboardFilter").focus();
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    const id = event.target.closest("[data-persona-id]")?.dataset.personaId;
    const persona = personas.find((item) => item.id === id);
    if (action && persona) void perform(action, persona).catch((error) => toast(error.message || String(error), true));
  });
  modal.addEventListener("keydown", trapModalFocus);
  modal.addEventListener("click", async (event) => {
    if (event.target === modal || event.target.closest("[data-modal-close]")) { closeModal(); return; }
    const cloneId = event.target.closest("[data-confirm-clone]")?.dataset.confirmClone;
    if (cloneId) {
      const options = {name:$("clonePersonaName").value.trim()};
      for (const input of modal.querySelectorAll("[data-clone]")) options[input.dataset.clone] = input.checked;
      await browser.runtime.sendMessage({type:"DUPLICATE_PERSONA", profileId:cloneId, options});
      closeModal(); await refresh(); notifyPersonaStateChanged(); toast("Persona duplicated"); return;
    }
    const identityId = event.target.closest("[data-confirm-identity]")?.dataset.confirmIdentity;
    if (identityId) {
      await browser.runtime.sendMessage({type:"UPDATE_PERSONA_IDENTITY", profileId:identityId, changes:{name:$("personaIdentityName").value.trim(), color:$("personaIdentityColor").value, icon:$("personaIdentityIcon").value, description:$("personaIdentityDescription").value.trim()}});
      closeModal(); await refresh(); notifyPersonaStateChanged(); toast("Persona identity updated"); return;
    }
    if (event.target.closest("[data-confirm-import]")) {
      await browser.runtime.sendMessage({type:"IMPORT_PERSONA_PACKAGE", bytes:importBytes.buffer, options:{name:$("importPersonaName").value.trim(), allowDirect:$("importAllowDirect").checked, importCookies:$("importPersonaCookies")?.checked === true}});
      importBytes = null; closeModal(); await refresh(); notifyPersonaStateChanged(); toast("Persona imported"); return;
    }
    if (event.target.closest("[data-confirm-temporary]")) {
      const nameInput = $("temporaryPersonaName");
      const name = nameInput?.value.trim() || "";
      if (!name) {
        nameInput?.setCustomValidity("Persona name is required");
        nameInput?.reportValidity();
        toast("Persona name is required", true);
        return;
      }
      nameInput?.setCustomValidity("");
      await browser.runtime.sendMessage({type:"CREATE_PERSONA", input:{name, temporary:true, ttlHours:Number($("temporaryPersonaHours").value)}});
      closeModal(); await refresh(); notifyPersonaStateChanged(); toast("Temporary persona created"); return;
    }
    const clear = event.target.closest("[data-clear-storage]");
    if (clear) {
      const persona = personas.find((item) => item.id === clear.dataset.persona);
      const name = persona?.name || "this persona";
      const scope = clear.dataset.clearStorage;
      const confirmation = scope === "cookies"
        ? {title:"Clear persona cookies", label:"Clear cookies", message:`Clear all cookies from ${name}? Signed-in sessions may be lost. Site storage, persona configuration, routes, userscripts and workflows are kept.`}
        : scope === "siteData"
          ? {title:"Clear persona site data", label:"Clear site data", message:`Clear site data from ${name}? LocalStorage, session storage, IndexedDB and cache data exposed by the storage service will be removed where Firefox permits. Cookies and persona configuration are kept.`}
          : {title:"Factory reset persona", label:"Factory reset", message:`Factory reset ${name}? PersonaMonkey will create a new clean Firefox container, re-bind this persona's configuration, userscripts and workflow references, close current persona tabs, then remove the old container and its browser data. This cannot be undone.`};
      if (!await confirmAction(confirmation.message, {title:confirmation.title, confirmLabel:confirmation.label, danger:true})) return;
      if (scope === "full") await browser.runtime.sendMessage({type:"FULL_WIPE_PERSONA", profileId:clear.dataset.persona});
      else await browser.runtime.sendMessage({type:"CLEAR_PERSONA_STORAGE", profileId:clear.dataset.persona, scope});
      closeModal(); await refresh(); notifyPersonaStateChanged();
      toast(scope === "full" ? `Factory reset ${name}` : `Cleared ${scope === "cookies" ? "cookies" : "site data"} from ${name}`);
    }
  });
  refresh().catch(reportDashboardRefreshFailure);
}

window.addEventListener("persona-state-changed", () => {
  void refresh().catch(reportDashboardRefreshFailure);
});

init();
