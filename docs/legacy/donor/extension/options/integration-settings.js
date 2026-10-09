import { authorizeSecurityPreview } from "./security-review.js";
import { confirmAction } from "./confirm-dialog.js";

const byId = (id) => document.getElementById(id);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendReadMessageWithRetry(message, attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await browser.runtime.sendMessage(message); }
    catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(Math.min(1000, 100 * (2 ** attempt)));
    }
  }
  throw lastError || new Error("Extension background is unavailable");
}

function setStatus(message, error = false) {
  const node = byId("integrationPolicyStatus");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("error", error);
}

function render(policy = {}) {
  byId("integrationEnabled").checked = policy.enabled === true;
  byId("integrationTrustedIds").value = Array.isArray(policy.trustedExtensionIds)
    ? policy.trustedExtensionIds.join("\n")
    : "";
  byId("integrationAllowDestructive").checked = policy.allowDestructive === true;
  byId("integrationAllowDirect").checked = policy.allowDirect === true;
  byId("integrationAllowExternalAutomation").checked = policy.allowExternalAutomation === true;
  byId("integrationAllowExecutableInstall").checked = policy.allowExecutableInstall === true;
  setStatus("Policy loaded");
}

function leaseName(lease) {
  const name = typeof lease?.personaName === "string" ? lease.personaName.trim() : "";
  return name || "Persona";
}

function leaseStatusText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "active";
}

function leaseExpiryText(value) {
  if (typeof value !== "string" || !value) return "Expiry unavailable";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? `Expires ${new Date(timestamp).toLocaleString()}`
    : "Expiry unavailable";
}

function renderControlLeases(leases) {
  const list = byId("integrationControlLeaseList");
  if (!list) return;
  list.replaceChildren();
  if (!Array.isArray(leases) || leases.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No Personas are currently under external control.";
    list.append(empty);
    return;
  }

  for (const lease of leases) {
    if (!lease || typeof lease.personaUid !== "string" || !lease.personaUid) continue;
    // Keep sender and lease IDs out of the rendered UI. Carry the opaque lease ID
    // with the action so the confirmation remains bound to this exact lease.
    const row = document.createElement("div");
    row.className = "external-control-lease";
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = leaseName(lease);
    const description = document.createElement("p");
    description.className = "hint";
    const purpose = typeof lease.purpose === "string" && lease.purpose.trim()
      ? lease.purpose.trim()
      : "External automation control";
    description.textContent = `${purpose} · ${leaseStatusText(lease.status)} · ${leaseExpiryText(lease.expiresAt)}`;
    details.append(title, description);
    row.append(details);

    if (lease.status === "active") {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Override control";
      button.setAttribute("aria-label", `Override external control of ${leaseName(lease)}`);
      button.addEventListener("click", () => {
        void overrideControlLease(lease.personaUid, lease.leaseId, leaseName(lease), button);
      });
      row.append(button);
    }
    list.append(row);
  }
  if (!list.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No active external control leases.";
    list.append(empty);
  }
}

async function loadControlLeases() {
  const status = byId("integrationControlLeaseStatus");
  if (status) status.textContent = "Checking local control leases…";
  try {
    const result = await sendReadMessageWithRetry({ type: "GET_EXTERNAL_AUTOMATION_CONTROL_LEASES" });
    renderControlLeases(result?.leases || []);
    if (status) status.textContent = "Control status is local to this browser profile.";
  } catch {
    if (status) status.textContent = "Unable to load external control status.";
  }
}

async function overrideControlLease(personaUid, leaseId, personaLabel, button) {
  const approved = await confirmAction(
    `Release external automation control of ${personaLabel}? Active work for this Persona may be stopped.`,
    { title: "Override external control", confirmLabel: "Release control", danger: true }
  );
  if (!approved) return;
  button.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({
      type: "OVERRIDE_EXTERNAL_PERSONA_CONTROL", personaUid, leaseId
    });
    if (result?.overridden !== true) throw new Error("Control release was not confirmed");
    const status = byId("integrationControlLeaseStatus");
    if (status) status.textContent = `External control released for ${personaLabel}.`;
    await loadControlLeases();
    if (status) status.textContent = `External control released for ${personaLabel}.`;
  } catch {
    const status = byId("integrationControlLeaseStatus");
    if (status) status.textContent = `Unable to release external control for ${personaLabel}.`;
    button.disabled = false;
  }
}

async function loadPolicy() {
  try {
    const result = await sendReadMessageWithRetry({ type: "GET_INTEGRATION_POLICY" });
    render(result?.policy || {});
  } catch (error) {
    setStatus(error?.message || "Unable to load integration policy", true);
  }
}

async function savePolicy() {
  const button = byId("saveIntegrationPolicy");
  button.disabled = true;
  setStatus("Saving…");
  try {
    const trustedExtensionIds = byId("integrationTrustedIds").value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 16);
    const policy = {
      enabled: byId("integrationEnabled").checked,
      trustedExtensionIds,
      allowDestructive: byId("integrationAllowDestructive").checked,
      allowDirect: byId("integrationAllowDirect").checked,
      allowExternalAutomation: byId("integrationAllowExternalAutomation").checked,
      allowExecutableInstall: byId("integrationAllowExecutableInstall").checked
    };
    const preview = await browser.runtime.sendMessage({ type: "PREVIEW_INTEGRATION_POLICY", policy });
    const authorizationId = await authorizeSecurityPreview(preview, "Integration API policy");
    if (!authorizationId) {
      await loadPolicy();
      setStatus("Changes cancelled");
      return;
    }
    const result = await browser.runtime.sendMessage({
      type: "UPDATE_INTEGRATION_POLICY", policy, authorizationId
    });
    render(result?.policy || {});
    setStatus("Policy saved");
    await loadControlLeases();
  } catch (error) {
    setStatus(error?.message || "Unable to save integration policy", true);
  } finally {
    button.disabled = false;
  }
}

byId("saveIntegrationPolicy")?.addEventListener("click", () => { void savePolicy(); });
byId("refreshIntegrationControlLeases")?.addEventListener("click", () => { void loadControlLeases(); });
void loadPolicy();
void loadControlLeases();
