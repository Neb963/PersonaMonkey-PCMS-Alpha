import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "./constants.js";
import { normalizeScript, normalizeWorkflow } from "./storage.js";
import { analyzeGrants } from "./userscripts.js";
import { validateWorkflowForRun } from "./workflow-model.js";
import { currentRouteTest, personaCard, routeHealthSnapshot } from "./persona-intelligence.js";
import { createPersonaPackage, inspectPersonaPackage } from "./persona-package.js";

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function uniqueId(prefix, collection) {
  let id;
  do { id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`; } while (collection[id]);
  return id;
}

export function createPersonaPlatform({
  getState,
  setState,
  personaManager,
  cookieService,
  storageService,
  browserApi = browser,
  securityState = {},
  getRouteTest,
  runRouteTest,
  mutate,
  inspectPackage = inspectPersonaPackage,
  appVersion = ""
} = {}) {
  if (!getState || !setState || !personaManager || !cookieService || !storageService) {
    throw new Error("Persona platform dependencies are incomplete");
  }

  async function mutateState(mutator, options) {
    if (typeof mutate === "function") {
      let localResult;
      const committed = await mutate(async (draft) => {
        localResult = await mutator(draft);
        return localResult;
      }, options);
      return {
        state: committed?.state || committed?.committedState || await getState(),
        result: committed?.result === undefined ? localResult : committed.result,
        revision: committed?.revision
      };
    }
    const state = await getState();
    const result = await mutator(state);
    const committed = await setState(state);
    return { state: committed || state, result };
  }

  function pcmsError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function publicRoute(route) {
    if (!route) return null;
    return {
      id: route.id,
      name: route.name,
      provider: route.provider,
      type: route.type,
      host: route.host,
      port: route.port,
      proxyDNS: route.proxyDNS === true,
      country: route.country || "",
      city: route.city || "",
      server: route.server || "",
      enabled: route.enabled !== false,
      createdAt: route.createdAt || null
    };
  }

  function virtualRoute(id) {
    if (id === BLOCK_ROUTE_ID) return { id, name: "Block", provider: "block", type: "block", enabled: true };
    if (id === DIRECT_ROUTE_ID) return { id, name: "Direct", provider: "direct", type: "direct", enabled: true };
    return null;
  }

  function assertAllowedRoute(state, routeId, { allowDirect = false } = {}) {
    const selected = String(routeId || BLOCK_ROUTE_ID);
    if (selected === BLOCK_ROUTE_ID) return selected;
    if (selected === DIRECT_ROUTE_ID) {
      if (allowDirect !== true) throw pcmsError("DIRECT_ROUTE_REQUIRES_OPT_IN", "Direct routing requires allowDirect: true");
      return selected;
    }
    const route = state.routes?.[selected];
    if (!route) throw pcmsError("ROUTE_NOT_FOUND", "Route not found");
    if (route.enabled === false) throw pcmsError("ROUTE_DISABLED", "Route is disabled");
    return selected;
  }

  async function list({ includeStorage = false } = {}) {
    const [state, containers, tabs] = await Promise.all([
      getState(),
      personaManager.listContainers(),
      browserApi.tabs.query({})
    ]);
    const containerById = new Map(containers.filter((item) => item?.cookieStoreId).map((item) => [item.cookieStoreId, item]));
    const tabCounts = new Map();
    for (const tab of tabs) tabCounts.set(tab.cookieStoreId, (tabCounts.get(tab.cookieStoreId) || 0) + 1);
    return Promise.all(Object.values(state.profiles).filter((profile) => profile.managed && !profile.rotationRole).map(async (profile) => {
      const [cookies, storage] = await Promise.all([
        cookieService.list(profile.containerId).catch(() => []),
        includeStorage ? storageService.summary(profile.containerId).catch(() => null) : Promise.resolve(null)
      ]);
      const route = [BLOCK_ROUTE_ID, DIRECT_ROUTE_ID].includes(profile.routeId) ? null : state.routes[profile.routeId];
      const security = {
        ready: securityState.ready,
        privacySafe: securityState.privacySafe,
        privacyRequired: state.global.enforcePrivacyControls,
        proxyControl: securityState.proxyControl,
        strictProxyVerification: state.global.strictProxyVerification
      };
      const live = getRouteTest ? currentRouteTest(profile, route, security, await getRouteTest(profile.containerId)) : null;
      const health = routeHealthSnapshot(profile, route, security, live);
      return personaCard(profile, containerById.get(profile.containerId), {
        activeTabs: tabCounts.get(profile.containerId) || 0,
        cookies,
        storage,
        health
      });
    }));
  }

  async function exportPersona(profileId, include = {}) {
    const [state, containers, cookies] = await Promise.all([
      getState(),
      personaManager.listContainers(),
      include.cookies === true ? cookieService.list(profileId) : Promise.resolve([])
    ]);
    const container = containers.find((item) => item.cookieStoreId === profileId);
    return createPersonaPackage({ profileId, state, container, cookies, appVersion, include });
  }

  async function importPersona(input, options = {}) {
    // Re-parse the original archive at the mutation boundary; a caller-supplied
    // preview object is not proof that this import was inspected.
    const preview = await inspectPackage(input);
    const state = await getState();
    const routeSpec = preview.route || { mode: "block" };
    let routeId = BLOCK_ROUTE_ID;
    if (routeSpec.mode === "direct" && options.allowDirect === true) routeId = DIRECT_ROUTE_ID;
    if (routeSpec.mode === "route" && routeSpec.route) {
      const match = Object.values(state.routes).find((route) =>
        route.provider === routeSpec.route.provider &&
        route.host === routeSpec.route.host &&
        Number(route.port) === Number(routeSpec.route.port));
      if (match) routeId = match.id;
    }
    const created = await personaManager.create({
      name: options.name || preview.identity.name || "Imported Persona",
      color: preview.identity.color,
      icon: preview.identity.icon,
      // Portable package settings never disable safety controls on a new
      // Persona without a separate reviewed state transaction.
      profile: { ...preview.settings, routeId, scriptIds: [], killSwitch: true, blockLocalNetwork: true }
    }, { expectedRevision: options.expectedRevision, allowDirect: routeId === DIRECT_ROUTE_ID && options.allowDirect === true, granular: true });
    const profileId = created.profile.containerId;
    const { result: importState } = await mutateState((next) => {
      const scriptMap = new Map();
      for (const source of preview.scripts) {
        let id = source.id;
        if (next.scripts[id] && next.scripts[id].code !== source.code) id = uniqueId("script", next.scripts);
        next.scripts[id] = normalizeScript({ ...source, profileIds: [profileId] }, id);
        scriptMap.set(source.id, id);
      }
      if (!next.profiles[profileId]) throw pcmsError("PERSONA_NOT_FOUND", "Imported persona was not created");
      next.profiles[profileId].scriptIds = [...scriptMap.values()];
      const workflowIds = [];
      for (const source of preview.workflows) {
        const id = uniqueId("workflow", next.workflows);
        const workflow = normalizeWorkflow({
          ...source,
          name: `${source.name} — ${created.profile.name}`,
          steps: (source.steps || []).map((step) => ({
            ...step,
            profileId: step.profileId === "$persona" ? profileId : step.profileId,
            scriptIds: (step.scriptIds || []).map((scriptId) => scriptMap.get(scriptId) || scriptId)
          }))
        }, id);
        next.workflows[id] = workflow;
        workflowIds.push(id);
      }
      return { workflowIds, scriptIds: [...scriptMap.values()] };
    });
    const cookies = options.importCookies === true
      ? await cookieService.importRecords(profileId, preview.cookies, "replace")
      : { imported: 0, failed: 0, failures: [], excluded: preview.cookies.length };
    return { ...created, routeId, workflowIds: importState.workflowIds, scriptIds: importState.scriptIds, cookies };
  }

  async function test(profileId) {
    if (!runRouteTest) throw new Error("Route testing is unavailable");
    return runRouteTest(profileId);
  }

  async function get(profileId, options = {}) {
    const personas = await list({ includeStorage: options.includeStorage === true });
    return personas.find((persona) => persona.id === profileId) || null;
  }

  async function create(input = {}, mutationOptions) {
    const name = input.name == null ? "Persona" : String(input.name).trim().slice(0, 128);
    if (!name) throw pcmsError("INVALID_PERSONA_NAME", "Persona name must not be empty");
    let expiresAt = input.expiresAt || null;
    if (!expiresAt && input.temporary) {
      const ttlHours = Math.min(24 * 30, Math.max(1, Number(input.ttlHours) || 24));
      expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
    }
    const routeId = input.routeId || input.settings?.routeId || input.profile?.routeId || BLOCK_ROUTE_ID;
    const routeOptions = { ...(mutationOptions || {}), allowDirect: input.allowDirect === true || mutationOptions?.allowDirect === true, granular: true };
    const validateProfile = (draft, profile) => assertAllowedRoute(draft, profile.routeId, routeOptions);
    // Provide an immediate domain error, then validate again within the queued
    // Persona mutation before a contextual identity is created.
    assertAllowedRoute(await getState(), routeId, routeOptions);
    return personaManager.create({
      name,
      color: input.color,
      icon: input.icon,
      profile: {
        ...(input.settings || input.profile || {}),
        description: input.description || "",
        routeId,
        status: expiresAt ? "temporary" : "active",
        expiresAt
      }
    }, { ...routeOptions, validateProfile });
  }

  async function getPersonaStatus(profileId) {
    const persona = await get(profileId);
    return persona ? {
      id: persona.id,
      personaUid: persona.personaUid || null,
      cookieStoreId: persona.cookieStoreId || persona.id,
      status: persona.status,
      protection: persona.protection,
      health: clone(persona.health),
      lastUsedAt: persona.lastUsedAt,
      expiresAt: persona.expiresAt
    } : null;
  }

  async function getRouteStatus(profileId) {
    const persona = await get(profileId);
    return persona?.health || null;
  }

  async function listRoutes({ includeVirtual = true } = {}) {
    const state = await getState();
    const routes = Object.values(state.routes || {}).map(publicRoute);
    return includeVirtual ? [virtualRoute(BLOCK_ROUTE_ID), virtualRoute(DIRECT_ROUTE_ID), ...routes] : routes;
  }

  async function getRoute(routeId) {
    const virtual = virtualRoute(routeId);
    if (virtual) return virtual;
    const state = await getState();
    return publicRoute(state.routes?.[routeId]);
  }

  async function assignRoute(profileId, routeId, { allowDirect = false, expectedRevision, expectedBootId } = {}) {
    const state = await getState();
    const selected = String(routeId || BLOCK_ROUTE_ID);
    const assertAssignable = (draft, profile) => {
      if (!profile) throw pcmsError("PERSONA_NOT_FOUND", "Managed persona not found");
      if (!profile.managed) throw pcmsError("PERSONA_UNMANAGED", "Persona is not managed");
      if (selected === DIRECT_ROUTE_ID && allowDirect !== true) {
        throw pcmsError("DIRECT_ROUTE_REQUIRES_OPT_IN", "Direct routing requires allowDirect: true");
      }
      if (selected !== BLOCK_ROUTE_ID && selected !== DIRECT_ROUTE_ID) {
        const route = draft.routes?.[selected];
        if (!route) throw pcmsError("ROUTE_NOT_FOUND", "Route not found");
        if (route.enabled === false) throw pcmsError("ROUTE_DISABLED", "Route is disabled");
      }
    };
    // Validate once before side effects and again against the queued draft so
    // an unrelated UI route edit cannot turn a safe PCMS assignment stale.
    assertAssignable(state, state.profiles?.[profileId]);
    const updated = await personaManager.updateProfileRoute(profileId, selected, { expectedRevision, expectedBootId, allowDirect, granular: true }, assertAssignable);
    return { profile: clone(updated), route: await getRoute(selected) };
  }

  async function clonePersona(profileId, options = {}) {
    const state = await getState();
    const source = state.profiles?.[profileId];
    if (!source) throw pcmsError("PERSONA_NOT_FOUND", "Managed persona not found");
    if (!source.managed) throw pcmsError("PERSONA_UNMANAGED", "Persona is not managed");
    const copySettings = options.copySettings == null ? options.settings !== false : options.copySettings !== false;
    const copyRoute = options.copyRoute == null
      ? (options.route == null ? (options.copySettings == null ? options.settings !== false : options.copySettings !== false) : options.route !== false)
      : options.copyRoute !== false;
    const routeId = copyRoute ? source.routeId : BLOCK_ROUTE_ID;
    const validateProfile = (draft, profile) => assertAllowedRoute(draft, profile.routeId, options);
    assertAllowedRoute(state, routeId, options);
    return personaManager.clone(profileId, { ...options, granular: true, validateProfile });
  }

  async function testRoute(profileId) {
    const state = await getState();
    const profile = state.profiles?.[profileId];
    if (!profile) throw pcmsError("PERSONA_NOT_FOUND", "Managed persona not found");
    if (!profile.managed) throw pcmsError("PERSONA_UNMANAGED", "Persona is not managed");
    return test(profileId);
  }

  function publicUserscript(script) {
    if (!script || typeof script !== "object") return null;
    const compatibility = analyzeGrants(script.grants || []);
    return {
      id: String(script.id || "").slice(0, 256),
      name: String(script.name || "").slice(0, 200),
      namespace: String(script.namespace || "").slice(0, 500),
      version: String(script.version || "").slice(0, 100),
      enabled: script.enabled !== false,
      matches: clone(script.matches || []),
      includeMatches: clone(script.includes || []),
      excludeMatches: clone(script.excludeMatches || []),
      excludes: clone(script.excludes || []),
      runAt: script.runAt || "document_idle",
      world: script.world || "USER_SCRIPT",
      grants: clone(script.grants || []),
      connects: clone(script.connects || []),
      compatibility: {
        compatible: compatibility.compatible === true,
        supported: clone(compatibility.supported || []),
        unsupported: clone(compatibility.unsupported || [])
      },
      assignedProfileIds: clone(script.profileIds || [])
    };
  }

  async function listUserscripts() {
    const state = await getState();
    return Object.values(state.scripts || {}).map(publicUserscript).filter(Boolean);
  }

  async function getUserscript(scriptId) {
    const state = await getState();
    return publicUserscript(state.scripts?.[scriptId]);
  }

  async function setUserscriptAssignment(scriptId, profileId, assigned, options = {}) {
    const { result } = await mutateState((draft) => {
      const profile = draft.profiles?.[profileId];
      if (!profile?.managed || profile.rotationRole) throw pcmsError("PERSONA_NOT_FOUND", "Managed persona not found");
      const script = draft.scripts?.[scriptId];
      if (!script) throw pcmsError("USERSCRIPT_NOT_FOUND", "Userscript not found");
      const compatibility = analyzeGrants(script.grants || []);
      if (assigned && script.enabled === false) throw pcmsError("USERSCRIPT_DISABLED", "Userscript is disabled");
      if (assigned && !compatibility.compatible) throw pcmsError("USERSCRIPT_INCOMPATIBLE", "Userscript has unsupported grants");

      const profileIds = new Set(script.profileIds || []);
      const scriptIds = new Set(profile.scriptIds || []);
      if (assigned) {
        profileIds.add(profileId);
        scriptIds.add(scriptId);
      } else {
        profileIds.delete(profileId);
        scriptIds.delete(scriptId);
      }
      script.profileIds = [...profileIds];
      profile.scriptIds = [...scriptIds];
      return publicUserscript(script);
    }, options);
    return result;
  }

  async function assignUserscript(scriptId, profileId, options = {}) {
    return setUserscriptAssignment(scriptId, profileId, true, options);
  }

  async function unassignUserscript(scriptId, profileId, options = {}) {
    return setUserscriptAssignment(scriptId, profileId, false, options);
  }

  async function listWorkflows() {
    const state = await getState();
    return Object.values(state.workflows || {}).map((workflow) => clone(workflow));
  }

  async function getWorkflow(workflowId) {
    const state = await getState();
    return state.workflows?.[workflowId] ? clone(state.workflows[workflowId]) : null;
  }

  async function createWorkflow(input = {}, options = {}) {
    const { result } = await mutateState((draft) => {
      const id = uniqueId("workflow", draft.workflows || {});
      const now = new Date().toISOString();
      const candidate = { ...clone(input), id, createdAt: now, updatedAt: now };
      // Validate un-normalized values first so clamping/defaulting cannot turn
      // an invalid authoring request into a runnable workflow.
      validateWorkflowForRun(candidate, draft);
      const normalized = normalizeWorkflow(candidate, id);
      validateWorkflowForRun(normalized, draft);
      draft.workflows[id] = normalized;
      return clone(normalized);
    }, options);
    return result;
  }

  async function updateWorkflow(workflowId, input = {}, options = {}) {
    const { result } = await mutateState((draft) => {
      const existing = draft.workflows?.[workflowId];
      if (!existing) throw pcmsError("WORKFLOW_NOT_FOUND", "Workflow not found");
      const candidate = {
        ...clone(input),
        id: workflowId,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString()
      };
      validateWorkflowForRun(candidate, draft);
      const normalized = normalizeWorkflow(candidate, workflowId);
      validateWorkflowForRun(normalized, draft);
      draft.workflows[workflowId] = normalized;
      return clone(normalized);
    }, options);
    return result;
  }

  async function deleteWorkflow(workflowId, options = {}) {
    const { result } = await mutateState((draft) => {
      if (!draft.workflows?.[workflowId]) throw pcmsError("WORKFLOW_NOT_FOUND", "Workflow not found");
      delete draft.workflows[workflowId];
      return { id: workflowId, removed: true };
    }, options);
    return result;
  }

  return {
    list,
    get,
    resolvePersonaUid: personaManager.resolvePersonaUid,
    create,
    open: personaManager.open,
    export: exportPersona,
    inspectImport: inspectPackage,
    import: importPersona,
    duplicate: personaManager.duplicate,
    clone: clonePersona,
    archive: personaManager.archive,
    fullWipe: personaManager.fullWipe,
    remove: personaManager.remove,
    destroy: personaManager.destroy,
    cleanupExpired: personaManager.cleanupExpired,
    updateIdentity: personaManager.updateIdentity,
    storage: storageService.summary,
    clearStorage: storageService.clear,
    inspectStorage: storageService.inspect,
    clearCookies: storageService.clearCookies,
    clearSiteData: storageService.clearSiteData,
    wipeStorage: personaManager.fullWipe,
    test,
    listRoutes,
    getRoute,
    assignRoute,
    testRoute,
    listUserscripts,
    getUserscript,
    assignUserscript,
    unassignUserscript,
    listWorkflows,
    getWorkflow,
    createWorkflow,
    updateWorkflow,
    deleteWorkflow,
    getPersonaStatus,
    getRouteStatus
  };
}
