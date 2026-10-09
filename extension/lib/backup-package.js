import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "./constants.js";
import { filterOrdinaryAutomationJobs } from "./automation-history.js";
import { normalizeState } from "./storage.js";
import { normalizePersonaUid } from "./persona-identity.js";
import { sealBackupPayload, openBackupPayload } from "./backup-crypto.js";
import { assertExternalArtifactMetadataMatchesSource, externalArtifactIdentityKey, validateExternalArtifactIdentity } from "./external-artifact-integrity.js";

export const BACKUP_FORMAT = "personamonkey-backup";
export const BACKUP_FORMAT_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function externalArtifactOf(script = {}) {
  return script && Object.hasOwn(script, "externalArtifact") ? script.externalArtifact : undefined;
}

function validateExternalArtifactMetadata(script, label = "External userscript") {
  const artifact = externalArtifactOf(script);
  if (artifact === null) throw new Error(`${label} metadata is invalid`);
  if (artifact === undefined) return null;
  return validateExternalArtifactIdentity(script, label);
}

export async function validateExternalArtifactHashes(scripts = [], { entries = false } = {}) {
  const identities = new Map();
  for (const item of scripts || []) {
    const script = entries ? item?.script : item;
    const code = entries ? item?.code : script?.code;
    const artifact = validateExternalArtifactMetadata(script);
    if (!artifact) continue;
    if (typeof code !== "string") throw new Error(`External userscript ${artifact.artifactId} source is missing`);
    assertExternalArtifactMetadataMatchesSource(script, code);
    const ownerScopedId = `${artifact.ownerKey}\0${artifact.artifactId}`;
    const previous = identities.get(ownerScopedId);
    const identityKey = externalArtifactIdentityKey(artifact);
    if (previous && previous.identityKey !== identityKey) {
      throw new Error(`External artifact ID ${artifact.artifactId} has conflicting ownership or SHA-256 identity (including provenance)`);
    }
    identities.set(ownerScopedId, { identityKey });
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(code));
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== artifact.sha256.toLowerCase()) throw new Error(`External artifact ${artifact.artifactId} source SHA-256 does not match its recorded identity`);
  }
  return true;
}

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function text(value) {
  if (value instanceof Uint8Array) return decoder.decode(value);
  if (value instanceof ArrayBuffer) return decoder.decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return String(value ?? "");
}

function redactRoute(route, includeSecrets) {
  const out = clone(route);
  if (!includeSecrets) {
    out.username = "";
    out.password = "";
  }
  return out;
}

function sortedEntries(object, nameField = "name") {
  return Object.entries(object || {}).sort(([, a], [, b]) => String(a?.[nameField] || "").localeCompare(String(b?.[nameField] || "")));
}

function makeKeyMap(ids, prefix) {
  return new Map([...ids].sort().map((id, index) => [id, `${prefix}-${index + 1}`]));
}

export function backupIsSensitive(payload = {}) {
  if (Object.values(payload.cookies || {}).some((records) => Array.isArray(records) && records.length)) return true;
  if (Object.keys(payload.gmValues || {}).length) return true;
  return (payload.routes || []).some((entry) => entry?.route?.username || entry?.route?.password);
}

export function backupInventory(payload = {}) {
  return {
    settings: payload.settings ? 1 : 0,
    routes: (payload.routes || []).length,
    personas: (payload.personas || []).length,
    userscripts: (payload.scripts || []).length,
    workflows: (payload.workflows || []).length,
    cookies: Object.values(payload.cookies || {}).reduce((sum, records) => sum + (Array.isArray(records) ? records.length : 0), 0),
    gmValueSets: Object.keys(payload.gmValues || {}).length,
    automationJobs: (payload.automationHistory || []).length
  };
}

export function validateBackupPayload(payload = {}) {
  if (!payload || typeof payload !== "object") throw new Error("Backup payload is invalid");
  for (const key of ["routes", "personas", "scripts", "workflows"]) {
    if (payload[key] != null && !Array.isArray(payload[key])) throw new Error(`Backup ${key} must be an array`);
  }
  if (payload.cookies != null && typeof payload.cookies !== "object") throw new Error("Backup cookies must be an object");
  if (payload.gmValues != null && typeof payload.gmValues !== "object") throw new Error("Backup GM values must be an object");

  const personaKeys = new Set((payload.personas || []).map((entry) => entry.key));
  const routeKeys = new Set((payload.routes || []).map((entry) => entry.key));
  const scriptKeys = new Set((payload.scripts || []).map((entry) => entry.key));
  const workflowKeys = new Set((payload.workflows || []).map((entry) => entry.key));
  if (personaKeys.size !== (payload.personas || []).length || routeKeys.size !== (payload.routes || []).length || scriptKeys.size !== (payload.scripts || []).length || workflowKeys.size !== (payload.workflows || []).length) {
    throw new Error("Backup contains duplicate portable keys");
  }
  for (const [kind, entries] of [["route", payload.routes], ["persona", payload.personas], ["userscript", payload.scripts], ["workflow", payload.workflows]]) {
    for (const entry of entries || []) {
      if (entry?.sourceId == null) continue;
      const sourceId = entry.sourceId;
      if (typeof sourceId !== "string" || !sourceId || sourceId.length > 512 || /[\u0000-\u001f\u007f]/.test(sourceId) || ["__proto__", "constructor", "prototype"].includes(sourceId)) {
        throw new Error(`Backup ${kind} sourceId is invalid`);
      }
    }
  }
  for (const persona of payload.personas || []) {
    if (!persona.key || !persona.profile) throw new Error("Backup persona entry is incomplete");
    if (Object.hasOwn(persona.profile, "personaUid") && persona.profile.personaUid != null &&
        !normalizePersonaUid(persona.profile.personaUid)) {
      throw new Error(`Backup persona ${persona.key} has an invalid personaUid`);
    }
    if (persona.profile.routeKey && !routeKeys.has(persona.profile.routeKey)) throw new Error(`Persona ${persona.key} references a missing route`);
    for (const key of persona.profile.scriptKeys || []) if (!scriptKeys.has(key)) throw new Error(`Persona ${persona.key} references a missing userscript`);
  }
  for (const workflow of payload.workflows || []) {
    for (const step of workflow.workflow?.steps || []) {
      if (step.personaKey && !personaKeys.has(step.personaKey)) throw new Error(`Workflow ${workflow.key} references a missing persona`);
      for (const key of step.scriptKeys || []) if (!scriptKeys.has(key)) throw new Error(`Workflow ${workflow.key} references a missing userscript`);
    }
  }
  const artifactIds = new Map();
  for (const entry of payload.scripts || []) {
    const artifact = validateExternalArtifactMetadata(entry?.script, `External userscript ${entry?.key || ""}`);
    if (!artifact) continue;
    const ownerScopedId = `${artifact.ownerKey}\0${artifact.artifactId}`;
    const previous = artifactIds.get(ownerScopedId);
    if (previous && previous.sha256 !== artifact.sha256.toLowerCase()) {
      throw new Error(`External artifact ID ${artifact.artifactId} has conflicting ownership or SHA-256 identities`);
    }
    artifactIds.set(ownerScopedId, { sha256: artifact.sha256.toLowerCase() });
  }
  for (const key of Object.keys(payload.cookies || {})) if (!personaKeys.has(key)) throw new Error(`Cookie data references a missing persona: ${key}`);
  for (const key of Object.keys(payload.gmValues || {})) if (!scriptKeys.has(key)) throw new Error(`GM data references a missing userscript: ${key}`);
  return payload;
}

export function createPortableBackupPayload({
  state: stateInput,
  containers = [],
  cookiesByProfile = {},
  userscriptData = {},
  automationHistory = [],
  selection = {}
} = {}) {
  const state = normalizeState(stateInput);
  const kind = selection.kind === "selection" ? "selection" : "full";
  const includeSettings = kind === "full" || selection.settings === true;
  const includeCookies = kind === "full" || selection.cookies === true;
  const includeGmValues = kind === "full" || selection.gmValues === true;
  const includeHistory = kind === "full" || selection.automationHistory === true;
  const includeRouteSecrets = kind === "full" || selection.routeSecrets === true;

  const profileIds = new Set(kind === "full"
    ? Object.values(state.profiles).filter((profile) => profile.managed).map((profile) => profile.containerId)
    : selection.profileIds || []);
  const scriptIds = new Set(kind === "full" ? Object.keys(state.scripts) : selection.scriptIds || []);
  const workflowIds = new Set(kind === "full" ? Object.keys(state.workflows) : selection.workflowIds || []);
  const routeIds = new Set(kind === "full" ? Object.keys(state.routes) : []);

  for (const workflowId of workflowIds) {
    const workflow = state.workflows[workflowId];
    if (!workflow) continue;
    for (const step of workflow.steps || []) {
      if (step.profileId) profileIds.add(step.profileId);
      for (const scriptId of step.scriptIds || []) scriptIds.add(scriptId);
    }
  }
  for (const profileId of profileIds) {
    const profile = state.profiles[profileId];
    if (!profile) continue;
    if (profile.routeId && ![BLOCK_ROUTE_ID, DIRECT_ROUTE_ID].includes(profile.routeId)) routeIds.add(profile.routeId);
    for (const scriptId of profile.scriptIds || []) scriptIds.add(scriptId);
  }

  const personaKeys = makeKeyMap([...profileIds].filter((id) => state.profiles[id]), "persona");
  const routeKeys = makeKeyMap([...routeIds].filter((id) => state.routes[id]), "route");
  const scriptKeys = makeKeyMap([...scriptIds].filter((id) => state.scripts[id]), "script");
  const workflowKeys = makeKeyMap([...workflowIds].filter((id) => state.workflows[id]), "workflow");
  const containerById = new Map((containers || []).filter((entry) => entry?.cookieStoreId).map((entry) => [entry.cookieStoreId, entry]));

  const routes = [...routeKeys].map(([sourceId, key]) => ({ key, sourceId, route: redactRoute(state.routes[sourceId], includeRouteSecrets) }));
  const scripts = [...scriptKeys].map(([sourceId, key]) => {
    const script = clone(state.scripts[sourceId]);
    const code = script.code || "";
    delete script.id;
    delete script.code;
    script.profileKeys = (script.profileIds || []).map((id) => personaKeys.get(id)).filter(Boolean);
    delete script.profileIds;
    return { key, sourceId, script, code };
  });
  const personas = [...personaKeys].map(([sourceId, key]) => {
    const profile = clone(state.profiles[sourceId]);
    const container = containerById.get(sourceId) || {};
    delete profile.containerId;
    profile.routeKey = routeKeys.get(profile.routeId) || null;
    profile.routeMode = profile.routeId === DIRECT_ROUTE_ID ? "direct" : profile.routeId === BLOCK_ROUTE_ID ? "block" : "route";
    delete profile.routeId;
    profile.scriptKeys = (profile.scriptIds || []).map((id) => scriptKeys.get(id)).filter(Boolean);
    delete profile.scriptIds;
    return {
      key,
      sourceId,
      name: profile.name || container.name || sourceId,
      color: container.color || null,
      icon: container.icon || null,
      profile
    };
  });
  const workflows = [...workflowKeys].map(([sourceId, key]) => {
    const workflow = clone(state.workflows[sourceId]);
    delete workflow.id;
    workflow.steps = (workflow.steps || []).map((step) => {
      const portable = clone(step);
      portable.personaKey = personaKeys.get(portable.profileId) || null;
      portable.scriptKeys = (portable.scriptIds || []).map((id) => scriptKeys.get(id)).filter(Boolean);
      delete portable.profileId;
      delete portable.scriptIds;
      return portable;
    });
    return { key, sourceId, workflow };
  });

  const cookies = {};
  if (includeCookies) {
    for (const [sourceId, key] of personaKeys) {
      if (Array.isArray(cookiesByProfile[sourceId])) cookies[key] = clone(cookiesByProfile[sourceId]);
    }
  }
  const gmValues = {};
  if (includeGmValues) {
    for (const [sourceId, key] of scriptKeys) {
      const value = userscriptData[`gm-values:${sourceId}`];
      if (value && typeof value === "object") gmValues[key] = clone(value);
    }
  }

  const portableSettings = includeSettings ? clone(state.global) : null;
  if (portableSettings) delete portableSettings.integration;

  return validateBackupPayload({
    version: 1,
    settings: portableSettings,
    routes,
    personas,
    scripts,
    workflows,
    cookies,
    gmValues,
    automationHistory: includeHistory ? clone(filterOrdinaryAutomationJobs(automationHistory)) : []
  });
}

export async function encodeBackupEnvelope({
  payload,
  appVersion = "",
  stateSchemaVersion = null,
  scope = "selection",
  password = "",
  allowSensitivePlaintext = false,
  iterations = 250000
} = {}) {
  validateBackupPayload(payload);
  await validateExternalArtifactHashes(payload.scripts || [], { entries: true });
  const sensitive = backupIsSensitive(payload);
  if (sensitive && !password && !allowSensitivePlaintext) throw new Error("This backup contains sensitive data and requires a password");
  const envelope = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: String(appVersion || ""),
    stateSchemaVersion,
    scope,
    sensitive,
    inventory: backupInventory(payload),
    encryption: null
  };
  const payloadText = JSON.stringify(payload);
  if (password) {
    const sealed = await sealBackupPayload(encoder.encode(payloadText), password, { iterations });
    envelope.encryption = sealed.encryption;
    envelope.sealedPayload = sealed.data;
  } else {
    envelope.payload = payload;
  }
  return JSON.stringify(envelope, null, 2);
}

export async function decodeBackupEnvelope(input, password = "") {
  let envelope;
  try { envelope = JSON.parse(text(input)); }
  catch { throw new Error("Backup file is not valid JSON"); }
  if (!envelope || envelope.format !== BACKUP_FORMAT || envelope.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error("Unsupported PersonaMonkey backup format");
  }
  let payload = envelope.payload;
  if (envelope.encryption) {
    if (!envelope.sealedPayload) throw new Error("Encrypted backup payload is missing");
    const opened = await openBackupPayload(envelope.sealedPayload, envelope.encryption, password);
    try { payload = JSON.parse(decoder.decode(opened)); }
    catch { throw new Error("Decrypted backup payload is invalid"); }
  }
  validateBackupPayload(payload);
  await validateExternalArtifactHashes(payload.scripts || [], { entries: true });
  return { envelope, payload };
}

export function suggestPersonaBindings(payload, containers = []) {
  const byId = new Map((containers || []).filter((item) => item?.cookieStoreId).map((item) => [item.cookieStoreId, item]));
  return (payload.personas || []).map((persona) => {
    if (persona.sourceId && byId.has(persona.sourceId)) {
      const match = byId.get(persona.sourceId);
      return { key: persona.key, suggestedId: match.cookieStoreId, reason: "same container id" };
    }
    const nameMatches = (containers || []).filter((item) => item?.cookieStoreId && item.name === persona.name);
    if (nameMatches.length === 1) return { key: persona.key, suggestedId: nameMatches[0].cookieStoreId, reason: "unique name match" };
    return { key: persona.key, suggestedId: "", reason: "create new" };
  });
}
