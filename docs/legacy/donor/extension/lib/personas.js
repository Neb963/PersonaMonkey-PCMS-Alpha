import { BLOCK_ROUTE_ID } from "./constants.js";
import { filterOrdinaryAutomationJobs } from "./automation-history.js";
import { normalizeProfile } from "./storage.js";
import { allocatePersonaUid, createPersonaUid, normalizePersonaUid, resolvePersonaUid as resolvePersonaIdentity } from "./persona-identity.js";
import { createPersonaRotationService } from "./persona-rotation.js";

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function uniqueId(prefix, collection) {
  let id;
  do { id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`; } while (collection[id]);
  return id;
}

export function createPersonaManager({
  getState,
  setState,
  mutate,
  browserApi = browser,
  cookieService = null,
  generatePersonaUid = createPersonaUid,
  remapAutomationHistory = null,
  onRotationEvent = null,
  rotationFailureInjector = null,
  rotationOperationIdFactory = null
} = {}) {
  if (!getState || !setState) throw new Error("Persona manager requires getState and setState");

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
        revision: committed?.revision,
        bootId: committed?.bootId
      };
    }
    const state = await getState();
    const result = await mutator(state);
    const committed = await setState(state);
    return { state: committed || state, result };
  }

  function allocateProfilePersonaUid(state, requestedUid = null) {
    const used = new Set(Object.values(state.profiles || {})
      .map((profile) => normalizePersonaUid(profile?.personaUid))
      .filter(Boolean));
    if (requestedUid != null) {
      const requested = normalizePersonaUid(requestedUid);
      if (!requested) throw new Error("personaUid must be a valid UUID");
      if (used.has(requested)) throw new Error("personaUid is already assigned");
      return requested;
    }
    return allocatePersonaUid(used, { generatePersonaUid });
  }

  async function resolvePersonaUid(personaUid) {
    return resolvePersonaIdentity(await getState(), personaUid);
  }

  const rotationService = createPersonaRotationService({
    getState,
    mutateState,
    browserApi,
    remapAutomationHistory,
    onRotated: onRotationEvent,
    failureInjector: rotationFailureInjector,
    operationIdFactory: rotationOperationIdFactory
  });

  async function listContainers() {
    try {
      return await browserApi.contextualIdentities.query({});
    } catch (error) {
      return [{ error: String(error) }];
    }
  }

  async function supportedAppearance() {
    let colors = ["blue", "green", "orange", "pink", "purple", "red", "cyan", "gray", "violet", "yellow"];
    let icons = ["fingerprint", "briefcase", "circle", "tree", "chill", "vacation", "cart", "gift", "pet", "food", "fruit", "dollar", "fence"];
    try {
      if (browserApi.contextualIdentities.getSupportedColors) {
        const result = await browserApi.contextualIdentities.getSupportedColors();
        colors = result.map((item) => typeof item === "string" ? item : item.color).filter(Boolean);
      }
      if (browserApi.contextualIdentities.getSupportedIcons) {
        const result = await browserApi.contextualIdentities.getSupportedIcons();
        icons = result.map((item) => typeof item === "string" ? item : item.icon).filter(Boolean);
      }
    } catch (error) {
      console.warn("Using fallback container appearance values", error);
    }
    return { colors, icons };
  }

  function sequenceNumber(name, prefix) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(name || "").match(new RegExp(`^${escaped}\\s+(\\d+)$`, "i"));
    return match ? Number(match[1]) : null;
  }

  async function ensureProfiles(targetCount, requestedPrefix) {
    const state = await getState();
    if (Object.keys(state.personaRotations || {}).length) {
      throw new Error("Persona rotation is in progress");
    }
    const count = Math.min(200, Math.max(1, Number.parseInt(targetCount, 10) || 30));
    const prefix = String(requestedPrefix || "Persona").trim().slice(0, 64) || "Persona";
    state.global.profileTargetCount = count;
    state.global.profileNamePrefix = prefix;

    const containers = await listContainers();
    const actualIds = new Set(containers.filter((c) => !c.error).map((c) => c.cookieStoreId));
    let releasedManagement = false;
    for (const [id, profile] of Object.entries(state.profiles)) {
      if (!actualIds.has(id) && profile.managed) {
        profile.managed = false;
        profile.routeId = BLOCK_ROUTE_ID;
        releasedManagement = true;
      }
    }

    let ownedManaged = Object.values(state.profiles).filter((p) => p.owned && p.managed && actualIds.has(p.containerId));
    if (ownedManaged.length > count) {
      ownedManaged
        .sort((a, b) => (sequenceNumber(b.name, prefix) || 0) - (sequenceNumber(a.name, prefix) || 0))
        .slice(0, ownedManaged.length - count)
        .forEach((profile) => {
          profile.managed = false;
          profile.routeId = BLOCK_ROUTE_ID;
          releasedManagement = true;
        });
    }
    // Releasing a Persona while unmanaged traffic is Direct would silently
    // bypass its old route. Quarantine unmanaged traffic instead.
    if (releasedManagement) state.global.unmanagedPolicy = "block";

    ownedManaged = Object.values(state.profiles).filter((p) => p.owned && p.managed && actualIds.has(p.containerId));
    const appearance = await supportedAppearance();
    const usedNames = new Set(containers.filter((c) => !c.error).map((c) => c.name.toLowerCase()));
    let seq = 1;
    while (ownedManaged.length < count) {
      while (usedNames.has(`${prefix} ${String(seq).padStart(2, "0")}`.toLowerCase())) seq++;
      const name = `${prefix} ${String(seq).padStart(2, "0")}`;
      const color = appearance.colors[(seq - 1) % appearance.colors.length] || "blue";
      const icon = appearance.icons[(seq - 1) % appearance.icons.length] || "fingerprint";
      const created = await browserApi.contextualIdentities.create({ name, color, icon });
      const profile = normalizeProfile({
        name,
        routeId: BLOCK_ROUTE_ID,
        personaUid: allocateProfilePersonaUid(state),
        killSwitch: true,
        blockLocalNetwork: true,
        domainMode: "any",
        owned: true,
        managed: true,
        createdAt: new Date().toISOString()
      }, created.cookieStoreId);
      state.profiles[created.cookieStoreId] = profile;
      ownedManaged.push(profile);
      usedNames.add(name.toLowerCase());
      seq++;
    }

    const saved = await setState(state);
    return { state: saved, containers: await listContainers() };
  }

  async function reloadContainerTabs(cookieStoreId) {
    const tabs = await browserApi.tabs.query({ cookieStoreId });
    await Promise.allSettled(tabs.map((tab) => tab.id != null
      ? browserApi.tabs.reload(tab.id, { bypassCache: false })
      : Promise.resolve()));
  }

  async function updateProfileRoute(profileId, routeId, mutationOptions, validate) {
    const { state, result: profile } = await mutateState((draft) => {
      const current = draft.profiles[profileId];
      if (!current?.managed) throw new Error("Managed profile not found");
      if (current.rotationRole || current.rotationOperationId || rotationService.hasActiveRotationForProfile(draft, profileId)) {
        throw new Error("Persona rotation is in progress");
      }
      if (typeof validate === "function") validate(draft, current);
      current.routeId = routeId || BLOCK_ROUTE_ID;
      current.updatedAt = new Date().toISOString();
      return clone(current);
    }, mutationOptions);
    if (state.global.autoReloadOnRouteChange) await reloadContainerTabs(profileId);
    return profile;
  }

  async function handleRemoved(change) {
    const id = change.contextualIdentity?.cookieStoreId;
    if (!id) return false;
    const { result } = await mutateState((state) => {
      const profile = state.profiles[id];
      if (!profile) return false;
      if (rotationService.hasActiveRotationForProfile(state, id)) return false;
      if (profile.managed === false && profile.routeId === BLOCK_ROUTE_ID) return false;
      profile.managed = false;
      profile.routeId = BLOCK_ROUTE_ID;
      state.global.unmanagedPolicy = "block";
      profile.updatedAt = new Date().toISOString();
      return true;
    });
    return result;
  }

  async function handleUpdated(change) {
    const id = change.contextualIdentity?.cookieStoreId;
    if (!id) return false;
    const { result } = await mutateState(async (state) => {
      const profile = state.profiles[id];
      if (!profile?.managed) return false;
      if (rotationService.hasActiveRotationForProfile(state, id)) return false;
      let latestIdentity;
      try {
        latestIdentity = typeof browserApi.contextualIdentities.get === "function"
          ? await browserApi.contextualIdentities.get(id)
          : (await browserApi.contextualIdentities.query({})).find((identity) => identity.cookieStoreId === id);
      } catch {
        return false;
      }
      if (!latestIdentity || latestIdentity.cookieStoreId !== id) return false;
      const name = String(latestIdentity?.name || profile.name).slice(0, 128);
      if (profile.name === name) return false;
      profile.name = name;
      profile.updatedAt = new Date().toISOString();
      return true;
    });
    return result;
  }

  async function assertPersona(profileId) {
    const state = await getState();
    const profile = state.profiles[profileId];
    if (!profile?.managed) throw new Error("Managed persona not found");
    if (profile.rotationRole || profile.rotationOperationId || rotationService.hasActiveRotationForProfile(state, profileId)) {
      throw new Error("Persona rotation is in progress");
    }
    return profile;
  }

  async function list({ includeArchived = false } = {}) {
    const state = await getState();
    return Object.values(state.profiles || {}).filter((profile) =>
      profile?.managed && !profile.rotationRole && (includeArchived || profile.status !== "archived"));
  }

  async function get(profileId) {
    const state = await getState();
    return state.profiles?.[profileId] || null;
  }

  async function createPersona({ name = "Persona", color = "blue", icon = "fingerprint", profile = {} } = {}, mutationOptions) {
    const appearance = await supportedAppearance();
    const safeColor = appearance.colors.includes(color) ? color : (appearance.colors[0] || "blue");
    const safeIcon = appearance.icons.includes(icon) ? icon : (appearance.icons[0] || "fingerprint");
    const identity = { name: String(name || "Persona").trim().slice(0, 128) || "Persona", color: safeColor, icon: safeIcon };
    let created = null;
    const validateProfile = (state) => mutationOptions?.validateProfile?.(state, profile);
    const apply = (state, personaUid) => {
      validateProfile(state);
      state.profiles[created.cookieStoreId] = normalizeProfile({
        ...clone(profile), personaUid, name: created.name, managed: true, owned: true,
        routeId: profile.routeId || BLOCK_ROUTE_ID,
        status: profile.expiresAt || profile.temporary ? "temporary" : (profile.status || "active"),
        expiresAt: profile.expiresAt || null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      }, created.cookieStoreId);
      return clone(state.profiles[created.cookieStoreId]);
    };
    let createdProfile;
    try {
      if (typeof mutate === "function") {
        ({ result: createdProfile } = await mutateState(async (state) => {
          // The queue checks expectedRevision before creating the Firefox identity.
          validateProfile(state);
          const personaUid = allocateProfilePersonaUid(state, profile.personaUid);
          created = await browserApi.contextualIdentities.create(identity);
          return apply(state, personaUid);
        }, mutationOptions));
      } else {
        const currentState = await getState();
        validateProfile(currentState);
        const personaUid = allocateProfilePersonaUid(currentState, profile.personaUid);
        created = await browserApi.contextualIdentities.create(identity);
        ({ result: createdProfile } = await mutateState((state) => apply(state, personaUid), mutationOptions));
      }
    } catch (error) {
      // A failed persistence commit must not leave a newly-created identity orphaned.
      if (created?.cookieStoreId) {
        try { await browserApi.contextualIdentities.remove(created.cookieStoreId); } catch {}
      }
      throw error;
    }
    return { profile: createdProfile, container: created };
  }

  async function updateIdentity(profileId, changes = {}, mutationOptions) {
    const profile = await assertPersona(profileId);
    const update = {};
    if (changes.name != null) update.name = String(changes.name).trim().slice(0, 128);
    if (changes.color) update.color = changes.color;
    if (changes.icon) update.icon = changes.icon;
    const apply = (state, container) => {
      const current = state.profiles[profileId];
      if (!current?.managed) throw new Error("Managed persona not found");
      if (current.rotationRole || current.rotationOperationId || rotationService.hasActiveRotationForProfile(state, profileId)) {
        throw new Error("Persona rotation is in progress");
      }
      state.profiles[profileId] = normalizeProfile({
        ...current,
        name: container.name,
        description: changes.description == null ? current.description : String(changes.description),
        updatedAt: new Date().toISOString()
      }, profileId);
      return clone(state.profiles[profileId]);
    };
    let container;
    let updatedProfile;
    if (typeof mutate === "function") {
      const previous = await browserApi.contextualIdentities.get(profileId);
      try {
        ({ result: updatedProfile } = await mutateState(async (state) => {
          container = await browserApi.contextualIdentities.update(profileId, update);
          return apply(state, container);
        }, mutationOptions));
      } catch (error) {
        if (container) {
          try { await browserApi.contextualIdentities.update(profileId, { name: previous.name, color: previous.color, icon: previous.icon }); } catch {}
        }
        throw error;
      }
    } else {
      container = await browserApi.contextualIdentities.update(profileId, update);
      ({ result: updatedProfile } = await mutateState((state) => apply(state, container), mutationOptions));
    }
    return { profile: updatedProfile, container };
  }

  async function touch(profileId, at = new Date().toISOString()) {
    const { result } = await mutateState((state) => {
      const profile = state.profiles[profileId];
      if (!profile?.managed || profile.lastUsedAt === at || rotationService.hasActiveRotationForProfile(state, profileId)) return false;
      profile.lastUsedAt = at;
      profile.updatedAt = at;
      profile.statistics = { ...(profile.statistics || {}), opens: Number(profile.statistics?.opens || 0) + 1 };
      return true;
    });
    return result;
  }

  async function open(profileId, url, active = true, mutationOptions) {
    const details = { cookieStoreId: profileId, active };
    if (url) details.url = url;

    const guarded = typeof mutate === "function"
      && (mutationOptions?.expectedRevision !== undefined || mutationOptions?.expectedBootId !== undefined);
    if (guarded) {
      let tab = null;
      try {
        await mutateState(async (state) => {
          // Keep the optimistic-concurrency check and the browser side effect
          // in the same mutation queue turn. A stale request must not open a tab.
          const profile = state.profiles[profileId];
          if (!profile?.managed) throw new Error("Managed persona not found");
          if (profile.rotationRole || profile.rotationOperationId || rotationService.hasActiveRotationForProfile(state, profileId)) {
            throw new Error("Persona rotation is in progress");
          }
          tab = await browserApi.tabs.create(details);
          const at = new Date().toISOString();
          profile.lastUsedAt = at;
          profile.updatedAt = at;
          profile.statistics = {
            ...(profile.statistics || {}),
            opens: Number(profile.statistics?.opens || 0) + 1
          };
          return true;
        }, mutationOptions);
      } catch (error) {
        // If persistence fails after Firefox created the tab, remove the tab so
        // a failed guarded operation does not leave an uncorrelated side effect.
        if (tab?.id != null) {
          try { await browserApi.tabs.remove(tab.id); } catch {}
        }
        throw error;
      }
      return tab;
    }

    await assertPersona(profileId);
    const tab = await browserApi.tabs.create(details);
    await touch(profileId);
    return tab;
  }

  async function duplicate(profileId, options = {}) {
    const source = await assertPersona(profileId);
    const sourceContainer = await browserApi.contextualIdentities.get(profileId);
    const include = {
      identity: options.copyIdentity == null ? options.identity !== false : options.copyIdentity !== false,
      settings: options.copySettings == null ? options.settings !== false : options.copySettings !== false,
      route: options.copyRoute == null
        ? (options.route == null ? (options.copySettings == null ? options.settings !== false : options.copySettings !== false) : options.route !== false)
        : options.copyRoute !== false,
      userscripts: options.copyScripts == null ? options.userscripts !== false : options.copyScripts !== false,
      workflows: options.copyWorkflows == null ? options.workflows !== false : options.copyWorkflows !== false,
      cookies: options.copyCookies === true || options.cookies === true,
      storage: options.copyStorage === true || options.storage === true,
      history: options.copySessionState === true || options.history === true,
      openTabs: options.copyTabs === true || options.openTabs === true
    };
    if (include.storage) throw new Error("Firefox does not expose safe cross-container site-storage cloning");
    const prepared = include.settings ? clone(source) : {};
    // A clone is a new logical Persona even when all settings are copied.
    delete prepared.personaUid;
    prepared.routeId = include.route ? source.routeId : BLOCK_ROUTE_ID;
    prepared.scriptIds = include.userscripts ? clone(source.scriptIds || []) : [];
    prepared.killSwitch = true;
    prepared.blockLocalNetwork = true;
    const created = await createPersona({
      name: options.name || (include.identity && options.copyName !== false ? `${source.name} Copy` : "Persona Copy"),
      color: include.identity && options.copyColor !== false ? (options.color || sourceContainer.color) : "blue",
      icon: include.identity && options.copyIcon !== false ? (options.icon || sourceContainer.icon) : "fingerprint",
      profile: prepared
    }, options);
    const targetId = created.profile.containerId;
    const { result: workflowIds } = await mutateState((state) => {
      if (!state.profiles[targetId]) throw new Error("Cloned persona was not created");
      if (include.userscripts) {
        for (const script of Object.values(state.scripts || {})) {
          if (script.profileIds?.includes(profileId) && !script.profileIds.includes(targetId)) script.profileIds.push(targetId);
        }
      }
      const copiedWorkflowIds = [];
      if (include.workflows) {
        for (const workflow of Object.values(state.workflows || {})) {
          if (!workflow.steps?.some((step) => step.profileId === profileId)) continue;
          const id = uniqueId("workflow", state.workflows);
          const copy = clone(workflow);
          copy.id = id;
          copy.name = `${workflow.name} — ${created.profile.name}`.slice(0, 200);
          copy.createdAt = copy.updatedAt = new Date().toISOString();
          copy.steps = copy.steps.map((step, index) => ({
            ...step,
            id: `step-${index + 1}-${crypto.randomUUID().slice(0, 6)}`,
            profileId: step.profileId === profileId ? targetId : step.profileId
          }));
          state.workflows[id] = copy;
          copiedWorkflowIds.push(id);
        }
      }
      if (state.profiles[profileId]) {
        state.profiles[profileId].statistics = {
          ...(state.profiles[profileId].statistics || {}),
          clones: Number(state.profiles[profileId].statistics?.clones || 0) + 1
        };
      }
      return copiedWorkflowIds;
    });

    let cookieResult = { imported: 0, failed: 0, failures: [] };
    if (include.cookies) {
      if (!cookieService) throw new Error("Cookie cloning service is unavailable");
      cookieResult = await cookieService.importRecords(targetId, await cookieService.list(profileId), "replace");
    }
    const openedTabs = [];
    if (include.openTabs) {
      for (const tab of await browserApi.tabs.query({ cookieStoreId: profileId })) {
        if (!tab.url || tab.url.startsWith("about:")) continue;
        openedTabs.push(await browserApi.tabs.create({ cookieStoreId: targetId, url: tab.url, active: false }));
      }
    }
    let historyEntries = 0;
    if (include.history && browserApi.storage?.local) {
      const stored = await browserApi.storage.local.get("automationJobs");
      const sourceJobs = stored.automationJobs;
      const sourceRecords = Array.isArray(sourceJobs) ? sourceJobs : Object.values(sourceJobs || {});
      const jobs = filterOrdinaryAutomationJobs(sourceRecords);
      const copies = jobs.filter((job) => job.profileId === profileId || job.tasks?.some((task) => task.profileId === profileId)).map((job) => ({
        ...clone(job),
        id: `history-${crypto.randomUUID()}`,
        profileId: job.profileId === profileId ? targetId : job.profileId,
        tasks: (job.tasks || []).map((task) => ({ ...task, profileId: task.profileId === profileId ? targetId : task.profileId })),
        clonedHistory: true
      }));
      historyEntries = copies.length;
      const externalJobs = sourceRecords.filter((job) => job && typeof job === "object" && job.externalOwner);
      const combined = [...externalJobs, ...jobs, ...copies].slice(-1000);
      await browserApi.storage.local.set({ automationJobs: Array.isArray(sourceJobs)
        ? combined
        : Object.fromEntries(combined.map((job) => [job.id, job])) });
    }
    return { ...created, include, workflowIds, cookies: cookieResult, openTabs: openedTabs.length, historyEntries };
  }

  async function fullWipe(profileId, mutationOptions) {
    return rotationService.start(profileId, mutationOptions);
  }

  async function reconcileRotations() {
    return rotationService.reconcileAll();
  }

  async function remove(profileId, mutationOptions) {
    await assertPersona(profileId);
    const apply = (state) => {
      delete state.profiles[profileId];
      if (state.global.unmanagedPolicy === "direct") state.global.unmanagedPolicy = "block";
      for (const script of Object.values(state.scripts || {})) {
        script.profileIds = (script.profileIds || []).filter((id) => id !== profileId);
      }
      for (const workflow of Object.values(state.workflows || {})) {
        for (const step of workflow.steps || []) if (step.profileId === profileId) step.profileId = "";
      }
    };
    if (typeof mutate === "function") {
      // The queue checks expectedRevision before the destructive Firefox call.
      await mutateState(async (state) => {
        if (rotationService.hasActiveRotationForProfile(state, profileId)) {
          throw new Error("Persona rotation is in progress");
        }
        await browserApi.contextualIdentities.remove(profileId);
        return apply(state);
      }, mutationOptions);
    } else {
      await browserApi.contextualIdentities.remove(profileId);
      await mutateState(apply, mutationOptions);
    }
    return true;
  }

  async function archive(profileId, mutationOptions) {
    const profile = await assertPersona(profileId);
    const previousRouteId = profile.routeId || BLOCK_ROUTE_ID;
    const { result: archivedProfile } = await mutateState((state) => {
      const current = state.profiles[profileId];
      if (!current?.managed) throw new Error("Managed persona not found");
      if (current.rotationRole || current.rotationOperationId || rotationService.hasActiveRotationForProfile(state, profileId)) {
        throw new Error("Persona rotation is in progress");
      }
      current.archivedRouteId = current.routeId || BLOCK_ROUTE_ID;
      current.routeId = BLOCK_ROUTE_ID;
      current.status = "archived";
      current.archivedAt = current.updatedAt = new Date().toISOString();
      return clone(current);
    }, mutationOptions);
    const openTabs = await browserApi.tabs.query({ cookieStoreId: profileId });
    const tabIds = openTabs.map((tab) => tab.id).filter((id) => id != null);
    if (tabIds.length) await browserApi.tabs.remove(tabIds);
    return { profile: archivedProfile, closedTabs: tabIds.length, previousRouteId };
  }

  async function cleanupExpired(at = Date.now()) {
    const state = await getState();
    const ids = Object.values(state.profiles || {})
      .filter((profile) => profile.managed && !profile.rotationRole && !profile.rotationOperationId
        && profile.status === "temporary" && profile.expiresAt && Date.parse(profile.expiresAt) <= at)
      .map((profile) => profile.containerId);
    const results = [];
    for (const id of ids) {
      try { await remove(id); results.push({ id, removed: true }); }
      catch (error) { results.push({ id, removed: false, error: error?.message || String(error) }); }
    }
    return results;
  }

  return {
    list,
    get,
    listContainers,
    ensureProfiles,
    updateProfileRoute,
    handleRemoved,
    handleUpdated,
    assertPersona,
    resolvePersonaUid,
    create: createPersona,
    updateIdentity,
    touch,
    open,
    duplicate,
    clone: duplicate,
    archive,
    fullWipe,
    reconcileRotations,
    remove,
    destroy: remove,
    cleanupExpired
  };
}
