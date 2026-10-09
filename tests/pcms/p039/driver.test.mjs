import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createPerchanceExecutionReadDriver } from "../../../extension/pcms/providers/perchance/execution-read-driver.js";
import { createObserveFixtureArtifact } from "../../../extension/pcms/providers/perchance/observe-artifact.js";
import { normalizeProviderObservation } from "../../../extension/pcms/providers/perchance/observation.js";
import { generatorPayloadHash } from "../../../extension/pcms/providers/perchance/contract.js";
import { setup } from "../p036/harness.mjs";
import { parseUserscriptMetadata } from "../../../extension/lib/userscripts.js";
import { userScriptMatches } from "../../../extension/lib/policy.js";

const UID="11111111-1111-4111-8111-111111111111";
const ORIGIN="http://127.0.0.1:1234";
const REQUIRED=["userscript.artifact.install","userscript.artifact.assign","persona.control.acquire",
  "persona.control.release","execution.start","execution.result.get","execution.result.ack","execution.cancel"];
test("A039-01 the read artifact matches through PersonaMonkey's actual URL matcher at a fixture port",()=>{
  const source=createObserveFixtureArtifact(ORIGIN),metadata=parseUserscriptMetadata(source);
  assert.equal(userScriptMatches(metadata,ORIGIN+"/alpha"),true);
  assert.equal(userScriptMatches(metadata,"https://perchance.org/alpha"),false);
  assert.ok(source.includes("location.origin !== "+JSON.stringify(ORIGIN)));
});
function clientHarness({authorized=true,body=null,truncated=false,state="completed"}={}) {
  const calls=[];
  const client={async request(command,params,options){
    calls.push({command,params,options});
    if(command==="system.describe")return {commands:REQUIRED.map(command=>({command,authorized,available:true})),externalAutomation:{executionAvailable:true}};
    if(command==="persona.control.acquire")return {leaseId:"lease-1"};
    if(command==="execution.start")return {executionId:"exec-1"};
    if(command==="execution.result.get")return {executionId:"exec-1",state,truncated,acknowledged:false,tasks:[{result:{script1:body}}]};
    return {};
  }};
  return {client,calls};
}
test("A039-01 real Perchance has no enabled read profile; no browser action is attempted",async()=>{
  const h=clientHarness();const driver=createPerchanceExecutionReadDriver({client:h.client});
  assert.equal(await driver.available(),false);
  await assert.rejects(driver.observeGenerator({generatorId:"alpha",personaUid:UID,readId:"read-1"}),e=>e.code==="PCMS_PERCHANCE_INCOMPATIBLE");
  assert.deepEqual(h.calls,[]);
  assert.throws(()=>createPerchanceExecutionReadDriver({client:h.client,profile:{kind:"fixture",origin:"https://perchance.org"}}));
});
test("A039-01 every required execution authority must be advertised as authorized",async()=>{
  const h=clientHarness({authorized:false});const driver=createPerchanceExecutionReadDriver({client:h.client,profile:{kind:"fixture",origin:ORIGIN}});
  assert.equal(await driver.available(),false);
  await assert.rejects(driver.observeGenerator({generatorId:"alpha",personaUid:UID,readId:"read-1"}));
  assert.ok(h.calls.every(c=>c.command==="system.describe"));
});
test("A039-01 observation installs exact immutable source, acquires a lease, runs once and acknowledges",async()=>{
  const body={generatorId:"alpha",observation:{exists:false,challenge:false}};
  const h=clientHarness({body});const driver=createPerchanceExecutionReadDriver({client:h.client,profile:{kind:"fixture",origin:ORIGIN}});
  assert.deepEqual(await driver.observeGenerator({generatorId:"alpha",personaUid:UID,readId:"read-1"}),body.observation);
  assert.deepEqual(h.calls.map(c=>c.command),["system.describe",...REQUIRED.slice(0,2),"persona.control.acquire","execution.start","execution.result.get","execution.result.ack","persona.control.release"]);
  const plan=h.calls.find(c=>c.command==="execution.start").params;
  assert.equal(plan.allowDirect,false);assert.equal(plan.plan.steps[0].retries,0);
  assert.deepEqual(plan.plan.steps[0].urls,[ORIGIN+"/alpha"]);
  assert.equal(h.calls.find(c=>c.command==="userscript.artifact.install").params.sha256.length,64);
});
test("A039-01 foreign target, omitted results and terminal failures are never observations",async()=>{
  for(const args of [{body:{generatorId:"beta",observation:{exists:false,challenge:false}}},
    {body:{generatorId:"alpha",observation:{}},truncated:true},{state:"failed"}]) {
    const h=clientHarness(args);const driver=createPerchanceExecutionReadDriver({client:h.client,profile:{kind:"fixture",origin:ORIGIN}});
    await assert.rejects(driver.observeGenerator({generatorId:"alpha",personaUid:UID,readId:"read-1"}));
    assert.ok(h.calls.some(c=>c.command==="execution.cancel"));
    assert.equal(h.calls.at(-1).command,"persona.control.release");
    assert.ok(!h.calls.some(c=>c.command==="execution.result.ack"));
  }
});
test("A039-01 challenge strips stale content and never proves sync; malformed content fails closed",async()=>{
  assert.deepEqual(await normalizeProviderObservation({exists:true,challenge:true,code:"stale",html:"",settings:{isPrivate:false}}),
    {exists:null,payloadHash:null,thumbnailHash:null,listing:"UNKNOWN",challenge:true});
  for(const raw of [{exists:true,challenge:false},{exists:null,challenge:false},{exists:true,challenge:false,code:"x",html:42},
    {exists:false,challenge:false,cookies:"secret"}])await assert.rejects(normalizeProviderObservation(raw));
  let accessed=false;await assert.rejects(normalizeProviderObservation({exists:true,challenge:false,get code(){accessed=true;return "secret";}}));
  assert.equal(accessed,false);
});
test("A039-01 emulator observes byte-exact code and HTML; UNKNOWN listing disables only listing",async()=>{
  const h=setup();h.emulator.seedGenerator({generatorId:"alpha",code:"a\r\n",html:"<b>雪</b>"});
  const observed=await h.adapter.observe("alpha");assert.equal(observed.payloadHash,await generatorPayloadHash("a\r\n","<b>雪</b>"));
  h.emulator.setSettingsShape({other:true});assert.equal((await h.adapter.observe("alpha")).listing,"UNKNOWN");
  const probe=await h.adapter.probeCompatibility();assert.equal(probe.capabilities.listing,false);assert.equal(probe.capabilities.observe,true);
  h.emulator.setCapabilities({observe:false});await assert.rejects(h.adapter.observe("alpha"));
});
test("A039-01 reviewed fixture artifact reads only declared panels and computes canonical identity",async()=>{
  let result;let failure;
  const source=createObserveFixtureArtifact(ORIGIN,{includeContent:true});
  const page={dataset:{generator:"alpha",isPrivate:"false"},querySelector(selector){return selector.includes('"code"')?{textContent:"a\r\n"}:selector.includes('"html"')?{textContent:"<b>雪</b>"}:null;}};
  await runInNewContext(source,{document:{querySelector:()=>page},location:{origin:ORIGIN,pathname:"/alpha"},
    Persona:{complete(value){result=JSON.parse(JSON.stringify(value));},fail(value){failure=value;}},TextEncoder,Uint8Array,crypto,atob});
  // The artifact reports asynchronously after its digest.
  for(let i=0;i<20&&!result&&!failure;i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(failure,undefined);assert.equal(result.generatorId,"alpha");
  assert.equal(result.observation.payloadHash,await generatorPayloadHash("a\r\n","<b>雪</b>"));
  assert.equal(result.observation.code,"a\r\n");
  assert.ok(!/browser\.|userScripts|fetch\(|eval\(/.test(source));
});
