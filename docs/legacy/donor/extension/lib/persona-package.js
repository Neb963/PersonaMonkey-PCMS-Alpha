import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "./constants.js";
import { PERSONA_PACKAGE_LIMITS } from "./package-limits.js";
import { createStoredZip, decodeZipText, readZip } from "./zip.js";
import { normalizeProfile, normalizeScript, normalizeWorkflow } from "./storage.js";

export const PERSONA_PACKAGE_FORMAT = "persona.personamonkey";
export const PERSONA_PACKAGE_VERSION = 2;
export const MAX_PERSONA_PACKAGE_BYTES = PERSONA_PACKAGE_LIMITS.maxCompressedBytes;
const encoder = new TextEncoder();

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function json(value) { return JSON.stringify(value, null, 2); }
function safePathPart(value, fallback = "item") {
  return String(value || fallback).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 100) || fallback;
}

function portableRoute(profile, routes = {}) {
  if (profile.routeId === DIRECT_ROUTE_ID) return { mode: "direct" };
  if (profile.routeId === BLOCK_ROUTE_ID) return { mode: "block" };
  const source = routes[profile.routeId];
  if (!source) return { mode: "block", warning: "Assigned route was unavailable during export" };
  return {
    mode: "route",
    route: {
      name: String(source.name || ""),
      provider: String(source.provider || "generic"),
      type: String(source.type || "socks"),
      host: String(source.host || ""),
      port: Number(source.port) || 0,
      proxyDNS: source.proxyDNS !== false,
      country: String(source.country || ""),
      city: String(source.city || ""),
      server: String(source.server || "")
    }
  };
}

export function createPersonaPackage({ profileId, state, container = {}, cookies = [], appVersion = "", include = {} } = {}) {
  const profile = state?.profiles?.[profileId];
  if (!profile?.managed) throw new Error("Managed persona not found");
  const includeCookies = include.cookies === true;
  const includeUserscripts = include.userscripts !== false;
  const includeWorkflows = include.workflows !== false;
  const selectedScripts = includeUserscripts ? Object.values(state.scripts || {}).filter((script) =>
    profile.scriptIds?.includes(script.id) || script.profileIds?.includes(profileId)) : [];
  const scriptIds = new Set(selectedScripts.map((script) => script.id));
  const selectedWorkflows = includeWorkflows ? Object.values(state.workflows || {}).filter((workflow) =>
    workflow.steps?.some((step) => step.profileId === profileId)) : [];
  for (const workflow of selectedWorkflows) {
    for (const step of workflow.steps || []) for (const id of step.scriptIds || []) scriptIds.add(id);
  }
  for (const id of scriptIds) if (!selectedScripts.some((script) => script.id === id) && state.scripts?.[id]) selectedScripts.push(state.scripts[id]);

  const settings = clone(profile);
  delete settings.containerId;
  const route = portableRoute(profile, state.routes || {});
  delete settings.routeId;
  delete settings.containerId;
  delete settings.lastUsedAt;
  delete settings.createdAt;
  delete settings.updatedAt;
  delete settings.statistics;
  // Portable Persona packages create a new logical Persona on import.
  delete settings.personaUid;
  settings.scriptIds = selectedScripts.map((script) => script.id);

  const identity = {
    name: container.name || profile.name,
    color: container.color || "blue",
    icon: container.icon || "fingerprint",
    description: profile.description || ""
  };

  const manifest = {
    format: PERSONA_PACKAGE_FORMAT,
    formatVersion: PERSONA_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: String(appVersion || ""),
    persona: clone(identity),
    includes: { identity: true, settings: true, route: true, cookies: includeCookies, storage: false, userscripts: includeUserscripts, workflows: includeWorkflows, history: false, openTabs: false },
    warnings: [
      ...(!includeCookies ? ["Cookies excluded"] : ["Package contains sensitive cookie data"]),
      "Site storage excluded",
      "Route credentials excluded"
    ]
  };
  const scriptIndex = selectedScripts.map((source) => {
    const script = clone(source);
    const code = script.code || "";
    delete script.code;
    delete script.profileIds;
    const path = `persona/userscripts/${safePathPart(script.id)}.user.js`;
    return { metadata: script, path, code };
  });
  const workflows = selectedWorkflows.map((source) => {
    const workflow = clone(source);
    workflow.steps = (workflow.steps || []).map((step) => ({ ...step, profileId: step.profileId === profileId ? "$persona" : step.profileId }));
    return workflow;
  });
  const entries = [
    { name: "manifest.json", data: json(manifest) },
    { name: "persona/identity.json", data: json(identity) },
    { name: "persona/settings.json", data: json(settings) },
    { name: "persona/route.json", data: json(route) },
    ...(includeCookies ? [{ name: "persona/cookies.json", data: json(cookies) }] : []),
    { name: "persona/userscripts/index.json", data: json(scriptIndex.map(({ metadata, path }) => ({ metadata, path }))) },
    { name: "persona/workflows/index.json", data: json(workflows) },
    { name: "persona/metadata.json", data: json({ lastUsedAt: profile.lastUsedAt || null, createdAt: profile.createdAt || null, notes: profile.notes || "" }) },
    ...scriptIndex.map(({ path, code }) => ({ name: path, data: code }))
  ];
  return createStoredZip(entries, PERSONA_PACKAGE_LIMITS);
}

function parseJson(files, path, fallback = null) {
  if (!files.has(path)) {
    if (fallback !== null) return clone(fallback);
    throw new Error(`Persona package is missing ${path}`);
  }
  try { return JSON.parse(decodeZipText(files.get(path))); }
  catch { throw new Error(`Persona package contains invalid JSON in ${path}`); }
}

export async function inspectPersonaPackage(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > MAX_PERSONA_PACKAGE_BYTES) throw new Error("Persona package is too large");
  const files = await readZip(bytes, PERSONA_PACKAGE_LIMITS);
  const manifest = parseJson(files, "manifest.json");
  if (manifest?.format !== PERSONA_PACKAGE_FORMAT || ![1, PERSONA_PACKAGE_VERSION].includes(manifest?.formatVersion)) throw new Error("Unsupported PersonaMonkey persona package");
  const legacy = manifest.formatVersion === 1;
  const legacySettings = parseJson(files, "persona/settings.json");
  const settings = normalizeProfile(parseJson(files, "persona/settings.json"), "");
  const cookies = parseJson(files, "persona/cookies.json", []);
  const scriptIndex = parseJson(files, "persona/userscripts/index.json", []);
  const workflows = parseJson(files, "persona/workflows/index.json", []);
  const metadata = parseJson(files, "persona/metadata.json", {});
  if (!Array.isArray(cookies) || !Array.isArray(scriptIndex) || !Array.isArray(workflows)) throw new Error("Persona package collections are invalid");
  const scripts = scriptIndex.map((entry, index) => {
    if (!entry?.path || !files.has(entry.path)) throw new Error(`Persona userscript ${index + 1} is missing`);
    if (!entry.path.startsWith("persona/userscripts/") || !entry.path.endsWith(".user.js")) throw new Error("Persona userscript path is invalid");
    return normalizeScript({ ...(entry.metadata || {}), code: decodeZipText(files.get(entry.path)), profileIds: [] }, entry.metadata?.id || `script-${index + 1}`);
  });
  return {
    manifest: clone(manifest),
    identity: legacy ? clone(manifest.persona || {}) : parseJson(files, "persona/identity.json"),
    settings,
    route: legacy ? (legacySettings.route || { mode: "block" }) : parseJson(files, "persona/route.json"),
    cookies: clone(cookies),
    scripts,
    workflows: workflows.map((workflow, index) => normalizeWorkflow(workflow, workflow.id || `workflow-${index + 1}`)),
    metadata: clone(metadata),
    warnings: Array.isArray(manifest.warnings) ? clone(manifest.warnings) : [
      ...(manifest.includes?.cookies ? ["Package contains sensitive cookie data"] : ["Cookies excluded"]),
      "Site storage excluded",
      "Route credentials excluded"
    ],
    inventory: { cookies: cookies.length, storage: false, userscripts: scripts.length, workflows: workflows.length, bytes: bytes.byteLength }
  };
}
