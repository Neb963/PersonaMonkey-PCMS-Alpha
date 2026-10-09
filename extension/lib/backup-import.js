import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "./constants.js";
import { normalizeState, normalizeProfile, normalizeRoute, normalizeScript, normalizeWorkflow } from "./storage.js";
import { allocatePersonaUid, createPersonaUid, normalizePersonaUid } from "./persona-identity.js";
import { validateExternalArtifactHashes } from "./backup-package.js";
import { externalArtifactIdentityKey } from "./external-artifact-integrity.js";

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function uniqueId(prefix, object) {
  let id;
  do { id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`; } while (object[id]);
  return id;
}

function cleanRoute(route) {
  const copy = clone(route || {});
  delete copy.id;
  delete copy.createdAt;
  return copy;
}

function sameRoute(a, b) {
  return JSON.stringify(cleanRoute(a)) === JSON.stringify(cleanRoute(b));
}

function cleanWorkflow(workflow) {
  const copy = clone(workflow || {});
  delete copy.id;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy;
}

function sameWorkflow(a, b) {
  return JSON.stringify(cleanWorkflow(a)) === JSON.stringify(cleanWorkflow(b));
}

export function backupComponents(payload = {}) {
  const out = new Set();
  if (payload.settings) out.add("settings");
  if ((payload.routes || []).length) out.add("routes");
  if ((payload.personas || []).length) out.add("personas");
  if ((payload.scripts || []).length) out.add("userscripts");
  if ((payload.workflows || []).length) out.add("workflows");
  if (Object.values(payload.cookies || {}).some((records) => Array.isArray(records))) out.add("cookies");
  if (Object.keys(payload.gmValues || {}).length) out.add("gm-values");
  if ((payload.automationHistory || []).length) out.add("automation-history");
  return out;
}

export async function buildImportedState({ payload, currentState, profileBindings, mode = "merge", generatePersonaUid = createPersonaUid } = {}) {
  await validateExternalArtifactHashes(payload?.scripts || [], { entries: true });
  const components = backupComponents(payload);
  const replace = mode === "replace";
  const state = normalizeState(clone(currentState), { generatePersonaUid });
  await validateExternalArtifactHashes(Object.values(state.scripts || {}));
  const profileMap = profileBindings instanceof Map ? profileBindings : new Map(Object.entries(profileBindings || {}));

  for (const persona of payload.personas || []) {
    if (!profileMap.get(persona.key)) throw new Error(`Persona mapping is missing for ${persona.name || persona.key}`);
  }

  if (replace && components.has("routes")) state.routes = {};
  if (replace && components.has("userscripts")) state.scripts = {};
  if (replace && components.has("workflows")) state.workflows = {};
  if (replace && components.has("personas")) {
    for (const profile of Object.values(state.profiles)) {
      profile.personaUid = null;
      profile.managed = false;
      profile.routeId = BLOCK_ROUTE_ID;
      profile.scriptIds = [];
    }
  }

  const routeMap = new Map();
  for (const entry of payload.routes || []) {
    const body = clone(entry.route || {});
    delete body.id;
    let id = "";
    if (entry.sourceId && state.routes[entry.sourceId] && sameRoute(state.routes[entry.sourceId], body)) id = entry.sourceId;
    if (!id && entry.sourceId && !state.routes[entry.sourceId]) id = entry.sourceId;
    if (!id) {
      const same = Object.values(state.routes).find((route) => sameRoute(route, body));
      if (same) id = same.id;
    }
    if (!id) id = uniqueId("route-import", state.routes);
    state.routes[id] = normalizeRoute({ ...body, id }, id);
    routeMap.set(entry.key, id);
  }

  const scriptMap = new Map();
  for (const entry of payload.scripts || []) {
    const body = clone(entry.script || {});
    const incomingArtifact = body.externalArtifact || null;
    const incomingIdentityKey = incomingArtifact ? externalArtifactIdentityKey(incomingArtifact) : null;
    const profileIds = (body.profileKeys || []).map((key) => profileMap.get(key)).filter(Boolean);
    delete body.profileKeys;
    let id = "";
    if (incomingArtifact) {
      const conflictingArtifact = Object.values(state.scripts).find((script) =>
        script.externalArtifact?.artifactId === incomingArtifact.artifactId &&
        script.externalArtifact?.ownerKey === incomingArtifact.ownerKey &&
        externalArtifactIdentityKey(script.externalArtifact) !== incomingIdentityKey
      );
      if (conflictingArtifact) throw new Error(`External artifact ID ${incomingArtifact.artifactId} has conflicting ownership or SHA-256 identity (including provenance)`);
      const sameArtifact = Object.values(state.scripts).find((script) =>
        script.externalArtifact?.artifactId === incomingArtifact.artifactId &&
        script.externalArtifact?.ownerKey === incomingArtifact.ownerKey &&
        externalArtifactIdentityKey(script.externalArtifact) === incomingIdentityKey
      );
      if (sameArtifact) id = sameArtifact.id;
      if (!id && entry.sourceId && !state.scripts[entry.sourceId]) id = entry.sourceId;
    } else if (entry.sourceId && state.scripts[entry.sourceId]?.code === String(entry.code || "") && !state.scripts[entry.sourceId]?.externalArtifact) id = entry.sourceId;
    if (!id && entry.sourceId && !state.scripts[entry.sourceId]) id = entry.sourceId;
    if (!id && !incomingArtifact) {
      const same = Object.values(state.scripts).find((script) => !script.externalArtifact && script.code === String(entry.code || "") && script.name === body.name);
      if (same) id = same.id;
    }
    if (!id) id = uniqueId("script-import", state.scripts);
    const prior = state.scripts[id];
    if (incomingArtifact && prior?.externalArtifact &&
        (prior.externalArtifact.artifactId !== incomingArtifact.artifactId ||
         externalArtifactIdentityKey(prior.externalArtifact) !== externalArtifactIdentityKey(incomingArtifact))) {
      throw new Error(`External artifact ownership, provenance, or identity conflict at script ${id}`);
    }
    const verifiedPrior = incomingArtifact && prior?.externalArtifact
      && prior.externalArtifact.ownerKey === incomingArtifact.ownerKey
      && externalArtifactIdentityKey(prior.externalArtifact) === incomingIdentityKey
      && prior.externalArtifact.ownershipVerified !== false;
    const importedBody = incomingArtifact
      ? { ...body, externalArtifact: { ...incomingArtifact, ownershipVerified: verifiedPrior === true } }
      : body;
    state.scripts[id] = normalizeScript({
      ...importedBody, id, code: String(entry.code || ""), profileIds, updatedAt: new Date().toISOString()
    }, id);
    scriptMap.set(entry.key, id);
  }

  const usedPersonaUids = new Map();
  for (const [profileId, profile] of Object.entries(state.profiles || {})) {
    const personaUid = normalizePersonaUid(profile?.personaUid);
    if (personaUid) usedPersonaUids.set(personaUid, profileId);
  }
  const personaUidMap = new Map();
  const personaUidRemaps = [];

  if (components.has("personas")) {
    for (const entry of payload.personas || []) {
      const profileId = profileMap.get(entry.key);
      const body = clone(entry.profile || {});
      const previousUid = normalizePersonaUid(state.profiles?.[profileId]?.personaUid);
      if (previousUid && usedPersonaUids.get(previousUid) === profileId) usedPersonaUids.delete(previousUid);
      const suppliedUid = normalizePersonaUid(body.personaUid);
      const explicitUidWasInvalid = body.personaUid != null && !suppliedUid;
      const collisionOwner = suppliedUid ? usedPersonaUids.get(suppliedUid) : null;
      let personaUid = suppliedUid;
      if (!personaUid || collisionOwner) {
        personaUid = allocatePersonaUid(new Set(usedPersonaUids.keys()), { generatePersonaUid });
        if (collisionOwner || explicitUidWasInvalid) {
          personaUidRemaps.push({
            personaKey: entry.key,
            sourcePersonaUid: suppliedUid,
            personaUid,
            reason: collisionOwner ? "collision" : "invalid"
          });
        }
      }
      usedPersonaUids.set(personaUid, profileId);
      personaUidMap.set(entry.key, personaUid);
      const routeId = body.routeMode === "direct"
        ? DIRECT_ROUTE_ID
        : body.routeMode === "block"
          ? BLOCK_ROUTE_ID
          : (routeMap.get(body.routeKey) || BLOCK_ROUTE_ID);
      const scriptIds = (body.scriptKeys || []).map((key) => scriptMap.get(key)).filter(Boolean);
      delete body.routeMode;
      delete body.routeKey;
      delete body.scriptKeys;
      state.profiles[profileId] = normalizeProfile({
        ...body,
        personaUid,
        name: entry.name || body.name || profileId,
        managed: true,
        routeId,
        scriptIds
      }, profileId);
    }
  }

  const workflowMap = new Map();
  for (const entry of payload.workflows || []) {
    const workflow = clone(entry.workflow || {});
    workflow.steps = (workflow.steps || []).map((step) => {
      const copy = clone(step);
      copy.profileId = profileMap.get(copy.personaKey) || "";
      copy.scriptIds = (copy.scriptKeys || []).map((key) => scriptMap.get(key)).filter(Boolean);
      delete copy.personaKey;
      delete copy.scriptKeys;
      return copy;
    });
    const candidate = normalizeWorkflow({ ...workflow, id: entry.sourceId || entry.key || "workflow-import" }, entry.sourceId || entry.key || "workflow-import");
    let id = "";
    if (entry.sourceId && state.workflows[entry.sourceId] && sameWorkflow(state.workflows[entry.sourceId], candidate)) id = entry.sourceId;
    if (!id && entry.sourceId && !state.workflows[entry.sourceId]) id = entry.sourceId;
    if (!id) {
      const same = Object.values(state.workflows).find((existing) => sameWorkflow(existing, candidate));
      if (same) id = same.id;
    }
    if (!id) id = uniqueId("workflow-import", state.workflows);
    state.workflows[id] = normalizeWorkflow({ ...workflow, id }, id);
    workflowMap.set(entry.sourceId || entry.key, id);
  }

  if (components.has("settings") && payload.settings) {
    const integrationPolicy = clone(state.global.integration);
    const importedSettings = clone(payload.settings);
    // Integration trust is local authority, not portable configuration. Keep
    // the current policy while leaving other sensitive settings in the
    // proposed state for the caller's security-delta review.
    delete importedSettings.integration;
    state.global = replace ? importedSettings : { ...state.global, ...importedSettings };
    state.global.integration = integrationPolicy;
  }

  return {
    state: normalizeState(state, { generatePersonaUid }),
    components,
    maps: { profile: profileMap, personaUid: personaUidMap, route: routeMap, script: scriptMap, workflow: workflowMap },
    diagnostics: { personaUidRemaps }
  };
}

export function remapAutomationHistory(history = [], maps = {}) {
  const profileSource = maps.profileSource instanceof Map ? maps.profileSource : new Map(Object.entries(maps.profileSource || {}));
  const workflow = maps.workflow instanceof Map ? maps.workflow : new Map(Object.entries(maps.workflow || {}));
  return (Array.isArray(history) ? history : []).map((raw) => {
    const job = clone(raw);
    if (["queued", "preparing", "running", "stopping"].includes(job.state)) {
      job.state = "interrupted";
      job.finishedAt = new Date().toISOString();
      job.error = "Imported historical job was active in the source backup";
    }
    if (workflow.has(job.workflowId)) job.workflowId = workflow.get(job.workflowId);
    for (const task of job.tasks || []) if (profileSource.has(task.profileId)) task.profileId = profileSource.get(task.profileId);
    for (const step of job.stepProgress || []) if (profileSource.has(step.profileId)) step.profileId = profileSource.get(step.profileId);
    return job;
  });
}
