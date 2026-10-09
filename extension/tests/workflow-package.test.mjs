import assert from "node:assert/strict";
import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "../lib/constants.js";
import { normalizeProfile, normalizeScript, normalizeWorkflow } from "../lib/storage.js";
import { exportWorkflowPackage, inspectWorkflowPackage, importWorkflowPackage, personaMatchesRequirement, validateWorkflowPackageManifest } from "../lib/workflow-package.js";

const scriptCode = `// ==UserScript==\n// @name Package signal\n// @match https://example.com/*\n// @grant GM_info\n// @grant Persona.signal\n// ==/UserScript==\nPersona.complete({ ok: true });\n`;
const sourceState = {
  profiles: {
    "firefox-container-1": normalizeProfile({ name: "Source Persona", managed: true, routeId: DIRECT_ROUTE_ID, scriptIds: ["signal-script"] }, "firefox-container-1")
  },
  routes: {},
  scripts: {
    "signal-script": normalizeScript({ name: "Package signal", code: scriptCode, grants: ["GM_info", "Persona.signal"], matches: ["https://example.com/*"], profileIds: ["firefox-container-1"] }, "signal-script")
  },
  workflows: {}
};
const sourceWorkflow = normalizeWorkflow({
  id: "source-workflow",
  name: "Portable signal workflow",
  steps: [{
    profileId: "firefox-container-1",
    urls: ["https://example.com/"],
    concurrency: 1,
    scriptIds: ["signal-script"],
    completion: { mode: "signal", value: "", timeoutMs: 30000 },
    retries: 2,
    retryDelayMs: 2500,
    closeTabs: true,
    stopOnError: true
  }]
}, "source-workflow");

const exported = await exportWorkflowPackage(sourceWorkflow, sourceState);
assert.match(exported.filename, /portable-signal-workflow\.personamonkey\.zip$/);
assert.equal(exported.manifest.formatVersion, 1);
assert.equal(exported.manifest.personas.length, 1);
assert.equal(exported.manifest.scripts.length, 1);
assert.equal(exported.manifest.workflow.steps[0].personaKey, "persona-1");
assert.equal(exported.manifest.workflow.steps[0].scriptKeys[0], "script-1");
assert.equal(exported.manifest.workflow.steps[0].retryDelayMs, 2500);
assert.ok(!JSON.stringify(exported.manifest).includes("firefox-container-1"), "portable manifest must not depend on local container IDs");
assert.deepEqual(validateWorkflowPackageManifest(exported.manifest, new Map()), []);

const targetState = {
  profiles: {
    "firefox-container-2": normalizeProfile({ name: "Target Persona", managed: true, routeId: DIRECT_ROUTE_ID }, "firefox-container-2")
  },
  routes: {},
  scripts: {},
  workflows: {}
};
const preview = await inspectWorkflowPackage(exported.bytes, targetState);
assert.equal(preview.scripts[0].metadata.name, "Package signal");
assert.deepEqual(preview.scripts[0].metadata.grants, ["GM_info", "Persona.signal"], "package preview must expose userscript grants parsed from the inspected source");
assert.equal(preview.personas[0].candidates[0].id, "firefox-container-2");
const imported = importWorkflowPackage(preview, targetState, { "persona-1": "firefox-container-2" });
assert.equal(imported.workflow.steps[0].profileId, "firefox-container-2");
assert.equal(imported.importedScripts.length, 1);
const importedScriptId = imported.importedScripts[0];
assert.ok(imported.state.scripts[importedScriptId].profileIds.includes("firefox-container-2"), "package script should be auto-assigned to mapped persona");
assert.deepEqual(imported.workflow.steps[0].scriptIds, [importedScriptId]);

const blocked = normalizeProfile({ name: "Blocked", managed: true, routeId: BLOCK_ROUTE_ID }, "blocked");
assert.equal(personaMatchesRequirement(blocked, { routes: {} }, "any"), false, "package mapping must not suggest a persona that Run rejects");
assert.equal(personaMatchesRequirement({ ...blocked, routeId: "missing" }, { routes: {} }, "networked"), false, "missing routes cannot run");
assert.equal(personaMatchesRequirement({ ...blocked, routeId: "r" }, { routes: { r: { enabled: false } } }, "protected"), false, "disabled routes cannot run");
await assert.rejects(exportWorkflowPackage(sourceWorkflow, {
  ...sourceState, profiles: { "firefox-container-1": { ...sourceState.profiles["firefox-container-1"], routeId: BLOCK_ROUTE_ID } }
}), /selected persona is set to Block/);

const mainWorldBytes = await exportWorkflowPackage({ ...sourceWorkflow, steps: [{ ...sourceWorkflow.steps[0], completion: { mode: "load" } }] }, {
  ...sourceState, scripts: { "signal-script": { ...sourceState.scripts["signal-script"], code: scriptCode.replace("@grant GM_info", "@grant none"), grants: ["none"] } }
});
const unsafeFiles = await import("../lib/zip.js").then(({ readZip }) => readZip(mainWorldBytes.bytes));
const unsafeManifest = structuredClone(mainWorldBytes.manifest);
unsafeManifest.workflow.steps[0].completion.mode = "signal";
const { createStoredZip } = await import("../lib/zip.js");
const unsafeZip = createStoredZip([...unsafeFiles].map(([name, data]) => ({ name, data: name === "manifest.json" ? JSON.stringify(unsafeManifest) : data })));
await assert.rejects(inspectWorkflowPackage(unsafeZip, targetState), /signal userscript .* runs in MAIN/);

const noSignalExport = await exportWorkflowPackage({ ...sourceWorkflow, steps: [{ ...sourceWorkflow.steps[0], completion: { mode: "load" } }] }, {
  ...sourceState,
  scripts: { "signal-script": { ...sourceState.scripts["signal-script"], code: scriptCode.replace("// @grant Persona.signal\n", ""), grants: ["GM_info"] } }
});
const noSignalFiles = await import("../lib/zip.js").then(({ readZip }) => readZip(noSignalExport.bytes));
const noSignalManifest = structuredClone(noSignalExport.manifest);
noSignalManifest.workflow.steps[0].completion.mode = "signal";
const noSignalZip = createStoredZip([...noSignalFiles].map(([name, data]) => ({ name, data: name === "manifest.json" ? JSON.stringify(noSignalManifest) : data })));
await assert.rejects(inspectWorkflowPackage(noSignalZip, targetState), /must declare @grant Persona\.signal/);

const secondPreview = await inspectWorkflowPackage(exported.bytes, imported.state);
const reused = importWorkflowPackage(secondPreview, imported.state, { "persona-1": "firefox-container-2" });
assert.equal(reused.importedScripts.length, 0);
assert.equal(reused.reusedScripts.length, 1, "identical installed script should be reused");

const bad = structuredClone(exported.manifest);
bad.workflow.steps[0].scriptKeys = ["missing-script"];
assert.ok(validateWorkflowPackageManifest(bad, new Map()).some((error) => error.includes("unknown scriptKey")));

console.log("workflow package tests passed");
