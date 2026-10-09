import assert from "node:assert/strict";
import { normalizeState } from "../lib/storage.js";

const v03 = {
  schemaVersion: 1,
  global: {
    profileTargetCount: 30,
    profileNamePrefix: "Persona",
    unmanagedPolicy: "direct",
    blockSpeculative: true,
    strictProxyVerification: true,
    enforcePrivacyControls: true,
    disableNetworkPrediction: true,
    webRTCMode: "proxy_only",
    autoReloadOnRouteChange: true,
    userscripts: { autoAssignImportedToAllProfiles: false, dependencyFetch: "disabled" },
    automation: { maxTabsTotal: 12, maxTabsPerStep: 6, maxJobRuntimeMinutes: 90, historyLimit: 80 }
  },
  profiles: {
    p1: { containerId: "p1", managed: true, name: "P1", routeId: "r1", killSwitch: true, scriptIds: ["s1"] }
  },
  routes: {
    r1: { id: "r1", name: "Route", provider: "generic", type: "socks", host: "127.0.0.1", port: 1080, proxyDNS: true, enabled: true }
  },
  scripts: {
    s1: { id: "s1", name: "Script", code: "console.log(1)", enabled: true, profileIds: ["p1"], grants: ["GM_getValue"], runAt: "document_idle", matches: ["*://*/*"] }
  },
  workflows: {
    w1: { id: "w1", name: "Workflow", enabled: true, steps: [{ profileId: "p1", urls: ["https://example.com"], concurrency: 2, scriptIds: ["s1"], completion: { mode: "signal", timeoutMs: 45000 }, retries: 1, closeTabs: false, stopOnError: true }] }
  },
  wireguardImports: [{ name: "historical" }]
};

const migratedPersonaUid = "30000000-0000-4000-8000-000000000001";
const normalized = normalizeState(v03, { generatePersonaUid: () => migratedPersonaUid });
assert.equal(normalized.schemaVersion, 3);
assert.equal(normalized.profiles.p1.personaUid, migratedPersonaUid);
assert.equal(normalized.profiles.p1.routeId, "r1");
assert.deepEqual(normalized.profiles.p1.scriptIds, ["s1"]);
assert.equal(normalized.routes.r1.host, "127.0.0.1");
assert.deepEqual(normalized.scripts.s1.profileIds, ["p1"]);
assert.equal(normalized.scripts.s1.code, "console.log(1)");
const artifactState = normalizeState({ scripts: { artifact: {
  id: "artifact", code: "immutable", autoRun: true,
  externalArtifact: { artifactId: "a", sha256: "0".repeat(64), ownerKey: "1".repeat(64), provenance: { packageId: "p", packageVersion: "1", component: "c" }, installedAt: "2026-01-01T00:00:00.000Z" }
} } });
assert.deepEqual(artifactState.scripts.artifact.externalArtifact, {
  artifactId: "a", sha256: "0".repeat(64), ownerKey: "1".repeat(64), provenance: { packageId: "p", packageVersion: "1", component: "c" }, installedAt: "2026-01-01T00:00:00.000Z"
});
assert.equal(artifactState.scripts.artifact.autoRun, false, "state normalization preserves external identity and disables auto-run");
assert.equal(normalized.workflows.w1.steps[0].completion.mode, "signal");
assert.equal(normalized.workflows.w1.steps[0].closeTabs, false);
assert.equal(normalized.global.userscripts.dependencyFetch, "disabled");
assert.equal(normalized.global.userscripts.autoAssignImportedToAllProfiles, false, "v1.0's default-on import preference migrates to disabled until the user saves an explicit opt-in");
assert.equal(normalizeState({ global: { userscripts: { autoAssignImportedToAllProfiles: true } } }).global.userscripts.autoAssignImportedToAllProfiles, false);
assert.equal(normalizeState({ global: { userscripts: { autoAssignImportedToAllProfiles: true, autoAssignImportedToAllProfilesConfirmed: true } } }).global.userscripts.autoAssignImportedToAllProfiles, true);
assert.equal(normalized.global.automation.maxTabsTotal, 12);
assert.equal(normalized.global.automation.historyLimit, 80);
assert.equal(normalizeState({ global: { automation: { historyLimit: 1000 } } }).global.automation.historyLimit, 500, "old settings above the retention cap migrate to 500");
assert.equal(normalized.global.mullvadNative.enabled, true, "new defaults must be additive for v0.3 state");
assert.equal(normalized.wireguardImports.length, 1);

console.log("storage compatibility tests passed");
