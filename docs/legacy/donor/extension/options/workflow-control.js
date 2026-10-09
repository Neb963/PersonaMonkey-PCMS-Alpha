import { confirmAction } from "./confirm-dialog.js";

/**
 * Returns a run confirmation bound to the workflow targets and exact active
 * control leases seen by the local user, or null when the user cancels.
 */
export async function confirmWorkflowControlOverride(workflow, state) {
  const profileIds = new Set((workflow?.steps || []).map((step) => step.profileId).filter(Boolean));
  const personas = Object.values(state?.profiles || {}).filter((profile) =>
    profile?.managed && !profile.rotationRole && profile.personaUid && profileIds.has(profile.containerId));
  const expectedPersonaUids = [...new Set(personas.map((profile) => String(profile.personaUid).toLowerCase()))].sort();

  let leases;
  try {
    const result = await browser.runtime.sendMessage({ type: "GET_EXTERNAL_AUTOMATION_CONTROL_LEASES" });
    leases = Array.isArray(result?.leases) ? result.leases : [];
  } catch {
    throw new Error("Unable to check external Persona control. Refresh the Integration settings and try again.");
  }

  const byUid = new Map(personas.map((profile) => [String(profile.personaUid).toLowerCase(), profile]));
  const controlled = leases.filter((lease) => lease?.status === "active"
    && byUid.has(String(lease.personaUid || "").toLowerCase()));
  if (controlled.some((lease) => typeof lease.leaseId !== "string" || !lease.leaseId)) {
    throw new Error("Unable to verify the active Persona control lease. Refresh the Integration settings and try again.");
  }
  const confirmedLeases = controlled.map((lease) => ({
    personaUid: String(lease.personaUid).toLowerCase(),
    leaseId: lease.leaseId
  })).sort((a, b) => a.personaUid.localeCompare(b.personaUid) || a.leaseId.localeCompare(b.leaseId));
  if (!controlled.length) return { expectedPersonaUids, leases: [], takeControl: false };
  const names = controlled.map((lease) => byUid.get(String(lease.personaUid).toLowerCase())?.name || "Persona");
  const approved = await confirmAction(
    `Running this workflow will stop external automation and take control of ${[...new Set(names)].join(", ")}.`,
    { title: "Take local control?", confirmLabel: "Stop external work and run", danger: true }
  );
  return approved ? { expectedPersonaUids, leases: confirmedLeases, takeControl: true } : null;
}
