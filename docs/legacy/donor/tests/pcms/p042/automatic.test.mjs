import assert from "node:assert/strict";
import test from "node:test";
import { harness, CODE, HTML } from "./harness.mjs";
import { AUTOMATIC_MAX_DISPATCHES, AUTOMATIC_SPACING_MS, AUTOMATIC_TIMERS } from "../../../pcms-modules/p015/automatic.js";
import { createUiContribution } from "../../../pcms-modules/p015/ui.js";
import { normalizePcmsUiConditions, normalizePcmsUiDescriptor, normalizePcmsUiReceipt, normalizePcmsUiSummary }
  from "../../../extension/pcms/integration/ui-contribution-contract.js";

const dispatches=(h,slug)=>h.emulator.dispatched().filter(d=>!slug||d.generatorId===slug).length;
async function readyUpdate(h,slug){await h.create(slug,{deployed:true});return h.release(slug,"release 2 of "+slug);}

test("A042-02 Automatic refuses to turn on while any gate is unmet and lists every unmet gate",async()=>{
  for(const [options,gate] of [[{unattended:false},"unattended"],[{observe:false},"observe"]]){
    const h=await harness(options);
    await assert.rejects(h.automatic.enable(),e=>e.code==="PCMS_DEPLOYER_AUTOMATIC_GATED"&&e.unmet.includes(gate));
    assert.equal((await h.automatic.readControl()).value.enabled,false);
  }
  const held=await harness();await held.recoveryHold.enterRecoveryHold({reason:"p042-test"});
  await assert.rejects(held.automatic.enable(),e=>e.unmet.includes("recovery"));
  const incompatible=await harness();incompatible.emulator.setCompatible(false);
  await assert.rejects(incompatible.automatic.enable(),e=>e.unmet.includes("provider")&&e.unmet.includes("unattended"));
  const challenged=await harness();await challenged.create("alpha",{deployed:true});
  challenged.emulator.setChallenge(true);challenged.advance(AUTOMATIC_SPACING_MS);
  assert.equal((await challenged.obs.verifyNow("gen:alpha")).status,"CHALLENGE");
  await assert.rejects(challenged.automatic.enable(),e=>e.unmet.includes("challenge"));
  const h=await harness();
  assert.equal((await h.automatic.gates()).gates.find(g=>g.id==="operator").met,false);
  const status=await h.automatic.enable();assert.equal(status.enabled,true);assert.equal(status.ready,true);
  assert.ok(status.gates.every(g=>g.met));
});

test("A042-02 drifted, uncertain, paused, failed, manual and held targets are never dispatched",async()=>{
  const h=await harness({slugs:["alpha","beta","gamma","delta","eps","hold"]});
  await readyUpdate(h,"alpha");
  await readyUpdate(h,"beta");let list=await h.deployer.listDeployments();
  await h.deployer.setPaused("gen:beta",{expectedRevision:list.revision,paused:true});
  // gamma: deployed, then changed on Perchance → DRIFT pause, and a new release waits.
  await h.create("gamma",{deployed:true});h.advance(AUTOMATIC_SPACING_MS);
  h.emulator.seedGenerator({generatorId:"gamma",code:"edited on Perchance",html:HTML,settings:{isPrivate:false}});
  assert.equal((await h.obs.verifyNow("gen:gamma")).status,"OBSERVED");
  assert.equal((await h.deployer.getDeployment("gen:gamma")).policy.pauseReason,"DRIFT");
  // delta: the provider applied but the answer was lost → UNCERTAIN until reconciled.
  const delta=await h.create("delta");h.emulator.failNext("after-apply");
  await assert.rejects(h.deployer.deploy("gen:delta",{expectedRevision:delta.revision,payload:{code:CODE,html:HTML,thumbnail:null}}));
  assert.equal((await h.deployer.getDeployment("gen:delta")).operation.status,"RECONCILE");
  // eps: definitely not applied → FAILED for this desired revision.
  const eps=await h.create("eps");h.emulator.failNext("not-applied");
  await h.deployer.deploy("gen:eps",{expectedRevision:eps.revision,payload:{code:CODE,html:HTML,thumbnail:null}});
  assert.equal((await h.deployer.getDeployment("gen:eps")).operation.status,"FAILED");
  // hold: repository says deploy: hold.
  h.repo.snapshot.items.find(i=>i.slug==="hold").deploy="hold";await h.create("hold");
  list=await h.deployer.listDeployments();
  await h.deployer.createDeployment({deploymentId:"gen:manual",accountId:"acct-1",generatorId:"manual",payloadHash:h.payloadHash,
    thumbnailHash:null,listing:"PUBLICLY_LISTED",origin:{kind:"MANUAL"}},{expectedRevision:list.revision});
  const reasons=Object.fromEntries((await h.automatic.evaluate()).map(r=>[r.deploymentId.slice(4),r.reason]));
  assert.deepEqual(reasons,{alpha:null,beta:"PAUSED",gamma:"DRIFT",delta:"UNCERTAIN",eps:"FAILED",hold:"NOT_AUTO",manual:"MANUAL"});
  const before=h.emulator.dispatched().length;
  await h.automatic.enable();
  for(let i=0;i<6;i++){await h.runDue();h.advance(AUTOMATIC_SPACING_MS);}
  const after=h.emulator.dispatched().slice(before);
  assert.deepEqual(after.map(d=>d.generatorId),["alpha"]);
  assert.equal((await h.deployer.getDeployment("gen:alpha")).operation.status,"SUCCEEDED");
  // UNCERTAIN stays for reconciliation; nothing blind-retried it.
  assert.equal((await h.deployer.getDeployment("gen:delta")).operation.status,"RECONCILE");
});

test("A042-02 a pass is serial, at most ten dispatches per cycle and at least twenty seconds apart, all timer-driven",async()=>{
  const slugs=Array.from({length:12},(_,i)=>"g"+String(i).padStart(2,"0"));
  const h=await harness({slugs});
  for(const slug of slugs)await readyUpdate(h,slug);
  const before=h.emulator.dispatched().length;
  await h.automatic.enable();
  const stamps=[];
  for(let i=0;i<40;i++){
    const count=h.emulator.dispatched().length;
    await h.runDue();
    const delta=h.emulator.dispatched().length-count;
    assert.ok(delta<=1,"one dispatch per timer occurrence");
    if(delta)stamps.push(h.now());
    // A second delivery at the same instant never dispatches again.
    await h.runDue();assert.equal(h.emulator.dispatched().length,count+delta);
    h.advance(AUTOMATIC_SPACING_MS/4);
  }
  assert.equal(h.emulator.dispatched().length-before,AUTOMATIC_MAX_DISPATCHES);
  for(let i=1;i<stamps.length;i++)assert.ok(stamps[i]-stamps[i-1]>=AUTOMATIC_SPACING_MS);
  const control=(await h.automatic.readControl()).value;
  assert.equal(control.cycle,null);assert.equal(control.lastPass.bounded,true);
  assert.ok(!(await h.timers.list()).some(t=>AUTOMATIC_TIMERS.includes(t.value.timerId)&&t.value.state==="SCHEDULED"));
  // The next repository check starts a new bounded cycle for the remaining targets.
  await h.automatic.enqueueCycle(h.clock());
  for(let i=0;i<8;i++){await h.runDue();h.advance(AUTOMATIC_SPACING_MS);}
  assert.equal(h.emulator.dispatched().length-before,12);
  const remaining=(await h.automatic.evaluate()).filter(r=>r.reason===null);assert.deepEqual(remaining,[]);
});

test("A042-02 two consecutive NOT_APPLIED for one desired revision pause the target; nothing is retried automatically",async()=>{
  const h=await harness();await readyUpdate(h,"alpha");
  await h.automatic.enable();h.emulator.failNext("not-applied");
  await h.runDue();
  let d=await h.deployer.getDeployment("gen:alpha");
  assert.equal(d.operation.status,"FAILED");assert.equal(d.policy.paused,false);
  const afterFirst=dispatches(h,"alpha");
  for(let i=0;i<3;i++){h.advance(AUTOMATIC_SPACING_MS);await h.automatic.enqueueCycle(h.clock());await h.runDue();}
  assert.equal(dispatches(h,"alpha"),afterFirst,"FAILED is never dispatched again");
  // The operator retries; the next automatic attempt fails again for the same desired revision.
  let list=await h.deployer.listDeployments();await h.deployer.prepareRetry("gen:alpha",{expectedRevision:list.revision});
  h.emulator.failNext("not-applied");h.advance(AUTOMATIC_SPACING_MS);await h.automatic.enqueueCycle(h.clock());await h.runDue();
  d=await h.deployer.getDeployment("gen:alpha");
  assert.equal(d.policy.paused,true);assert.equal(d.policy.pauseReason,"REPEATED_FAILURE");
  list=await h.deployer.listDeployments();await h.deployer.prepareRetry("gen:alpha",{expectedRevision:list.revision});
  h.advance(AUTOMATIC_SPACING_MS);await h.automatic.enqueueCycle(h.clock());await h.runDue();
  assert.equal(dispatches(h,"alpha"),afterFirst+1);
  assert.equal((await h.automatic.evaluate())[0].reason,"PAUSED");
});

test("A042-02 recovery hold or a challenge during a cycle stops the pass without dispatch",async()=>{
  const h=await harness({slugs:["alpha","beta"]});await readyUpdate(h,"alpha");await readyUpdate(h,"beta");
  await h.automatic.enable();await h.recoveryHold.enterRecoveryHold({reason:"p042-test"});
  const before=h.emulator.dispatched().length;
  h.advance(AUTOMATIC_SPACING_MS);await h.runDue();
  assert.equal(h.emulator.dispatched().length,before);
  const control=(await h.automatic.readControl()).value;
  assert.equal(control.cycle,null);assert.ok(control.lastPass.unmet.includes("recovery"));
  // A cycle started directly is refused by the recovery gate before any dispatch.
  await h.automatic.enqueueCycle(h.clock());assert.equal((await h.automatic.step()).status,"GATED");
  assert.equal(h.emulator.dispatched().length,before);
});

test("A042-02 a never-deployed target is dispatched only after a read proves it exists",async()=>{
  const h=await harness();await h.create("alpha");await h.automatic.enable();
  let step=await h.automatic.step();assert.equal(step.status,"EXISTENCE_READ");assert.equal(step.deploymentId,"gen:alpha");
  assert.deepEqual(h.reads,["alpha"]);assert.equal(dispatches(h,"alpha"),0);
  assert.equal((await h.automatic.step()).status,"SPACED");
  h.advance(AUTOMATIC_SPACING_MS);step=await h.automatic.step();
  assert.equal(step.status,"DISPATCHED");assert.equal(step.deploymentId,"gen:alpha");assert.equal(step.outcome,"APPLIED");
  assert.equal(dispatches(h,"alpha"),1);
});

test("A042-02 a generator that does not exist on Perchance needs creation and is never dispatched",async()=>{
  const h=await harness({slugs:[]});
  h.repo.snapshot.items.push({slug:"ghost",deploy:"auto",payloadHash:h.payloadHash,thumbnailHash:null,listing:"PUBLICLY_LISTED"});
  await h.create("ghost");await h.automatic.enable();
  assert.equal((await h.automatic.step()).status,"EXISTENCE_READ");
  h.advance(AUTOMATIC_SPACING_MS);
  assert.equal((await h.automatic.evaluate())[0].reason,"NEEDS_CREATION");
  assert.equal((await h.automatic.step()).status,"COMPLETE");
  assert.equal(dispatches(h,"ghost"),0);
});

test("A042-02 a stale repository snapshot or a disabled mode dispatches nothing and retires timers",async()=>{
  const h=await harness();await readyUpdate(h,"alpha");await h.automatic.enable();
  h.repo.lastCheckedAt=new Date(h.now()-3*60*60*1000).toISOString();
  assert.equal((await h.automatic.evaluate())[0].reason,"SNAPSHOT_STALE");
  h.repo.lastCheckedAt=h.clock();h.repo.lastFailure={code:"UNAVAILABLE"};
  assert.equal((await h.automatic.evaluate())[0].reason,"SNAPSHOT_STALE");
  h.repo.lastFailure=null;
  await h.automatic.disable();
  assert.ok(!(await h.timers.list()).some(t=>AUTOMATIC_TIMERS.includes(t.value.timerId)&&t.value.state==="SCHEDULED"));
  assert.deepEqual(await h.automatic.enqueueCycle(h.clock()),{started:false});
  const before=dispatches(h,"alpha");await h.runDue();assert.equal(dispatches(h,"alpha"),before);
});

test("A042-02 the Deployer page states the mode, previews unmet gates and refuses Automatic while gated",async()=>{
  const h=await harness({unattended:false});
  const service={read:h.repository.read,startScan:async()=>null,scanStep:async()=>null,automatic:h.automatic};
  const ui=createUiContribution({service});
  normalizePcmsUiDescriptor({contractVersion:ui.contractVersion,moduleId:ui.moduleId,title:ui.title,description:ui.description,
    icon:ui.icon,nav:ui.nav,actions:ui.actions,page:ui.page},{moduleId:"deployer"});
  const preview=await ui.invoke({}, "automatic-on",null,{}, {mode:"preview"});
  normalizePcmsUiReceipt(preview,{mode:"preview",risk:"EXTERNAL_MUTATION"});
  assert.ok(preview.impact.consequences.some(c=>c.startsWith("Unmet: Unattended Perchance driver")));
  await assert.rejects(ui.invoke({}, "automatic-on",null,{}, {}),e=>e.code==="PCMS_DEPLOYER_AUTOMATIC_GATED");
  const summary=normalizePcmsUiSummary(await ui.summary());
  assert.equal(summary.facts.find(f=>f.label==="Deployment").value,"Assisted");
  h.emulator.setCapabilities({unattended:true});await ui.invoke({}, "automatic-on",null,{}, {});
  assert.equal(normalizePcmsUiSummary(await ui.summary()).facts.find(f=>f.label==="Deployment").value,"Automatic");
  h.emulator.setCapabilities({unattended:false});
  const conditions=normalizePcmsUiConditions(await ui.conditions(),"deployer");
  assert.ok(conditions.some(c=>c.key==="deployer:automatic-gate:unattended"));
  assert.equal(normalizePcmsUiSummary(await ui.summary()).facts.find(f=>f.label==="Deployment").value,"Automatic (waiting: gate unmet)");
  await ui.invoke({}, "automatic-off",null,{}, {});
  assert.equal((await h.automatic.readControl()).value.enabled,false);
});
