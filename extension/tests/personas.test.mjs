import assert from "node:assert/strict";

const PERSONA_UIDS = Array.from({ length: 6 }, (_, index) =>
  `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
let personaUidIndex = 0;
function generatePersonaUid() {
  const value = PERSONA_UIDS[personaUidIndex++];
  if (!value) throw new Error("deterministic Persona UID sequence exhausted");
  return value;
}

const mod = await import(`../lib/personas.js?test=${Date.now()}`);

let state = {
  global: { profileTargetCount: 2, profileNamePrefix: "Persona", autoReloadOnRouteChange: true },
  profiles: {}, routes: {}, scripts: {}, workflows: {}, wireguardImports: []
};
let containers = [];
let seq = 0;
const reloaded = [];
const removedTabs = [];
const openTabIds = new Set([7]);
const createdTabs = [];
let automationJobs = {job1:{id:"job1",profileId:"firefox-container-1",tasks:[{profileId:"firefox-container-1"}],stepProgress:[{profileId:"firefox-container-1"}]}};
const browserApi = {
  contextualIdentities: {
    async query() { return containers.map((x) => ({ ...x })); },
    async create({ name, color, icon }) {
      const created = { cookieStoreId: `firefox-container-${++seq}`, name, color, icon };
      containers.push(created);
      return { ...created };
    },
    async get(id) { return { ...containers.find((item) => item.cookieStoreId === id) }; },
    async update(id, changes) {
      const item = containers.find((entry) => entry.cookieStoreId === id);
      Object.assign(item, changes);
      return { ...item };
    },
    async remove(id) { containers = containers.filter((entry) => entry.cookieStoreId !== id); },
    async getSupportedColors() { return ["blue", "green"]; },
    async getSupportedIcons() { return ["fingerprint", "briefcase"]; }
  },
  tabs: {
    async query({ cookieStoreId }) { return openTabIds.has(7) ? [{ id: 7, cookieStoreId }] : []; },
    async reload(id) { reloaded.push(id); },
    async create(details) { createdTabs.push({ ...details }); return { id: 8, ...details }; },
    async remove(ids) {
      const list = Array.isArray(ids) ? ids : [ids];
      removedTabs.push(...list);
      for (const id of list) openTabIds.delete(id);
    }
  },
  storage: { local: { async get() { return {automationJobs:structuredClone(automationJobs)}; }, async set(value) { if (value.automationJobs) automationJobs=structuredClone(value.automationJobs); } } }
};
const savedStates = [];
const manager = mod.createPersonaManager({
  getState: async () => state,
  setState: async (next) => {
    state = structuredClone(next);
    savedStates.push(structuredClone(state));
    return state;
  },
  browserApi,
  generatePersonaUid
});

const created = await manager.ensureProfiles(2, "Persona");
assert.equal(Object.values(created.state.profiles).filter((p) => p.managed).length, 2);
for (const profile of Object.values(created.state.profiles)) {
  assert.equal(profile.routeId, "__block__", "new personas must start fail closed");
  assert.equal(profile.killSwitch, true);
  assert.equal(profile.owned, true);
  assert.ok(profile.personaUid);
}
assert.equal(new Set(Object.values(created.state.profiles).map((profile) => profile.personaUid)).size, 2);
const sourcePersonaUid = state.profiles["firefox-container-1"].personaUid;

state.routes.r1 = { id: "r1", enabled: true };
await manager.updateProfileRoute("firefox-container-1", "r1");
assert.equal(state.profiles["firefox-container-1"].routeId, "r1");
assert.deepEqual(reloaded, [7]);

state.scripts.s1 = {id:"s1",name:"One",code:"",profileIds:["firefox-container-1"]};
state.profiles["firefox-container-1"].scriptIds = ["s1"];
state.workflows.w1 = {id:"w1",name:"Research",steps:[{id:"step-1",profileId:"firefox-container-1",urls:[],scriptIds:["s1"]}]};
const duplicated = await manager.duplicate("firefox-container-1", {userscripts:true,workflows:true});
assert.equal(duplicated.profile.routeId,"r1");
assert.notEqual(duplicated.profile.personaUid,sourcePersonaUid,"clone receives a fresh logical identity");
assert.equal(state.scripts.s1.profileIds.includes(duplicated.profile.containerId),true);
assert.equal(duplicated.workflowIds.length,1);
await manager.updateIdentity(duplicated.profile.containerId,{name:"Research Copy",color:"green"});
assert.equal(state.profiles[duplicated.profile.containerId].name,"Research Copy");
assert.equal(state.profiles[duplicated.profile.containerId].personaUid,duplicated.profile.personaUid,"identity edits preserve personaUid");
await manager.open(duplicated.profile.containerId);
assert.equal("url" in createdTabs.at(-1),false,"opening a persona without a URL must let Firefox choose the normal New Tab page");
assert.equal(createdTabs.at(-1).cookieStoreId,duplicated.profile.containerId);
assert.equal(createdTabs.at(-1).active,true);
await manager.open(duplicated.profile.containerId,undefined,false);
assert.equal("url" in createdTabs.at(-1),false,"repeat opens without a URL must also let Firefox choose the New Tab page");
assert.equal(createdTabs.at(-1).cookieStoreId,duplicated.profile.containerId);
assert.equal(createdTabs.at(-1).active,false,"inactive opens must preserve their requested focus behavior");
await manager.open(duplicated.profile.containerId,"https://example.com",false);
assert.equal(createdTabs.at(-1).url,"https://example.com");
assert.equal(createdTabs.at(-1).cookieStoreId,duplicated.profile.containerId);
assert.equal(createdTabs.at(-1).active,false);
assert.ok(state.profiles[duplicated.profile.containerId].lastUsedAt);
const opensBeforeFailedCreate = state.profiles[duplicated.profile.containerId].statistics.opens;
const originalTabCreate = browserApi.tabs.create;
browserApi.tabs.create = async () => { throw new Error("Illegal URL"); };
await assert.rejects(manager.open(duplicated.profile.containerId,"unsupported:test-url"),/Illegal URL/);
assert.equal(state.profiles[duplicated.profile.containerId].statistics.opens,opensBeforeFailedCreate,"failed tab creation must not count as a successful open");
browserApi.tabs.create = originalTabCreate;
const blankClone = await manager.duplicate("firefox-container-1", {settings:false,userscripts:false,workflows:false});
assert.equal(blankClone.profile.routeId,"__block__","route must not leak through when settings are excluded");
assert.notEqual(blankClone.profile.personaUid,sourcePersonaUid);
state.profiles["firefox-container-1"].killSwitch = false;
state.profiles["firefox-container-1"].blockLocalNetwork = false;
automationJobs.externalJob = {
  id:"externalJob", profileId:"firefox-container-1", state:"completed",
  externalOwner:{senderId:"trusted-sender-secret",executionId:"external-exec"},
  tasks:[{profileId:"firefox-container-1"}]
};
const safeClone = await manager.clone("firefox-container-1", {copySettings:true,copyScripts:true,copyWorkflows:true,copyCookies:false,copyStorage:false,copyTabs:false,copySessionState:true});
assert.equal(safeClone.profile.killSwitch,true,"clones start with a kill switch even when the source is relaxed");
assert.equal(safeClone.profile.blockLocalNetwork,true,"clones start with LAN blocking even when the source is relaxed");
state.profiles["firefox-container-1"].killSwitch = true;
state.profiles["firefox-container-1"].blockLocalNetwork = true;
assert.notEqual(safeClone.profile.personaUid,sourcePersonaUid);
assert.equal(safeClone.include.cookies,false);
assert.equal(safeClone.include.storage,false);
assert.equal(safeClone.include.openTabs,false);
assert.equal(safeClone.historyEntries, 1, "persona history cloning excludes externally owned executions");
assert.equal(Object.values(automationJobs).filter((job) => job.externalOwner).length, 1, "the original external record remains untouched");

savedStates.length = 0;
const wiped = await manager.fullWipe("firefox-container-1");
assert.notEqual(wiped.profile.containerId,"firefox-container-1");
assert.equal(wiped.profile.personaUid,sourcePersonaUid,"successful full wipe preserves the logical Persona");
const preparedRotation = savedStates.find((saved) => Object.keys(saved.personaRotations || {}).length === 1);
assert.equal(preparedRotation.profiles["firefox-container-1"].personaUid, sourcePersonaUid, "journal preparation keeps the source logical identity intact");
assert.equal(preparedRotation.profiles["firefox-container-1"].managed, true, "journal preparation keeps source routing managed");
const cutoverRotation = savedStates.find((saved) =>
  saved.profiles["firefox-container-1"]?.rotationRole === "source"
  && saved.profiles[wiped.profile.containerId]?.personaUid === sourcePersonaUid);
assert.ok(cutoverRotation, "rotation persists an explicit UID cutover stage");
assert.equal(cutoverRotation.profiles["firefox-container-1"].managed, true, "old source remains managed until tab quiescence");
assert.equal(cutoverRotation.profiles["firefox-container-1"].routeId, "r1", "old source retains its protected route while tabs can still exist");
assert.equal(state.profiles["firefox-container-1"],undefined);
assert.equal(state.profiles[wiped.profile.containerId].routeId,"r1");
assert.deepEqual(state.scripts.s1.profileIds.includes(wiped.profile.containerId),true);
assert.equal(state.workflows.w1.steps[0].profileId,wiped.profile.containerId);
assert.equal(automationJobs.job1.profileId,wiped.profile.containerId);
assert.deepEqual(removedTabs,[7]);

containers.find((item) => item.cookieStoreId === wiped.profile.containerId).name = "Renamed";
await manager.handleUpdated({ contextualIdentity: { cookieStoreId: wiped.profile.containerId, name: "Renamed" } });
assert.equal(state.profiles[wiped.profile.containerId].name, "Renamed");
await manager.handleRemoved({ contextualIdentity: { cookieStoreId: wiped.profile.containerId } });
assert.equal(state.profiles[wiped.profile.containerId].managed, false);
assert.equal(state.profiles[wiped.profile.containerId].routeId, "__block__");
await manager.remove(duplicated.profile.containerId);
assert.equal(state.profiles[duplicated.profile.containerId],undefined);

const temporary = await manager.create({name:"Agent-Test",profile:{temporary:true,expiresAt:"2026-01-01T00:00:00.000Z"}});
assert.equal(temporary.profile.status,"temporary");
const expired = await manager.cleanupExpired(Date.parse("2026-01-02T00:00:00.000Z"));
assert.deepEqual(expired,[{id:temporary.profile.containerId,removed:true}]);
const archived = await manager.archive(safeClone.profile.containerId);
assert.equal(archived.profile.status,"archived");
assert.equal(archived.profile.routeId,"__block__");
assert.equal(archived.previousRouteId,"r1");
assert.equal(archived.profile.personaUid,safeClone.profile.personaUid,"archive preserves personaUid");

const suppliedPersonaUid = "4fffffff-ffff-4fff-8fff-ffffffffffff";
const supplied = await manager.create({name:"Internally supplied",profile:{personaUid:suppliedPersonaUid}});
assert.equal(supplied.profile.personaUid,suppliedPersonaUid,"trusted internal create may supply an unused validated UID");
await assert.rejects(
  manager.create({name:"Duplicate supplied",profile:{personaUid:suppliedPersonaUid}}),
  /already assigned/
);

console.log("persona lifecycle tests passed");
