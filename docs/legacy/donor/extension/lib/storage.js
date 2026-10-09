import { DEFAULT_SETTINGS, MAX_WORKFLOW_STEP_TIMEOUT_MS, SCHEMA_VERSION } from "./constants.js";
import { createPersonaUid, normalizePersonaUid, repairPersonaUids } from "./persona-identity.js";
import { normalizeIntegrationPolicy } from "./management-integration-protocol.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function makeDefaultState() {
  return clone(DEFAULT_SETTINGS);
}

export function normalizeState(input, { generatePersonaUid = createPersonaUid } = {}) {
  const base = makeDefaultState();
  if (!input || typeof input !== "object") return base;

  const out = {
    schemaVersion: SCHEMA_VERSION,
    global: { ...base.global, ...(input.global || {}) },
    profiles: typeof input.profiles === "object" && input.profiles ? input.profiles : {},
    routes: typeof input.routes === "object" && input.routes ? input.routes : {},
    scripts: typeof input.scripts === "object" && input.scripts ? input.scripts : {},
    workflows: typeof input.workflows === "object" && input.workflows ? input.workflows : {},
    personaRotations: normalizePersonaRotations(input.personaRotations),
    wireguardImports: Array.isArray(input.wireguardImports) ? input.wireguardImports : []
  };

  out.global.profileTargetCount = clampInt(out.global.profileTargetCount, 1, 200, 30);
  out.global.profileNamePrefix = String(out.global.profileNamePrefix || "Persona").slice(0, 64);
  out.global.unmanagedPolicy = ["direct", "block"].includes(out.global.unmanagedPolicy)
    ? out.global.unmanagedPolicy
    : "direct";
  out.global.webRTCMode = ["proxy_only", "disabled", "unchanged"].includes(out.global.webRTCMode)
    ? out.global.webRTCMode
    : "proxy_only";
  // External integration authority is persisted but always normalized back to
  // the bounded local policy shape. Unknown fields cannot become authority.
  out.global.integration = normalizeIntegrationPolicy(input.global?.integration || out.global.integration);

  out.global.mullvadNative = {
    ...base.global.mullvadNative,
    ...(input.global?.mullvadNative || out.global.mullvadNative || {})
  };
  out.global.mullvadNative.enabled = out.global.mullvadNative.enabled !== false;
  out.global.mullvadNative.autoStart = out.global.mullvadNative.autoStart !== false;
  out.global.mullvadNative.requireReady = out.global.mullvadNative.requireReady !== false;
  out.global.mullvadNative.autoStopMinutes = clampInt(out.global.mullvadNative.autoStopMinutes, 0, 1440, 15);

  out.global.userscripts = {
    ...base.global.userscripts,
    ...(input.global?.userscripts || {})
  };
  out.global.userscripts.dependencyFetch = ["direct", "disabled"].includes(out.global.userscripts.dependencyFetch)
    ? out.global.userscripts.dependencyFetch
    : "direct";
  // v1.0 normalized this preference to true by default, so old saved true
  // values do not prove the user deliberately enabled broad assignment.
  out.global.userscripts.autoAssignImportedToAllProfiles =
    out.global.userscripts.autoAssignImportedToAllProfiles === true &&
    out.global.userscripts.autoAssignImportedToAllProfilesConfirmed === true;
  out.global.userscripts.autoAssignImportedToAllProfilesConfirmed =
    out.global.userscripts.autoAssignImportedToAllProfilesConfirmed === true;
  out.global.userscripts.defaultInjectInto = ["auto", "page", "content"].includes(out.global.userscripts.defaultInjectInto)
    ? out.global.userscripts.defaultInjectInto
    : "auto";

  out.global.automation = {
    ...base.global.automation,
    ...(input.global?.automation || {})
  };
  out.global.automation.maxTabsTotal = clampInt(out.global.automation.maxTabsTotal, 1, 500, 40);
  out.global.automation.maxTabsPerStep = clampInt(out.global.automation.maxTabsPerStep, 1, 200, 20);
  out.global.automation.maxJobRuntimeMinutes = clampInt(out.global.automation.maxJobRuntimeMinutes, 1, 1440, 60);
  out.global.automation.historyLimit = clampInt(out.global.automation.historyLimit, 10, 500, 100);

  for (const [id, profile] of Object.entries(out.profiles)) out.profiles[id] = normalizeProfile(profile, id);
  repairPersonaUids(out.profiles, { generatePersonaUid });
  for (const [id, route] of Object.entries(out.routes)) out.routes[id] = normalizeRoute(route, id);
  for (const [id, script] of Object.entries(out.scripts)) out.scripts[id] = normalizeScript(script, id);
  for (const [id, workflow] of Object.entries(out.workflows)) out.workflows[id] = normalizeWorkflow(workflow, id);
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function normalizeProfile(profile = {}, containerId = "") {
  const now = new Date().toISOString();
  const status = ["active", "temporary", "archived"].includes(profile.status)
    ? profile.status
    : (profile.temporary === true ? "temporary" : "active");
  return {
    containerId,
    personaUid: normalizePersonaUid(profile.personaUid),
    managed: profile.managed !== false,
    name: String(profile.name || containerId || "Profile").slice(0, 128),
    routeId: String(profile.routeId || "__block__"),
    killSwitch: profile.killSwitch !== false,
    blockLocalNetwork: profile.blockLocalNetwork !== false,
    domainMode: ["any", "allowlist"].includes(profile.domainMode) ? profile.domainMode : "any",
    allowedDomains: normalizeStringArray(profile.allowedDomains),
    blockedDomains: normalizeStringArray(profile.blockedDomains),
    scriptIds: normalizeStringArray(profile.scriptIds),
    notes: String(profile.notes || "").slice(0, 2048),
    description: String(profile.description || profile.notes || "").slice(0, 2048),
    owned: profile.owned === true,
    provisioned: profile.provisioned === true,
    provisionedSequence: Number.isInteger(Number(profile.provisionedSequence)) && Number(profile.provisionedSequence) > 0
      ? Number(profile.provisionedSequence)
      : null,
    suspendedRouteId: profile.suspendedRouteId ? String(profile.suspendedRouteId) : null,
    status,
    temporary: status === "temporary",
    expiresAt: profile.expiresAt ? String(profile.expiresAt) : null,
    archivedAt: profile.archivedAt ? String(profile.archivedAt) : null,
    archivedRouteId: profile.archivedRouteId ? String(profile.archivedRouteId) : null,
    statistics: profile.statistics && typeof profile.statistics === "object"
      ? {
          opens: clampInt(profile.statistics.opens, 0, Number.MAX_SAFE_INTEGER, 0),
          clones: clampInt(profile.statistics.clones, 0, Number.MAX_SAFE_INTEGER, 0)
        }
      : { opens: 0, clones: 0 },
    createdAt: String(profile.createdAt || now),
    updatedAt: String(profile.updatedAt || profile.createdAt || now),
    lastUsedAt: profile.lastUsedAt ? String(profile.lastUsedAt) : null,
    rotationOperationId: profile.rotationOperationId ? String(profile.rotationOperationId).slice(0, 128) : null,
    rotationRole: ["source", "target"].includes(profile.rotationRole) ? profile.rotationRole : null
  };
}

const ROTATION_STAGES = new Set([
  "prepared",
  "target-created",
  "uid-cutover",
  "references-remapped",
  "history-remapped",
  "source-quiesced",
  "source-removed"
]);

function boundedText(value, max) {
  return value == null ? null : String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

export function normalizePersonaRotations(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [key, raw] of Object.entries(source).slice(0, 32)) {
    if (!raw || typeof raw !== "object") continue;
    const operationId = boundedText(raw.operationId || key, 128);
    const personaUid = normalizePersonaUid(raw.personaUid);
    const sourceCookieStoreId = boundedText(raw.sourceCookieStoreId, 256);
    const temporaryContainerName = boundedText(raw.temporaryContainerName, 128);
    const stage = ROTATION_STAGES.has(raw.stage) ? raw.stage : null;
    if (!operationId || !personaUid || !sourceCookieStoreId || !temporaryContainerName || !stage) continue;
    out[operationId] = {
      operationId,
      correlationOperationId: boundedText(raw.correlationOperationId, 256),
      personaUid,
      sourceCookieStoreId,
      targetCookieStoreId: boundedText(raw.targetCookieStoreId, 256),
      temporaryContainerName,
      finalContainerName: boundedText(raw.finalContainerName, 128) || "Persona",
      targetColor: boundedText(raw.targetColor, 64),
      targetIcon: boundedText(raw.targetIcon, 64),
      stage,
      startedAt: boundedText(raw.startedAt, 64) || boundedText(raw.updatedAt, 64) || "1970-01-01T00:00:00.000Z",
      updatedAt: boundedText(raw.updatedAt, 64) || boundedText(raw.startedAt, 64) || "1970-01-01T00:00:00.000Z",
      error: boundedText(raw.error, 512),
      closedTabs: clampInt(raw.closedTabs, 0, Number.MAX_SAFE_INTEGER, 0)
    };
  }
  return out;
}

export function normalizeRoute(route = {}, id = "") {
  const type = ["socks", "http", "https"].includes(route.type) ? route.type : "socks";
  return {
    id,
    name: String(route.name || id || "Route").slice(0, 128),
    provider: ["mullvad", "generic", "proton-manual"].includes(route.provider) ? route.provider : "generic",
    type,
    host: String(route.host || "").trim().slice(0, 255),
    port: clampInt(route.port, 1, 65535, type === "socks" ? 1080 : 443),
    proxyDNS: type === "socks" ? route.proxyDNS !== false : false,
    username: String(route.username || "").slice(0, 512),
    password: String(route.password || "").slice(0, 2048),
    country: String(route.country || "").slice(0, 128),
    city: String(route.city || "").slice(0, 128),
    server: String(route.server || "").slice(0, 255),
    enabled: route.enabled !== false,
    createdAt: route.createdAt || new Date().toISOString()
  };
}

function normalizeResources(value) {
  const out = {};
  if (value && typeof value === "object") {
    for (const [key, url] of Object.entries(value)) {
      const k = String(key || "").trim().slice(0, 128);
      const u = String(url || "").trim().slice(0, 4096);
      if (k && u) out[k] = u;
    }
  }
  return out;
}

export function normalizeScript(script = {}, id = "") {
  const grants = normalizeStringArray(script.grants || script.detectedGrants);
  const injectInto = ["auto", "page", "content"].includes(script.injectInto) ? script.injectInto : "auto";
  const inferredWorld = grants.includes("none") || script.unwrap === true || injectInto === "page" ? "MAIN" : "USER_SCRIPT";
  const hostRulesDeclared = /(?:^|\n)\s*\/\/\s*@(?:match|include)\b/im.test(`${script.metaBlock || ""}\n${script.code || ""}`) ||
    normalizeStringArray(script.includes).length > 0 ||
    normalizeStringArray(script.matches).some((pattern) => pattern !== "*://*/*");
  const normalized = {
    id,
    name: String(script.name || id || "Userscript").slice(0, 200),
    namespace: String(script.namespace || "").slice(0, 500),
    version: String(script.version || "").slice(0, 100),
    description: String(script.description || "").slice(0, 2000),
    author: String(script.author || "").slice(0, 500),
    homepageURL: String(script.homepageURL || script.homepage || "").slice(0, 4096),
    supportURL: String(script.supportURL || "").slice(0, 4096),
    updateURL: String(script.updateURL || "").slice(0, 4096),
    downloadURL: String(script.downloadURL || "").slice(0, 4096),
    icon: String(script.icon || "").slice(0, 4096),
    code: String(script.code || ""),
    enabled: script.enabled !== false,
    autoRun: Object.hasOwn(script, "externalArtifact") ? false : script.autoRun !== false,
    matches: normalizeStringArray((script.matches?.length || script.includes?.length) ? (script.matches || []) : ["*://*/*"]),
    hostScopeDeclared: typeof script.hostScopeDeclared === "boolean" ? script.hostScopeDeclared : hostRulesDeclared,
    excludeMatches: normalizeStringArray(script.excludeMatches),
    includes: normalizeStringArray(script.includes),
    excludes: normalizeStringArray(script.excludes),
    runAt: ["document_start", "document_end", "document_idle"].includes(script.runAt)
      ? script.runAt
      : "document_idle",
    allFrames: script.allFrames === true,
    injectInto,
    world: script.world === "MAIN" || script.world === "USER_SCRIPT" ? script.world : inferredWorld,
    grants,
    requires: normalizeStringArray(script.requires),
    resources: normalizeResources(script.resources),
    connects: normalizeStringArray(script.connects),
    tags: normalizeStringArray(script.tags),
    unwrap: script.unwrap === true,
    profileIds: normalizeStringArray(script.profileIds),
    sourceURL: String(script.sourceURL || "").slice(0, 4096),
    compatibility: script.compatibility && typeof script.compatibility === "object" ? script.compatibility : {},
    metaBlock: String(script.metaBlock || "").slice(0, 65536),
    updatedAt: script.updatedAt || new Date().toISOString()
  };
  // Keep external artifact identity intact through every state normalization.
  // Validation of its source digest is asynchronous and is performed at import,
  // backup decode/encode, and recovery restore boundaries.
  if (Object.hasOwn(script, "externalArtifact")) {
    normalized.externalArtifact = script.externalArtifact && typeof script.externalArtifact === "object"
      ? {
          artifactId: script.externalArtifact.artifactId,
          sha256: script.externalArtifact.sha256,
          ...(typeof script.externalArtifact.ownerKey === "string" ? { ownerKey: script.externalArtifact.ownerKey } : {}),
          ...(typeof script.externalArtifact.ownershipVerified === "boolean"
            ? { ownershipVerified: script.externalArtifact.ownershipVerified } : {}),
          provenance: script.externalArtifact.provenance && typeof script.externalArtifact.provenance === "object"
            ? {
                packageId: script.externalArtifact.provenance.packageId,
                packageVersion: script.externalArtifact.provenance.packageVersion,
                component: script.externalArtifact.provenance.component
              }
            : script.externalArtifact.provenance,
          installedAt: script.externalArtifact.installedAt
        }
      : script.externalArtifact;
  }
  if (Object.hasOwn(normalized, "externalArtifact")) normalized.autoRun = false;
  return normalized;
}

function normalizeCompletion(value, fallback = {}) {
  const mode = ["load", "delay", "selector", "signal"].includes(value?.mode) ? value.mode : (fallback.mode || "load");
  return {
    mode,
    value: String(value?.value ?? fallback.value ?? "").slice(0, 4096),
    timeoutMs: clampInt(value?.timeoutMs ?? fallback.timeoutMs, 1000, MAX_WORKFLOW_STEP_TIMEOUT_MS, 60000)
  };
}

export function normalizeWorkflow(workflow = {}, id = "") {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  return {
    id,
    name: String(workflow.name || id || "Workflow").slice(0, 200),
    enabled: workflow.enabled !== false,
    createdAt: workflow.createdAt || new Date().toISOString(),
    updatedAt: workflow.updatedAt || new Date().toISOString(),
    steps: steps.slice(0, 200).map((step, index) => ({
      id: String(step?.id || `step-${index + 1}`).slice(0, 100),
      profileId: String(step?.profileId || "").slice(0, 256),
      urls: normalizeStringArray(step?.urls).slice(0, 10000),
      concurrency: clampInt(step?.concurrency, 1, 200, 4),
      scriptIds: normalizeStringArray(step?.scriptIds),
      completion: normalizeCompletion(step?.completion),
      retries: clampInt(step?.retries, 0, 10, 0),
      retryDelayMs: clampInt(step?.retryDelayMs, 0, 600000, 1000),
      closeTabs: step?.closeTabs !== false,
      stopOnError: step?.stopOnError !== false
    }))
  };
}

export function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
}

export async function loadState() {
  const stored = await browser.storage.local.get("state");
  return normalizeState(stored.state);
}

export async function saveState(state) {
  const normalized = normalizeState(state);
  await browser.storage.local.set({ state: normalized });
  return normalized;
}

export function redactSecrets(state) {
  const copy = normalizeState(state);
  for (const route of Object.values(copy.routes)) {
    route.username = "";
    route.password = "";
  }
  return copy;
}
