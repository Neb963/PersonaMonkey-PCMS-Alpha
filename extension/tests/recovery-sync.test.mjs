import assert from "node:assert/strict";
import {
  createRecoveryPayload,
  initializeRecoveryConsent,
  enableRecoverySnapshot,
  writeRecoverySnapshot,
  readRecoverySnapshot,
  restoreRecoveryPayload,
  clearRecoverySnapshot,
  RECOVERY_META_KEY,
  RECOVERY_CHUNK_PREFIX,
  RECOVERY_CONSENT_KEY,
  RECOVERY_LOCAL_CONSENT_KEY
} from "../lib/recovery-sync.js";
import { parseUserscriptMetadata } from "../lib/userscripts.js";

function makeStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      if (typeof keys === "string") return Object.prototype.hasOwnProperty.call(data, keys) ? { [keys]: structuredClone(data[keys]) } : {};
      const out = {};
      for (const key of keys || []) if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  };
}

const sync = makeStorage();
const local = makeStorage();
const state = {
  schemaVersion: 2,
  global: {
    profileTargetCount: 2,
    profileNamePrefix: "Persona",
    unmanagedPolicy: "direct",
    userscripts: { dependencyFetch: "direct", autoAssignImportedToAllProfiles: true, defaultInjectInto: "auto" },
    automation: { maxTabsTotal: 40, maxTabsPerStep: 20, maxJobRuntimeMinutes: 60, historyLimit: 100 },
    mullvadNative: { enabled: true, autoStart: true, autoStopMinutes: 15, requireReady: true }
  },
  profiles: {
    "firefox-container-source": { containerId: "firefox-container-source", managed: true, name: "Work", description: "profile-description-secret", notes: "profile-note-secret", routeId: "route-source", killSwitch: true, blockLocalNetwork: true, domainMode: "any", allowedDomains: [], blockedDomains: [], scriptIds: ["script-source"], owned: true }
  },
  routes: {
    "route-source": { id: "route-source", name: "Private proxy", provider: "generic", type: "https", host: "proxy.private.example", port: 443, proxyDNS: false, username: "route-user-secret", password: "route-password-secret", enabled: true }
  },
  scripts: {
    "script-source": { id: "script-source", name: "Signal", code: "// source-secret-sentinel\nPersona.complete({ok:true});", enabled: true, autoRun: true, matches: ["https://example.com/*"], excludeMatches: [], includes: [], excludes: [], runAt: "document_idle", allFrames: false, injectInto: "auto", world: "MAIN", grants: ["none"], requires: [], resources: {}, connects: [], tags: [], unwrap: false, profileIds: ["firefox-container-source"], compatibility: { compatible: true, supported: ["none"], unsupported: [] }, metaBlock: "" }
  },
  workflows: {
    "workflow-source": { id: "workflow-source", name: "Recovered workflow", enabled: true, steps: [{ id: "step-1", profileId: "firefox-container-source", urls: ["https://internal.private.example/path?token=url-secret-sentinel"], concurrency: 1, scriptIds: ["script-source"], completion: { mode: "signal", value: "", timeoutMs: 60000 }, retries: 0, retryDelayMs: 1000, closeTabs: true, stopOnError: true }] }
  },
  wireguardImports: [{ name: "private-key-file-sentinel", privateKey: "wireguard-secret" }]
};
const artifactCode = "// ==UserScript==\n// @name Signal\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\n// source-secret-sentinel\nPersona.complete({ok:true});";
const artifactHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(artifactCode)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const ownerKey = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("personamonkey/external-artifact-owner/v1\0owner@example.test")))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
state.scripts["script-source"].code = artifactCode;
Object.assign(state.scripts["script-source"], parseUserscriptMetadata(artifactCode, "org.example/package@2/signal"));
state.scripts["script-source"].autoRun = false;
state.scripts["script-source"].externalArtifact = {
  artifactId: "org.example/package@2/signal",
  sha256: artifactHash,
  ownerKey,
  provenance: { packageId: "org.example/package", packageVersion: "2", component: "signal" },
  installedAt: "2026-09-27T00:00:00.000Z"
};
const sourceContainers = [{ cookieStoreId: "firefox-container-source", name: "Work", color: "blue", icon: "briefcase" }];

const disabledWrite = await writeRecoverySnapshot({ syncStorage: sync, localStorage: local, state, containers: sourceContainers, appVersion: "1.0.0" });
assert.equal(disabledWrite.available, false, "startup or state changes cannot write before local opt-in");
assert.equal(disabledWrite.consentRequired, true);
assert.equal(sync.data[RECOVERY_META_KEY], undefined);

const localOnlyConsent = makeStorage();
await localOnlyConsent.set({ [RECOVERY_LOCAL_CONSENT_KEY]: { enabled: true, epoch: "local-only" } });
const syncedOptOut = makeStorage();
await syncedOptOut.set({ [RECOVERY_CONSENT_KEY]: { version: 1, enabled: false, epoch: "synced-opt-out" } });
const syncedOptOutResult = await readRecoverySnapshot({ syncStorage: syncedOptOut, localStorage: localOnlyConsent });
assert.equal(syncedOptOutResult.available, false);
assert.equal(syncedOptOutResult.syncConsentEnabled, false, "local consent cannot make a synced opt-out appear enabled");
assert.equal(syncedOptOutResult.reason, "Firefox Sync recovery is disabled in Firefox Sync");
assert.equal(syncedOptOut.data[RECOVERY_CONSENT_KEY].enabled, false, "reading disabled recovery does not mutate synced consent");
assert.equal(localOnlyConsent.data[RECOVERY_LOCAL_CONSENT_KEY].enabled, true, "reading disabled recovery preserves local consent for explicit review");
const unsyncedConsent = makeStorage();
const unsyncedResult = await readRecoverySnapshot({ syncStorage: unsyncedConsent, localStorage: localOnlyConsent });
assert.equal(unsyncedResult.syncConsentEnabled, false);
assert.match(unsyncedResult.reason, /missing or invalid/);
assert.equal(unsyncedConsent.data[RECOVERY_CONSENT_KEY], undefined, "a missing sync consent record is not created by a status read");

const legacy = makeStorage();
legacy.data[RECOVERY_META_KEY] = { version: 1, available: true, digest: "legacy-auto-snapshot", chunks: 1 };
legacy.data[`${RECOVERY_CHUNK_PREFIX}00`] = "legacy snapshot contents";
await initializeRecoveryConsent({ syncStorage: legacy });
assert.equal((await readRecoverySnapshot({ syncStorage: legacy, localStorage: local })).available, false);
assert.equal(legacy.data[RECOVERY_META_KEY].digest, "legacy-auto-snapshot", "startup does not overwrite a consent record still syncing from another device");
await clearRecoverySnapshot({ syncStorage: legacy, localStorage: local });
assert.equal(legacy.data[RECOVERY_CONSENT_KEY].enabled, false, "explicit clear persists the off tombstone");
assert.equal(legacy.data[RECOVERY_META_KEY], undefined, "explicit clear removes snapshots written before opt-in existed");

await enableRecoverySnapshot({ syncStorage: sync, localStorage: local });
assert.equal(local.data[RECOVERY_LOCAL_CONSENT_KEY].enabled, true);
const payload = createRecoveryPayload(state, sourceContainers);
assert.equal(payload.routes[0].route.username, "");
assert.equal(payload.routes[0].route.password, "");
assert.equal(payload.routes[0].route.host, "proxy.private.example", "recovery retains route host and port for local review");
assert.equal(payload.scripts[0].code, state.scripts["script-source"].code, "recovery includes userscript source");
assert.deepEqual(payload.scripts[0].script.externalArtifact, state.scripts["script-source"].externalArtifact, "recovery preserves external artifact identity");
assert.equal(payload.scripts[0].script.autoRun, false);
assert.equal(JSON.stringify(payload).includes("owner@example.test"), false, "recovery preserves ownership without exposing sender IDs");
assert.equal(payload.personas[0].profile.notes, "profile-note-secret", "recovery includes persona notes");
assert.equal(payload.workflows[0].workflow.steps[0].urls[0], state.workflows["workflow-source"].steps[0].urls[0], "recovery includes workflow URLs");
assert.equal(JSON.stringify(payload).includes("route-user-secret"), false);
assert.equal(JSON.stringify(payload).includes("route-password-secret"), false);
assert.equal(JSON.stringify(payload).includes("wireguard-secret"), false, "wireguard private material is excluded");
assert.equal(payload.settings.integration, undefined, "recovery omits external authority and trusted sender identifiers");
assert.equal(Object.keys(payload.cookies).length, 0);
assert.equal(Object.keys(payload.gmValues).length, 0);
assert.equal(payload.automationHistory.length, 0);

const written = await writeRecoverySnapshot({ syncStorage: sync, localStorage: local, state, containers: sourceContainers, appVersion: "1.0.0" });
assert.equal(written.available, true);
assert.ok(written.chunks >= 1);
assert.ok(written.generation);
assert.equal(sync.data[RECOVERY_META_KEY].digest, written.digest);
assert.equal(sync.data[RECOVERY_META_KEY].consentEpoch, sync.data[RECOVERY_CONSENT_KEY].epoch);
assert.equal(
  Object.keys(sync.data).filter((key) => key.startsWith(`${RECOVERY_CHUNK_PREFIX}${written.generation}:`)).length,
  written.chunks,
  "published recovery chunks must be scoped to the metadata generation"
);
const read = await readRecoverySnapshot({ syncStorage: sync, localStorage: local });
assert.equal(read.available, true);
assert.equal(read.syncConsentEnabled, true);
assert.equal(read.payload.workflows[0].workflow.name, "Recovered workflow");

const identities = [{ cookieStoreId: "firefox-container-new", name: "Work", color: "green", icon: "fingerprint" }];
const browserApi = { contextualIdentities: { async query() { return structuredClone(identities); }, async create(details) { const created = { cookieStoreId: `created-${identities.length}`, ...details }; identities.push(created); return structuredClone(created); } } };
const restored = await restoreRecoveryPayload(read.payload, { browserApi });
assert.ok(restored.profiles["firefox-container-new"]);
assert.equal(restored.profiles["firefox-container-new"].routeId, "__block__");
assert.equal(restored.profiles["firefox-container-new"].killSwitch, true);
assert.equal(restored.routes["route-source"].enabled, false, "recovered endpoint requires local review before use");
assert.equal(restored.global.unmanagedPolicy, "block");
assert.equal(restored.routes["route-source"].username, "");
assert.equal(restored.routes["route-source"].password, "");
assert.deepEqual(restored.scripts["script-source"].profileIds, ["firefox-container-new"]);
assert.deepEqual(restored.scripts["script-source"].externalArtifact, state.scripts["script-source"].externalArtifact);
assert.equal(restored.scripts["script-source"].externalArtifact.ownerKey, ownerKey, "recovery preserves opaque artifact ownership");
assert.equal(restored.scripts["script-source"].autoRun, false);
assert.equal(restored.workflows["workflow-source"].steps[0].profileId, "firefox-container-new");
assert.deepEqual(restored.workflows["workflow-source"].steps[0].scriptIds, ["script-source"]);

const corruptedRecovery = structuredClone(read.payload);
corruptedRecovery.scripts[0].code += "tamper";
await assert.rejects(restoreRecoveryPayload(corruptedRecovery, { browserApi }), /SHA-256 does not match/);

const unsafeRecoveryMetadataCases = [
  ["remote @require", (script) => { script.requires = ["https://cdn.example.test/helper.js"]; }],
  ["remote @resource", (script) => { script.resources = { helper: "https://cdn.example.test/helper.js" }; }],
  ["protocol-relative resource", (script) => { script.resources = { helper: "//cdn.example.test/helper.js" }; }],
  ["relative resource", (script) => { script.resources = { helper: "../helper.js" }; }],
  ["update URL", (script) => { script.updateURL = "https://cdn.example.test/update.js"; }],
  ["download URL", (script) => { script.downloadURL = "https://cdn.example.test/install.js"; }],
  ["extra GM grant", (script) => { script.grants = ["none", "GM_xmlhttpRequest"]; }],
  ["widened match", (script) => { script.matches = ["https://example.com/*", "*://*/*"]; }],
  ["auto-run enabled", (script) => { script.autoRun = true; }],
  ["malformed owner marker", (script) => { script.externalArtifact.ownerKey = "not-an-owner-hash"; }],
  ["malformed provenance", (script) => { script.externalArtifact.provenance.component = ""; }]
];
for (const [label, tamper] of unsafeRecoveryMetadataCases) {
  const metadataTampered = structuredClone(read.payload);
  tamper(metadataTampered.scripts[0].script);
  assert.equal(metadataTampered.scripts[0].code, artifactCode, `${label}: recovery artifact source bytes are unchanged`);
  assert.equal(metadataTampered.scripts[0].script.externalArtifact.sha256, artifactHash, `${label}: recovery artifact digest is unchanged`);
  await assert.rejects(
    restoreRecoveryPayload(metadataTampered, { browserApi }),
    undefined,
    `${label}: recovery must reject tampered artifact metadata instead of converting it`
  );
}

for (const resource of ["https://cdn.example.test/helper.js", "//cdn.example.test/helper.js", "/helper.js", "../helper.js"]) {
  const unsafeSource = artifactCode.replace("// @grant none", `// @grant none\n// @resource helper ${resource}`);
  const unsafeSourcePayload = structuredClone(read.payload);
  unsafeSourcePayload.scripts[0].code = unsafeSource;
  Object.assign(unsafeSourcePayload.scripts[0].script, parseUserscriptMetadata(unsafeSource, "org.example/package@2/signal"));
  unsafeSourcePayload.scripts[0].script.externalArtifact.sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(unsafeSource)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const beforeContainerCount = identities.length;
  await assert.rejects(
    restoreRecoveryPayload(unsafeSourcePayload, { browserApi }),
    /metadata does not match its safe source/,
    `recovery rejects a source-declared ${resource} resource even with a matching digest`
  );
  assert.equal(identities.length, beforeContainerCount, "invalid recovery artifacts are rejected before persona creation");
}

const invalidWriteState = structuredClone(state);
invalidWriteState.scripts["script-source"].matches = ["*://*/*"];
const invalidWriteSync = makeStorage();
const invalidWriteLocal = makeStorage();
await enableRecoverySnapshot({ syncStorage: invalidWriteSync, localStorage: invalidWriteLocal });
await assert.rejects(
  writeRecoverySnapshot({ syncStorage: invalidWriteSync, localStorage: invalidWriteLocal, state: invalidWriteState, containers: sourceContainers }),
  /metadata does not match its safe source/,
  "recovery snapshot generation rejects artifact metadata drift before publishing any chunks"
);
assert.equal(invalidWriteSync.data[RECOVERY_META_KEY], undefined);
assert.deepEqual(Object.keys(invalidWriteSync.data).filter((key) => key.startsWith(RECOVERY_CHUNK_PREFIX)), []);

const authorityState = structuredClone(state);
authorityState.global.integration = { enabled: true, trustedExtensionIds: ["pcms@example.test"], allowDirect: true, allowDestructive: true };
authorityState.profiles["firefox-container-source"].routeId = "__direct__";
authorityState.profiles["firefox-container-source"].killSwitch = false;
authorityState.global.blockSpeculative = false;
authorityState.global.disableNetworkPrediction = false;
authorityState.global.webRTCMode = "unchanged";
const authorityPayload = createRecoveryPayload(authorityState, sourceContainers);
assert.equal(authorityPayload.settings.integration, undefined, "sync snapshot omits external authority and trusted sender identifiers");
// Older snapshots may contain authority; restoration must still quarantine it.
authorityPayload.settings.integration = authorityState.global.integration;
const authorityRestored = await restoreRecoveryPayload(authorityPayload, { browserApi });
assert.equal(authorityRestored.global.integration.enabled, false);
assert.deepEqual(authorityRestored.global.integration.trustedExtensionIds, []);
assert.equal(authorityRestored.profiles["firefox-container-new"].routeId, "__block__");
assert.equal(authorityRestored.profiles["firefox-container-new"].killSwitch, true);
assert.equal(authorityRestored.global.blockSpeculative, true);
assert.equal(authorityRestored.global.disableNetworkPrediction, true);
assert.equal(authorityRestored.global.webRTCMode, "disabled");

const oldEpoch = sync.data[RECOVERY_CONSENT_KEY].epoch;
await clearRecoverySnapshot({ syncStorage: sync, localStorage: local });
assert.equal(local.data[RECOVERY_LOCAL_CONSENT_KEY].enabled, false);
assert.equal(sync.data[RECOVERY_CONSENT_KEY].enabled, false);
assert.notEqual(sync.data[RECOVERY_CONSENT_KEY].epoch, oldEpoch, "clear publishes a new durable consent epoch");
assert.deepEqual(Object.keys(sync.data).filter((key) => key === RECOVERY_META_KEY || key.startsWith(RECOVERY_CHUNK_PREFIX)), []);
assert.equal((await readRecoverySnapshot({ syncStorage: sync, localStorage: local })).available, false);
const forceCannotOptIn = await writeRecoverySnapshot({ syncStorage: sync, localStorage: local, state, containers: sourceContainers, force: true });
assert.equal(forceCannotOptIn.consentRequired, true, "force refresh cannot bypass durable opt-in");
const stateChangeWhileOff = await writeRecoverySnapshot({ syncStorage: sync, localStorage: local, state: structuredClone(state) });
assert.equal(stateChangeWhileOff.available, false, "state changes after clear do not recreate a snapshot");

await enableRecoverySnapshot({ syncStorage: sync, localStorage: local });
const reenabled = await writeRecoverySnapshot({ syncStorage: sync, localStorage: local, state, containers: sourceContainers });
assert.equal(reenabled.available, true, "a fresh explicit opt-in starts a new snapshot epoch");
const staleMeta = structuredClone(sync.data[RECOVERY_META_KEY]);
await enableRecoverySnapshot({ syncStorage: sync, localStorage: local });
sync.data[RECOVERY_META_KEY] = staleMeta;
assert.equal((await readRecoverySnapshot({ syncStorage: sync, localStorage: local })).available, false, "metadata from an earlier consent epoch cannot be read after re-enabling");

const raceSync = makeStorage();
const raceLocal = makeStorage();
await enableRecoverySnapshot({ syncStorage: raceSync, localStorage: raceLocal });
const baseRaceSet = raceSync.set.bind(raceSync);
let metaWriteEntered;
const metaStarted = new Promise((resolve) => { metaWriteEntered = resolve; });
let releaseMetaWrite;
const metaRelease = new Promise((resolve) => { releaseMetaWrite = resolve; });
raceSync.set = async (values) => {
  if (values?.[RECOVERY_META_KEY]) {
    metaWriteEntered();
    await metaRelease;
  }
  return baseRaceSet(values);
};
const pendingWrite = writeRecoverySnapshot({ syncStorage: raceSync, localStorage: raceLocal, state, containers: sourceContainers });
await metaStarted;
await clearRecoverySnapshot({ syncStorage: raceSync, localStorage: raceLocal });
releaseMetaWrite();
const raced = await pendingWrite;
assert.equal(raced.available, false, "a snapshot writer crossing a clear cannot restore its deleted generation");
assert.equal((await readRecoverySnapshot({ syncStorage: raceSync, localStorage: raceLocal })).available, false);
assert.equal(raceSync.data[RECOVERY_META_KEY], undefined, "the late writer removes its post-clear metadata");

const retained = makeStorage();
const retainedLocal = makeStorage();
await enableRecoverySnapshot({ syncStorage: retained, localStorage: retainedLocal });
await writeRecoverySnapshot({ syncStorage: retained, localStorage: retainedLocal, state, containers: sourceContainers });
const healthyNext = structuredClone(state);
healthyNext.global.profileNamePrefix = "Healthy Next";
const retainedSecond = await writeRecoverySnapshot({ syncStorage: retained, localStorage: retainedLocal, state: healthyNext, containers: sourceContainers });
assert.equal((await readRecoverySnapshot({ syncStorage: retained, localStorage: retainedLocal })).payload.settings.profileNamePrefix, "Healthy Next");
const emptyState = structuredClone(state);
emptyState.profiles = {};
emptyState.routes = {};
emptyState.scripts = {};
emptyState.workflows = {};
const deletedInventory = await writeRecoverySnapshot({ syncStorage: retained, localStorage: retainedLocal, state: emptyState, containers: [] });
assert.equal(deletedInventory.available, true, "deletions replace old data without a force flag or stale-inventory hold");
assert.notEqual(deletedInventory.digest, retainedSecond.digest);
assert.equal((await readRecoverySnapshot({ syncStorage: retained, localStorage: retainedLocal })).payload.personas.length, 0);

const overlap = makeStorage();
const overlapLocal = makeStorage();
await enableRecoverySnapshot({ syncStorage: overlap, localStorage: overlapLocal });
const baseSet = overlap.set.bind(overlap);
let metaWrites = 0;
let releaseFirstMeta;
const secondMetaStarted = new Promise((resolve) => { releaseFirstMeta = resolve; });
overlap.set = async (values) => {
  if (!values?.[RECOVERY_META_KEY]) return baseSet(values);
  metaWrites += 1;
  if (metaWrites === 1) {
    await secondMetaStarted;
    return baseSet(values);
  }
  const result = await baseSet(values);
  releaseFirstMeta();
  return result;
};
const firstState = structuredClone(state);
const secondState = structuredClone(state);
firstState.global.profileNamePrefix = "Concurrent A";
secondState.global.profileNamePrefix = "Concurrent B";
await Promise.all([
  writeRecoverySnapshot({ syncStorage: overlap, localStorage: overlapLocal, state: firstState, containers: sourceContainers }),
  writeRecoverySnapshot({ syncStorage: overlap, localStorage: overlapLocal, state: secondState, containers: sourceContainers })
]);
const overlapRead = await readRecoverySnapshot({ syncStorage: overlap, localStorage: overlapLocal });
assert.equal(overlapRead.available, true);
assert.ok(["Concurrent A", "Concurrent B"].includes(overlapRead.payload.settings.profileNamePrefix), "metadata must reference one complete generation for the active consent epoch");

let seed = 0x12345678;
let noise = "";
for (let i = 0; i < 150000; i += 1) { seed = (seed * 1664525 + 1013904223) >>> 0; noise += String.fromCharCode(33 + (seed % 90)); }
const huge = structuredClone(state);
huge.scripts["script-source"].code = artifactCode + "\n" + noise;
huge.scripts["script-source"].externalArtifact.sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(huge.scripts["script-source"].code)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const hugeSync = makeStorage();
const hugeLocal = makeStorage();
await enableRecoverySnapshot({ syncStorage: hugeSync, localStorage: hugeLocal });
const hugeResult = await writeRecoverySnapshot({ syncStorage: hugeSync, localStorage: hugeLocal, state: huge, containers: sourceContainers, appVersion: "1.0.0" });
assert.equal(hugeResult.available, false);
assert.equal(hugeResult.tooLarge, true);
assert.equal((await readRecoverySnapshot({ syncStorage: hugeSync, localStorage: hugeLocal })).available, false);
console.log("sync reinstall recovery tests passed");
