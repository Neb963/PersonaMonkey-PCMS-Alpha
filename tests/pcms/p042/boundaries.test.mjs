import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const P042_SOURCES=["extension/pcms/providers/perchance/execution-update-driver.js","extension/pcms/providers/perchance/deploy-artifact.js",
  "extension/pcms/integration/deployer-automatic.js","pcms-modules/p015/automatic.js"];
const strip=source=>source.replace(/^\s*\/\/.*$/gm,"");

test("A042-01 unattended paths have no browser, userScripts, IndexedDB, network or dynamic-code authority",async()=>{
  for(const path of [...P042_SOURCES,"extension/pcms/integration/live-mutations.js"]){
    const source=strip(await readFile(path,"utf8"));
    assert.doesNotMatch(source,/\bbrowser\s*[.[]|\bchrome\s*[.[]|\buserScripts\b|\bindexedDB\b|\beval\s*\(|new\s+Function\b|\bfetch\s*\(|XMLHttpRequest/,path);
  }
  // The only executable code PCMS hands PersonaMonkey is the reviewed artifact template.
  const driver=await readFile("extension/pcms/providers/perchance/execution-update-driver.js","utf8");
  assert.match(driver,/userscript\.artifact\.install/);assert.match(driver,/persona\.control\.acquire/);
  assert.match(driver,/persona\.control\.release/);assert.match(driver,/profile = null/);
  assert.match(driver,/source = profile \? createDeployFixtureArtifact\(profile\.origin\) : null/);
});

test("A042-01 no PCMS file outside the reviewed drivers names a browser-execution API",async()=>{
  async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);
    if(e.isDirectory())out.push(...await walk(p));else if(p.endsWith(".js"))out.push(p);}return out;}
  for(const path of [...await walk("extension/pcms"),...await walk("pcms-modules")]){
    const source=strip(await readFile(path,"utf8"));
    assert.doesNotMatch(source,/\bbrowser\.userScripts\b|\bbrowser\.scripting\b|\bbrowser\.tabs\.executeScript\b/,path);
  }
});

test("A042-03 production composition enables no unattended or observation profile",async()=>{
  for(const path of ["extension/pcms/background/core-factory.js","extension/pcms/integration/composition.js","extension/pcms/integration/live-core.js"]){
    const source=await readFile(path,"utf8");
    assert.doesNotMatch(source,/automationProfile|observationProfile/,path);
  }
  const live=await readFile("extension/pcms/integration/live-mutations.js","utf8");
  assert.match(live,/observationProfile = null,\n\s*automationProfile = null,\n\s*allowDirect = false/);
  assert.match(live,/"https:\/\/perchance\.org\/"\+encodeURIComponent\(generatorId\)/,"real Perchance stays an assisted handoff");
});

test("A042-02 automatic dispatch goes only through the repository release and the Deployer",async()=>{
  const source=strip(await readFile("pcms-modules/p015/automatic.js","utf8"));
  assert.doesNotMatch(source,/\.mutate\s*\(|providerGate|personaBroker|\.request\s*\(/);
  assert.match(source,/repository\.deployFromRepository\(/);
  const imports=[...source.matchAll(/from\s+"([^"]+)"/g)].map(m=>m[1]);
  assert.deepEqual(imports,["./schema.js"]);
});
