import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const mod = await import(`../lib/userscript-runtime.js?test=${Date.now()}`);
const { parseUserscriptMetadata, worldIdForScript } = await import("../lib/userscripts.js");
const state = {
  profiles: { p1: { managed: true } },
  scripts: {
    s1: { id: "s1", name: "Selected", enabled: true, autoRun: true, runAt: "document_start", profileIds: ["p1"], matches: ["*://*/*"], allFrames: false },
    s2: { id: "s2", name: "Automatic", enabled: true, autoRun: true, runAt: "document_start", profileIds: ["p1"], matches: ["*://*/*"], allFrames: false },
    s3: { id: "s3", name: "Manual", enabled: true, autoRun: false, runAt: "document_start", profileIds: ["p1"], matches: ["*://*/*"], allFrames: false },
    s4: { id: "s4", name: "Other persona", enabled: true, autoRun: true, runAt: "document_start", profileIds: ["p2"], matches: ["*://*/*"], allFrames: false }
  }
};
const executed = [];
const worlds = [];
const failures = [];
let policy = { allowedScriptIds: ["s1"], automationToken: "token" };
let failSelectedOnce = true;
const browserApi = {
  permissions: { async contains() { return true; } },
  tabs: { async get(id) { return { id, cookieStoreId: "p1" }; } },
  userScripts: {
    async configureWorld(opts) { worlds.push(opts.worldId); },
    async execute(opts) { executed.push(opts); }
  }
};
const runtime = mod.createUserscriptRuntime({
  getState: async () => state,
  getAutomationTabPolicy: () => policy,
  handleAutomationSignal: (signal) => failures.push(signal),
  browserApi,
  prepareInjection: async (script, context) => {
    if (script.id === "s1" && failSelectedOnce) {
      failSelectedOnce = false;
      throw new Error("synthetic preparation failure");
    }
    return {
      code: `${script.id}:${context.automationToken}`,
      world: "USER_SCRIPT",
      worldId: await worldIdForScript(script.id)
    };
  }
});

const sameRequest = { tabId: 9, frameId: 0, documentId: "doc-a", url: "https://example.com/a" };
const originalConsoleError = console.error;
console.error = () => {};
await runtime.injectForContext(sameRequest, "document_start");
console.error = originalConsoleError;
assert.equal(executed.length, 0, "preparation failure must not poison the injection dedupe key");
assert.equal(failures.length, 1);
await runtime.injectForContext(sameRequest, "document_start");
assert.equal(executed.length, 1);
assert.equal(executed[0].js[0].code, "s1:token");
assert.deepEqual(worlds, [await worldIdForScript("s1")]);
await runtime.injectForContext(sameRequest, "document_start");
assert.equal(executed.length, 1, "successful injections must remain deduped");

policy = { allowedScriptIds: [], automationToken: "empty" };
await runtime.injectForContext({ tabId: 9, frameId: 0, documentId: "doc-empty", url: "https://example.com/empty" }, "document_start");
assert.equal(executed.length, 1, "an automation tab with an empty script allowlist must run no persona autoRun scripts");

policy = null;
await runtime.injectForContext({ tabId: 9, frameId: 0, documentId: "doc-b", url: "https://example.com/b" }, "document_start");
assert.equal(executed.length, 3, "manual tabs should run the two eligible autoRun scripts");
assert.ok(executed.some((x) => x.js[0].code === "s1:"));
assert.ok(executed.some((x) => x.js[0].code === "s2:"));
assert.equal(executed.some((x) => x.js[0].code.startsWith("s3:")), false);
assert.equal(executed.some((x) => x.js[0].code.startsWith("s4:")), false);
assert.equal(failures.length, 1);

// External artifact runtime regression: preserve the exact source bytes and
// valid artifact digest, but mutate normalized metadata after installation.
// None of these altered metadata records may reach userScripts.execute.
const artifactSource = [
  "// ==UserScript==",
  "// @name Safe external artifact",
  "// @match https://example.com/*",
  "// @grant Persona.signal",
  "// @run-at document-start",
  "// ==/UserScript==",
  "window.__externalArtifactRan = true;"
].join("\n");
const artifactHash = createHash("sha256").update(artifactSource, "utf8").digest("hex");
const metadataTamperingCases = [
  { name: "remote @require", mutate: (script) => { script.requires = ["https://cdn.example.test/dep.js"]; } },
  { name: "remote @resource", mutate: (script) => { script.resources = { config: "https://cdn.example.test/config.json" }; } },
  { name: "dangerous grant", mutate: (script) => { script.grants = ["Persona.signal", "GM_xmlhttpRequest"]; } },
  {
    name: "widened host scope",
    url: "https://evil.example.test/page",
    mutate: (script) => { script.matches = ["*://*/*"]; }
  },
  { name: "auto-run enabled", mutate: (script) => { script.autoRun = true; } },
  { name: "unverified portable ownership", mutate: (script) => { script.externalArtifact.ownershipVerified = false; } },
  { name: "malformed ownership marker", mutate: (script) => { script.externalArtifact.ownerKey = "not-an-owner-hash"; } }
];
policy = { allowedScriptIds: ["external-artifact"], automationToken: "external-token" };
const executedBeforeArtifactChecks = executed.length;
const injectedAfterMetadataTampering = [];
for (const [index, scenario] of metadataTamperingCases.entries()) {
  const metadata = parseUserscriptMetadata(artifactSource, "Safe external artifact");
  const script = {
    ...metadata,
    id: "external-artifact",
    code: artifactSource,
    enabled: true,
    autoRun: false,
    profileIds: ["p1"],
    externalArtifact: {
      artifactId: "org.example/package@1/component", sha256: artifactHash, ownerKey: "a".repeat(64),
      provenance: { packageId: "org.example/package", packageVersion: "1", component: "component" },
      installedAt: "2026-09-27T00:00:00.000Z"
    }
  };
  scenario.mutate(script);
  state.scripts = { [script.id]: script };
  const before = executed.length;
  await runtime.injectForContext({
    tabId: 9,
    frameId: 0,
    documentId: `tampered-artifact-${index}`,
    url: scenario.url || "https://example.com/page"
  }, "document_start");
  if (executed.length !== before) injectedAfterMetadataTampering.push(scenario.name);
}
assert.equal(executed.length - executedBeforeArtifactChecks, injectedAfterMetadataTampering.length);
assert.deepEqual(
  injectedAfterMetadataTampering,
  [],
  `external artifacts with unchanged source digests but tampered metadata must be rejected before injection: ${injectedAfterMetadataTampering.join(", ")}`
);

const disabledArtifact = {
  ...parseUserscriptMetadata(artifactSource, "Safe external artifact"),
  id: "external-artifact", code: artifactSource, enabled: false, autoRun: false, profileIds: ["p1"],
  externalArtifact: {
    artifactId: "org.example/package@1/component", sha256: artifactHash, ownerKey: "a".repeat(64),
    provenance: { packageId: "org.example/package", packageVersion: "1", component: "component" },
    installedAt: "2026-09-27T00:00:00.000Z"
  }
};
state.scripts = { [disabledArtifact.id]: disabledArtifact };
const beforeDisabledArtifact = executed.length;
await runtime.injectForContext({ tabId: 9, frameId: 0, documentId: "disabled-artifact", url: "https://example.com/page" }, "document_start");
assert.equal(executed.length, beforeDisabledArtifact, "disabled external artifacts remain non-executable in selected workflows");

console.log("userscript runtime tests passed");
