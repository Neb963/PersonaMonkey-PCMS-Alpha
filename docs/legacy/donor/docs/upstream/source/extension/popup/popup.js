import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "../lib/constants.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[ch]);
const COLORS = {blue:"#37adff",green:"#51cd00",orange:"#ff9f00",pink:"#ff4bda",purple:"#af51f5",red:"#ff613d",cyan:"#00c79a",gray:"#7c8798",violet:"#7f6cff",yellow:"#e0b400"};
let snapshot, active;

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
load().catch((e) => {
  $("status").textContent = "Unavailable";
  $("status").className = "badge bad";
  $("route").disabled = true;
  $("test").disabled = true;
  $("actionHint").textContent = "Persona state is unavailable. Open settings to inspect the extension.";
  setResult(e.message || String(e), true);
});
