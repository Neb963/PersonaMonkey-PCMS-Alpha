import { BLOCK_ROUTE_ID } from "./constants.js";
import { normalizeProfile } from "./storage.js";

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function nowIso() { return new Date().toISOString(); }

function safeError(error) {
  const code = String(error?.code || error?.name || "ROTATION_FAILED").replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 64);
  const message = String(error?.message || error || "Rotation failed")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(password|token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 384);
  return `${code}: ${message}`.slice(0, 512);
}

function temporaryName(operationId) {
  return `PersonaMonkey Rotation ${String(operationId).slice(0, 96)}`.slice(0, 128);
}

function operationId(factory) {
  const value = factory?.() || globalThis.crypto?.randomUUID?.();
  if (!value) throw new Error("Rotation operation ID generation is unavailable");
  return String(value).slice(0, 128);
}

function correlationOperationId(value) {
  if (typeof value !== "string" || !value) return null;
  return value.slice(0, 256);
}

async function getIdentity(browserApi, cookieStoreId) {
  try {
    const identity = await browserApi.contextualIdentities.get(cookieStoreId);
    if (identity?.cookieStoreId === cookieStoreId) return identity;
  } catch {
    // Firefox's get() error does not reliably distinguish absence from other
    // failures, so confirm against query() before treating the identity absent.
  }
  const identities = await browserApi.contextualIdentities.query({});
  const matches = (identities || []).filter((identity) => identity?.cookieStoreId === cookieStoreId);
  if (matches.length > 1) throw new Error("Contextual identity lookup is ambiguous");
  return matches[0] || null;
}

async function findTemporaryIdentity(browserApi, name) {
  const identities = await browserApi.contextualIdentities.query({});
  const matches = (identities || []).filter((identity) => identity?.name === name);
  if (matches.length > 1) throw new Error("Rotation target marker is ambiguous");
  return matches[0] || null;
}

function remapStateReferences(state, sourceId, targetId) {
  for (const script of Object.values(state.scripts || {})) {
    script.profileIds = [...new Set((script.profileIds || []).map((id) => id === sourceId ? targetId : id))];
  }
  for (const workflow of Object.values(state.workflows || {})) {
    for (const step of workflow.steps || []) if (step.profileId === sourceId) step.profileId = targetId;
  }
}

export function createPersonaRotationService({
  getState,
  mutateState,
  browserApi,
  remapAutomationHistory,
  onRotated,
  failureInjector,
  operationIdFactory
} = {}) {
  if (!getState || !mutateState || !browserApi?.contextualIdentities || !browserApi?.tabs) {
    throw new Error("Persona rotation dependencies are incomplete");
  }
  let rotationTail = Promise.resolve();

  function serialize(task) {
    const pending = rotationTail.then(task, task);
    rotationTail = pending.catch(() => {});
    return pending;
  }

  async function inject(point, journal) {
    if (typeof failureInjector === "function") await failureInjector(point, clone(journal));
  }

  async function journal(operationIdValue) {
    return (await getState()).personaRotations?.[operationIdValue] || null;
  }

  async function recordError(operationIdValue, error) {
    try {
      await mutateState((state) => {
        const current = state.personaRotations?.[operationIdValue];
        if (!current) return false;
        current.error = safeError(error);
        current.updatedAt = nowIso();
        return true;
      });
    } catch {}
  }

  async function setJournalAppearance(entry) {
    if (entry.targetColor && entry.targetIcon) return entry;
    const sourceIdentity = await getIdentity(browserApi, entry.sourceCookieStoreId);
    if (!sourceIdentity) throw new Error("Rotation source container is unavailable before target creation");
    const { result } = await mutateState((state) => {
      const current = state.personaRotations?.[entry.operationId];
      if (!current || current.stage !== "prepared") return current || null;
      current.targetColor = String(sourceIdentity.color || "blue").slice(0, 64);
      current.targetIcon = String(sourceIdentity.icon || "fingerprint").slice(0, 64);
      current.finalContainerName = String(sourceIdentity.name || current.finalContainerName || "Persona").slice(0, 128);
      current.updatedAt = nowIso();
      current.error = null;
      return clone(current);
    });
    return result;
  }

  async function remapHistory(sourceId, targetId) {
    if (typeof remapAutomationHistory === "function") {
      await remapAutomationHistory(sourceId, targetId);
      return;
    }
    if (!browserApi.storage?.local) return;
    const stored = await browserApi.storage.local.get("automationJobs");
    const sourceJobs = stored.automationJobs;
    const jobs = Array.isArray(sourceJobs) ? sourceJobs : Object.values(sourceJobs || {});
    for (const job of jobs) {
      if (job.profileId === sourceId) job.profileId = targetId;
      for (const task of job.tasks || []) if (task.profileId === sourceId) task.profileId = targetId;
      for (const progress of job.stepProgress || []) if (progress.profileId === sourceId) progress.profileId = targetId;
    }
    await browserApi.storage.local.set({
      automationJobs: Array.isArray(sourceJobs) ? jobs : Object.fromEntries(jobs.map((job) => [job.id, job]))
    });
  }

  async function reconcileOperation(operationIdValue) {
    let closedTabs = 0;
    while (true) {
      let entry = await journal(operationIdValue);
      if (!entry) return null;

      try {
        if (entry.stage === "prepared") {
          entry = await setJournalAppearance(entry);
          let target = await findTemporaryIdentity(browserApi, entry.temporaryContainerName);
          if (!target) {
            target = await browserApi.contextualIdentities.create({
              name: entry.temporaryContainerName,
              color: entry.targetColor || "blue",
              icon: entry.targetIcon || "fingerprint"
            });
            await inject("after-target-create", entry);
          }
          const targetId = target.cookieStoreId;
          if (!targetId) throw new Error("Rotation target container has no cookieStoreId");
          const committed = await mutateState((state) => {
            const currentJournal = state.personaRotations?.[operationIdValue];
            if (!currentJournal || currentJournal.stage !== "prepared") return clone(currentJournal);
            const source = state.profiles?.[currentJournal.sourceCookieStoreId];
            if (!source?.managed || source.rotationRole) throw new Error("Rotation source Persona is no longer current");
            if (source.personaUid !== currentJournal.personaUid) throw new Error("Rotation source Persona identity changed");
            const existing = state.profiles?.[targetId];
            if (existing && existing.rotationOperationId !== operationIdValue) {
              throw new Error("Rotation target container is already managed by another record");
            }
            state.profiles[targetId] = normalizeProfile({
              ...clone(source),
              containerId: targetId,
              name: currentJournal.finalContainerName,
              personaUid: null,
              managed: true,
              owned: true,
              routeId: source.routeId || BLOCK_ROUTE_ID,
              lastUsedAt: null,
              updatedAt: nowIso(),
              rotationOperationId: operationIdValue,
              rotationRole: "target"
            }, targetId);
            currentJournal.targetCookieStoreId = targetId;
            currentJournal.stage = "target-created";
            currentJournal.updatedAt = nowIso();
            currentJournal.error = null;
            return clone(currentJournal);
          });
          entry = committed.result;
          await inject("after-target-persist", entry);
          continue;
        }

        if (entry.stage === "target-created") {
          const committed = await mutateState((state) => {
            const currentJournal = state.personaRotations?.[operationIdValue];
            if (!currentJournal || currentJournal.stage !== "target-created") return clone(currentJournal);
            const source = state.profiles?.[currentJournal.sourceCookieStoreId];
            const target = state.profiles?.[currentJournal.targetCookieStoreId];
            if (!source || !target || target.rotationOperationId !== operationIdValue) {
              throw new Error("Rotation profiles are incomplete");
            }
            if (source.personaUid !== currentJournal.personaUid) throw new Error("Rotation source Persona identity changed");
            target.personaUid = currentJournal.personaUid;
            target.rotationRole = null;
            target.rotationOperationId = operationIdValue;
            target.updatedAt = nowIso();
            source.personaUid = null;
            source.rotationRole = "source";
            source.rotationOperationId = operationIdValue;
            source.updatedAt = nowIso();
            // The source stays managed and keeps its route until every source
            // tab is closed. This prevents the global unmanaged Direct policy
            // from ever seeing a live old-container tab.
            source.managed = true;
            currentJournal.stage = "uid-cutover";
            currentJournal.updatedAt = nowIso();
            currentJournal.error = null;
            return clone(currentJournal);
          });
          entry = committed.result;
          await inject("after-state-cutover", entry);
          continue;
        }

        if (entry.stage === "uid-cutover") {
          const committed = await mutateState((state) => {
            const currentJournal = state.personaRotations?.[operationIdValue];
            if (!currentJournal || currentJournal.stage !== "uid-cutover") return clone(currentJournal);
            remapStateReferences(state, currentJournal.sourceCookieStoreId, currentJournal.targetCookieStoreId);
            currentJournal.stage = "references-remapped";
            currentJournal.updatedAt = nowIso();
            currentJournal.error = null;
            return clone(currentJournal);
          });
          entry = committed.result;
          await inject("after-reference-remap", entry);
          continue;
        }

        if (entry.stage === "references-remapped") {
          await remapHistory(entry.sourceCookieStoreId, entry.targetCookieStoreId);
          await inject("after-history-remap", entry);
          const committed = await mutateState((state) => {
            const currentJournal = state.personaRotations?.[operationIdValue];
            if (!currentJournal || currentJournal.stage !== "references-remapped") return clone(currentJournal);
            currentJournal.stage = "history-remapped";
            currentJournal.updatedAt = nowIso();
            currentJournal.error = null;
            return clone(currentJournal);
          });
          entry = committed.result;
          continue;
        }

        if (entry.stage === "history-remapped") {
          const source = (await getState()).profiles?.[entry.sourceCookieStoreId];
          if (!source || source.rotationOperationId !== operationIdValue || source.rotationRole !== "source") {
            throw new Error("Rotation source ownership proof is missing before tab quiescence");
          }
          const openTabs = await browserApi.tabs.query({ cookieStoreId: entry.sourceCookieStoreId });
          const tabIds = openTabs.map((tab) => tab?.id).filter((id) => id != null);
          if (tabIds.length) {
            await browserApi.tabs.remove(tabIds);
            closedTabs += tabIds.length;
          }
          await inject("after-source-tabs-remove", entry);
          const remaining = await browserApi.tabs.query({ cookieStoreId: entry.sourceCookieStoreId });
          if (remaining.some((tab) => tab?.id != null)) throw new Error("Rotation source tabs remain open");
          const committed = await mutateState((state) => {
            const currentJournal = state.personaRotations?.[operationIdValue];
            if (!currentJournal || currentJournal.stage !== "history-remapped") return clone(currentJournal);
            currentJournal.closedTabs = Math.max(Number(currentJournal.closedTabs) || 0, closedTabs);
            currentJournal.stage = "source-quiesced";
            currentJournal.updatedAt = nowIso();
            currentJournal.error = null;
            return clone(currentJournal);
          });
          entry = committed.result;
          continue;
        }

        if (entry.stage === "source-quiesced") {
          const state = await getState();
          const source = state.profiles?.[entry.sourceCookieStoreId];
          if (!source || source.rotationOperationId !== operationIdValue || source.rotationRole !== "source") {
            throw new Error("Rotation source ownership proof is missing before container removal");
          }
          const sourceIdentity = await getIdentity(browserApi, entry.sourceCookieStoreId);
          if (sourceIdentity) await browserApi.contextualIdentities.remove(entry.sourceCookieStoreId);
          await inject("after-source-remove", entry);
          const committed = await mutateState((next) => {
            const currentJournal = next.personaRotations?.[operationIdValue];
            if (!currentJournal || currentJournal.stage !== "source-quiesced") return clone(currentJournal);
            currentJournal.stage = "source-removed";
            currentJournal.updatedAt = nowIso();
            currentJournal.error = null;
            return clone(currentJournal);
          });
          entry = committed.result;
          continue;
        }

        if (entry.stage === "source-removed") {
          const targetId = entry.targetCookieStoreId;
          if (!targetId) throw new Error("Rotation target ID is missing during finalization");
          const targetIdentity = await getIdentity(browserApi, targetId);
          if (!targetIdentity) throw new Error("Rotation target container is unavailable during finalization");
          if (targetIdentity.name !== entry.temporaryContainerName && targetIdentity.name !== entry.finalContainerName) {
            throw new Error("Rotation target marker no longer matches the recorded operation");
          }
          let finalIdentity = targetIdentity;
          if (targetIdentity.name !== entry.finalContainerName) {
            finalIdentity = await browserApi.contextualIdentities.update(targetId, { name: entry.finalContainerName });
          }
          const committed = await mutateState((state) => {
            const currentJournal = state.personaRotations?.[operationIdValue];
            if (!currentJournal || currentJournal.stage !== "source-removed") {
              return { profile: state.profiles?.[targetId] || null, journal: null };
            }
            const target = state.profiles?.[targetId];
            if (!target?.managed || target.personaUid !== currentJournal.personaUid || target.rotationOperationId !== operationIdValue) {
              throw new Error("Rotation target ownership proof is missing during finalization");
            }
            delete state.profiles[currentJournal.sourceCookieStoreId];
            // A removed source identity must never inherit Direct from the
            // global unmanaged policy if Firefox reports requests under its
            // former container ID while finalization completes.
            if (state.global.unmanagedPolicy === "direct") state.global.unmanagedPolicy = "block";
            target.name = currentJournal.finalContainerName;
            target.rotationOperationId = null;
            target.rotationRole = null;
            target.updatedAt = nowIso();
            const result = { profile: clone(target), journal: clone(currentJournal) };
            delete state.personaRotations[operationIdValue];
            return result;
          });
          const finalized = committed.result;
          const finalJournal = finalized?.journal || entry;
          const result = {
            personaUid: finalJournal.personaUid,
            oldCookieStoreId: finalJournal.sourceCookieStoreId,
            newCookieStoreId: finalJournal.targetCookieStoreId,
            operationId: finalJournal.operationId,
            correlationOperationId: finalJournal.correlationOperationId || null,
            oldProfileId: finalJournal.sourceCookieStoreId,
            profile: finalized?.profile || committed.state?.profiles?.[targetId] || null,
            container: finalIdentity,
            closedTabs: Number(finalJournal.closedTabs) || closedTabs,
            revision: committed.revision,
            bootId: committed.bootId
          };
          if (typeof onRotated === "function") {
            try { await onRotated(clone(result)); } catch { /* Advisory event sinks cannot roll back a committed rotation. */ }
          }
          await inject("after-final-cleanup", finalJournal);
          return result;
        }

        throw new Error("Rotation journal contains an unsupported stage");
      } catch (error) {
        await recordError(operationIdValue, error);
        throw error;
      }
    }
  }

  function findActiveRotation(state, personaRef) {
    const ref = String(personaRef || "").trim();
    const refUid = ref.toLowerCase();
    const profile = state.profiles?.[ref];
    return Object.values(state.personaRotations || {}).find((entry) =>
      entry?.sourceCookieStoreId === ref
      || entry?.targetCookieStoreId === ref
      || String(entry?.personaUid || "").toLowerCase() === refUid
      || profile?.rotationOperationId === entry?.operationId
      || (profile?.personaUid && profile.personaUid === entry?.personaUid)
    ) || null;
  }

  function resolveCurrentSource(state, personaRef) {
    const ref = String(personaRef || "").trim();
    const direct = state.profiles?.[ref];
    if (direct?.managed && !direct.rotationRole && !direct.rotationOperationId) {
      return { sourceId: ref, source: direct };
    }
    const refUid = ref.toLowerCase();
    const matches = Object.entries(state.profiles || {}).filter(([, profile]) =>
      profile?.managed
      && !profile.rotationRole
      && !profile.rotationOperationId
      && String(profile.personaUid || "").toLowerCase() === refUid
    );
    if (matches.length !== 1) return null;
    return { sourceId: matches[0][0], source: matches[0][1] };
  }

  async function start(personaRef, mutationOptions = {}) {
    return serialize(async () => {
      const requestedCorrelationOperationId = correlationOperationId(mutationOptions?.correlationOperationId);
      // A retry for an already-journaled operation is recovery, not a new
      // mutation. Resolve it by operation/UID/current or source container and
      // deliberately ignore stale original boot/revision expectations.
      const before = await getState();
      const existing = findActiveRotation(before, personaRef);
      if (existing) return reconcileOperation(existing.operationId);

      const resolved = resolveCurrentSource(before, personaRef);
      if (!resolved) throw new Error("Managed persona not found");
      const { sourceId } = resolved;
      const id = operationId(operationIdFactory);
      const tempName = temporaryName(id);
      const prepared = await mutateState((state) => {
        state.personaRotations ||= {};
        const currentResolved = resolveCurrentSource(state, sourceId);
        const source = currentResolved?.source;
        if (!source?.managed || source.rotationRole || source.rotationOperationId) throw new Error("Managed persona not found");
        if (!source.personaUid) throw new Error("Managed persona has no durable identity");
        const active = findActiveRotation(state, sourceId) || findActiveRotation(state, source.personaUid);
        if (active) throw new Error("Persona rotation is already in progress");
        const timestamp = nowIso();
        const entry = {
          operationId: id,
          correlationOperationId: requestedCorrelationOperationId,
          personaUid: source.personaUid,
          sourceCookieStoreId: sourceId,
          targetCookieStoreId: null,
          temporaryContainerName: tempName,
          finalContainerName: source.name,
          targetColor: null,
          targetIcon: null,
          stage: "prepared",
          startedAt: timestamp,
          updatedAt: timestamp,
          error: null,
          closedTabs: 0
        };
        state.personaRotations[id] = entry;
        return clone(entry);
      }, mutationOptions);
      await inject("after-journal-prepare", prepared.result);
      return reconcileOperation(id);
    });
  }

  async function reconcileAll() {
    return serialize(async () => {
      const results = [];
      const state = await getState();
      const ids = Object.keys(state.personaRotations || {}).sort();
      for (const id of ids) {
        const result = await reconcileOperation(id);
        if (result) results.push(result);
      }
      return results;
    });
  }

  function hasActiveRotationForProfile(state, profileId) {
    return Object.values(state?.personaRotations || {}).some((entry) =>
      entry?.sourceCookieStoreId === profileId || entry?.targetCookieStoreId === profileId);
  }

  return Object.freeze({ start, reconcileAll, hasActiveRotationForProfile });
}
