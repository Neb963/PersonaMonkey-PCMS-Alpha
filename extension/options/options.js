import { toast } from "./toast.js";
import { confirmAction } from "./confirm-dialog.js";
import { authorizeSecurityPreview } from "./security-review.js";
import { captureFocusReturnId, restoreFocusById } from "./focus-return.js";
import { confirmWorkflowControlOverride } from "./workflow-control.js";
import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID, MAX_WORKFLOW_STEP_TIMEOUT_MS } from "../lib/constants.js";
import { normalizeProfile, normalizeRoute, normalizeScript, normalizeWorkflow } from "../lib/storage.js";
import { parseUserscriptMetadata, makeScriptId, analyzeGrants, shouldUseMainWorld } from "../lib/userscripts.js";

let snapshot = null;
let mullvadRelays = [];
let mullvadEntries = [];
let mullvadRelayLoadPromise = null;
let mullvadRelayAutoAttempted = false;
let selectedProfileId = null;
let selectedRouteId = null;
let selectedScriptId = null;
let selectedWorkflowId = null;
let scriptFilterText = "";
let jobs = [];
let jobsTimer = null;
let pendingImportPayload = null;
let personaRefreshQueued = false;
let profilesDirty = false;
let securityDirty = false;

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[ch]);

async function msg(type, extra = {}) {
  return browser.runtime.sendMessage({ type, ...extra });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchSnapshotWithRetry() {
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

async function load() {
  snapshot = await fetchSnapshotWithRetry();
  try {
    const e = await msg("MULLVAD_LIST_ENTRIES");
    mullvadEntries = e.entries || [];
    if (snapshot.mullvadNative) snapshot.mullvadNative.selected_entry = e.selected_entry || snapshot.mullvadNative.selected_entry;
  } catch { mullvadEntries = []; }
  renderAll();
  setProfilesDirty(false);
  if (!mullvadRelays.length && !mullvadRelayAutoAttempted) {
    mullvadRelayAutoAttempted = true;
    void loadMullvadRelays().catch((error) => {
      const select = $("mullvadRelay");
      if (select && !mullvadRelays.length) {
        select.innerHTML = '<option value="">Relay load failed — click Load relays to retry</option>';
      }
      console.warn("Unable to load Mullvad relays automatically", error);
    });
  }
}

function renderAll() {
  renderSecurityBadge();
  renderProfiles();
  renderRoutes();
  renderMullvadNative();
  renderScripts();
  renderWorkflows();
  renderJobs();
  renderSecurityControls();
  renderSecurityState();
  $("profileCount").value = snapshot.state.global.profileTargetCount;
  $("profilePrefix").value = snapshot.state.global.profileNamePrefix;
}

function renderSecurityBadge() {
  const s = snapshot.security;
  const el = $("securityBadge");
  if (!s.ready) {
    el.className = "badge bad";
    el.textContent = "Policy not ready";
  } else if (snapshot.state.global.enforcePrivacyControls && !s.privacySafe) {
    el.className = "badge bad";
    el.textContent = "Protected personas locked";
  } else {
    el.className = "badge good";
    el.textContent = "Fail-closed policy active";
  }
}

function routeOptions(selected) {
  const entries = [
    [BLOCK_ROUTE_ID, "BLOCK — no network"],
    [DIRECT_ROUTE_ID, "DIRECT — no VPN/proxy"],
    ...Object.values(snapshot.state.routes).sort((a,b) => a.name.localeCompare(b.name)).map((r) => [r.id, r.name])
  ];
  return entries.map(([id, name]) => `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(name)}</option>`).join("");
}

function defaultProfile(container) {
  return normalizeProfile({
    name: container.name,
    managed: true,
    owned: false,
    routeId: BLOCK_ROUTE_ID,
    killSwitch: true,
    blockLocalNetwork: true,
    domainMode: "any"
  }, container.cookieStoreId);
}

function setProfilesDirty(dirty) {
  profilesDirty = Boolean(dirty);
  const save = $("saveProfiles");
  const state = $("profileDirtyState");
  if (save) save.disabled = !profilesDirty;
  if (state) {
    state.textContent = profilesDirty ? "Unsaved policy changes" : "All changes saved";
    state.classList.toggle("dirty", profilesDirty);
  }
}

function updateProfileDirectNotice() {
  const notice = $("profileDirectNotice");
  if (!notice || !snapshot) return;
  const direct = Object.values(snapshot.state.profiles || {}).filter((profile) => profile?.managed && profile.routeId === DIRECT_ROUTE_ID);
  notice.classList.toggle("hidden", direct.length === 0);
  notice.textContent = direct.length
    ? direct.length + " managed persona" + (direct.length === 1 ? "" : "s") + " use Direct network. Their traffic follows the normal Firefox network path without a configured VPN/proxy route."
    : "";
}

function renderProfiles() {
  const filter = ($("profileFilter")?.value || "").trim().toLowerCase();
  const containers = snapshot.containers.filter((c) => !c.error).filter((c) => !filter || c.name.toLowerCase().includes(filter) || c.cookieStoreId.toLowerCase().includes(filter));
  const rows = containers.map((container) => {
    const p = snapshot.state.profiles[container.cookieStoreId];
    const managed = Boolean(p?.managed);
    const name = esc(container.name);
    return `<tr data-id="${esc(container.cookieStoreId)}">
      <td class="policy-managed" data-label="Managed"><input class="manage-profile" type="checkbox" aria-label="Manage ${name}" ${managed ? "checked" : ""}></td>
      <td class="policy-persona" data-label="Persona"><strong title="${name}">${name}</strong><div class="route-meta">${esc(container.cookieStoreId)}${p?.owned ? " · extension-created" : ""}</div></td>
      <td class="policy-route" data-label="Route"><select class="profile-route" aria-label="Route for ${name}" ${managed ? "" : "disabled"}>${routeOptions(p?.routeId || BLOCK_ROUTE_ID)}</select></td>
      <td class="policy-protection" data-label="Protection"><div class="policy-switches"><label class="check"><input class="profile-kill" type="checkbox" ${p?.killSwitch !== false ? "checked" : ""} ${managed ? "" : "disabled"}> Kill switch</label><label class="check"><input class="profile-local" type="checkbox" ${p?.blockLocalNetwork !== false ? "checked" : ""} ${managed ? "" : "disabled"}> Block LAN</label></div></td>
      <td class="policy-scripts" data-label="Scripts"><span class="policy-script-count">${managed ? esc((p?.scriptIds || []).length) : "—"}</span></td>
      <td class="policy-actions" data-label="Actions"><button class="small edit-profile" ${managed ? "" : "disabled"}>Edit</button> <button class="small test-profile" ${managed ? "" : "disabled"}>Test</button></td>
    </tr>`;
  }).join("");

  $("profilesTable").innerHTML = `<table class="profiles-policy-table">
    <thead><tr><th>Managed</th><th>Persona</th><th>Route</th><th>Protection</th><th>Scripts</th><th>Actions</th></tr></thead>
    <tbody>${rows || `<tr class="policy-empty"><td colspan="6">No containers found.</td></tr>`}</tbody>
  </table>`;
  updateProfileDirectNotice();

  if (selectedProfileId) renderProfileEditor(selectedProfileId);
}

function renderProfileEditor(id) {
  const p = snapshot.state.profiles[id];
  const container = snapshot.containers.find((c) => c.cookieStoreId === id);
  const el = $("profileEditor");
  if (!p || !p.managed || !container) {
    el.classList.add("hidden");
    selectedProfileId = null;
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = `<h2>${esc(container.name)} persona policy</h2>
    <div class="profile-editor-grid">
      <label>Domain mode<select id="editDomainMode"><option value="any"${p.domainMode === "any" ? " selected" : ""}>Allow all except blocklist</option><option value="allowlist"${p.domainMode === "allowlist" ? " selected" : ""}>Allowlist only</option></select></label>
      <label>Notes<input id="editProfileNotes" value="${esc(p.notes || "")}"></label>
      <label class="wide">Allowed domains (one per line; supports <code>*.example.com</code>)<textarea id="editAllowed">${esc((p.allowedDomains || []).join("\n"))}</textarea></label>
      <label class="wide">Blocked domains (one per line)<textarea id="editBlocked">${esc((p.blockedDomains || []).join("\n"))}</textarea></label>
    </div>
    <div class="inline"><button id="saveProfileEditor" class="primary">Save persona policy</button><button id="closeProfileEditor">Close</button></div>`;
  $("saveProfileEditor").onclick = async () => {
    p.domainMode = $("editDomainMode").value;
    p.notes = $("editProfileNotes").value;
    p.allowedDomains = lines($("editAllowed").value);
    p.blockedDomains = lines($("editBlocked").value);
    await saveLocalState("Persona policy saved");
  };
  $("closeProfileEditor").onclick = () => { selectedProfileId = null; el.classList.add("hidden"); };
}

function lines(text) {
  return [...new Set(String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

async function saveLocalState(successMessage = "Saved") {
  const returnFocusId = captureFocusReturnId(document.activeElement);
  const restoreFocus = () => restoreFocusById(document, returnFocusId);
  try {
    const preview = await msg("PREVIEW_STATE_CHANGE", { state: snapshot.state });
    const authorizationId = await authorizeSecurityPreview(preview, "settings");
    if (!authorizationId) {
      setSecurityDirty(false);
      await load();
      restoreFocus();
      return null;
    }
    const result = await msg("SAVE_STATE", { state: snapshot.state, authorizationId });
    snapshot.state = result.state;
    snapshot.containers = result.containers;
    snapshot.security = result.security;
    renderAll();
    setProfilesDirty(false);
    if (successMessage) toast(successMessage);
    window.dispatchEvent(new CustomEvent("persona-state-changed"));
    return true;
  } catch (error) {
    const conflict = error?.code === "STATE_CONFLICT" || /state revision conflict/i.test(String(error?.message || error));
    setSecurityDirty(false);
    try { await load(); } catch {}
    restoreFocus();
    toast(conflict
      ? "State changed in another surface. Latest state reloaded; retry your edit."
      : `Save failed: ${error?.message || error}`, true);
    return false;
  }
}

function attachProfileEvents() {
  $("profilesTable").addEventListener("change", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (!row) return;
    const id = row.dataset.id;
    const container = snapshot.containers.find((c) => c.cookieStoreId === id);
    if (event.target.classList.contains("manage-profile")) {
      if (event.target.checked) {
        snapshot.state.profiles[id] = snapshot.state.profiles[id] || defaultProfile(container);
        snapshot.state.profiles[id].managed = true;
      } else if (snapshot.state.profiles[id]) {
        snapshot.state.profiles[id].managed = false;
        snapshot.state.profiles[id].routeId = BLOCK_ROUTE_ID;
      }
      setProfilesDirty(true);
      renderProfiles();
    } else {
      const p = snapshot.state.profiles[id];
      if (!p) return;
      if (event.target.classList.contains("profile-route")) {
        const nextRouteId = event.target.value;
        const previousRouteId = p.routeId || BLOCK_ROUTE_ID;
        if (nextRouteId === DIRECT_ROUTE_ID && previousRouteId !== DIRECT_ROUTE_ID) {
          event.target.value = previousRouteId;
          const routeSelect = event.target;
          // Capture this control as the dialog opener before disabling it, so
          // confirmation cleanup can return focus after finally re-enables it.
          void confirmAction(
            "Direct network bypasses PersonaMonkey's protected routing. Continue only if this persona should intentionally use the normal Firefox network path without a VPN or proxy route.",
            { title: "Use Direct network?", confirmLabel: "Use Direct network", danger: true, opener: routeSelect }
          ).then((confirmed) => {
            const current = snapshot.state.profiles[id];
            if (!confirmed || !current || current.routeId !== previousRouteId) return;
            current.routeId = DIRECT_ROUTE_ID;
            event.target.value = DIRECT_ROUTE_ID;
            updateProfileDirectNotice();
            setProfilesDirty(true);
          }).catch((error) => toast(error.message || String(error), true)).finally(() => {
            if (routeSelect.isConnected) routeSelect.disabled = false;
          });
          routeSelect.disabled = true;
          return;
        }
        p.routeId = nextRouteId;
        updateProfileDirectNotice();
      }
      if (event.target.classList.contains("profile-kill")) p.killSwitch = event.target.checked;
      if (event.target.classList.contains("profile-local")) p.blockLocalNetwork = event.target.checked;
      if (event.target.matches(".profile-route,.profile-kill,.profile-local")) setProfilesDirty(true);
    }
  });

  $("profilesTable").addEventListener("click", async (event) => {
    const row = event.target.closest("tr[data-id]");
    if (!row) return;
    const id = row.dataset.id;
    if (event.target.classList.contains("edit-profile")) {
      selectedProfileId = id;
      renderProfileEditor(id);
      $("profileEditor").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (event.target.classList.contains("test-profile")) {
      try {
        if (!await saveLocalState(null)) return;
        toast("Testing route…");
        const result = await msg("TEST_PROFILE", { profileId: id });
        if (!result.ok) throw new Error(result.error || "Route test failed");
        const d = result.data || {};
        const summary = d.ip ? `${d.ip}${d.city ? ` · ${d.city}` : ""}${d.country ? ` · ${d.country}` : ""}` : JSON.stringify(d).slice(0, 180);
        toast(`Route OK: ${summary}`);
      } catch (error) { toast(String(error.message || error), true); }
    }
  });
}

function renderRoutes() {
  const rows = Object.values(snapshot.state.routes).sort((a,b) => a.name.localeCompare(b.name)).map((r) => `<tr data-id="${esc(r.id)}">
    <td data-label="Route"><strong title="${esc(r.name)}">${esc(r.name)}</strong><div class="route-meta">${esc(r.provider)}</div></td>
    <td data-label="Type">${esc(r.type.toUpperCase())}</td>
    <td data-label="Endpoint"><code>${esc(r.host)}:${esc(r.port)}</code></td>
    <td data-label="DNS">${r.type === "socks" ? (r.proxyDNS ? "Proxy DNS" : "Local DNS") : "Proxy target DNS"}</td>
    <td data-label="Location">${r.country || r.city ? `${esc(r.country)} ${esc(r.city)}` : "—"}</td>
    <td data-label="Actions"><div class="row-actions route-row-actions"><button class="small edit-route">Edit</button><details class="route-row-more"><summary>More</summary><button class="small danger delete-route">Delete route</button></details></div></td>
  </tr>`).join("");
  $("routesTable").innerHTML = `<table class="routes-table"><thead><tr><th>Name</th><th>Type</th><th>Endpoint</th><th>DNS</th><th>Location</th><th>Actions</th></tr></thead><tbody>${rows || `<tr class="route-empty"><td colspan="6">No routes configured.</td></tr>`}</tbody></table>`;
  if (selectedRouteId) renderRouteEditor(selectedRouteId);
}

function renderRouteEditor(id) {
  const route = snapshot.state.routes[id];
  const host = $("routeEditor");
  if (!host || !route) {
    selectedRouteId = null;
    host?.classList.add("hidden");
    return;
  }
  host.classList.remove("hidden");
  host.innerHTML = `<div class="inline spread panel-heading"><div><span class="eyebrow">Edit route</span><h2>${esc(route.name)}</h2><p class="hint">${esc(route.type.toUpperCase())} · ${esc(route.provider)}. Route type is immutable; create a new route to change transport.</p></div><button id="closeRouteEditor">Close</button></div>
    <div class="form-grid">
      <label>Name<input id="editRouteName" value="${esc(route.name)}" maxlength="128"></label>
      <label>Host<input id="editRouteHost" value="${esc(route.host)}" required aria-describedby="routeEditError"></label>
      <label>Port<input id="editRoutePort" type="number" min="1" max="65535" value="${esc(route.port)}" required aria-describedby="routeEditError"></label>
      <div class="notice info"><strong>Current DNS mode:</strong> ${esc(route.type === "socks" ? (route.proxyDNS ? "Proxy DNS" : "Local DNS") : "Proxy target DNS")}</div>
    </div>
    <p id="routeEditError" class="warning-text" role="alert" hidden></p>
    <div class="action-row"><button id="saveRouteEditor" class="primary">Save route</button><button id="cancelRouteEditor">Cancel</button></div>`;

  const setError = (message = "", control = null) => {
    for (const field of [$("editRouteHost"), $("editRoutePort")]) {
      field?.classList.remove("field-invalid");
      field?.removeAttribute("aria-invalid");
    }
    const error = $("routeEditError");
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
  $("editRouteHost")?.addEventListener("input", () => setError());
  $("editRoutePort")?.addEventListener("input", () => setError());
  const close = () => {
    selectedRouteId = null;
    host.classList.add("hidden");
    host.innerHTML = "";
  };
  $("closeRouteEditor").onclick = close;
  $("cancelRouteEditor").onclick = close;
  $("saveRouteEditor").onclick = async () => {
    const name = $("editRouteName").value.trim() || route.id;
    const nextHost = $("editRouteHost").value.trim();
    const port = Number($("editRoutePort").value);
    if (!nextHost) return setError("Route host is required", $("editRouteHost"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setError("Route port must be an integer from 1 to 65535", $("editRoutePort"));
    route.name = name;
    route.host = nextHost;
    route.port = port;
    if (await saveLocalState("Route updated")) close();
  };
}

function renderMullvadNative() {
  const n = snapshot.mullvadNative || { installed:false, ready:false, error:"Not checked" };
  const cfg = snapshot.state.global.mullvadNative || {};
  const badge = $("mullvadNativeBadge");
  if (!n.installed) { badge.className = "badge bad"; badge.textContent = "Local bridge not installed"; }
  else if (n.compatible === false) { badge.className = "badge warn"; badge.textContent = "Bridge update required"; }
  else if (n.ready) { badge.className = "badge good"; badge.textContent = "Connected / ready"; }
  else if (n.interface_up) { badge.className = "badge warn"; badge.textContent = "Tunnel up, proxy unavailable"; }
  else { badge.className = "badge neutral"; badge.textContent = "Disconnected"; }

  $("mullvadNativeDetails").innerHTML = [
    ["Native host", n.installed ? "Installed" : "Unavailable"],
    ["WireGuard interface", n.interface_up ? `${n.interface || "prm-mv"} up` : "Down"],
    ["Native bridge version", n.version || "Unknown"],
    ["Mullvad base SOCKS", n.base_proxy_reachable ? "Reachable" : "Not reachable"],
    ["Entry", n.selected_entry || "—"],
    ["Active exit forwarders", String((n.active_exits || []).length)],
    ["Handshake", n.latest_handshake_age_seconds == null ? "—" : `${n.latest_handshake_age_seconds}s ago`],
    ["Mullvad desktop app", n.mullvad_app_connected ? "Connected — disconnect it" : "Not connected / not detected"]
  ].map(([k,v]) => `<div class="status-card"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("");

  $("mullvadEntry").innerHTML = mullvadEntries.length
    ? mullvadEntries.map((e) => `<option value="${esc(e.id)}"${e.id === n.selected_entry ? " selected" : ""}>${esc(e.id)}</option>`).join("")
    : `<option value="">No imported entries found</option>`;
  $("mullvadAutoStart").checked = cfg.autoStart !== false;
  $("mullvadAutoStop").value = Number(cfg.autoStopMinutes ?? 15);
  $("mullvadNativeHelp").textContent = n.installed && n.compatible === false
    ? `Local bridge: ${n.error}. Update it with ./install.sh, then refresh status.`
    : n.error
      ? `Local bridge: ${n.error}. If a bridge was installed before, repair it with ./install.sh. For a first install, supply your Mullvad WireGuard config explicitly.`
      : "The entry is the first Mullvad hop. Every container can simultaneously use a different SOCKS exit configured below.";
}

function populateMullvadList() {
  const q = ($("mullvadSearch").value || "").toLowerCase();
  const filtered = mullvadRelays.filter((r) => !q || `${r.country} ${r.city} ${r.hostname} ${r.ipv4_address}`.toLowerCase().includes(q));
  $("mullvadRelay").innerHTML = filtered.length
    ? filtered.slice(0, 1500).map((r) => `<option value="${esc(r.hostname)}|${esc(r.ipv4_address)}|${esc(r.port)}">${esc(r.country)} / ${esc(r.city)} — ${esc(r.hostname)} — ${esc(r.ipv4_address)}</option>`).join("")
    : `<option value="">${mullvadRelays.length ? "No relays match this filter" : "No online Mullvad relays available"}</option>`;
}

async function loadMullvadRelays({ announce = false, force = false } = {}) {
  if (mullvadRelayLoadPromise && !force) return mullvadRelayLoadPromise;
  if (mullvadRelays.length && !force) {
    populateMullvadList();
    return mullvadRelays;
  }

  const select = $("mullvadRelay");
  if (select) select.innerHTML = '<option value="">Loading Mullvad relays…</option>';

  const pending = (async () => {
    if (announce) toast("Loading Mullvad relays…");
    const result = await msg("FETCH_MULLVAD_RELAYS");
    mullvadRelays = Array.isArray(result?.relays) ? result.relays : [];
    populateMullvadList();
    if (announce) toast(`Loaded ${mullvadRelays.length} online Mullvad SOCKS relays`);
    return mullvadRelays;
  })();

  mullvadRelayLoadPromise = pending;
  try {
    return await pending;
  } finally {
    if (mullvadRelayLoadPromise === pending) mullvadRelayLoadPromise = null;
  }
}

function managedProfileIds() {
  return Object.values(snapshot.state.profiles).filter((p) => p.managed).map((p) => p.containerId);
}

function scriptCompatibilityText(script) {
  const c = analyzeGrants(script.grants || []);
  if (!c.compatible) return `Unsupported grants: ${c.unsupported.join(", ")}`;
  if (script.grants?.includes("none")) return "@grant none · MAIN/page context";
  if (!(script.grants || []).length) return "No @grant · isolated compatibility sandbox";
  return `${c.supported.length} supported grant${c.supported.length === 1 ? "" : "s"}`;
}

function renderScripts() {
  const query = scriptFilterText.trim().toLowerCase();
  const allScripts = Object.values(snapshot.state.scripts).sort((a,b) => a.name.localeCompare(b.name));
  const scripts = query
    ? allScripts.filter((script) => `${script.name} ${script.id} ${script.namespace || ""} ${script.author || ""}`.toLowerCase().includes(query))
    : allScripts;
  const permissionState = $("userScriptsPermissionState");
  if (permissionState) {
    permissionState.textContent = snapshot.userScriptsGranted ? "Permission enabled" : "Permission required";
    permissionState.className = snapshot.userScriptsGranted ? "badge good" : "badge warn";
  }
  $("enableUserScripts").hidden = snapshot.userScriptsGranted;
  $("enableUserScripts").disabled = snapshot.userScriptsGranted;
  const ug = snapshot.state.global.userscripts || {};
  $("autoAssignImported").checked = ug.autoAssignImportedToAllProfiles === true && ug.autoAssignImportedToAllProfilesConfirmed === true;
  $("dependencyFetch").value = ug.dependencyFetch || "direct";
  $("scriptList").innerHTML = scripts.length ? scripts.map((s) => {
    const compat = analyzeGrants(s.grants || []);
    return `<button class="${s.id === selectedScriptId ? "active" : ""}" data-script-id="${esc(s.id)}" aria-pressed="${s.id === selectedScriptId ? "true" : "false"}"><strong title="${esc(s.name)}">${esc(s.name)}</strong><div class="route-meta">${s.externalArtifact ? "External artifact · " : ""}${s.enabled ? "Enabled" : "Disabled"} · ${s.autoRun !== false ? "auto" : "workflow only"} · ${esc(s.runAt)} · ${esc(s.profileIds.length)} personas · <span class="${compat.compatible ? "compat-ok" : "compat-bad"}">${esc(compat.compatible ? "compatible core" : "unsupported grant")}</span></div></button>`;
  }).join("") : `<p class="muted">${allScripts.length ? "No scripts match this filter." : "No userscripts imported."}</p>`;
  if (selectedScriptId && snapshot.state.scripts[selectedScriptId]) renderScriptEditor(selectedScriptId);
  else if (selectedScriptId) selectedScriptId = null;
}

function renderScriptEditor(id) {
  const s = snapshot.state.scripts[id];
  const managedProfiles = Object.values(snapshot.state.profiles).filter((p) => p.managed).sort((a,b) => a.name.localeCompare(b.name));
  const compatibility = analyzeGrants(s.grants || []);
  const metadata = [
    s.namespace && `namespace: ${s.namespace}`,
    s.version && `version: ${s.version}`,
    (s.grants || []).length && `@grant: ${s.grants.join(", ")}`,
    (s.requires || []).length && `@require: ${s.requires.length}`,
    Object.keys(s.resources || {}).length && `@resource: ${Object.keys(s.resources || {}).length}`,
    (s.connects || []).length && `@connect: ${s.connects.join(", ")}`
  ].filter(Boolean).join(" · ") || "No additional metadata";
  $("scriptEditor").innerHTML = `${s.externalArtifact ? `<div class="wide goodbox"><strong>Immutable external artifact</strong><p class="hint">Artifact ${esc(s.externalArtifact.artifactId)} · SHA-256 <code>${esc(s.externalArtifact.sha256)}</code>. Source cannot be edited. Clone as a local script to change the code.</p></div>` : ""}<div class="script-editor-grid">
    <label>Name<input id="seName" value="${esc(s.name)}"></label>
    <label>Run at<select id="seRunAt"><option value="document_start"${s.runAt === "document_start" ? " selected" : ""}>document-start</option><option value="document_end"${s.runAt === "document_end" ? " selected" : ""}>document-end</option><option value="document_idle"${s.runAt === "document_idle" ? " selected" : ""}>document-idle</option></select></label>
    <label>Injection<select id="seInjectInto"><option value="auto"${s.injectInto === "auto" ? " selected" : ""}>auto</option><option value="page"${s.injectInto === "page" ? " selected" : ""}>page / MAIN</option><option value="content"${s.injectInto === "content" ? " selected" : ""}>isolated USER_SCRIPT</option></select></label>
    <label class="check"><input id="seEnabled" type="checkbox" ${s.enabled ? "checked" : ""}> Enabled</label>
    <label class="check"><input id="seAutoRun" type="checkbox" ${s.autoRun !== false ? "checked" : ""} ${s.externalArtifact ? "disabled" : ""}> Auto-run on matching pages</label>
    <label class="check"><input id="seFrames" type="checkbox" ${s.allFrames ? "checked" : ""}> Run in matching subframes</label>
    <details class="wide userscript-editor-section">
      <summary>Match rules</summary>
      <div class="userscript-section-body"><label>@match patterns<textarea id="seMatches">${esc((s.matches || []).join("\n"))}</textarea></label><label>@exclude-match patterns<textarea id="seExcludeMatches">${esc((s.excludeMatches || []).join("\n"))}</textarea></label><label class="check"><input id="seCookieHostScope" type="checkbox" ${s.hostScopeDeclared ? "checked" : ""}> Use declared @match/@include hosts to authorize GM_cookie</label><p class="hint">Cookie access is limited to these hosts and the calling persona's cookie store. @connect does not add cookie hosts.</p></div>
    </details>
    <details class="wide userscript-editor-section persona-assignment-section">
      <summary>Persona assignment — ${s.profileIds.length} selected</summary>
      <div class="userscript-section-body assignment-section"><div class="inline spread"><label>Assigned managed personas</label><div class="inline"><button id="selectAllProfiles" class="small">All</button><button id="selectNoProfiles" class="small">None</button></div></div><input id="seProfileFilter" class="collection-filter" type="search" placeholder="Filter personas…" aria-label="Filter assigned personas"><div class="profile-checks">${managedProfiles.map((p) => `<label data-profile-search="${esc(`${p.name} ${p.containerId}`.toLowerCase())}"><input type="checkbox" class="seProfile" value="${esc(p.containerId)}" ${s.profileIds.includes(p.containerId) ? "checked" : ""}> <span title="${esc(p.name)}">${esc(p.name)}</span></label>`).join("") || `<span class="muted">No managed personas.</span>`}</div></div>
    </details>
    <label class="wide userscript-code-field">Code<textarea id="seCode" class="code" spellcheck="false" ${s.externalArtifact ? "readonly aria-readonly=\"true\"" : ""}>${esc(s.code)}</textarea></label>
    <details class="wide userscript-editor-section compatibility-section">
      <summary>Compatibility &amp; metadata — ${esc(scriptCompatibilityText(s))}</summary>
      <div class="userscript-section-body compatibility ${compatibility.compatible ? "goodbox" : "badbox"}"><strong>${esc(scriptCompatibilityText(s))}</strong><div class="hint">${esc(metadata)}</div>${compatibility.unsupported.length ? `<div>Unsupported: <code>${esc(compatibility.unsupported.join(", "))}</code>. This script will fail explicitly instead of silently running without those APIs.</div>` : ""}<div class="hint">Common GM value/storage, XHR, download, notification, menu, resource, cookie, clipboard, tab and style APIs are implemented. See README for edge-case differences.</div></div>
    </details>
  </div>
  <div class="editor-action-groups"><div class="action-row">${s.externalArtifact ? `<button id="cloneExternalScript">Clone as local script</button>` : ""}<button id="saveScript" class="primary">Save script</button></div><details class="secondary-controls destructive-disclosure"><summary>More actions</summary><div class="action-row"><button id="deleteScript" class="danger">Delete script</button></div></details></div>`;

  $("selectAllProfiles").onclick = () => document.querySelectorAll(".seProfile").forEach((el) => { el.checked = true; });
  $("selectNoProfiles").onclick = () => document.querySelectorAll(".seProfile").forEach((el) => { el.checked = false; });
  $("seProfileFilter").oninput = (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll(".assignment-section [data-profile-search]").forEach((label) => {
      label.hidden = Boolean(query) && !String(label.dataset.profileSearch || "").includes(query);
    });
  };
  $("saveScript").onclick = async () => {
    const code = $("seCode").value;
    if (s.externalArtifact && code !== s.code) throw new Error("External artifact source is immutable; clone it as a local script to edit the code");
    const parsed = parseUserscriptMetadata(code, $("seName").value.trim() || s.name);
    const profiles = [...document.querySelectorAll(".seProfile:checked")].map((el) => el.value);
    const keep = {
      id,
      code,
      ...(s.externalArtifact ? { externalArtifact: s.externalArtifact } : {}),
      enabled: $("seEnabled").checked,
      autoRun: s.externalArtifact ? false : $("seAutoRun").checked,
      profileIds: profiles,
      ...parsed,
      hostScopeDeclared: $("seCookieHostScope").checked,
      name: $("seName").value.trim() || parsed.name || s.name,
      runAt: $("seRunAt").value,
      injectInto: $("seInjectInto").value,
      allFrames: $("seFrames").checked,
      matches: lines($("seMatches").value),
      excludeMatches: lines($("seExcludeMatches").value),
      updatedAt: new Date().toISOString()
    };
    keep.world = shouldUseMainWorld(keep) ? "MAIN" : "USER_SCRIPT";
    snapshot.state.scripts[id] = normalizeScript(keep, id);
    await saveLocalState("Userscript saved and metadata reparsed");
    selectedScriptId = id;
    renderScripts();
  };
  if (s.externalArtifact) $("cloneExternalScript").onclick = async () => {
    const code = s.code;
    const parsed = parseUserscriptMetadata(code, `${s.name} (local copy)`);
    const id = makeScriptId(`${s.name}-local`);
    snapshot.state.scripts[id] = normalizeScript({
      id,
      ...parsed,
      name: `${s.name} (local copy)`.slice(0, 200),
      code,
      profileIds: [...s.profileIds],
      autoRun: false,
      enabled: s.enabled,
      compatibility: analyzeGrants(parsed.grants)
    }, id);
    selectedScriptId = id;
    await saveLocalState("External artifact cloned as a local script");
    renderScripts();
  };
  $("deleteScript").onclick = async () => {
    const usedBy = Object.values(snapshot.state.workflows || {}).filter((workflow) =>
      (workflow.steps || []).some((step) => (step.scriptIds || []).includes(id))
    ).length;
    const consequence = usedBy ? ` It will also be removed from ${usedBy} workflow${usedBy === 1 ? "" : "s"}.` : "";
    if (!await confirmAction(`Delete ${s.name}?${consequence}`, {title:"Delete userscript",confirmLabel:"Delete script"})) return;
    delete snapshot.state.scripts[id];
    for (const workflow of Object.values(snapshot.state.workflows || {})) {
      for (const step of workflow.steps || []) step.scriptIds = (step.scriptIds || []).filter((x) => x !== id);
    }
    selectedScriptId = null;
    await saveLocalState("Userscript deleted");
    $("scriptEditor").innerHTML = `<p class="muted">Import or select a userscript.</p>`;
  };
}

async function importUserscriptCode(code, fallbackName) {
  const meta = parseUserscriptMetadata(code, fallbackName || "Imported userscript");
  const id = makeScriptId(meta.name);
  const profileIds = importsDefaultToAllProfiles() ? managedProfileIds() : [];
  snapshot.state.scripts[id] = normalizeScript({ id, ...meta, code, profileIds, autoRun: true, compatibility: analyzeGrants(meta.grants) }, id);
  selectedScriptId = id;
  return id;
}

function importsDefaultToAllProfiles() {
  const settings = snapshot.state.global.userscripts || {};
  return settings.autoAssignImportedToAllProfiles === true && settings.autoAssignImportedToAllProfilesConfirmed === true;
}

async function reviewUserscriptImports(items) {
  const highRisk = new Set([
    "unsafeWindow", "GM_cookie", "GM.cookie", "GM_xmlhttpRequest", "GM.xmlHttpRequest", "GM.xmlhttpRequest",
    "GM_download", "GM.download", "GM_setClipboard", "GM.setClipboard", "window.close", "Persona.signal"
  ]);
  const assignment = importsDefaultToAllProfiles()
    ? `These scripts will be assigned to all ${managedProfileIds().length} managed personas.`
    : "These scripts will have no persona assignments until you assign them.";
  const detail = items.map(({ name, meta }) => {
    const grants = meta.grants.length ? meta.grants.join(", ") : "none declared";
    const connects = meta.connects.length ? meta.connects.join(", ") : "none declared";
    const sensitive = meta.grants.filter((grant) => highRisk.has(grant));
    return `${name}\n  Execution world: ${meta.world} (injection mode: ${meta.injectInto})\n  @grant: ${grants}\n  @connect: ${connects}\n  High-impact grants: ${sensitive.length ? sensitive.join(", ") : "none detected"}`;
  }).join("\n\n");
  return confirmAction(`Review each script's declared privileges and network destinations before importing.\n${assignment}\n\n${detail}`, {
    title: `Review ${items.length} userscript${items.length === 1 ? "" : "s"}`,
    confirmLabel: "Import reviewed scripts",
    danger: false
  });
}

function profileOptions(selected = "") {
  const profiles = Object.values(snapshot.state.profiles).filter((p) => p.managed).sort((a,b) => a.name.localeCompare(b.name));
  return `<option value="">Choose persona…</option>` + profiles.map((p) => `<option value="${esc(p.containerId)}"${p.containerId === selected ? " selected" : ""}>${esc(p.name)}</option>`).join("");
}

function workflowScriptChecks(selected = []) {
  const set = new Set(selected || []);
  return Object.values(snapshot.state.scripts).filter((s) => s.enabled).sort((a,b) => a.name.localeCompare(b.name)).map((s) => `<label><input type="checkbox" class="wfScript" value="${esc(s.id)}" ${set.has(s.id) ? "checked" : ""}> ${esc(s.name)}</label>`).join("") || `<span class="muted">No enabled userscripts.</span>`;
}

function newWorkflowObject() {
  const id = `workflow-${crypto.randomUUID().slice(0,8)}`;
  const firstProfile = managedProfileIds()[0] || "";
  return normalizeWorkflow({ id, name: "New workflow", steps: [{ profileId: firstProfile, urls: [], concurrency: 4, scriptIds: [], completion: { mode: "load", timeoutMs: 60000 }, retries: 0, closeTabs: true, stopOnError: true }] }, id);
}

function renderWorkflows() {
  const workflows = Object.values(snapshot.state.workflows || {}).sort((a,b) => a.name.localeCompare(b.name));
  $("workflowList").innerHTML = workflows.length ? workflows.map((w) => `<button class="${w.id === selectedWorkflowId ? "active" : ""}" data-workflow-id="${esc(w.id)}" aria-pressed="${w.id === selectedWorkflowId ? "true" : "false"}"><strong>${esc(w.name)}</strong><div class="route-meta">${w.enabled ? "Enabled" : "Disabled"} · ${w.steps.length} step${w.steps.length === 1 ? "" : "s"}</div></button>`).join("") : `<p class="muted">No workflows yet.</p>`;
  if (selectedWorkflowId && snapshot.state.workflows[selectedWorkflowId]) renderWorkflowEditor(selectedWorkflowId);
  else if (selectedWorkflowId) selectedWorkflowId = null;
}

function renderWorkflowEditor(id) {
  const workflow = snapshot.state.workflows[id];
  if (!workflow) return;
  const stepsHtml = workflow.steps.map((step, index) => `<div class="workflow-step" data-step-index="${index}">
    <div class="inline spread"><h3>Step ${index + 1}</h3><button class="small danger remove-step" ${workflow.steps.length <= 1 ? "disabled" : ""}>Remove</button></div>
    <div class="form-grid">
      <label>Persona<select class="wfProfile">${profileOptions(step.profileId)}</select></label>
      <label>Concurrency<input class="wfConcurrency" type="number" min="1" max="200" value="${esc(step.concurrency)}"></label>
      <label>Completion<select class="wfCompletion"><option value="load"${step.completion.mode === "load" ? " selected" : ""}>Page load</option><option value="delay"${step.completion.mode === "delay" ? " selected" : ""}>Delay (ms)</option><option value="selector"${step.completion.mode === "selector" ? " selected" : ""}>Wait for CSS selector</option><option value="signal"${step.completion.mode === "signal" ? " selected" : ""}>Persona.complete() signal</option></select></label>
      <label>Completion value<input class="wfCompletionValue" value="${esc(step.completion.value || "")}" placeholder="delay ms or CSS selector"></label>
      <label>Timeout (ms)<input class="wfTimeout" type="number" min="1000" max="${MAX_WORKFLOW_STEP_TIMEOUT_MS}" value="${esc(step.completion.timeoutMs)}"></label>
      <label>Retries<input class="wfRetries" type="number" min="0" max="10" value="${esc(step.retries)}"></label>
      <label class="check"><input class="wfClose" type="checkbox" ${step.closeTabs !== false ? "checked" : ""}> Close each job tab after completion</label>
      <label class="check"><input class="wfStopError" type="checkbox" ${step.stopOnError !== false ? "checked" : ""}> Stop workflow on final task failure</label>
    </div>
    <label>URLs — one per line<textarea class="wfUrls" rows="7">${esc((step.urls || []).join("\n"))}</textarea></label>
    <div><label>Userscripts to run in this step</label><div class="profile-checks wf-scripts">${workflowScriptChecks(step.scriptIds)}</div></div>
    <p class="hint">Selected scripts must also be assigned to this persona. With <strong>signal</strong> completion, every selected script must declare <code>@grant Persona.signal</code>, run in the isolated world, and call <code>Persona.complete(result)</code> or <code>Persona.fail(error)</code>.</p>
  </div>`).join("");
  $("workflowEditor").innerHTML = `<div class="script-editor-grid"><label>Name<input id="wfName" value="${esc(workflow.name)}"></label><label class="check"><input id="wfEnabled" type="checkbox" ${workflow.enabled ? "checked" : ""}> Enabled</label></div>
  <div id="workflowSteps">${stepsHtml}</div>
  <div class="inline"><button id="addWorkflowStep">+ Add step</button><button id="saveWorkflow" class="primary">Save workflow</button><button id="runWorkflow" class="primary">Run</button><button id="deleteWorkflow" class="danger">Delete</button></div>`;

  $("workflowSteps").querySelectorAll(".remove-step").forEach((button) => button.onclick = () => {
    readWorkflowEditor(id);
    const index = Number(button.closest(".workflow-step").dataset.stepIndex);
    workflow.steps.splice(index, 1);
    renderWorkflowEditor(id);
  });
  $("addWorkflowStep").onclick = () => {
    readWorkflowEditor(id);
    workflow.steps.push(normalizeWorkflow({ steps: [{ profileId: managedProfileIds()[0] || "", urls: [], concurrency: 4, scriptIds: [], completion: { mode: "load", timeoutMs: 60000 }, closeTabs: true, stopOnError: true }] }, "tmp").steps[0]);
    renderWorkflowEditor(id);
  };
  $("saveWorkflow").onclick = async () => { readWorkflowEditor(id); await saveLocalState("Workflow saved"); selectedWorkflowId = id; renderWorkflows(); };
  $("runWorkflow").onclick = async () => {
    try {
      readWorkflowEditor(id);
      await saveLocalState("Workflow saved");
      if (!snapshot.userScriptsGranted && workflow.steps.some((s) => s.scriptIds.length)) throw new Error("Enable userscript permission before running a workflow that uses scripts");
      const overrideConfirmation = await confirmWorkflowControlOverride(workflow, snapshot.state);
      if (overrideConfirmation === null) return;
      const result = await msg("RUN_WORKFLOW", { workflowId: id, overrideConfirmation });
      toast(`Started ${result.job.id}`);
      await refreshJobs();
      document.querySelector('[data-tab="activity"]').click();
    } catch (e) { toast(e.message || String(e), true); }
  };
  $("deleteWorkflow").onclick = async () => { delete snapshot.state.workflows[id]; selectedWorkflowId = null; await saveLocalState("Workflow deleted"); $("workflowEditor").innerHTML = `<p class="muted">Create or select a workflow.</p>`; };
}

function readWorkflowEditor(id) {
  const workflow = snapshot.state.workflows[id];
  if (!workflow || !$("wfName")) return workflow;
  workflow.name = $("wfName").value.trim() || workflow.name;
  workflow.enabled = $("wfEnabled").checked;
  const steps = [...document.querySelectorAll("#workflowSteps .workflow-step")].map((el, index) => ({
    id: workflow.steps[index]?.id || `step-${index + 1}`,
    profileId: el.querySelector(".wfProfile").value,
    urls: lines(el.querySelector(".wfUrls").value),
    concurrency: Number(el.querySelector(".wfConcurrency").value || 1),
    scriptIds: [...el.querySelectorAll(".wfScript:checked")].map((x) => x.value),
    completion: { mode: el.querySelector(".wfCompletion").value, value: el.querySelector(".wfCompletionValue").value, timeoutMs: Number(el.querySelector(".wfTimeout").value || 60000) },
    retries: Number(el.querySelector(".wfRetries").value || 0),
    closeTabs: el.querySelector(".wfClose").checked,
    stopOnError: el.querySelector(".wfStopError").checked
  }));
  snapshot.state.workflows[id] = normalizeWorkflow({ ...workflow, steps, updatedAt: new Date().toISOString() }, id);
  return snapshot.state.workflows[id];
}

function renderJobs() {
  if (!$("jobsList")) return;
  $("jobsList").innerHTML = jobs.length ? jobs.map((job) => {
    const done = (job.tasks || []).filter((t) => t.state === "completed").length;
    const failed = (job.tasks || []).filter((t) => t.state === "failed").length;
    const active = ["queued", "preparing", "running", "stopping"].includes(job.state);
    return `<div class="job-card" data-job-id="${esc(job.id)}"><div class="inline spread"><div><strong>${esc(job.workflowName || job.workflowId)}</strong><div class="route-meta"><code>${esc(job.id)}</code> · ${esc(job.state)} · ${done} completed${failed ? ` · ${failed} failed` : ""}</div></div>${active ? `<button class="small danger stop-job">Stop</button>` : ""}</div>${job.error ? `<div class="job-error">${esc(job.error)}</div>` : ""}<div class="task-grid">${(job.tasks || []).slice(-40).map((t) => `<div><span>${esc(t.state)}</span><code>${esc(t.url)}</code>${t.error ? `<small>${esc(t.error)}</small>` : ""}</div>`).join("")}</div></div>`;
  }).join("") : `<p class="muted">No automation jobs recorded.</p>`;
}

async function refreshJobs() {
  try { jobs = (await msg("LIST_AUTOMATION_JOBS", { limit: 100 })).jobs || []; renderJobs(); } catch (e) { toast(e.message || String(e), true); }
}

function formatSecurityTime(value) {
  if (!value) return "unknown time";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
}

function proxyControlLabel(value) {
  switch (value) {
    case "controlled_by_this_extension": return "Controlled by PersonaMonkey";
    case "controlled_by_other_extensions": return "Controlled by another extension";
    case "controllable_by_this_extension": return "Available to PersonaMonkey";
    case "not_controllable": return "Browser does not allow extension control";
    default: return "Control state unknown";
  }
}

function blockReasonLabel(value) {
  const raw = String(value || "").replace(/[_-]+/g, " ").trim();
  if (!raw) return "Request blocked by fail-closed policy";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function setSecurityDirty(dirty) {
  securityDirty = Boolean(dirty);
  const save = $("saveSecurity");
  const state = $("securitySaveState");
  const notice = $("securityApplyNotice");
  if (save) save.disabled = !securityDirty;
  if (state) {
    state.textContent = securityDirty ? "Unsaved security changes" : "Settings applied";
    state.classList.toggle("dirty", securityDirty);
  }
  if (notice) {
    notice.className = `notice ${securityDirty ? "warning" : "info"} security-apply-notice`;
    notice.innerHTML = securityDirty
      ? "<strong>Changes not applied yet.</strong> Runtime checks below still describe the last saved configuration."
      : "<strong>Settings applied.</strong> Runtime checks below correspond to the saved configuration.";
  }
}

function renderSecurityControls({ force = false } = {}) {
  if (securityDirty && !force) return;
  const g = snapshot.state.global;
  $("blockSpeculative").checked = g.blockSpeculative;
  $("strictProxyVerification").checked = g.strictProxyVerification;
  $("enforcePrivacyControls").checked = g.enforcePrivacyControls;
  $("disableNetworkPrediction").checked = g.disableNetworkPrediction;
  $("webRTCMode").value = g.webRTCMode;
  $("unmanagedPolicy").value = g.unmanagedPolicy;
  $("autoReload").checked = g.autoReloadOnRouteChange;
  setSecurityDirty(false);
}

function renderSecurityState() {
  const g = snapshot.state.global;
  const s = snapshot.security || {};
  const browserControlsSafe = s.networkPredictionSafe !== false && s.webRTCSafe !== false;
  const proxyOwned = s.proxyControl !== "controlled_by_other_extensions" && s.proxyControl !== "not_controllable";
  const policyReady = s.ready === true && (!g.enforcePrivacyControls || s.privacySafe !== false);
  const lastBlock = s.lastBlock;
  const cards = [
    ["Fail-closed policy", policyReady ? "Active" : "Needs attention", policyReady],
    ["Browser leak controls", browserControlsSafe ? "Protected" : "Needs attention", browserControlsSafe],
    ["Proxy control", proxyControlLabel(s.proxyControl), proxyOwned],
    ["Recent proxy errors", s.lastProxyError ? "Error recorded" : "None", !s.lastProxyError]
  ];
  $("securityDetails").innerHTML = `<div class="security-state-cards">${cards.map(([k,v,ok]) =>
    `<div class="status-card security-state-card${ok ? "" : " attention"}"><b>${esc(k)}</b><span>${esc(v)}</span></div>`
  ).join("")}</div>
    <details class="security-technical">
      <summary>Technical details</summary>
      <div class="status-grid security-technical-grid">
        <div class="status-card"><b>Network prediction</b><span>${esc(s.networkPredictionSafe ? "Safe" : "Unsafe")}</span></div>
        <div class="status-card"><b>WebRTC</b><span>${esc(s.webRTCSafe ? "Safe" : "Unsafe")}</span></div>
        <div class="status-card"><b>Last proxy error</b><span>${esc(s.lastProxyError?.message || "None")}</span></div>
        <div class="status-card"><b>Last blocked request</b><span>${esc(lastBlock ? `${blockReasonLabel(lastBlock.reason)} · ${formatSecurityTime(lastBlock.at)}` : "None")}</span></div>
      </div>
    </details>`;
}

function attachStaticEvents() {
  const tabs = document.querySelector(".tabs");
  const mobileNav = $("mobileSectionNav");
  const routeCreateOptions = [...document.querySelectorAll(".route-create-option")];
  for (const option of routeCreateOptions) {
    option.addEventListener("toggle", () => {
      if (!option.open) return;
      for (const other of routeCreateOptions) if (other !== option) other.open = false;
    });
  }
  const navGroupFor = (button) => button.dataset.navGroup || (["profiles","routes","cookies"].includes(button.dataset.tab) ? "Operate" : ["scripts","automations"].includes(button.dataset.tab) ? "Automate" : "Inspect & Admin");
  const syncTabA11y = () => {
    if (!tabs) return;
    for (const button of tabs.querySelectorAll("button[data-tab]")) {
      const target = document.getElementById(`tab-${button.dataset.tab}`);
      const active = button.classList.contains("active");
      if (!button.id) button.id = `nav-${button.dataset.tab}`;
      button.setAttribute("role","tab");
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.setAttribute("aria-controls", `tab-${button.dataset.tab}`);
      button.tabIndex = active ? 0 : -1;
      if (target) {
        target.setAttribute("role","tabpanel");
        target.setAttribute("aria-labelledby", button.id);
        target.setAttribute("aria-hidden", active ? "false" : "true");
      }
    }
  };
  const syncMobileSectionNav = () => {
    if (!tabs || !mobileNav) return;
    const active = tabs.querySelector("button.active[data-tab]")?.dataset.tab || "profiles";
    const groups = new Map();
    for (const button of tabs.querySelectorAll("button[data-tab]")) {
      const group = navGroupFor(button);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(button);
    }
    mobileNav.replaceChildren(...[...groups].map(([label, buttons]) => {
      const group = document.createElement("optgroup");
      group.label = label;
      for (const button of buttons) {
        const option = document.createElement("option");
        option.value = button.dataset.tab;
        option.textContent = button.textContent.trim();
        group.append(option);
      }
      return group;
    }));
    if ([...mobileNav.options].some((option) => option.value === active)) mobileNav.value = active;
  };
  mobileNav?.addEventListener("change", () => tabs?.querySelector(`button[data-tab="${CSS.escape(mobileNav.value)}"]`)?.click());
  const updateTabsOverflowCue = () => {
    const cue = $("tabsOverflowCue");
    if (!tabs || !cue) return;
    const overflow = tabs.scrollWidth > tabs.clientWidth + 4;
    const atEnd = tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 8;
    cue.classList.toggle("hidden", !overflow || atEnd);
  };
  const bindTab = (button) => {
    if (button.dataset.tabBound === "true") return;
    button.dataset.tabBound = "true";
    button.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === button));
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${button.dataset.tab}`));
      syncTabA11y();
      button.scrollIntoView({behavior:"smooth", block:"nearest", inline:"center"});
      if (mobileNav) mobileNav.value = button.dataset.tab;
      queueMicrotask(updateTabsOverflowCue);
    });
  };
  document.querySelectorAll(".tabs button").forEach(bindTab);
  if (tabs) {
    tabs.addEventListener("scroll", updateTabsOverflowCue, {passive:true});
    tabs.addEventListener("keydown", (event) => {
      if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      const buttons = [...tabs.querySelectorAll('button[data-tab]')];
      const current = buttons.indexOf(document.activeElement);
      if (current < 0) return;
      event.preventDefault();
      const targetIndex = event.key === "Home" ? 0
        : event.key === "End" ? buttons.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[targetIndex]?.click();
      buttons[targetIndex]?.focus();
    });
    new MutationObserver(() => {
      tabs.querySelectorAll("button[data-tab]").forEach(bindTab);
      syncTabA11y();
      syncMobileSectionNav();
      updateTabsOverflowCue();
    }).observe(tabs, {childList:true,subtree:true,attributes:true,attributeFilter:["class"]});
  }
  window.addEventListener("resize", updateTabsOverflowCue, {passive:true});
  syncTabA11y();
  syncMobileSectionNav();
  updateTabsOverflowCue();

  $("profileFilter").addEventListener("input", renderProfiles);
  $("refreshProfiles").onclick = async () => { await load(); setProfilesDirty(false); };
  $("saveProfiles").onclick = () => saveLocalState("Persona routing policy saved").catch((e) => toast(e.message, true));
  $("applyProfileCount").onclick = async () => {
    try {
      const result = await msg("ENSURE_PROFILES", { count: $("profileCount").value, prefix: $("profilePrefix").value });
      snapshot.state = result.state; snapshot.containers = result.containers;
      renderAll(); window.dispatchEvent(new CustomEvent("persona-state-changed")); toast("Persona count applied");
    } catch (e) { toast(e.message, true); }
  };

  const setRouteFormError = (message = "", control = null) => {
    for (const field of [$("routeHost"), $("routePort")]) {
      field?.classList.remove("field-invalid");
      field?.removeAttribute("aria-invalid");
    }
    const error = $("routeFormError");
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
  $("routeHost").addEventListener("input", () => setRouteFormError());
  $("routePort").addEventListener("input", () => setRouteFormError());
  $("routeType").onchange = () => {
    const socks = $("routeType").value === "socks";
    $("routePort").value = socks ? "1080" : "443";
    $("routeProxyDNS").disabled = !socks;
    setRouteFormError();
  };
  $("addGenericRoute").onclick = async () => {
    try {
      setRouteFormError();
      const id = `route-${crypto.randomUUID().slice(0,8)}`;
      const name = $("routeName").value.trim() || id;
      const host = $("routeHost").value.trim();
      const port = Number($("routePort").value);
      if (!host) return setRouteFormError("Route host is required", $("routeHost"));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return setRouteFormError("Route port must be an integer from 1 to 65535", $("routePort"));
      const candidate = normalizeRoute({
        name,
        provider: /^proton\b/i.test(name) ? "proton-manual" : "generic",
        type: $("routeType").value,
        host,
        port,
        proxyDNS: $("routeProxyDNS").checked,
        username: $("routeUser").value,
        password: $("routePass").value
      }, id);
      snapshot.state.routes[id] = candidate;
      if (await saveLocalState("Route added")) {
        $("routeName").value = $("routeHost").value = $("routeUser").value = $("routePass").value = "";
        setRouteFormError();
      }
    } catch (e) {
      const message = e?.message || String(e);
      setRouteFormError(message);
      toast(message, true);
    }
  };

  $("routesTable").addEventListener("click", async (event) => {
    const row = event.target.closest("tr[data-id]"); if (!row) return;
    const id = row.dataset.id; const r = snapshot.state.routes[id]; if (!r) return;
    if (event.target.classList.contains("delete-route")) {
      const affected = Object.values(snapshot.state.profiles).filter((profile) => profile.routeId === id).length;
      const consequence = affected
        ? ` ${affected} persona${affected === 1 ? "" : "s"} using this route will be set to Block.`
        : "";
      if (!await confirmAction(`Delete ${r.name}?${consequence}`, {title:"Delete route",confirmLabel:"Delete route"})) return;
      for (const p of Object.values(snapshot.state.profiles)) if (p.routeId === id) p.routeId = BLOCK_ROUTE_ID;
      if (r.provider === "mullvad") { try { await msg("MULLVAD_RELEASE_ROUTE", { routeId:id }); } catch {} }
      delete snapshot.state.routes[id];
      if (selectedRouteId === id) selectedRouteId = null;
      await saveLocalState("Route deleted; affected personas were blocked");
    }
    if (event.target.classList.contains("edit-route")) {
      selectedRouteId = id;
      renderRouteEditor(id);
      $("routeEditor")?.scrollIntoView({behavior:"smooth",block:"nearest"});
    }
  });

  $("mullvadRefreshNative").onclick = async () => {
    try {
      snapshot.mullvadNative = (await msg("MULLVAD_STATUS")).status;
      const e = await msg("MULLVAD_LIST_ENTRIES"); mullvadEntries = e.entries || [];
      renderMullvadNative(); toast("Local Mullvad status refreshed");
    } catch (e) { snapshot.mullvadNative = { installed:false, ready:false, error:e.message || String(e) }; renderMullvadNative(); toast(e.message || String(e), true); }
  };
  $("mullvadEnsure").onclick = async () => {
    try { toast("Starting / checking Mullvad tunnel…"); snapshot.mullvadNative = (await msg("MULLVAD_ENSURE")).status; renderMullvadNative(); toast(snapshot.mullvadNative.ready ? "Mullvad bridge ready" : "Tunnel started but not ready", !snapshot.mullvadNative.ready); }
    catch (e) { toast(e.message || String(e), true); }
  };
  $("mullvadStop").onclick = async () => {
    try { snapshot.mullvadNative = (await msg("MULLVAD_STOP")).status; renderMullvadNative(); toast("Mullvad entry tunnel disconnected"); }
    catch (e) { toast(e.message || String(e), true); }
  };
  $("mullvadRestart").onclick = async () => {
    try { toast("Restarting Mullvad tunnel…"); snapshot.mullvadNative = (await msg("MULLVAD_RESTART")).status; renderMullvadNative(); toast(snapshot.mullvadNative.ready ? "Mullvad bridge restarted" : "Restarted, but bridge is not ready", !snapshot.mullvadNative.ready); }
    catch (e) { toast(e.message || String(e), true); }
  };
  $("mullvadSetEntry").onclick = async () => {
    const entryId = $("mullvadEntry").value; if (!entryId) return toast("No WireGuard entry config is available", true);
    try { toast(`Switching entry to ${entryId}…`); snapshot.mullvadNative = (await msg("MULLVAD_SET_ENTRY", { entryId, start:true })).status; renderMullvadNative(); toast(snapshot.mullvadNative.ready ? `Entry switched to ${entryId}` : "Entry switched but tunnel is not ready", !snapshot.mullvadNative.ready); }
    catch (e) { toast(e.message || String(e), true); }
  };
  $("mullvadSaveSettings").onclick = async () => {
    const cfg = snapshot.state.global.mullvadNative || (snapshot.state.global.mullvadNative = {});
    cfg.enabled = true; cfg.autoStart = $("mullvadAutoStart").checked; cfg.requireReady = true; cfg.autoStopMinutes = Number($("mullvadAutoStop").value || 0);
    await saveLocalState("Mullvad bridge settings saved");
  };

  $("loadMullvad").onclick = async () => {
    try { await loadMullvadRelays({ announce: true, force: true }); }
    catch (e) { toast(e.message || String(e), true); }
  };
  $("mullvadSearch").addEventListener("input", populateMullvadList);
  $("addMullvadRoute").onclick = async () => {
    const value = $("mullvadRelay").value; if (!value) return toast("Select a Mullvad relay first", true);
    const [hostname, ip, port] = value.split("|");
    const relay = mullvadRelays.find((r) => r.hostname === hostname && r.ipv4_address === ip && String(r.port) === port);
    if (!relay) return toast("Selected relay is no longer in the list", true);
    try {
      const preview = await msg("CREATE_MULLVAD_ROUTE", { relay });
      const authorizationId = await authorizeSecurityPreview(preview, "new Mullvad route");
      if (!authorizationId) return;
      const result = await msg("CREATE_MULLVAD_ROUTE", { authorizationId });
      snapshot.state = result.state; renderAll(); toast("Mullvad route added");
    }
    catch (e) { toast(e.message, true); }
  };

  $("enableUserScripts").onclick = async () => {
    try {
      const granted = await browser.permissions.request({ permissions: ["userScripts"] });
      snapshot.userScriptsGranted = granted || await browser.permissions.contains({ permissions: ["userScripts"] });
      renderScripts(); toast(snapshot.userScriptsGranted ? "Userscript permission enabled" : "Userscript permission not granted", !snapshot.userScriptsGranted);
    } catch (e) { toast(e.message, true); }
  };

  $("scriptFile").onchange = async () => {
    const files = [...($("scriptFile").files || [])];
    try {
      const items = await Promise.all(files.map(async (file) => {
        const name = file.name.replace(/\.user\.js$|\.js$/i, "");
        const code = await file.text();
        return { name, code, meta: parseUserscriptMetadata(code, name || "Imported userscript") };
      }));
      if (items.length && !await reviewUserscriptImports(items)) {
        $("scriptFile").value = "";
        return;
      }
      for (const item of items) await importUserscriptCode(item.code, item.name);
      if (files.length) await saveLocalState(`${files.length} userscript${files.length === 1 ? "" : "s"} imported`);
      $("scriptFile").value = "";
      renderScripts();
    } catch (e) { toast(e.message || String(e), true); }
  };
  $("importPastedScript").onclick = async () => {
    const code = $("scriptPaste").value.trim();
    if (!code) return toast("Paste a userscript first", true);
    try {
      const meta = parseUserscriptMetadata(code, "Pasted userscript");
      const item = { name: meta.name, code, meta };
      if (!await reviewUserscriptImports([item])) return;
      await importUserscriptCode(code, "Pasted userscript");
      await saveLocalState("Userscript imported"); $("scriptPaste").value = ""; renderScripts();
    }
    catch (e) { toast(e.message || String(e), true); }
  };
  $("saveUserscriptSettings").onclick = async () => {
    const ug = snapshot.state.global.userscripts || (snapshot.state.global.userscripts = {});
    ug.autoAssignImportedToAllProfiles = $("autoAssignImported").checked;
    ug.autoAssignImportedToAllProfilesConfirmed = true;
    ug.dependencyFetch = $("dependencyFetch").value;
    await saveLocalState("Userscript settings saved");
  };
  $("scriptFilter").addEventListener("input", (event) => {
    scriptFilterText = event.target.value;
    renderScripts();
  });
  $("scriptList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-script-id]"); if (!button) return;
    selectedScriptId = button.dataset.scriptId; renderScripts();
  });

  $("newWorkflow").onclick = async () => {
    const workflow = newWorkflowObject();
    snapshot.state.workflows[workflow.id] = workflow;
    selectedWorkflowId = workflow.id;
    await saveLocalState("Workflow created");
    renderWorkflows();
  };
  $("workflowList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-workflow-id]"); if (!button) return;
    selectedWorkflowId = button.dataset.workflowId; renderWorkflows();
  });
  $("refreshJobs").onclick = refreshJobs;
  $("clearJobs").onclick = async () => { await msg("CLEAR_AUTOMATION_JOBS"); await refreshJobs(); toast("Finished job history cleared"); };
  $("jobsList").addEventListener("click", async (event) => {
    const card = event.target.closest("[data-job-id]");
    if (!card || !event.target.classList.contains("stop-job")) return;
    try { await msg("STOP_AUTOMATION_JOB", { jobId: card.dataset.jobId }); await refreshJobs(); toast("Stop requested"); }
    catch (e) { toast(e.message || String(e), true); }
  });

  document.querySelector("#tab-security .settings-list")?.addEventListener("change", () => setSecurityDirty(true));
  $("saveSecurity").onclick = async () => {
    const g = snapshot.state.global;
    g.blockSpeculative = $("blockSpeculative").checked;
    g.strictProxyVerification = $("strictProxyVerification").checked;
    g.enforcePrivacyControls = $("enforcePrivacyControls").checked;
    g.disableNetworkPrediction = $("disableNetworkPrediction").checked;
    g.webRTCMode = $("webRTCMode").value;
    g.unmanagedPolicy = $("unmanagedPolicy").value;
    g.autoReloadOnRouteChange = $("autoReload").checked;
    const saved = await saveLocalState("Security settings applied");
    if (saved) {
      setSecurityDirty(false);
      renderSecurityControls({ force:true });
      renderSecurityState();
    } else if (saved === false) {
      setSecurityDirty(true);
    }
  };
  $("refreshSecurity").onclick = async () => {
    snapshot.security = (await msg("REFRESH_SECURITY")).security;
    renderSecurityState();
    renderSecurityBadge();
    toast(securityDirty ? "Runtime state re-checked; unsaved security changes were preserved" : "Security runtime state re-checked");
  };

  $("exportConfig").onclick = async () => {
    const payload = await msg("EXPORT_STATE", { includeSecrets: $("includeSecrets").checked });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `persona-route-manager-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("importConfig").onchange = async () => {
    const file = $("importConfig").files?.[0]; if (!file) return;
    try { pendingImportPayload = JSON.parse(await file.text()); toast("Import file parsed; click Import configuration"); } catch (e) { pendingImportPayload = null; toast("Invalid JSON file", true); }
  };
  $("doImport").onclick = async () => {
    if (!pendingImportPayload) return toast("Choose a configuration JSON file first", true);
    try {
      const preview = await msg("IMPORT_STATE", { payload: pendingImportPayload, mode: $("importMode").value });
      const authorizationId = await authorizeSecurityPreview(preview, "legacy configuration import");
      if (!authorizationId) return;
      snapshot = await msg("IMPORT_STATE", { authorizationId });
      renderAll(); toast("Configuration imported");
    }
    catch (e) { toast(e.message, true); }
  };
}

function setInitialLoadState({ loading = false, error = null } = {}) {
  const surface = $("initialLoadState");
  const main = $("optionsMain");
  const title = $("initialLoadTitle");
  const detail = $("initialLoadDetail");
  const retry = $("retryInitialLoad");
  main?.setAttribute("aria-busy", loading ? "true" : "false");
  document.body.classList.toggle("options-loading", loading || Boolean(error));
  surface?.classList.toggle("error", Boolean(error));
  surface?.querySelector(".initial-load-spinner")?.classList.toggle("hidden", !loading);
  if (title) title.textContent = error ? "PersonaMonkey could not load" : "Loading PersonaMonkey…";
  if (detail) detail.textContent = error
    ? String(error?.message || error || "Extension background is unavailable")
    : "Connecting to the extension background and reading persona state.";
  retry?.classList.toggle("hidden", !error);
  if (!loading && !error) surface?.classList.add("hidden");
  else surface?.classList.remove("hidden");
}

async function initializeOptions() {
  setInitialLoadState({ loading:true });
  try {
    await load();
    setInitialLoadState();
    await refreshJobs();
    if (!jobsTimer) {
      jobsTimer = setInterval(() => {
        const activityVisible = $("tab-activity")?.classList.contains("active");
        if (activityVisible || jobs.some((j) => ["queued","preparing","running","stopping"].includes(j.state))) void refreshJobs();
      }, 2000);
    }
  } catch (error) {
    setInitialLoadState({ error });
    toast(`Unable to load extension: ${error.message || error}`, true);
  }
}

attachProfileEvents();
attachStaticEvents();
$("retryInitialLoad")?.addEventListener("click", () => { void initializeOptions(); });
browser.storage?.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes?.state) {
    window.dispatchEvent(new CustomEvent("persona-state-changed"));
  }
});
window.addEventListener("persona-state-changed", () => {
  if (personaRefreshQueued) return;
  personaRefreshQueued = true;
  queueMicrotask(async () => {
    personaRefreshQueued = false;
    try { await load(); }
    catch (error) { toast(`Refresh failed: ${error.message || error}`, true); }
  });
});
void initializeOptions();
