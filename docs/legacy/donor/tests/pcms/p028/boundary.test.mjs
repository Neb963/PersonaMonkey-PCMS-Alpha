import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

import { createPcmsBackgroundEntry } from "../../../extension/pcms/background/entry.js";

const CORE_CONSTRUCTORS=/\b(createPcmsLiveCore|createBackgroundPcmsCore|createPcmsStorageBroker|createPcmsAuditJournal|createRemoteOps|createRecoveryHoldController|createProviderGate|createModulePackageRegistry|createModuleRuntimeBroker|createHumanTaskService|createPcmsModuleIntegration|createPersonaBroker|createPcmsLiveMutationIntegration)\b/;
const CORE_MODULES=/(\/storage\/|\/audit\/|\/remoteops\/|\/runtime\/|\/services\/|\/modules\/|\/recovery\/|\/background\/|integration\/live-core|integration\/live-mutations|integration\/composition|core\/persona-broker\.js|pcms-modules\/)/;

async function walk(dir){
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const full=join(dir,entry.name);
    if(entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

function specifiers(source){
  const found=[];
  const pattern=/(?:\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["'])|(?:\bimport\s*\(\s*["']([^"']+)["']\s*\))/g;
  for(const match of source.matchAll(pattern)) found.push(match[1]||match[2]);
  return found;
}

// Follows every static and dynamic import reachable from an extension page script.
async function importGraph(entry){
  const seen=new Set();
  const queue=[normalize(entry)];
  while(queue.length){
    const file=queue.shift();
    if(seen.has(file)) continue;
    seen.add(file);
    for(const specifier of specifiers(await readFile(file,"utf8"))){
      const target=specifier.startsWith("/")?normalize(join("extension",specifier.slice(1))):normalize(join(dirname(file),specifier));
      queue.push(target);
    }
  }
  return [...seen].sort();
}

test("A028-01 SEC dashboard and popup never construct a Core service (static import graph)",async()=>{
  const html=await readFile("extension/pcms/app/index.html","utf8");
  const scripts=[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match)=>normalize(join("extension/pcms/app",match[1])));
  assert.ok(scripts.length>=1);
  const graph=(await Promise.all(scripts.map(importGraph))).flat();
  for(const file of graph){
    assert.doesNotMatch(file,CORE_MODULES,"dashboard reaches Core module "+file);
    assert.doesNotMatch(await readFile(file,"utf8"),CORE_CONSTRUCTORS,"dashboard constructs Core in "+file);
  }
  assert.ok(graph.includes(normalize("extension/pcms/app/ui-client.js")));
  for(const file of [...await walk("extension/pcms/app"),...await walk("extension/popup")].filter((path)=>path.endsWith(".js"))){
    const source=await readFile(file,"utf8");
    assert.doesNotMatch(source,CORE_CONSTRUCTORS,file);
    assert.doesNotMatch(source,/\bindexedDB\b|PCMS_PERSONA_BROKER_REQUEST|showModal\s*\(/,file);
  }
  await assert.rejects(readFile("extension/pcms/app/operator-bridge.js"),/ENOENT/,"the in-memory operator dialog is gone");
});

test("A028-01 PCMS entry is statically imported after the routing gate and has no static imports itself",async()=>{
  const bootstrap=await readFile("extension/lib/recovery-bootstrap.js","utf8");
  const imports=[...bootstrap.matchAll(/^import .* from "([^"]+)";$/gm)].map((match)=>match[1]);
  assert.equal(imports[0],"./routing-gate.js");
  assert.equal(imports[1],"../pcms/background/entry.js");
  assert.ok(bootstrap.indexOf("setBootstrapRetry(bootstrap);")<bootstrap.indexOf("setPcmsPersonaMonkeyBootstrap(bootstrap);"));
  assert.ok(bootstrap.indexOf("setPcmsPersonaMonkeyBootstrap(bootstrap);")<bootstrap.indexOf("void bootstrap().catch"));
  const entry=await readFile("extension/pcms/background/entry.js","utf8");
  assert.deepEqual(specifiers(entry).filter((specifier)=>!entry.includes('import("'+specifier+'")')),[],
    "a link failure in the PCMS graph must never take down the routing gate");
  const background=await readFile("extension/background.js","utf8");
  assert.match(background,/registerPcmsInternalBrokerHandler\(\{\n  ready: \(\) => initialize\(\),/);
  assert.match(background,/if \(message\?\.type === PCMS_UI_REQUEST_TYPE\) return undefined;\n  return handleRuntimeMessage\(message, sender\);/);
  assert.match(background,/managementIntegration\.handleInternalRequest\(message\.request\)/,"the message path stays during migration");
});

test("A028-01 PCMS background entry registers listeners synchronously and starts Core only after PersonaMonkey bootstrap",async()=>{
  const added=[];
  const fakeEvent=(name)=>({addListener(listener){added.push([name,listener]);}});
  const browserRef={runtime:{onMessage:fakeEvent("runtime.onMessage"),onStartup:fakeEvent("runtime.onStartup"),onInstalled:fakeEvent("runtime.onInstalled")},
    alarms:{onAlarm:fakeEvent("alarms.onAlarm")}};
  const events=[];
  let readyCalls=0;
  const entry=createPcmsBackgroundEntry({
    browserRef,
    loadHost:async({personaMonkeyReady})=>({
      async wake(){events.push("wake-start");await personaMonkeyReady();events.push("wake-ready");return true;},
      async handleUiMessage(message){await personaMonkeyReady();return {ok:true,requestId:message.requestId};}
    })
  });
  const registered=entry.install();
  assert.deepEqual(registered,["runtime.onMessage","alarms.onAlarm","runtime.onStartup","runtime.onInstalled"]);
  assert.equal(added.length,4,"listeners exist before any await");
  const onMessage=added.find(([name])=>name==="runtime.onMessage")[1];
  assert.equal(onMessage({type:"GET_STATE"},{}),undefined,"PersonaMonkey messages are left to PersonaMonkey");
  assert.equal(onMessage({type:"PCMS_PERSONA_BROKER_REQUEST"},{}),undefined);
  const answer=onMessage({type:"PCMS_UI_REQUEST",requestId:"r1"},{});
  assert.equal(typeof answer.then,"function");
  await new Promise((resolve)=>setImmediate(resolve));
  assert.deepEqual(events,["wake-start"],"no Core work before PersonaMonkey bootstrap is handed over");
  entry.setPersonaMonkeyBootstrap(async()=>{readyCalls+=1;});
  assert.equal(entry.setPersonaMonkeyBootstrap(async()=>{}),false,"bootstrap hook is set once");
  assert.deepEqual(await answer,{ok:true,requestId:"r1"});
  assert.deepEqual(events,["wake-start","wake-ready"]);
  assert.ok(readyCalls>=2);
  const onAlarm=added.find(([name])=>name==="alarms.onAlarm")[1];
  onAlarm({name:"persona-mullvad-idle"});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(events.filter((event)=>event==="wake-start").length,1,"PersonaMonkey alarms do not wake PCMS");
  onAlarm({name:"pcms.timers.next"});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(events.filter((event)=>event==="wake-start").length,2);
});

test("A028-01 a failing host load answers PCMS UI requests with CORE_UNAVAILABLE and retries on the next event",async()=>{
  let loads=0;
  const entry=createPcmsBackgroundEntry({
    browserRef:{},
    loadHost:async()=>{loads+=1;if(loads===1) throw new Error("load failed");return {async wake(){return true;},async handleUiMessage(){return {ok:true};}};}
  });
  assert.deepEqual(entry.install(),[]);
  const first=await entry.onMessage({type:"PCMS_UI_REQUEST"},{});
  assert.equal(first.ok,false);
  assert.equal(first.error.code,"PCMS_CORE_UNAVAILABLE");
  assert.deepEqual(await entry.onMessage({type:"PCMS_UI_REQUEST"},{}),{ok:true});
  assert.equal(loads,2);
});

test("A028-01 upstream derivative bookkeeping covers every touched PersonaMonkey file",async()=>{
  const manifest=JSON.parse(await readFile("docs/upstream/import-manifest.json","utf8"));
  const overrides=new Set(manifest.derivativeOverrides.map((item)=>item.destinationPath));
  for(const path of ["extension/background.js","extension/lib/recovery-bootstrap.js"]) assert.ok(overrides.has(path),path);
  const frozen=manifest.entries.find((entry)=>entry.sourcePath==="extension/lib/recovery-bootstrap.js");
  assert.equal(frozen.destinationPath,"docs/upstream/source/extension/lib/recovery-bootstrap.js");
  assert.equal(manifest.entries.some((entry)=>entry.sourcePath==="extension/lib/pcms-internal-broker-endpoint.js"),false,
    "the endpoint is PCMS-owned, not an upstream file");
});
