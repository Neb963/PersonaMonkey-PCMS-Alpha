import assert from "node:assert/strict";
import { createPersonaApi } from "../lib/persona-api.js";
const calls=[];
const personaManager={
  list:async()=>[1],get:async(id)=>({id}),create:async(value)=>value,updateIdentity:async(id, changes)=>calls.push(["identity",id,changes]),clone:async(id)=>calls.push(["clone",id]),archive:async(id)=>calls.push(["archive",id]),destroy:async(id)=>calls.push(["destroy",id]),
  open:async(id)=>calls.push(["open",id]),export:async(id)=>calls.push(["export",id]),import:async(value)=>value,duplicate:async(id)=>calls.push(["duplicate",id]),fullWipe:async(id)=>calls.push(["wipe",id]),storage:async(id)=>calls.push(["storage",id]),clearStorage:async(id)=>calls.push(["clear",id]),
  inspectStorage:async(id)=>calls.push(["inspect",id]),wipeStorage:async(id)=>calls.push(["wipe-storage",id]),clearCookies:async(id)=>calls.push(["cookies",id]),clearSiteData:async(id)=>calls.push(["site-data",id]),
  getPersonaStatus:async(id)=>({id,status:"active"}),getRouteStatus:async(id)=>({id,status:"healthy"}),
  listRoutes:async()=>[{id:"r1"}],getRoute:async(id)=>({id}),assignRoute:async(id,route,options)=>calls.push(["route",id,route,options]),testRoute:async(id)=>calls.push(["route-test",id])
};
const api=createPersonaApi({personaManager,workflowRunner:{list:async()=>["w1"],get:async(id)=>({id}),run:async(id)=>calls.push(["run",id]),listJobs:async()=>["j1"],getJob:async(id)=>({id}),stopJob:async(id)=>calls.push(["stop",id]),clearFinishedJobs:async()=>[]},diagnostics:{getStatus:()=>({status:"ready"})}});
assert.deepEqual(await api.PersonaManager.list(),[1]);
await api.PersonaManager.open("p1"); await api.WorkflowRunner.run("w1");
assert.deepEqual(calls,[["open","p1"],["run","w1"]]);
assert.equal(api.Diagnostics.getStatus().status,"ready");
assert.equal((await api.PersonaManager.get("p1")).id,"p1");
assert.equal((await api.Diagnostics.getPersonaStatus("p1")).status,"active");
assert.equal(api.Diagnostics.getSystemStatus().status,"ready");
await api.PersonaManager.updateIdentity("p1",{name:"Updated"});
assert.deepEqual(calls.at(-1),["identity","p1",{name:"Updated"}]);
assert.deepEqual(await api.WorkflowRunner.list(),["w1"]);
assert.equal((await api.WorkflowRunner.getJob("j1")).id,"j1");
await api.RouteManager.assign("p1","r1",{allowDirect:false});
assert.deepEqual(calls.at(-1),["route","p1","r1",{allowDirect:false}]);
assert.equal((await api.RouteManager.get("r1")).id,"r1");
await api.StorageManager.clearCookies("p1");
assert.deepEqual(calls.at(-1),["cookies","p1"]);
assert.equal(Object.isFrozen(api.PersonaManager),true);
assert.equal(Object.isFrozen(api.StorageManager),true);
console.log("persona api tests passed");
