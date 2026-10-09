import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createPerchanceExecutionUpdateDriver, PERCHANCE_UNATTENDED_COMMANDS } from "../../../extension/pcms/providers/perchance/execution-update-driver.js";
import { createDeployFixtureArtifact, PERCHANCE_RELEASE_INPUT_FORMAT } from "../../../extension/pcms/providers/perchance/deploy-artifact.js";
import { parseUserscriptMetadata } from "../../../extension/lib/userscripts.js";
import { userScriptMatches } from "../../../extension/lib/policy.js";

const UID="11111111-1111-4111-8111-111111111111";
const ORIGIN="http://127.0.0.1:1234";
const OP="deploy:gen:alpha:2:1";
const RELEASE={operationId:OP,generatorId:"alpha",intentFingerprint:"perchance:generator-release:v2:"+"c".repeat(64),
  payloadHash:"a".repeat(64),thumbnailHash:null,code:"code\n雪",html:"<b>x</b>",thumbnail:null,settings:{isPrivate:true},personaUid:UID};

function clientHarness({authorized=true,body,state="completed",failAt=null}={}){
  const calls=[],inputs=new Map();
  const client={async request(command,params,options){
    calls.push({command,params,options});
    if(command===failAt)throw new Error("broker failure at "+command);
    if(command==="system.describe")return {commands:PERCHANCE_UNATTENDED_COMMANDS.map(command=>({command,authorized,available:true})),externalAutomation:{executionAvailable:true}};
    if(command==="persona.control.acquire")return {leaseId:"lease-1"};
    if(command==="execution.input.begin"){inputs.set("input-1",{meta:params,chunks:[]});return {inputRef:"input-1",state:"uploading"};}
    if(command==="execution.input.append"){inputs.get(params.inputRef).chunks.push(Buffer.from(params.chunkBase64,"base64"));return {};}
    if(command==="execution.start")return {executionId:"exec-1"};
    if(command==="execution.result.get"){
      const staged=JSON.parse(Buffer.concat(inputs.get("input-1").chunks).toString("utf8"));
      const result=typeof body==="function"?body(staged):body;
      return {executionId:"exec-1",state,truncated:false,acknowledged:false,tasks:[{result:{script7:result}}]};
    }
    return {};
  }};
  return {client,calls,inputs,staged:()=>JSON.parse(Buffer.concat(inputs.get("input-1").chunks).toString("utf8"))};
}
const echo=(status,challenge=false)=>staged=>({operationId:staged.operationId,generatorId:staged.generatorId,status,challenge});

test("A042-01 real Perchance has no unattended profile; nothing reaches PersonaMonkey",async()=>{
  const h=clientHarness({body:echo("APPLIED")});const driver=createPerchanceExecutionUpdateDriver({client:h.client});
  assert.equal(await driver.available(),false);
  await assert.rejects(driver.updateGeneratorRelease(RELEASE),e=>e.code==="PCMS_PERCHANCE_INCOMPATIBLE");
  assert.deepEqual(await driver.reconcileGeneratorRelease(RELEASE),{status:"UNKNOWN"});
  assert.deepEqual(h.calls,[]);
  for(const origin of ["https://perchance.org","http://example.com","http://127.0.0.1:1234/x"])
    assert.throws(()=>createPerchanceExecutionUpdateDriver({client:h.client,profile:{kind:"fixture",origin}}));
  assert.throws(()=>createPerchanceExecutionUpdateDriver({client:h.client,profile:{kind:"live",origin:ORIGIN}}));
});

test("A042-01 unattended authority requires every execution and input command to be authorized",async()=>{
  const h=clientHarness({authorized:false,body:echo("APPLIED")});
  const driver=createPerchanceExecutionUpdateDriver({client:h.client,profile:{kind:"fixture",origin:ORIGIN}});
  assert.equal(await driver.available(),false);
  assert.ok(h.calls.every(c=>c.command==="system.describe"));
});

test("A042-01 deploy installs one immutable artifact, leases the Persona, stages the release as transient input and cleans up",async()=>{
  const h=clientHarness({body:echo("APPLIED")});
  const driver=createPerchanceExecutionUpdateDriver({client:h.client,profile:{kind:"fixture",origin:ORIGIN}});
  assert.deepEqual(await driver.updateGeneratorRelease(RELEASE),{status:"APPLIED"});
  assert.deepEqual(h.calls.map(c=>c.command).filter(c=>c!=="system.describe"),["userscript.artifact.install","userscript.artifact.assign",
    "persona.control.acquire","execution.input.begin","execution.input.append","execution.input.commit","execution.start",
    "execution.result.get","execution.result.ack","execution.input.discard","persona.control.release"]);
  const install=h.calls.find(c=>c.command==="userscript.artifact.install").params;
  assert.equal(install.source,createDeployFixtureArtifact(ORIGIN));assert.ok(!install.source.includes(RELEASE.code));
  assert.match(install.artifactId,/^pcms\.perchance\.deploy\/1\.0\.0\/[a-f0-9]{24}$/);
  const lease=h.calls.find(c=>c.command==="persona.control.acquire").params;
  assert.equal(lease.personaUid,UID);assert.ok(lease.ttlMs>=10000&&lease.ttlMs<=300000);
  const start=h.calls.find(c=>c.command==="execution.start");
  assert.deepEqual(start.params.inputRefs,["input-1"]);assert.equal(start.params.allowDirect,false);
  assert.equal(start.params.plan.steps[0].retries,0);assert.deepEqual(start.params.plan.steps[0].urls,[ORIGIN+"/alpha"]);
  assert.deepEqual(start.params.plan.steps[0].artifacts,[install.artifactId]);
  assert.equal(start.options.operationId,OP+":deploy:start");
  const begin=h.inputs.get("input-1").meta;assert.deepEqual(begin.stepIds,["deploy"]);assert.deepEqual(begin.artifactIds,[install.artifactId]);
  const staged=h.staged();
  assert.equal(staged.format,PERCHANCE_RELEASE_INPUT_FORMAT);assert.equal(staged.mode,"deploy");
  assert.equal(staged.code,RELEASE.code);assert.deepEqual(staged.settings,{isPrivate:true});assert.equal(staged.personaUid,undefined);
  const bytes=Buffer.concat(h.inputs.get("input-1").chunks);
  assert.equal(begin.byteLength,bytes.byteLength);
  assert.equal(begin.sha256,(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"));
});

test("A042-01 failures before execution.start are NOT_APPLIED; ambiguous failures after it are uncertain",async()=>{
  for(const failAt of ["userscript.artifact.install","persona.control.acquire","execution.input.commit"]){
    const h=clientHarness({body:echo("APPLIED"),failAt});
    const driver=createPerchanceExecutionUpdateDriver({client:h.client,profile:{kind:"fixture",origin:ORIGIN}});
    assert.deepEqual(await driver.updateGeneratorRelease(RELEASE),{status:"NOT_APPLIED"});
    assert.ok(!h.calls.some(c=>c.command==="execution.start"));
  }
  for(const args of [{failAt:"execution.start",body:echo("APPLIED")},{state:"failed",body:echo("APPLIED")},
    {body:s=>({...echo("APPLIED")(s),operationId:"other"})},{body:s=>({...echo("APPLIED")(s),extra:true})},
    {body:echo("APPLIED",true)},{body:echo("UNKNOWN")}]){
    const h=clientHarness(args);
    const driver=createPerchanceExecutionUpdateDriver({client:h.client,profile:{kind:"fixture",origin:ORIGIN}});
    await assert.rejects(driver.updateGeneratorRelease(RELEASE));
    assert.ok(!h.calls.some(c=>c.command==="execution.result.ack"));
    assert.equal(h.calls.at(-1).command,"persona.control.release");
    assert.ok(h.calls.some(c=>c.command==="execution.input.discard"));
  }
});

test("A042-01 reconciliation asks the provider about exactly this operation; anything indefinite stays UNKNOWN",async()=>{
  const applied=clientHarness({body:echo("APPLIED")});
  const driver=createPerchanceExecutionUpdateDriver({client:applied.client,profile:{kind:"fixture",origin:ORIGIN}});
  assert.deepEqual(await driver.reconcileGeneratorRelease(RELEASE),{status:"APPLIED"});
  const staged=applied.staged();assert.equal(staged.mode,"verify");assert.equal(staged.code,undefined);assert.equal(staged.operationId,OP);
  const missing=clientHarness({body:echo("NOT_APPLIED")});
  assert.deepEqual(await createPerchanceExecutionUpdateDriver({client:missing.client,profile:{kind:"fixture",origin:ORIGIN}})
    .reconcileGeneratorRelease(RELEASE),{status:"NOT_APPLIED"});
  for(const args of [{body:echo("NOT_APPLIED",true)},{state:"failed",body:echo("APPLIED")},{failAt:"persona.control.acquire",body:echo("APPLIED")}]){
    const h=clientHarness(args);
    assert.deepEqual(await createPerchanceExecutionUpdateDriver({client:h.client,profile:{kind:"fixture",origin:ORIGIN}})
      .reconcileGeneratorRelease(RELEASE),{status:"UNKNOWN"});
  }
});

test("A042-01 the deploy artifact matches only its loopback fixture origin through PersonaMonkey's matcher",()=>{
  const source=createDeployFixtureArtifact(ORIGIN),metadata=parseUserscriptMetadata(source);
  assert.equal(userScriptMatches(metadata,ORIGIN+"/alpha"),true);
  assert.equal(userScriptMatches(metadata,"https://perchance.org/alpha"),false);
  assert.deepEqual([...metadata.grants].sort(),["Persona.input","Persona.signal"]);
  assert.ok(!/\bbrowser\.|userScripts|fetch\(|eval\(|XMLHttpRequest|GM_/.test(source));
});

function fixturePage({receipts="",exists="true",challenge="false",reject=false}={}){
  const fields={code:{value:""},html:{value:""},thumbnail:{value:""}},listing={checked:false},operation={value:""};
  const events=[];
  const page={dataset:{generator:"alpha",receipts,exists,challenge},querySelector(selector){
    const panel=/data-panel="([a-z]+)"/.exec(selector)?.[1];
    if(panel)return Object.assign(fields[panel],{dispatchEvent:e=>events.push(panel+":"+e.type)});
    if(selector.includes('data-setting="isPrivate"'))return Object.assign(listing,{dispatchEvent:e=>events.push("listing:"+e.type)});
    if(selector.includes('data-field="operation"'))return operation;
    if(selector.includes('data-action="save"'))return {click(){setTimeout(()=>{page.dataset.saveState=(reject?"rejected:":"saved:")+operation.value;},5);}};
    return null;
  }};
  return {page,fields,listing,operation,events};
}
async function runArtifact(page,input){
  let result,failure;
  runInNewContext(createDeployFixtureArtifact(ORIGIN),{document:{querySelector:s=>s.includes("pcms-editor")?page:null},
    location:{origin:ORIGIN,pathname:"/alpha"},Event:class{constructor(type){this.type=type;}},setTimeout,
    Persona:{input:{json:async name=>name==="release"?structuredClone(input):null},complete(v){result=JSON.parse(JSON.stringify(v));},fail(v){failure=v;}}});
  for(let i=0;i<200&&!result&&!failure;i++)await new Promise(r=>setTimeout(r,2));
  return {result,failure};
}
const INPUT={format:PERCHANCE_RELEASE_INPUT_FORMAT,mode:"deploy",operationId:OP,generatorId:"alpha",code:"c",html:"<p>h</p>",thumbnail:null,settings:{isPrivate:true}};

test("A042-01 the reviewed artifact fills the fixture editor, saves once and reports the editor's own confirmation",async()=>{
  const f=fixturePage();const {result,failure}=await runArtifact(f.page,INPUT);
  assert.equal(failure,undefined);assert.deepEqual(result,{operationId:OP,generatorId:"alpha",status:"APPLIED",challenge:false});
  assert.equal(f.fields.code.value,"c");assert.equal(f.fields.html.value,"<p>h</p>");assert.equal(f.listing.checked,true);
  assert.equal(f.operation.value,OP);
  assert.equal((await runArtifact(fixturePage({reject:true}).page,INPUT)).result.status,"NOT_APPLIED");
});

test("A042-01 the artifact never solves a challenge, never creates a missing generator and replays nothing",async()=>{
  assert.deepEqual((await runArtifact(fixturePage({challenge:"true"}).page,INPUT)).result,{operationId:OP,generatorId:"alpha",status:"NOT_APPLIED",challenge:true});
  const missing=fixturePage({exists:"false"});
  assert.equal((await runArtifact(missing.page,INPUT)).result.status,"NOT_APPLIED");assert.equal(missing.fields.code.value,"");
  const done=fixturePage({receipts:"other "+OP});
  assert.equal((await runArtifact(done.page,INPUT)).result.status,"APPLIED");assert.equal(done.fields.code.value,"","already saved: no second save");
  assert.equal((await runArtifact(fixturePage({receipts:OP}).page,{...INPUT,mode:"verify",code:undefined})).result.status,"APPLIED");
  assert.equal((await runArtifact(fixturePage().page,{...INPUT,mode:"verify"})).result.status,"NOT_APPLIED");
  assert.equal((await runArtifact(fixturePage().page,{...INPUT,generatorId:"beta"})).failure,"Deployment fixture contract unavailable");
});
