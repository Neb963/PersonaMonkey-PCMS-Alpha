import assert from "node:assert/strict";
import { buildImportedState, backupComponents, remapAutomationHistory } from "../lib/backup-import.js";
import { parseUserscriptMetadata } from "../lib/userscripts.js";

const EXISTING_UID = "a0000000-0000-4000-8000-000000000001";
const IMPORTED_UID = "a0000000-0000-4000-8000-000000000002";
const REMAPPED_UID = "a0000000-0000-4000-8000-000000000003";
const LEGACY_ASSIGNED_UID = "a0000000-0000-4000-8000-000000000004";

const current = {
  schemaVersion:3,
  global:{profileTargetCount:30,profileNamePrefix:"Persona",unmanagedPolicy:"direct",userscripts:{},automation:{},mullvadNative:{}},
  profiles:{
    existing:{containerId:"existing",personaUid:EXISTING_UID,managed:true,name:"Existing",routeId:"__direct__",killSwitch:true,blockLocalNetwork:true,domainMode:"any",allowedDomains:[],blockedDomains:[],scriptIds:[],notes:"",owned:false}
  },
  routes:{conflict:{id:"conflict",name:"Existing route",provider:"generic",type:"https",host:"old.example",port:443,proxyDNS:false,username:"",password:"",enabled:true}},
  scripts:{conflict:{id:"conflict",name:"Existing script",code:"old",enabled:true,profileIds:["existing"],matches:["*://*/*"],excludeMatches:[],includes:[],excludes:[],runAt:"document_idle",allFrames:false,injectInto:"auto",world:"USER_SCRIPT",grants:[],requires:[],resources:{},connects:[],tags:[],unwrap:false,compatibility:{},metaBlock:""}},
  workflows:{conflict:{id:"conflict",name:"Existing workflow",enabled:true,steps:[{id:"s",profileId:"existing",urls:["https://old.example/"],concurrency:1,scriptIds:[],completion:{mode:"load",value:"",timeoutMs:60000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]}},
  wireguardImports:[]
};

const payload={
  version:1,
  settings:{profileTargetCount:5,profileNamePrefix:"Recovered",unmanagedPolicy:"block",userscripts:{},automation:{},mullvadNative:{}},
  routes:[{key:"route-1",sourceId:"conflict",route:{name:"Imported route",provider:"generic",type:"https",host:"new.example",port:443,proxyDNS:false,username:"",password:"",enabled:true}}],
  personas:[{key:"persona-1",sourceId:"old-container",name:"Imported Persona",profile:{personaUid:IMPORTED_UID,managed:true,name:"Imported Persona",routeMode:"route",routeKey:"route-1",killSwitch:true,blockLocalNetwork:true,domainMode:"any",allowedDomains:[],blockedDomains:[],scriptKeys:["script-1"],notes:"",owned:true}}],
  scripts:[{key:"script-1",sourceId:"conflict",script:{name:"Imported script",enabled:true,autoRun:true,matches:["https://example.com/*"],excludeMatches:[],includes:[],excludes:[],runAt:"document_idle",allFrames:false,injectInto:"auto",world:"MAIN",grants:["none"],requires:[],resources:{},connects:[],tags:[],unwrap:false,profileKeys:["persona-1"],compatibility:{},metaBlock:""},code:"Persona.complete(true);"}],
  workflows:[{key:"workflow-1",sourceId:"conflict",workflow:{name:"Imported workflow",enabled:true,steps:[{id:"step-1",personaKey:"persona-1",urls:["https://example.com/"],concurrency:1,scriptKeys:["script-1"],completion:{mode:"signal",value:"",timeoutMs:60000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]}}],
  cookies:{"persona-1":[]},gmValues:{},automationHistory:[]
};

const components=backupComponents(payload);
assert.deepEqual([...components].sort(),["cookies","personas","routes","settings","userscripts","workflows"].sort());

const result=await buildImportedState({payload,currentState:current,profileBindings:new Map([["persona-1","mapped-container"]]),mode:"merge"});
assert.equal(result.state.profiles.existing.routeId,"__direct__");
assert.equal(result.state.profiles["mapped-container"].managed,true);
assert.equal(result.state.profiles["mapped-container"].personaUid,IMPORTED_UID,"merge preserves a non-colliding imported UID");
assert.equal(result.maps.personaUid.get("persona-1"),IMPORTED_UID);
assert.notEqual(result.maps.route.get("route-1"),"conflict","different route must not overwrite colliding local route");
assert.notEqual(result.maps.script.get("script-1"),"conflict","different script must not overwrite colliding local script");
const importedWorkflowId=result.maps.workflow.get("conflict");
assert.notEqual(importedWorkflowId,"conflict","merge must preserve colliding local workflow");
const importedStep=result.state.workflows[importedWorkflowId].steps[0];
assert.equal(importedStep.profileId,"mapped-container");
assert.deepEqual(importedStep.scriptIds,[result.maps.script.get("script-1")]);
assert.equal(result.state.profiles["mapped-container"].routeId,result.maps.route.get("route-1"));
assert.equal(result.state.global.profileNamePrefix,"Recovered");

const repeated=await buildImportedState({payload,currentState:result.state,profileBindings:new Map([["persona-1","mapped-container"]]),mode:"merge"});
assert.equal(Object.keys(repeated.state.workflows).length,Object.keys(result.state.workflows).length,"re-importing an identical backup must not duplicate workflows");
assert.equal(repeated.maps.workflow.get("conflict"),result.maps.workflow.get("conflict"),"identical workflow imports must reuse the existing mapped workflow");

const replaced=await buildImportedState({payload,currentState:current,profileBindings:{"persona-1":"mapped-container"},mode:"replace"});
assert.equal(replaced.state.profiles.existing.managed,false);
assert.equal(replaced.state.profiles.existing.routeId,"__block__");
assert.equal(replaced.state.profiles.existing.personaUid,null,"replace demotes old compatibility records without retaining restored logical identity");
assert.equal(replaced.state.profiles["mapped-container"].personaUid,IMPORTED_UID,"replace preserves backup personaUid");
assert.equal(Object.keys(replaced.state.workflows).length,1);
assert.equal(Object.keys(replaced.state.routes).length,1);
assert.equal(Object.keys(replaced.state.scripts).length,1);

const localIntegrationPolicy={
  enabled:false,
  trustedExtensionIds:["local@example.test"],
  allowDestructive:false,
  allowDirect:false,
  allowExternalAutomation:false,
  allowExecutableInstall:false
};
const authorityPayload=structuredClone(payload);
authorityPayload.settings.integration={
  enabled:true,
  trustedExtensionIds:["attacker@example.test"],
  allowDestructive:true,
  allowDirect:true
};
authorityPayload.personas[0].profile.routeMode="direct";
authorityPayload.personas[0].profile.killSwitch=false;
authorityPayload.routes[0].route.host="review-this.example";
for (const mode of ["merge","replace"]) {
  const localState={...structuredClone(current),global:{...structuredClone(current.global),integration:localIntegrationPolicy}};
  const reviewed=await buildImportedState({
    payload:authorityPayload,
    currentState:localState,
    profileBindings:new Map([["persona-1","mapped-container"]]),
    mode
  });
  assert.deepEqual(reviewed.state.global.integration,localIntegrationPolicy,`${mode} import must retain local Integration authority`);
  assert.equal(reviewed.state.profiles["mapped-container"].routeId,"__direct__",`${mode} import must retain Direct in the proposed state for review`);
  assert.equal(reviewed.state.profiles["mapped-container"].killSwitch,false,`${mode} import must retain kill-switch weakening in the proposed state for review`);
  const importedRouteId=reviewed.maps.route.get("route-1");
  assert.equal(reviewed.state.routes[importedRouteId].host,"review-this.example",`${mode} import must retain the changed endpoint in the proposed state for review`);
}

for (const sourceId of ["foo.bar-1234abcd", `long-${"x".repeat(300)}`]) {
  const identityPayload = structuredClone(payload);
  identityPayload.scripts[0].sourceId = sourceId;
  const identityState = structuredClone(current);
  identityState.scripts["foo-bar-1234abcd"] = {
    ...identityState.scripts.conflict,
    id: "foo-bar-1234abcd",
    name: "Punctuation neighbor",
    code: "different source"
  };
  const identityResult = await buildImportedState({payload:identityPayload,currentState:identityState,profileBindings:new Map([["persona-1","mapped-container"]]),mode:"merge"});
  assert.equal(identityResult.state.scripts[sourceId].id, sourceId, "backup import must preserve long and punctuation-distinct script identity");
  assert.ok(identityResult.state.scripts["foo-bar-1234abcd"], "near-colliding script IDs must remain separate");
}

const collisionPayload=structuredClone(payload);
collisionPayload.personas[0].profile.personaUid=EXISTING_UID;
const collision=await buildImportedState({
  payload:collisionPayload,
  currentState:current,
  profileBindings:new Map([["persona-1","mapped-container"]]),
  mode:"merge",
  generatePersonaUid:()=>REMAPPED_UID
});
assert.equal(collision.state.profiles["mapped-container"].personaUid,REMAPPED_UID);
assert.deepEqual(collision.diagnostics.personaUidRemaps,[{
  personaKey:"persona-1",
  sourcePersonaUid:EXISTING_UID,
  personaUid:REMAPPED_UID,
  reason:"collision"
}]);

const legacyPayload=structuredClone(payload);
delete legacyPayload.personas[0].profile.personaUid;
const legacy=await buildImportedState({
  payload:legacyPayload,
  currentState:current,
  profileBindings:new Map([["persona-1","legacy-container"]]),
  mode:"merge",
  generatePersonaUid:()=>LEGACY_ASSIGNED_UID
});
assert.equal(legacy.state.profiles["legacy-container"].personaUid,LEGACY_ASSIGNED_UID,"schema-2-era backup entries receive a new durable UID");

const history=remapAutomationHistory([{id:"j",workflowId:"conflict",state:"running",tasks:[{profileId:"old-container"}],stepProgress:[{profileId:"old-container"}]}],{
  workflow:new Map([["conflict","new-workflow"]]),profileSource:new Map([["old-container","mapped-container"]])
});
assert.equal(history[0].state,"interrupted");
assert.equal(history[0].workflowId,"new-workflow");
assert.equal(history[0].tasks[0].profileId,"mapped-container");
await assert.rejects(buildImportedState({payload,currentState:current,profileBindings:{},mode:"merge"}),/mapping is missing/);

const artifactCode = "// ==UserScript==\n// @name Imported script\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\n// immutable artifact\n";
const artifactHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(artifactCode)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const ownerKey = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("personamonkey/external-artifact-owner/v1\0owner@example.test")))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const artifactPayload = structuredClone(payload);
artifactPayload.scripts[0].sourceId = "conflict";
artifactPayload.scripts[0].code = artifactCode;
Object.assign(artifactPayload.scripts[0].script, parseUserscriptMetadata(artifactCode, "org.example/package@1/component"));
artifactPayload.scripts[0].script.autoRun = false;
artifactPayload.scripts[0].script.externalArtifact = {
  artifactId: "org.example/package@1/component",
  sha256: artifactHash,
  ownerKey,
  provenance: { packageId: "org.example/package", packageVersion: "1", component: "main" },
  installedAt: "2026-09-27T00:00:00.000Z"
};
const artifactImported = await buildImportedState({payload:artifactPayload,currentState:current,profileBindings:{"persona-1":"mapped-container"},mode:"merge"});
const importedArtifact = Object.values(artifactImported.state.scripts).find((script) => script.externalArtifact?.artifactId === "org.example/package@1/component");
assert.ok(importedArtifact, "external artifact marker survives portable import");
assert.equal(importedArtifact.code, artifactCode);
assert.equal(importedArtifact.autoRun, false, "external artifacts remain workflow-only after normalization");
assert.equal(importedArtifact.externalArtifact.ownerKey, ownerKey, "backup import preserves opaque artifact ownership");
assert.equal(importedArtifact.externalArtifact.ownershipVerified, false,
  "portable backup ownership is an unverified claim until the authenticated sender reclaims exact bytes");
assert.notEqual(importedArtifact.id, "conflict", "an artifact does not overwrite an unrelated local script ID");
const repeatedArtifactImport = await buildImportedState({payload:artifactPayload,currentState:artifactImported.state,profileBindings:{"persona-1":"mapped-container"},mode:"merge"});
assert.equal(Object.values(repeatedArtifactImport.state.scripts).filter((script) => script.externalArtifact?.artifactId === "org.example/package@1/component").length, 1, "reimport reuses the artifact identity rather than duplicating it");
assert.equal(Object.values(repeatedArtifactImport.state.scripts).find((script) => script.externalArtifact?.artifactId === "org.example/package@1/component").id, importedArtifact.id);
const localCopyPayload = structuredClone(artifactPayload);
delete localCopyPayload.scripts[0].script.externalArtifact;
localCopyPayload.scripts[0].script.autoRun = false;
const ordinaryImport = await buildImportedState({payload:localCopyPayload,currentState:artifactImported.state,profileBindings:{"persona-1":"mapped-container"},mode:"merge"});
assert.ok(ordinaryImport.state.scripts[importedArtifact.id].externalArtifact, "an ordinary same-source import cannot strip an installed artifact marker");
assert.ok(Object.values(ordinaryImport.state.scripts).some((script) => !script.externalArtifact && script.code === artifactCode), "ordinary source can still be imported as a separate local script");

const tamperedArtifactPayload = structuredClone(artifactPayload);
tamperedArtifactPayload.scripts[0].code += "tamper";
await assert.rejects(buildImportedState({payload:tamperedArtifactPayload,currentState:current,profileBindings:{"persona-1":"mapped-container"},mode:"merge"}), /SHA-256 does not match/);

const conflictingLocal = structuredClone(current);
const localArtifactCode = "local artifact bytes";
const localArtifactHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(localArtifactCode)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
conflictingLocal.scripts.conflict.code = localArtifactCode;
Object.assign(conflictingLocal.scripts.conflict, parseUserscriptMetadata(localArtifactCode, "org.example/package@1/component"));
conflictingLocal.scripts.conflict.externalArtifact = {
  ...artifactPayload.scripts[0].script.externalArtifact,
  artifactId: "org.example/package@1/component",
  sha256: localArtifactHash
};
conflictingLocal.scripts.conflict.autoRun = false;
await assert.rejects(buildImportedState({payload:artifactPayload,currentState:conflictingLocal,profileBindings:{"persona-1":"mapped-container"},mode:"merge"}), /conflicting ownership or SHA-256 identity/);

const differentOwnerState = structuredClone(artifactImported.state);
const differentOwnerRecord = Object.values(differentOwnerState.scripts).find((script) => script.externalArtifact?.artifactId === "org.example/package@1/component");
differentOwnerRecord.externalArtifact.ownerKey = "0".repeat(64);
const ownerScopedImport = await buildImportedState({
  payload: artifactPayload, currentState: differentOwnerState,
  profileBindings: {"persona-1":"mapped-container"}, mode: "merge"
});
const sameNamedArtifacts = Object.values(ownerScopedImport.state.scripts)
  .filter((script) => script.externalArtifact?.artifactId === "org.example/package@1/component");
assert.equal(sameNamedArtifacts.length, 2, "portable merge keeps same artifact IDs independent across owners");
assert.equal(new Set(sameNamedArtifacts.map((script) => script.externalArtifact.ownerKey)).size, 2,
  "same-named portable artifacts must retain distinct opaque owners");

const shiftedInstallTimePayload = structuredClone(artifactPayload);
shiftedInstallTimePayload.scripts[0].script.externalArtifact.installedAt = "2026-09-27T01:00:00.000Z";
const shiftedInstallTimeImport = await buildImportedState({
  payload: shiftedInstallTimePayload, currentState: artifactImported.state,
  profileBindings: {"persona-1":"mapped-container"}, mode: "merge"
});
assert.equal(Object.values(shiftedInstallTimeImport.state.scripts)
  .filter((script) => script.externalArtifact?.artifactId === "org.example/package@1/component"
    && script.externalArtifact?.ownerKey === ownerKey).length, 1,
  "installedAt is metadata, not artifact identity");

const unsafeMetadataCases = [
  ["remote @require", (script) => { script.requires = ["https://cdn.example.test/helper.js"]; }],
  ["remote @resource", (script) => { script.resources = { helper: "https://cdn.example.test/helper.js" }; }],
  ["update URL", (script) => { script.updateURL = "https://cdn.example.test/update.js"; }],
  ["download URL", (script) => { script.downloadURL = "https://cdn.example.test/install.js"; }],
  ["extra GM grant", (script) => { script.grants = ["none", "GM_xmlhttpRequest"]; }],
  ["widened match", (script) => { script.matches = ["https://example.com/*", "*://*/*"]; }],
  ["host scope declaration", (script) => { script.hostScopeDeclared = false; }],
  ["world", (script) => { script.world = "USER_SCRIPT"; }],
  ["all frames", (script) => { script.allFrames = false; }],
  ["connect scope", (script) => { script.connects = ["*"]; }],
  ["source URL", (script) => { script.sourceURL = "https://cdn.example.test/source.user.js"; }],
  ["metadata block", (script) => { script.metaBlock = "// ==UserScript==\n// @grant GM_xmlhttpRequest\n// ==/UserScript=="; }]
];
for (const [label, tamper] of unsafeMetadataCases) {
  const metadataTampered = structuredClone(artifactPayload);
  tamper(metadataTampered.scripts[0].script);
  assert.equal(metadataTampered.scripts[0].code, artifactCode, `${label}: artifact source bytes are unchanged`);
  assert.equal(metadataTampered.scripts[0].script.externalArtifact.sha256, artifactHash, `${label}: artifact digest is unchanged`);
  await assert.rejects(
    buildImportedState({payload:metadataTampered,currentState:current,profileBindings:{"persona-1":"mapped-container"},mode:"merge"}),
    /metadata does not match its safe source/,
    `${label}: metadata changes must be rejected while source bytes and digest are unchanged`
  );
}
const remoteSource = "// ==UserScript==\n// @name Remote dependency\n// @match https://example.com/*\n// @grant none\n// @require https://cdn.example.test/helper.js\n// ==/UserScript==\n";
const remoteSourcePayload = structuredClone(artifactPayload);
remoteSourcePayload.scripts[0].code = remoteSource;
Object.assign(remoteSourcePayload.scripts[0].script, parseUserscriptMetadata(remoteSource, "org.example/package@1/component"));
remoteSourcePayload.scripts[0].script.externalArtifact.sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(remoteSource)))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
await assert.rejects(
  buildImportedState({payload:remoteSourcePayload,currentState:current,profileBindings:{"persona-1":"mapped-container"},mode:"merge"}),
  /metadata does not match its safe source/,
  "an external artifact whose original source declares a remote dependency is rejected"
);

const provenanceTamperedState = structuredClone(artifactImported.state);
const importedProvenanceArtifact = Object.values(provenanceTamperedState.scripts).find((script) => script.externalArtifact?.artifactId === "org.example/package@1/component");
importedProvenanceArtifact.externalArtifact.provenance.component = "different-component";
await assert.rejects(
  buildImportedState({payload:artifactPayload,currentState:provenanceTamperedState,profileBindings:{"persona-1":"mapped-container"},mode:"merge"}),
  /conflicting ownership or SHA-256 identity/,
  "reimport cannot replace an existing artifact's immutable provenance marker"
);
console.log("backup import remapping tests passed");
