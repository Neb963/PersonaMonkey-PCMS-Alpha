import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "./constants.js";
import { loadState, saveState, normalizeState, normalizeWorkflow } from "./storage.js";
import { securityDelta, securityAuthorizationError } from "./security-delta.js";

export const STATE_CONFLICT = "STATE_CONFLICT";
const SNAPSHOT_META = "__stateMeta";

function cloneState(value) {
  // Persona state is JSON-compatible. structuredClone keeps this utility safe
  // for callers that retain drafts while their mutation waits in the queue.
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function sameState(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function createBootId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `pcms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function stateConflictError({ expectedRevision, expectedBootId } = {}, actualRevision, actualBootId) {
  const error = new Error("State revision conflict");
  error.code = STATE_CONFLICT;
  error.expectedRevision = expectedRevision;
  error.actualRevision = actualRevision;
  error.expectedBootId = expectedBootId;
  error.actualBootId = actualBootId;
  return error;
}

function blankWorkflowStep(workflowId) {
  return normalizeWorkflow({
    steps: [{
      id: "step-1",
      profileId: "",
      urls: [],
      concurrency: 4,
      scriptIds: [],
      completion: { mode: "load", value: "", timeoutMs: 60000 },
      retries: 0,
      closeTabs: true,
      stopOnError: true
    }]
  }, workflowId || "workflow-draft").steps[0];
}

export function sanitizeCrossRefs(input) {
  const state = normalizeState(input);
  const validProfileIds = new Set(Object.keys(state.profiles));
  const validScriptIds = new Set(Object.keys(state.scripts));

  for (const profile of Object.values(state.profiles)) {
    profile.scriptIds = (profile.scriptIds || []).filter((id) => validScriptIds.has(id));
    if (profile.routeId !== BLOCK_ROUTE_ID && profile.routeId !== DIRECT_ROUTE_ID && !state.routes[profile.routeId]) {
      if (profile.killSwitch !== false) profile.routeId = BLOCK_ROUTE_ID;
    }
  }

  for (const script of Object.values(state.scripts)) {
    script.profileIds = (script.profileIds || []).filter((id) => validProfileIds.has(id));
  }

  for (const profile of Object.values(state.profiles)) profile.scriptIds = [];
  for (const script of Object.values(state.scripts)) {
    for (const profileId of script.profileIds || []) {
      const profile = state.profiles[profileId];
      if (profile && !profile.scriptIds.includes(script.id)) profile.scriptIds.push(script.id);
    }
  }

  for (const workflow of Object.values(state.workflows || {})) {
    if (!(workflow.steps || []).length) workflow.steps = [blankWorkflowStep(workflow.id)];
    for (const step of workflow.steps) {
      // Workflows are editable drafts. If a persona was removed (or none exists
      // yet), keep the step and clear the broken reference instead of deleting
      // the entire step. Run-time validation remains fail-closed.
      if (step.profileId && !validProfileIds.has(step.profileId)) step.profileId = "";
      step.scriptIds = (step.scriptIds || []).filter((id) => validScriptIds.has(id));
    }
  }
  return state;
}

export function createStateManager({ load = loadState, save = saveState } = {}) {
  let cache = null;
  let afterSet = null;
  let initializePromise = null;
  let mutationTail = Promise.resolve();
  let revision = 0;
  const bootId = createBootId();
  const subscribers = new Set();
  const pendingSecurityPreviews = new Map();
  const SECURITY_PREVIEW_LIFETIME_MS = 2 * 60 * 1000;

  function enqueue(operation) {
    const queued = mutationTail.then(operation, operation);
    // Keep the queue usable after a failed mutation without hiding the error
    // from the caller that owns this operation.
    mutationTail = queued.catch(() => {});
    return queued;
  }

  async function withWorkflowAdmissionLock(operation) {
    if (typeof operation !== "function") throw new TypeError("Workflow admission callback must be a function");
    await initialize();
    // Workflow admission shares the same FIFO queue as every persisted state
    // mutation. Do not call a state write from the callback; the runner starts
    // while this entry owns the queue so a retargeting write cannot overtake it.
    return enqueue(operation);
  }

  function snapshot(state) {
    const out = cloneState(state);
    out[SNAPSHOT_META] = { revision, bootId };
    return out;
  }

  function assertExpected({ expectedRevision, expectedBootId } = {}) {
    const bootMismatch = expectedBootId !== undefined && expectedBootId !== bootId;
    const revisionMismatch = expectedRevision !== undefined && expectedRevision !== revision;
    if (bootMismatch || revisionMismatch) {
      throw stateConflictError({ expectedRevision, expectedBootId }, revision, bootId);
    }
  }

  async function notifySubscribers(state, source) {
    const metadata = { revision, bootId, source };
    const listeners = [afterSet, ...subscribers].filter((listener) => typeof listener === "function");
    await Promise.allSettled(listeners.map(async (listener) => {
      // Never hand listeners the cached object: an observer must not be able
      // to alter future mutations without going through the commit path.
      await listener(cloneState(state), metadata);
    }));
  }

  function assertSecurityAuthorization(next, options = {}) {
    const delta = securityDelta(cache, next);
    if (!delta.length) return;
    // Granular Persona operations carry explicit Direct intent after their own
    // caller validation. A whole-state writer cannot use this narrow authority.
    if (options.granular === true && options.allowDirect === true &&
        delta.every((entry) => entry.kind === "persona-direct-assigned")) return;
    const preview = pendingSecurityPreviews.get(options.authorizationId);
    if (!preview || preview.authorized !== true || preview.expiresAt < Date.now() ||
        preview.revision !== revision || preview.bootId !== bootId ||
        preview.proposal !== JSON.stringify(next) ||
        JSON.stringify(preview.delta) !== JSON.stringify(delta)) {
      throw securityAuthorizationError(delta);
    }
    // A capability authorizes precisely one queued commit of the reviewed state.
    pendingSecurityPreviews.delete(options.authorizationId);
  }

  async function commit(next, { result, source = "commit", authorization = {} } = {}) {
    const sanitized = sanitizeCrossRefs(cloneState(next));
    if (cache && sameState(cache, sanitized)) {
      return { state: snapshot(cache), result, revision, bootId, changed: false };
    }
    assertSecurityAuthorization(sanitized, authorization);
    const saved = await save(sanitized);
    cache = sanitizeCrossRefs(saved ?? sanitized);
    revision += 1;
    await notifySubscribers(cache, source);
    return {
      state: snapshot(cache),
      result,
      revision,
      bootId,
      changed: true
    };
  }

  async function initialize() {
    if (cache) return snapshot(cache);
    if (!initializePromise) {
      initializePromise = enqueue(async () => {
        if (cache) return cache;
        const sanitized = sanitizeCrossRefs(await load());
        // Initialization retains its v0.7 behavior of repairing persisted
        // references, but is not a PCMS mutation and therefore starts at rev 0.
        cache = sanitizeCrossRefs(await save(sanitized));
        return cache;
      });
      void initializePromise.finally(() => { initializePromise = null; }).catch(() => {});
    }
    await initializePromise;
    return snapshot(cache);
  }

  async function getState() {
    if (!cache) await initialize();
    return snapshot(cache);
  }

  async function setState(next, options = {}) {
    // Whole-state compatibility writers inherit optimistic-concurrency metadata
    // from getState()/initialize(). normalizeState() drops this transport-only
    // field before persistence so transport metadata never enters persisted schema 3.
    const draft = cloneState(next);
    const inherited = draft?.[SNAPSHOT_META];
    if (draft && typeof draft === "object") delete draft[SNAPSHOT_META];
    const expectation = {
      expectedRevision: options.expectedRevision ?? inherited?.revision,
      expectedBootId: options.expectedBootId ?? inherited?.bootId
    };
    await initialize();
    if (options.requireMetadata === true && (
      !inherited
      || !Number.isInteger(inherited.revision)
      || inherited.revision < 0
      || typeof inherited.bootId !== "string"
      || !inherited.bootId
    )) {
      throw stateConflictError(expectation, revision, bootId);
    }
    const committed = await enqueue(() => {
      assertExpected(expectation);
      return commit(draft, { source: "setState", authorization: options });
    });
    return committed.state;
  }

  async function mutate(mutator, options = {}) {
    if (typeof mutator !== "function") throw new TypeError("State mutator must be a function");
    await initialize();
    return enqueue(async () => {
      assertExpected(options);
      // Each queued mutation starts with an independent snapshot. A failed
      // mutator cannot affect cache or advance revision.
      const draft = cloneState(cache);
      const result = await mutator(draft, { revision, bootId });
      return commit(draft, { result, source: "mutate", authorization: options });
    });
  }

  async function previewState(next, options = {}) {
    const draft = cloneState(next);
    const inherited = draft?.[SNAPSHOT_META];
    if (draft && typeof draft === "object") delete draft[SNAPSHOT_META];
    await initialize();
    if (options.requireMetadata === true && (
      !inherited || !Number.isInteger(inherited.revision) || inherited.revision < 0
      || typeof inherited.bootId !== "string" || !inherited.bootId
    )) {
      throw stateConflictError({ expectedRevision: inherited?.revision, expectedBootId: inherited?.bootId }, revision, bootId);
    }
    return enqueue(() => {
      assertExpected({
        expectedRevision: options.expectedRevision ?? inherited?.revision,
        expectedBootId: options.expectedBootId ?? inherited?.bootId
      });
      const proposed = sanitizeCrossRefs(draft);
      const delta = securityDelta(cache, proposed);
      const previewId = crypto.randomUUID();
      for (const [id, preview] of pendingSecurityPreviews) {
        if (preview.expiresAt < Date.now() || pendingSecurityPreviews.size >= 32) pendingSecurityPreviews.delete(id);
      }
      pendingSecurityPreviews.set(previewId, {
        proposal: JSON.stringify(proposed), delta, revision, bootId, authorized: delta.length === 0,
        expiresAt: Date.now() + SECURITY_PREVIEW_LIFETIME_MS
      });
      return { delta, previewId, revision, bootId };
    });
  }

  async function authorizePreview(previewId, approvedDelta) {
    await initialize();
    return enqueue(() => {
      const preview = pendingSecurityPreviews.get(previewId);
      if (!preview || preview.expiresAt < Date.now()) throw securityAuthorizationError([]);
      assertExpected({ expectedRevision: preview.revision, expectedBootId: preview.bootId });
      if (JSON.stringify(approvedDelta) !== JSON.stringify(preview.delta)) {
        throw securityAuthorizationError(preview.delta);
      }
      preview.authorized = true;
      return { authorizationId: previewId };
    });
  }

  async function commitPreview(authorizationId) {
    await initialize();
    return enqueue(async () => {
      const preview = pendingSecurityPreviews.get(authorizationId);
      if (!preview || preview.expiresAt < Date.now() || preview.authorized !== true) throw securityAuthorizationError([]);
      try {
        assertExpected({ expectedRevision: preview.revision, expectedBootId: preview.bootId });
        return await commit(JSON.parse(preview.proposal), {
          source: "security-preview", authorization: { authorizationId }
        });
      } finally {
        pendingSecurityPreviews.delete(authorizationId);
      }
    });
  }

  async function acceptStorageState(next) {
    const incoming = sanitizeCrossRefs(cloneState(next));
    await initialize();
    return enqueue(async () => {
      // Events may arrive out of order after multiple writes. Read inside the
      // mutation queue so an old self-write cannot rewind the committed cache.
      // This also permits a real external rollback to the same old value.
      const persisted = sanitizeCrossRefs(await load());
      if (!sameState(persisted, incoming)) {
        return { state: snapshot(cache), accepted: false, revision, bootId };
      }
      // browser.storage.onChanged also fires for this manager's own save().
      // If the accepted value is already our committed cache, it is only the
      // storage echo and must not advance revision or emit a duplicate event.
      if (sameState(cache, incoming)) {
        return { state: snapshot(cache), accepted: false, revision, bootId };
      }
      if (securityDelta(cache, incoming).length) {
        // Storage notifications are never a substitute for a reviewed state
        // transaction. Restore the last authorized state if an external write
        // attempts to widen trust or weaken routing.
        await save(cache);
        return { state: snapshot(cache), accepted: false, revision, bootId };
      }
      cache = incoming;
      revision += 1;
      await notifySubscribers(cache, "storage");
      return { state: snapshot(cache), accepted: true, revision, bootId };
    });
  }

  function setAfterSetHook(fn) {
    afterSet = typeof fn === "function" ? fn : null;
  }

  function peekState() {
    return cache == null ? null : snapshot(cache);
  }

  function getRevision() {
    return revision;
  }

  function getBootId() {
    return bootId;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("State subscriber must be a function");
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  return {
    initialize,
    getState,
    setState,
    mutate,
    previewState,
    authorizePreview,
    commitPreview,
    getRevision,
    getBootId,
    subscribe,
    acceptStorageState,
    withWorkflowAdmissionLock,
    setAfterSetHook,
    peekState
  };
}
