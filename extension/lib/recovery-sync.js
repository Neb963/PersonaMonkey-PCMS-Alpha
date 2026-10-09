import { BLOCK_ROUTE_ID } from "./constants.js";
import { makeDefaultState, normalizeProfile, normalizeRoute, normalizeScript, normalizeWorkflow, normalizeState } from "./storage.js";
import { createPortableBackupPayload, encodeBackupEnvelope, decodeBackupEnvelope, validateExternalArtifactHashes } from "./backup-package.js";
import { bytesToBase64, base64ToBytes } from "./backup-crypto.js";

export const RECOVERY_META_KEY = "personaRecoveryMetaV1";
export const RECOVERY_CHUNK_PREFIX = "personaRecoveryChunkV1:";
export const RECOVERY_CONSENT_KEY = "personaRecoveryConsentV1";
export const RECOVERY_LOCAL_CONSENT_KEY = "personaRecoveryLocalConsentV1";
export const RECOVERY_CHUNK_CHARS = 7000;
export const RECOVERY_MAX_CHUNKS = 13;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

async function sha256Text(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function compressText(text) {
  if (typeof CompressionStream !== "function") return { encoding: "plain", data: text };
  try {
    const stream = new CompressionStream("gzip");
    const response = new Response(new Blob([encoder.encode(text)]).stream().pipeThrough(stream));
    const compressed = new Uint8Array(await response.arrayBuffer());
    const encoded = bytesToBase64(compressed);
    return encoded.length < text.length ? { encoding: "gzip-base64", data: encoded } : { encoding: "plain", data: text };
  } catch {
    return { encoding: "plain", data: text };
  }
}

async function decompressText(data, encoding) {
  if (encoding === "plain") return String(data || "");
  if (encoding !== "gzip-base64") throw new Error("Unsupported recovery snapshot encoding");
  if (typeof DecompressionStream !== "function") throw new Error("This runtime cannot decompress the recovery snapshot");
  const stream = new DecompressionStream("gzip");
  const response = new Response(new Blob([base64ToBytes(data)]).stream().pipeThrough(stream));
  return decoder.decode(new Uint8Array(await response.arrayBuffer()));
}

function chunkKey(index, generation = "") {
  const suffix = String(index).padStart(2, "0");
  return generation ? `${RECOVERY_CHUNK_PREFIX}${generation}:${suffix}` : `${RECOVERY_CHUNK_PREFIX}${suffix}`;
}

function newGeneration() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function removeSnapshotChunks(syncStorage, meta = null) {
  const count = Number(meta?.chunks);
  const safeCount = Number.isInteger(count) && count > 0 && count <= RECOVERY_MAX_CHUNKS ? count : RECOVERY_MAX_CHUNKS;
  const generation = typeof meta?.generation === "string" && meta.generation ? meta.generation : "";
  const keys = Array.from({ length: safeCount }, (_, index) => chunkKey(index, generation));
  try { await syncStorage.remove(keys); } catch {}
}

function recoveryInventory(state) {
  const normalized = normalizeState(state);
  return {
    personas: Object.values(normalized.profiles).filter((profile) => profile?.managed).length,
    routes: Object.keys(normalized.routes || {}).length,
    scripts: Object.keys(normalized.scripts || {}).length,
    workflows: Object.keys(normalized.workflows || {}).length
  };
}

function validConsentControl(value) {
  return value?.version === 1 && typeof value.enabled === "boolean" && typeof value.epoch === "string" && Boolean(value.epoch);
}

async function readConsentControl(syncStorage) {
  const result = await syncStorage.get(RECOVERY_CONSENT_KEY).catch(() => ({}));
  const control = result?.[RECOVERY_CONSENT_KEY] || null;
  return validConsentControl(control) ? control : null;
}

async function readLocalConsent(localStorage) {
  if (!localStorage) return null;
  const result = await localStorage.get(RECOVERY_LOCAL_CONSENT_KEY).catch(() => ({}));
  return result?.[RECOVERY_LOCAL_CONSENT_KEY] || null;
}

async function removeAllSnapshotKeys(syncStorage) {
  const all = await syncStorage.get(null).catch(() => ({}));
  const keys = Object.keys(all || {}).filter((key) => key === RECOVERY_META_KEY || key.startsWith(RECOVERY_CHUNK_PREFIX));
  if (keys.length) await syncStorage.remove(keys);
}

function makeConsentControl(enabled) {
  return { version: 1, enabled: enabled === true, epoch: newGeneration(), updatedAt: new Date().toISOString() };
}

export async function initializeRecoveryConsent({ syncStorage = globalThis.browser?.storage?.sync } = {}) {
  if (!syncStorage) return false;
  // Missing consent is off. Do not write a tombstone during startup: on a
  // fresh install Firefox Sync may still be downloading an opted-in control
  // record from another device. Legacy metadata without a matching consent
  // epoch remains unreadable and is replaced or cleared by an explicit action.
  return Boolean(await readConsentControl(syncStorage));
}

export async function enableRecoverySnapshot({ syncStorage = globalThis.browser?.storage?.sync, localStorage = globalThis.browser?.storage?.local } = {}) {
  if (!syncStorage || !localStorage) throw new Error("Firefox Sync recovery storage is unavailable");
  const control = makeConsentControl(true);
  await syncStorage.set({ [RECOVERY_CONSENT_KEY]: control });
  await localStorage.set({ [RECOVERY_LOCAL_CONSENT_KEY]: { enabled: true, epoch: control.epoch, updatedAt: control.updatedAt } });
  return control;
}

async function readSnapshotByMeta(syncStorage, meta) {
  if (!meta || meta.version !== 1 || meta.available !== true) return null;
  const count = Number(meta.chunks);
  if (!Number.isInteger(count) || count < 1 || count > RECOVERY_MAX_CHUNKS) throw new Error("Recovery snapshot metadata is invalid");
  const generation = typeof meta.generation === "string" && meta.generation ? meta.generation : "";
  const keys = Array.from({ length: count }, (_, index) => chunkKey(index, generation));
  const values = await syncStorage.get(keys);
  const packed = keys.map((key) => values[key]).join("");
  if (!packed || keys.some((key) => typeof values[key] !== "string")) throw new Error("Recovery snapshot is incomplete");
  const text = await decompressText(packed, meta.encoding || "plain");
  if (await sha256Text(text) !== meta.digest) throw new Error("Recovery snapshot integrity check failed");
  const decoded = await decodeBackupEnvelope(text);
  return { available: true, meta, payload: decoded.payload, envelope: decoded.envelope };
}

export function createRecoveryPayload(state, containers = []) {
  const normalized = normalizeState(state);
  // When explicitly enabled, Sync recovery must still never replicate local
  // cross-extension authority into a profile that may be freshly installed elsewhere.
  normalized.global.integration = makeDefaultState().global.integration;
  return createPortableBackupPayload({
    state: normalized,
    containers,
    selection: {
      kind: "selection",
      settings: true,
      profileIds: Object.values(normalized.profiles).filter((profile) => profile.managed).map((profile) => profile.containerId),
      scriptIds: Object.keys(normalized.scripts),
      workflowIds: Object.keys(normalized.workflows),
      cookies: false,
      gmValues: false,
      automationHistory: false,
      routeSecrets: false
    }
  });
}

export async function encodeRecoverySnapshot({ state, containers = [], appVersion = "" } = {}) {
  const payload = createRecoveryPayload(state, containers);
  return encodeBackupEnvelope({
    payload,
    appVersion,
    stateSchemaVersion: normalizeState(state).schemaVersion,
    scope: { kind: "recovery", components: ["settings", "routes", "personas", "userscripts", "workflows"] }
  });
}

export async function writeRecoverySnapshot({ syncStorage = globalThis.browser?.storage?.sync, localStorage = globalThis.browser?.storage?.local, state, containers = [], appVersion = "" } = {}) {
  if (!syncStorage) return { available: false, reason: "storage.sync unavailable" };
  const localConsent = await readLocalConsent(localStorage);
  const initialControl = await readConsentControl(syncStorage);
  if (localConsent?.enabled !== true || initialControl?.enabled !== true) {
    return { available: false, consentRequired: true, reason: "Firefox Sync recovery is not enabled" };
  }
  const inventory = recoveryInventory(state);
  const text = await encodeRecoverySnapshot({ state, containers, appVersion });
  const digest = await sha256Text(text);
  const controlAfterEncoding = await readConsentControl(syncStorage);
  const localAfterEncoding = await readLocalConsent(localStorage);
  if (localAfterEncoding?.enabled !== true || !controlAfterEncoding?.enabled || controlAfterEncoding.epoch !== initialControl.epoch) {
    return { available: false, consentRequired: true, reason: "Firefox Sync recovery consent changed" };
  }
  const current = await syncStorage.get(RECOVERY_META_KEY).catch(() => ({}));
  const previousMeta = current?.[RECOVERY_META_KEY] || null;
  if (previousMeta?.digest === digest && previousMeta?.available === true && previousMeta?.consentEpoch === initialControl.epoch) return { available: true, unchanged: true, ...previousMeta };

  const packed = await compressText(text);
  const chunks = [];
  for (let offset = 0; offset < packed.data.length; offset += RECOVERY_CHUNK_CHARS) chunks.push(packed.data.slice(offset, offset + RECOVERY_CHUNK_CHARS));
  if (chunks.length > RECOVERY_MAX_CHUNKS) {
    const meta = {
      version: 1,
      available: false,
      tooLarge: true,
      digest,
      rawBytes: encoder.encode(text).byteLength,
      encodedChars: packed.data.length,
      encoding: packed.encoding,
      updatedAt: new Date().toISOString(),
      appVersion: String(appVersion || ""),
      consentEpoch: initialControl.epoch,
      inventory
    };
    // A failed/oversized candidate must not replace the last known-good snapshot.
    return meta;
  }

  const generation = newGeneration();
  const values = {};
  chunks.forEach((chunk, index) => { values[chunkKey(index, generation)] = chunk; });
  const meta = {
    version: 1,
    available: true,
    tooLarge: false,
    digest,
    chunks: chunks.length,
    generation,
    rawBytes: encoder.encode(text).byteLength,
    encodedChars: packed.data.length,
    encoding: packed.encoding,
    updatedAt: new Date().toISOString(),
    appVersion: String(appVersion || ""),
    consentEpoch: initialControl.epoch,
    inventory
  };
  // Publish new chunks under a unique generation first, then switch metadata.
  // Concurrent writers cannot mix one writer's digest with another writer's
  // chunk set because generations never share chunk keys.
  await syncStorage.set(values);
  const controlBeforePublish = await readConsentControl(syncStorage);
  const localBeforePublish = await readLocalConsent(localStorage);
  if (localBeforePublish?.enabled !== true || !controlBeforePublish?.enabled || controlBeforePublish.epoch !== initialControl.epoch) {
    await removeSnapshotChunks(syncStorage, { chunks: chunks.length, generation });
    return { available: false, consentRequired: true, reason: "Firefox Sync recovery consent changed" };
  }
  await syncStorage.set({ [RECOVERY_META_KEY]: meta });
  const latest = await syncStorage.get(RECOVERY_META_KEY).catch(() => ({}));
  const latestControl = await readConsentControl(syncStorage);
  const latestLocal = await readLocalConsent(localStorage);
  if (latestLocal?.enabled !== true || !latestControl?.enabled || latestControl.epoch !== initialControl.epoch) {
    if (latest?.[RECOVERY_META_KEY]?.generation === generation) await removeAllSnapshotKeys(syncStorage);
    return { available: false, consentRequired: true, reason: "Firefox Sync recovery consent changed" };
  }
  if (latest?.[RECOVERY_META_KEY]?.generation !== previousMeta?.generation) {
    await removeSnapshotChunks(syncStorage, previousMeta);
  }
  return meta;
}

export async function readRecoverySnapshot({ syncStorage = globalThis.browser?.storage?.sync, localStorage = globalThis.browser?.storage?.local } = {}) {
  if (!syncStorage) return { available: false, syncConsentEnabled: false, reason: "storage.sync unavailable", meta: null, payload: null };
  const control = await readConsentControl(syncStorage);
  if (!control) {
    return { available: false, syncConsentEnabled: false, reason: "Firefox Sync recovery consent is missing or invalid in Firefox Sync", meta: null, payload: null };
  }
  if (!control.enabled) {
    return { available: false, syncConsentEnabled: false, reason: "Firefox Sync recovery is disabled in Firefox Sync", meta: null, payload: null };
  }
  const localConsent = await readLocalConsent(localStorage);
  if (localConsent?.enabled === false) return { available: false, syncConsentEnabled: true, reason: "Recovery is disabled on this installation", meta: null, payload: null };
  const metaResult = await syncStorage.get(RECOVERY_META_KEY).catch(() => ({}));
  const meta = metaResult?.[RECOVERY_META_KEY] || null;
  if (!meta?.available) return { available: false, syncConsentEnabled: true, meta, payload: null };
  if (meta.consentEpoch !== control.epoch) return { available: false, syncConsentEnabled: true, reason: "Recovery consent changed", meta, payload: null };
  const snapshot = await readSnapshotByMeta(syncStorage, meta);
  const currentControl = await readConsentControl(syncStorage);
  const currentLocal = await readLocalConsent(localStorage);
  if (!currentControl?.enabled || currentControl.epoch !== control.epoch || currentLocal?.enabled === false) {
    return {
      available: false,
      syncConsentEnabled: currentControl?.enabled === true,
      reason: currentControl?.enabled ? "Recovery consent changed" : "Firefox Sync recovery is disabled in Firefox Sync",
      meta: null,
      payload: null
    };
  }
  return { ...snapshot, syncConsentEnabled: true };
}

export async function clearRecoverySnapshot({ syncStorage = globalThis.browser?.storage?.sync, localStorage = globalThis.browser?.storage?.local } = {}) {
  if (localStorage) await localStorage.set({ [RECOVERY_LOCAL_CONSENT_KEY]: { enabled: false, updatedAt: new Date().toISOString() } });
  if (!syncStorage) return false;
  // The tombstone epoch makes old metadata unreadable even if a writer that
  // started earlier publishes after this clear. Orphaned chunks are removed
  // from the current Sync view; an offline older device may later re-upload
  // chunks, but its metadata epoch cannot authorize them.
  await syncStorage.set({ [RECOVERY_CONSENT_KEY]: makeConsentControl(false) });
  await removeAllSnapshotKeys(syncStorage);
  return true;
}

function freshId(prefix, object) {
  let id;
  do { id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`; } while (object[id]);
  return id;
}

function sameRoute(a, b) {
  const clean = (value) => {
    const copy = clone(value || {});
    delete copy.id;
    delete copy.createdAt;
    return copy;
  };
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

export async function restoreRecoveryPayload(payload, { browserApi = browser } = {}) {
  await validateExternalArtifactHashes(payload?.scripts || [], { entries: true });
  const containers = await browserApi.contextualIdentities.query({});
  const byId = new Map(containers.map((entry) => [entry.cookieStoreId, entry]));
  const profileMap = new Map();
  const used = new Set();

  for (const persona of payload.personas || []) {
    let id = persona.sourceId && byId.has(persona.sourceId) ? persona.sourceId : "";
    if (!id) {
      const matches = containers.filter((entry) => entry.name === persona.name && !used.has(entry.cookieStoreId));
      if (matches.length === 1) id = matches[0].cookieStoreId;
    }
    if (!id) {
      let created;
      try {
        created = await browserApi.contextualIdentities.create({ name: persona.name || "Recovered persona", color: persona.color || "blue", icon: persona.icon || "fingerprint" });
      } catch {
        created = await browserApi.contextualIdentities.create({ name: persona.name || "Recovered persona", color: "blue", icon: "fingerprint" });
      }
      id = created.cookieStoreId;
      containers.push(created);
      byId.set(id, created);
    }
    if (used.has(id)) throw new Error("Recovery snapshot maps two personas to one container");
    used.add(id);
    profileMap.set(persona.key, id);
  }

  const state = makeDefaultState();
  if (payload.settings) state.global = { ...state.global, ...clone(payload.settings) };
  state.global.integration = makeDefaultState().global.integration;
  state.global.unmanagedPolicy = "block";
  state.global.enforcePrivacyControls = true;
  state.global.strictProxyVerification = true;
  state.global.blockSpeculative = true;
  state.global.disableNetworkPrediction = true;
  state.global.webRTCMode = "disabled";
  for (const entry of payload.routes || []) {
    let id = entry.sourceId && !state.routes[entry.sourceId] ? entry.sourceId : "";
    if (!id && entry.sourceId && sameRoute(state.routes[entry.sourceId], entry.route)) id = entry.sourceId;
    if (!id) id = freshId("route-recovered", state.routes);
    // Keep recovered endpoint details for review, but make the route unusable
    // until a local settings transaction explicitly enables it.
    state.routes[id] = normalizeRoute({ ...clone(entry.route), id, enabled: false }, id);
  }

  const scriptMap = new Map();
  for (const entry of payload.scripts || []) {
    let id = entry.sourceId && !state.scripts[entry.sourceId] ? entry.sourceId : freshId("script-recovered", state.scripts);
    const profileIds = (entry.script?.profileKeys || []).map((key) => profileMap.get(key)).filter(Boolean);
    const script = clone(entry.script || {});
    delete script.profileKeys;
    state.scripts[id] = normalizeScript({ ...script, id, code: entry.code || "", profileIds }, id);
    scriptMap.set(entry.key, id);
  }

  for (const entry of payload.personas || []) {
    const id = profileMap.get(entry.key);
    if (!id) continue;
    const profile = clone(entry.profile || {});
    const routeId = BLOCK_ROUTE_ID;
    const scriptIds = (profile.scriptKeys || []).map((key) => scriptMap.get(key)).filter(Boolean);
    delete profile.routeMode;
    delete profile.routeKey;
    delete profile.scriptKeys;
    state.profiles[id] = normalizeProfile({ ...profile, name: entry.name || profile.name || id,
      managed: true, routeId, killSwitch: true, blockLocalNetwork: true, scriptIds }, id);
  }

  for (const entry of payload.workflows || []) {
    let id = entry.sourceId && !state.workflows[entry.sourceId] ? entry.sourceId : freshId("workflow-recovered", state.workflows);
    const workflow = clone(entry.workflow || {});
    workflow.steps = (workflow.steps || []).map((step) => {
      const copy = clone(step);
      copy.profileId = profileMap.get(copy.personaKey) || "";
      copy.scriptIds = (copy.scriptKeys || []).map((key) => scriptMap.get(key)).filter(Boolean);
      delete copy.personaKey;
      delete copy.scriptKeys;
      return copy;
    });
    state.workflows[id] = normalizeWorkflow({ ...workflow, id }, id);
  }
  return normalizeState(state);
}
