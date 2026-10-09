import assert from "node:assert/strict";
import {
  createPortableBackupPayload,
  encodeBackupEnvelope,
  decodeBackupEnvelope,
  suggestPersonaBindings,
  backupInventory,
  validateBackupPayload,
  validateExternalArtifactHashes
} from "../lib/backup-package.js";
import { parseUserscriptMetadata } from "../lib/userscripts.js";

const WORK_UID = "90000000-0000-4000-8000-000000000001";
const PERSONAL_UID = "90000000-0000-4000-8000-000000000002";

const state = {
  schemaVersion: 3,
  global: { profileTargetCount:2, profileNamePrefix:"Persona", unmanagedPolicy:"direct", userscripts:{}, automation:{}, mullvadNative:{}, integration:{ enabled:true, trustedExtensionIds:["sender-id-private@example.test"], allowExternalAutomation:true, allowExecutableInstall:true } },
  profiles: {
    "firefox-container-1": { containerId:"firefox-container-1", personaUid:WORK_UID, managed:true, name:"Work", routeId:"route-a", killSwitch:true, blockLocalNetwork:true, domainMode:"any", allowedDomains:[], blockedDomains:[], scriptIds:["script-a"], notes:"", owned:true },
    "firefox-container-2": { containerId:"firefox-container-2", personaUid:PERSONAL_UID, managed:true, name:"Personal", routeId:"__direct__", killSwitch:true, blockLocalNetwork:true, domainMode:"any", allowedDomains:[], blockedDomains:[], scriptIds:[], notes:"", owned:true }
  },
  routes: {
    "route-a": { id:"route-a", name:"Proxy", provider:"generic", type:"https", host:"proxy.example", port:443, proxyDNS:false, username:"u", password:"p", enabled:true }
  },
  scripts: {
    "script-a": { id:"script-a", name:"Helper", code:"console.log('x')", enabled:true, autoRun:true, matches:["*://*/*"], excludeMatches:[], includes:[], excludes:[], runAt:"document_idle", allFrames:false, injectInto:"auto", world:"USER_SCRIPT", grants:[], requires:[], resources:{}, connects:[], tags:[], unwrap:false, profileIds:["firefox-container-1"], compatibility:{}, metaBlock:"" }
  },
  workflows: {
    "workflow-a": { id:"workflow-a", name:"Check", enabled:true, steps:[{ id:"step-1", profileId:"firefox-container-1", urls:["https://example.com/"], concurrency:1, scriptIds:["script-a"], completion:{mode:"load",value:"",timeoutMs:60000}, retries:0, retryDelayMs:1000, closeTabs:true, stopOnError:true }] }
  },
  wireguardImports: []
};
const artifactCode = "// ==UserScript==\n// @name Helper\n// @match *://*/*\n// @grant none\n// ==/UserScript==\nreturn 'ok';";
const artifactHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(artifactCode)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const ownerKey = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("personamonkey/external-artifact-owner/v1\0owner@example.test")))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
state.scripts["script-a"] = {
  ...state.scripts["script-a"], code: artifactCode,
  ...parseUserscriptMetadata(artifactCode, "org.example/package@1.2.3/component"),
  autoRun: false,
  externalArtifact: {
    artifactId: "org.example/package@1.2.3/component",
    sha256: artifactHash,
    ownerKey,
    provenance: { packageId: "org.example/package", packageVersion: "1.2.3", component: "component" },
    installedAt: "2026-09-27T00:00:00.000Z"
  }
};
const containers = [
  { cookieStoreId:"firefox-container-1", name:"Work", color:"blue", icon:"briefcase" },
  { cookieStoreId:"firefox-container-2", name:"Personal", color:"green", icon:"fingerprint" }
];
const payload = createPortableBackupPayload({
  state,
  containers,
  cookiesByProfile:{ "firefox-container-1":[{name:"sid",value:"secret",domain:"example.com",path:"/",secure:true,httpOnly:true,sameSite:"lax",session:true}] },
  userscriptData:{ "gm-values:script-a":{token:"abc"} },
  automationHistory:[
    {id:"job-1",state:"completed",workflowId:"workflow-a"},
    {id:"external-job-secret",state:"completed",workflowId:"external-exec",externalOwner:{senderId:"trusted-sender-secret"}}
  ],
  selection:{kind:"full"}
});

assert.equal(payload.personas.length, 2);
assert.equal(payload.personas.find((persona)=>persona.sourceId==="firefox-container-1").profile.personaUid,WORK_UID);
assert.equal(payload.personas.find((persona)=>persona.sourceId==="firefox-container-2").profile.personaUid,PERSONAL_UID);
assert.equal(payload.routes[0].route.password, "p");
assert.equal(payload.scripts[0].script.profileKeys.length, 1);
assert.deepEqual(payload.scripts[0].script.externalArtifact, state.scripts["script-a"].externalArtifact);
assert.equal(JSON.stringify(payload).includes("owner@example.test"), false, "portable backup preserves opaque ownership without exposing sender IDs");
assert.equal(payload.scripts[0].script.autoRun, false);
assert.equal(payload.scripts[0].code, artifactCode);
const duplicateArtifactWithForgedProvenance = structuredClone(payload.scripts[0].script);
duplicateArtifactWithForgedProvenance.externalArtifact.provenance.component = "forged-component";
await assert.rejects(
  validateExternalArtifactHashes([
    payload.scripts[0],
    { ...payload.scripts[0], script: duplicateArtifactWithForgedProvenance }
  ], { entries: true }),
  /conflicting ownership or SHA-256 identity/,
  "backup validation rejects duplicate artifact IDs with divergent provenance markers"
);
assert.equal(payload.settings.integration, undefined, "portable backups omit local Integration authority and trusted sender IDs");
assert.equal(JSON.stringify(payload).includes("sender-id-private@example.test"), false, "portable backups never contain trusted sender IDs");
assert.deepEqual(payload.automationHistory.map((job) => job.id), ["job-1"], "portable history excludes external automation executions");
assert.equal(payload.workflows[0].workflow.steps[0].personaKey, payload.personas.find((p)=>p.sourceId==="firefox-container-1").key);
assert.equal(backupInventory(payload).cookies, 1);
const legacyIdPayload = structuredClone(payload);
legacyIdPayload.scripts[0].sourceId = "foo.bar-1234abcd";
assert.equal(validateBackupPayload(legacyIdPayload), legacyIdPayload, "legacy punctuation and script IDs longer than world-name limits remain valid");
legacyIdPayload.scripts[0].sourceId = `long-${"x".repeat(300)}`;
assert.equal(validateBackupPayload(legacyIdPayload).scripts[0].sourceId.length, 305, "portable source IDs beyond old truncation limits must be preserved");
for (const sourceId of ["__proto__", "constructor", "bad\u0000id", "x".repeat(513), 42]) {
  const malformed = structuredClone(payload);
  malformed.scripts[0].sourceId = sourceId;
  assert.throws(() => validateBackupPayload(malformed), /userscript sourceId is invalid/);
}
await assert.rejects(() => encodeBackupEnvelope({payload}), /requires a password/);

const encoded = await encodeBackupEnvelope({ payload, password:"correct horse", appVersion:"0.6.1", stateSchemaVersion:3, scope:"full", iterations:1000 });
const outer = JSON.parse(encoded);
assert.equal(outer.format, "personamonkey-backup");
assert.equal(outer.payload, undefined);
assert.ok(outer.sealedPayload);
assert.equal(outer.sensitive, true);
const decoded = await decodeBackupEnvelope(encoded, "correct horse");
assert.deepEqual(decoded.payload, payload);
const corruptedArtifact = structuredClone(payload);
corruptedArtifact.scripts[0].code += "// tampered";
await assert.rejects(encodeBackupEnvelope({payload:corruptedArtifact,password:"correct horse",iterations:1000}), /SHA-256 does not match/);
await assert.rejects(() => decodeBackupEnvelope(encoded, "wrong"), /Unable to decrypt/);

const recoveryPayload = createPortableBackupPayload({ state, containers, selection:{kind:"full", cookies:false, gmValues:false, automationHistory:false, routeSecrets:false} });
// full intentionally means complete; use a selection for the non-sensitive recovery subset.
const recovery = createPortableBackupPayload({
  state,
  containers,
  selection:{kind:"selection", settings:true, profileIds:Object.keys(state.profiles), scriptIds:Object.keys(state.scripts), workflowIds:Object.keys(state.workflows), cookies:false, gmValues:false, automationHistory:false, routeSecrets:false}
});
assert.equal(recovery.routes[0].route.password, "");
assert.equal(Object.keys(recovery.cookies).length, 0);
assert.equal(Object.keys(recovery.gmValues).length, 0);
const plain = await encodeBackupEnvelope({ payload:recovery, scope:"recovery" });
assert.ok(JSON.parse(plain).payload);

const suggestions = suggestPersonaBindings(payload, [{cookieStoreId:"different-id",name:"Work"},{cookieStoreId:"firefox-container-2",name:"Personal"}]);
assert.equal(suggestions.find((s)=>s.key===payload.personas.find((p)=>p.name==="Personal").key).suggestedId, "firefox-container-2");
assert.equal(suggestions.find((s)=>s.key===payload.personas.find((p)=>p.name==="Work").key).suggestedId, "different-id");
console.log("portable backup package tests passed");
