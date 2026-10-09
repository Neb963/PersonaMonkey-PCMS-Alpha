import { toast } from "./toast.js";
import { createPortableBackupPayload, encodeBackupEnvelope } from "../lib/backup-package.js";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[ch]);
const COLOR_FALLBACKS = {blue:"#37adff",green:"#51cd00",orange:"#ff9f00",pink:"#ff4bda",purple:"#af51f5",red:"#ff613d",cyan:"#00c79a",gray:"#7c8798",violet:"#7f6cff",yellow:"#e0b400"};

let observer = null;
let decorating = false;
let queued = false;

function safeColor(container = {}) {
  const code = String(container.colorCode || "");
  if (/^#[0-9a-f]{6}$/i.test(code)) return code;
  return COLOR_FALLBACKS[container.color] || "#7c8798";
}

function safeFilePart(value) {
  return String(value || "persona").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0,80) || "persona";
}

function personaIdentity(container, profile) {
  const icon = container?.iconUrl
    ? `<img src="${esc(container.iconUrl)}" alt="">`
    : `<span aria-hidden="true">${esc(String(container?.icon || "fingerprint").slice(0,1).toUpperCase())}</span>`;
  return `<div class="persona-identity" style="--persona-color:${safeColor(container)}"><span class="persona-icon">${icon}</span><div class="persona-identity-copy"><strong title="${esc(container?.name || profile?.name || "Persona")}">${esc(container?.name || profile?.name || "Persona")}</strong><div class="route-meta">${esc(container?.cookieStoreId || profile?.containerId || "")}${profile?.owned ? " · extension-created" : ""}</div><div class="persona-appearance">${esc(container?.icon || "container")} · ${esc(container?.color || "default")}</div></div></div>`;
}

async function snapshot() {
  return browser.runtime.sendMessage({type:"GET_SNAPSHOT"});
}

function observe() {
  const table = $("profilesTable");
  if (!table || !observer) return;
  observer.observe(table, {childList:true,subtree:true});
}

async function decorateProfiles() {
  if (decorating) { queued = true; return; }
  decorating = true;
  try {
    const snap = await snapshot();
    const containers = new Map((snap.containers || []).filter((item) => item?.cookieStoreId && !item.error).map((item) => [item.cookieStoreId,item]));
    observer?.disconnect();
    for (const row of document.querySelectorAll('#profilesTable tr[data-id]')) {
      const id = row.dataset.id;
      const container = containers.get(id);
      const profile = snap.state.profiles?.[id];
      const cells = row.querySelectorAll("td");
      if (container && cells[1]) cells[1].innerHTML = personaIdentity(container, profile);
      const actions = cells[cells.length - 1];
      if (actions) {
        const managed = Boolean(profile?.managed);
        actions.innerHTML = `<div class="row-actions"><button class="small edit-profile"${managed ? "" : " disabled"}>Edit</button><button class="small profile-cookies"${managed ? "" : " disabled"}>Cookies</button><button class="small test-profile"${managed ? "" : " disabled"}>Test</button><button class="small export-profile"${managed ? "" : " disabled"}>Export</button></div>`;
      }
    }
  } catch (error) {
    console.error("Unable to decorate persona rows", error);
  } finally {
    observe();
    decorating = false;
    if (queued) { queued = false; queueMicrotask(() => void decorateProfiles()); }
  }
}

function scheduleDecorate() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    void decorateProfiles();
  });
}

function download(filename, value) {
  const blob = new Blob([value], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportPersona(profileId) {
  const snap = await snapshot();
  const profile = snap.state.profiles?.[profileId];
  if (!profile?.managed) throw new Error("Managed persona not found");
  const payload = createPortableBackupPayload({
    state:snap.state,
    containers:snap.containers,
    selection:{kind:"selection",profileIds:[profileId]}
  });
  const encoded = await encodeBackupEnvelope({
    payload,
    appVersion:browser.runtime.getManifest().version,
    stateSchemaVersion:snap.state.schemaVersion,
    scope:{kind:"persona",components:["routes","personas","userscripts"]}
  });
  download(`${safeFilePart(profile.name)}.personamonkey-backup.json`, encoded);
  toast(`Exported ${profile.name} without cookies or route credentials`);
}

function removeEmbeddedCookieManager() {
  $("personaCookieManager")?.remove();
}

function init() {
  const table = $("profilesTable");
  if (!table) return;
  observer = new MutationObserver(() => scheduleDecorate());
  observe();
  scheduleDecorate();

  table.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (!row) return;
    const profileId = row.dataset.id;
    if (event.target.closest(".profile-cookies")) {
      document.dispatchEvent(new CustomEvent("personamonkey-open-cookies", {detail:{profileId}}));
      return;
    }
    if (event.target.closest(".export-profile")) {
      void exportPersona(profileId).catch((error) => toast(error.message || String(error), true));
      return;
    }
    if (event.target.closest(".edit-profile")) {
      // v0.6.1 mounted cookie controls inside the policy editor. Cookies now
      // have a dedicated workspace; remove that legacy injected panel if the
      // compatibility data controller attempts to create it.
      setTimeout(removeEmbeddedCookieManager, 0);
      setTimeout(removeEmbeddedCookieManager, 100);
    }
  });
}

init();
