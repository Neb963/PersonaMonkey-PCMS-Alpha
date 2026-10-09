import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "../lib/constants.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[ch]);
const COLORS = {blue:"#37adff",green:"#51cd00",orange:"#ff9f00",pink:"#ff4bda",purple:"#af51f5",red:"#ff613d",cyan:"#00c79a",gray:"#7c8798",violet:"#7f6cff",yellow:"#e0b400"};
let snapshot, active;

const PCMS_STATUS_KEY = "pcms.status.v1";
const PCMS_IDLE_AFTER_MS = 120000;
const PCMS_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
let pcmsSummary = null;
let pcmsReadComplete = false;
let pcmsAccountId = null;

// Accept only the safe, bounded fields published by Core. Never render
// raw stored values, HumanTask instructions, secrets or cookieStoreId.
function normalizePcmsStatus(raw) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
  const asOf = typeof raw.asOf === "string" ? Date.parse(raw.asOf) : NaN;
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const personaAccounts = Array.isArray(raw.personaAccounts)
    ? raw.personaAccounts.slice(0, 500).map((entry) => ({
      personaUid: typeof entry?.personaUid === "string" ? entry.personaUid : null,
      accounts: Array.isArray(entry?.accounts)
        ? entry.accounts.slice(0, 5).filter((account) =>
          typeof account?.accountId === "string" && PCMS_ACCOUNT_ID_PATTERN.test(account.accountId)
        ).map((account) => ({
          accountId: account.accountId,
          displayName: typeof account.displayName === "string" ? account.displayName.slice(0, 160) : account.accountId
        })) : []
    })) : [];
  return {
    state: ["RUNNING", "STARTING", "UNAVAILABLE"].includes(raw.state) ? raw.state : "UNAVAILABLE",
    asOf: Number.isFinite(asOf) ? asOf : null,
    attention: count(raw.counts?.attention),
    recoveryHold: raw.recoveryState === "RECOVERY_HOLD",
    personaAccounts
  };
}

function renderPcms() {
  if (!active) return;
  const managed = active.profile?.managed === true;
  const attention = pcmsSummary?.attention || 0;
  const held = pcmsSummary?.recoveryHold === true;
  $("pcmsBlock").classList.toggle("hidden", !managed && !held && attention === 0);
  $("pcmsState").hidden = !managed;
  $("pcmsAccount").hidden = !managed;
  $("pcmsAsOf").hidden = !managed;
  const age = pcmsSummary?.asOf === null || !pcmsSummary ? null : Date.now() - pcmsSummary.asOf;
  $("pcmsState").textContent = !pcmsReadComplete ? "Starting" :
    !pcmsSummary ? "Unavailable" :
    pcmsSummary.state === "RUNNING" ? (age !== null && age > PCMS_IDLE_AFTER_MS ? "Idle · last known" : "Running") :
    pcmsSummary.state === "STARTING" ? "Starting" : "Unavailable";
  $("pcmsAsOf").textContent = pcmsSummary && pcmsSummary.asOf !== null
    ? "As of " + new Date(pcmsSummary.asOf).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})
    : "No status snapshot available";
  pcmsAccountId = null;
  const match = pcmsSummary?.personaAccounts.find((entry) => entry.personaUid === active.profile?.personaUid);
  if (managed && match?.accounts.length === 1) {
    pcmsAccountId = match.accounts[0].accountId;
    $("pcmsAccount").textContent = "Account: " + match.accounts[0].displayName;
  } else {
    $("pcmsAccount").textContent = managed ? "No linked account for this Persona" : "";
  }
  $("pcmsAttention").textContent = held ? "PCMS on hold after restore" :
    managed && pcmsSummary?.state === "UNAVAILABLE" ? "PCMS unavailable — open for details" :
    attention ? attention === 1 ? "1 item needs attention" : attention + " items need attention" :
    managed && pcmsSummary ? "No items need attention" : "";
  $("pcmsOpenAccount").hidden = !managed || !pcmsAccountId;
  $("pcmsOpenAccount").disabled = !pcmsAccountId;
}

async function readPcmsStatus() {
  try {
    const data = await browser.storage.session.get(PCMS_STATUS_KEY);
    pcmsSummary = normalizePcmsStatus(data?.[PCMS_STATUS_KEY]);
  } catch {
    pcmsSummary = null;
  }
  pcmsReadComplete = true;
  renderPcms();
}

async function openPcmsAccount() {
  const id = pcmsAccountId;
  if (!id || !PCMS_ACCOUNT_ID_PATTERN.test(id)) return;
  const base = browser.runtime.getURL("pcms/app/index.html");
  const url = base + "#/accounts/" + encodeURIComponent(id);
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((tab) => typeof tab.url === "string" &&
    (tab.url === base || tab.url.startsWith(base + "#")));
  if (existing && Number.isInteger(existing.id)) {
    await browser.tabs.update(existing.id, {url, active:true});
    if (Number.isInteger(existing.windowId)) await browser.windows.update(existing.windowId, {focused:true});
  } else {
    await browser.tabs.create({url});
  }
}


function setResult(message = "", error = false) {
  const result = $("result");
  result.className = `result${error ? " warning" : ""}`;
  result.setAttribute("role", error ? "alert" : "status");
  result.setAttribute("aria-live", error ? "assertive" : "polite");
  result.textContent = String(message || "");
}

function protectionLabel(profile) {
  return profile?.killSwitch === false ? "Relaxed" : "Enforced";
}

function identity(container, profile) {
  const color = /^#[0-9a-f]{6}$/i.test(container?.colorCode || "") ? container.colorCode : (COLORS[container?.color] || COLORS.gray);
  const icon = container?.iconUrl ? `<img src="${esc(container.iconUrl)}" alt="">` : esc(String(container?.icon || "fingerprint").slice(0,1).toUpperCase());
  return `<div class="popup-persona" style="--persona-color:${color}"><span class="popup-persona-icon">${icon}</span><div><div class="title">${esc(container?.name || profile.name)}</div><div class="persona-style">${esc(container?.icon || "fingerprint")} · ${esc(container?.color || "default")}</div></div></div>`;
}

function setDirectWarning(visible) {
  $("directWarning")?.classList.toggle("hidden", !visible);
}

async function applyRoute(routeId) {
  if (!active?.profile) return;
  const route = $("route");
  const confirm = $("confirmDirect");
  const cancel = $("cancelDirect");
  route.disabled = true;
  route.setAttribute("aria-busy","true");
  if (confirm) confirm.disabled = true;
  if (cancel) cancel.disabled = true;
  setResult("Applying route…");
  try {
    await browser.runtime.sendMessage({ type:"UPDATE_PROFILE_ROUTE", profileId:active.profile.containerId, routeId, allowDirect:routeId === DIRECT_ROUTE_ID });
    setDirectWarning(false);
    await load();
    setResult("Route applied; tabs reloaded if enabled.");
  } catch (e) {
    setDirectWarning(false);
    routeOptions(active.profile.routeId);
    setResult(e.message || String(e), true);
  } finally {
    route.removeAttribute("aria-busy");
    route.disabled = !active?.profile?.managed;
    if (confirm) confirm.disabled = false;
    if (cancel) cancel.disabled = false;
  }
}

function routeOptions(selected) {
  const entries = [[BLOCK_ROUTE_ID,"BLOCK — no network"],[DIRECT_ROUTE_ID,"DIRECT — no VPN/proxy"],...Object.values(snapshot.state.routes).sort((a,b)=>a.name.localeCompare(b.name)).map((r)=>[r.id,r.name])];
  $("route").innerHTML = entries.map(([id,name]) => `<option value="${esc(id)}"${id===selected?" selected":""}>${esc(name)}</option>`).join("");
}

async function load() {
  snapshot = await browser.runtime.sendMessage({ type:"GET_SNAPSHOT" });
  active = await browser.runtime.sendMessage({ type:"GET_ACTIVE_CONTEXT" });
  renderPcms();
  const p = active.profile;
  if (!p || !p.managed) {
    $("status").textContent = "Not a persona"; $("status").className = "badge";
    $("context").innerHTML = `<div class="title">${esc(active.tab?.cookieStoreId || "Normal tab")}</div><div class="meta">This tab is not managed by PersonaMonkey. Create or enable a persona in Settings → Personas.</div>`;
    $("route").disabled = true;
    $("test").disabled = true;
    $("route").title = "Route assignment is available only for managed personas";
    $("test").title = "Route verification is available only for managed personas";
    $("actionHint").textContent = "Route controls are disabled because this tab is not a managed persona.";
    setDirectWarning(false);
    routeOptions(BLOCK_ROUTE_ID);
    return;
  }
  const protectedRoute = p.routeId !== DIRECT_ROUTE_ID && p.routeId !== BLOCK_ROUTE_ID;
  const safe = !snapshot.state.global.enforcePrivacyControls || snapshot.security.privacySafe;
  if (p.routeId === BLOCK_ROUTE_ID || (protectedRoute && !safe)) { $("status").textContent = "Blocked fail-closed"; $("status").className = "badge warn"; }
  else if (protectedRoute) { $("status").textContent = "Protected route"; $("status").className = "badge good"; }
  else { $("status").textContent = "Direct network"; $("status").className = "badge warn"; }
  const mv = active.route?.provider === "mullvad" ? active.mullvadNative : null;
  const bridge = mv ? `<br>Local bridge: ${mv.ready ? "ready" : "not ready"}${mv.selected_entry ? ` · entry ${esc(mv.selected_entry)}` : ""}` : "";
  const verified = active.routeTest?.checkedAt ? `<br>${active.routeTest.ok ? "✓ Exit verified" : "⚠ Route check failed"} · ${new Date(active.routeTest.checkedAt).toLocaleTimeString()}` : "<br>○ Exit not tested";
  const network = active.route
    ? `${esc(active.route.name)}${active.route.country || active.route.city ? ` · ${esc(active.route.country || "")} ${esc(active.route.city || "")}` : ""}`
    : p.routeId === DIRECT_ROUTE_ID ? "Direct network" : "Blocked fail-closed";
  $("context").innerHTML = `${identity(active.container, p)}
    <div class="popup-state-grid">
      <div><span>Protection</span><strong>${esc(protectionLabel(p))}</strong></div>
      <div><span>Network</span><strong>${network}</strong></div>
    </div>
    <div class="meta">${bridge ? bridge.replace(/^<br>/, "") + "<br>" : ""}${verified.replace(/^<br>/, "")}<br>${p.scriptIds?.length || 0} assigned userscripts</div>`;
  $("route").disabled = false;
  $("test").disabled = false;
  $("route").removeAttribute("title");
  $("test").removeAttribute("title");
  $("actionHint").textContent = p.routeId === BLOCK_ROUTE_ID
    ? "This persona is intentionally blocked. Verify route after assigning a network route."
    : p.routeId === DIRECT_ROUTE_ID
      ? "This persona is using Firefox's normal network path without a protected route."
      : "Route changes affect this persona only.";
  setDirectWarning(false);
  routeOptions(p.routeId);
}

$("route").onchange = async () => {
  if (!active?.profile) return;
  const routeId = $("route").value;
  if (routeId === DIRECT_ROUTE_ID && active.profile.routeId !== DIRECT_ROUTE_ID) {
    setDirectWarning(true);
    setResult("Direct network requires confirmation.");
    return;
  }
  setDirectWarning(false);
  await applyRoute(routeId);
};
$("confirmDirect").onclick = () => { if ($("route").value === DIRECT_ROUTE_ID) void applyRoute(DIRECT_ROUTE_ID); };
$("cancelDirect").onclick = () => {
  setDirectWarning(false);
  routeOptions(active?.profile?.routeId || BLOCK_ROUTE_ID);
  setResult("Direct network change cancelled.");
};
$("test").onclick = async () => {
  if (!active?.profile) return;
  const button = $("test");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Verifying…";
  button.setAttribute("aria-busy","true");
  setResult("Verifying route…");
  try {
    const r = await browser.runtime.sendMessage({ type:"TEST_PROFILE", profileId:active.profile.containerId });
    if (!r.ok) { setResult(r.error || "Route verification failed", true); return; }
    const d = r.data || {};
    const ip = d.ip || (typeof d.raw === "string" ? d.raw.trim() : "");
    setResult(ip ? `${ip}${d.city ? ` · ${d.city}` : ""}${d.country ? ` · ${d.country}` : ""}${d.mullvad_exit_ip === true ? " · Mullvad exit" : ""}` : JSON.stringify(d).slice(0,220));
  } catch (error) {
    setResult(error?.message || String(error), true);
  } finally {
    button.textContent = label;
    button.removeAttribute("aria-busy");
    button.disabled = !active?.profile?.managed;
  }
};
$("options").onclick = () => browser.runtime.openOptionsPage();
$("pcmsOpenAccount").onclick = () => { void openPcmsAccount().catch(() => setResult("Could not open PCMS account.", true)); };
if (browser.storage?.onChanged?.addListener) browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[PCMS_STATUS_KEY]) {
    pcmsSummary = normalizePcmsStatus(changes[PCMS_STATUS_KEY].newValue);
    pcmsReadComplete = true;
    renderPcms();
  }
});
void readPcmsStatus();
load().catch((e) => {
  $("status").textContent = "Unavailable";
  $("status").className = "badge bad";
  $("route").disabled = true;
  $("test").disabled = true;
  $("actionHint").textContent = "Persona state is unavailable. Open settings to inspect the extension.";
  setResult(e.message || String(e), true);
});
