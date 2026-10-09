import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "../p036/harness.mjs";
import { createDeployerObservations, OBSERVATION_NAMESPACE } from "../../../pcms-modules/p015/observations.js";
import { createVerificationSweep, VERIFICATION_SERVICE, VERIFICATION_TIMERS } from "../../../pcms-modules/p015/verification-sweep.js";
import { createTimerService } from "../../../extension/pcms/services/timers.js";
import { createCoreServiceRegistry } from "../../../extension/pcms/services/registry.js";
import { createGeneratorIndexService } from "../../../extension/pcms/integration/generator-index.js";
import { generatorPayloadHash } from "../../../extension/pcms/providers/perchance/contract.js";

const CODE="lists\n  exact source",HTML="<main>exact HTML</main>",COMMIT="a".repeat(40);
function harness({enabled=true,provider=null,failRead=false}={}){
  const h=setup();let time=Date.parse("2026-10-08T12:00:00.000Z");const clock=()=>new Date(time).toISOString();
  h.emulator.setCapabilities({observe:enabled});
  const store=h.storage.namespace(OBSERVATION_NAMESPACE);
  const repository={async deployFromRepository({deploymentId,expectedRevision}){
    return h.deployer.deploy(deploymentId,{expectedRevision,payload:{code:CODE,html:HTML,thumbnail:null}});
  }};
  const options={deployer:h.deployer,accounts:h.accounts.service,provider:provider??(failRead?{...h.adapter,async observe(){throw new Error("Unreadable editor");}}:h.adapter),store,humanTasks:h.humanTasks,
    recoveryHold:h.recoveryHold,clock,repository,readDesiredPayload:async()=>({code:CODE,html:HTML,thumbnail:null})};
  const obs=createDeployerObservations(options);h.deployer.bindObservations(obs);
  const generators=createGeneratorIndexService({deployer:h.deployer,accounts:{...h.accounts.service,listAccounts:async()=>({accounts:[await h.accounts.service.getAccount("acct-1")]})},
    humanTasks:h.humanTasks,recoveryHold:h.recoveryHold,observations:obs,clock});
  const registry=createCoreServiceRegistry(),timers=createTimerService({storageBroker:h.storage,auditJournal:h.audit.journal,serviceRegistry:registry,clock});
  const sweep=createVerificationSweep({observations:obs,timers,clock});registry.register(VERIFICATION_SERVICE,{onTimer:sweep.onTimer},{ownerId:"core",generation:0});
  async function create(slug="alpha",origin="MANUAL"){
    const current=await h.deployer.listDeployments();
    const value=await h.deployer.createDeployment({deploymentId:"gen:"+slug,accountId:"acct-1",generatorId:slug,
      payloadHash:await generatorPayloadHash(CODE,HTML),thumbnailHash:null,listing:"PUBLICLY_LISTED",
      origin:origin==="MANUAL"?{kind:"MANUAL"}:{kind:"REPOSITORY",commitId:COMMIT,path:"alice/"+slug,version:"1.0"}},{expectedRevision:current.revision});
    return h.deployer.deploy(value.deployment.deploymentId,{expectedRevision:value.revision,payload:{code:CODE,html:HTML,thumbnail:null}});
  }
  async function alter(slug="alpha",{code=CODE,html=HTML,settings={isPrivate:false},thumbnail=null}={}){
    h.emulator.seedGenerator({generatorId:slug,code,html,settings,thumbnail});
  }
  async function choice(id="gen:alpha"){
    const listed=await h.deployer.listDeployments();const state=await obs.get(id);
    return {expectedRevision:listed.revision,expectedObservedAt:state.observation.observedAt,confirmation:id.slice(4)};
  }
  return {...h,obs,options,store,generators,timers,sweep,create,alter,choice,clock,advance(ms=10000){time+=ms;}};
}
test("A039-01 confirmed assisted apply is explicitly unverified with no fabricated baseline",async()=>{
  const h=harness({enabled:false}),result=await h.create();
  assert.equal(result.deployment.confirmed.baselineHash,null);
  const observed=await h.obs.get("gen:alpha");assert.equal(observed.available,false);
  assert.equal(observed.observation.method,"OPERATOR_CONFIRMED");assert.equal(observed.observation.payloadHash,null);
  assert.deepEqual((await h.generators.list()).rows[0].notes,["not verified"]);
  assert.equal((await h.obs.verifyNow("gen:alpha")).status,"GATED");
});
test("A039-02 post-apply read establishes a baseline, without storing code or HTML",async()=>{
  const h=harness(),result=await h.create();
  assert.equal(result.deployment.confirmed.baselineHash,await generatorPayloadHash(CODE,HTML));
  assert.ok((await h.generators.list()).rows[0].notes[0].startsWith("verified"));
  const records=JSON.stringify([...h.storage.shared.rows.values()]);
  assert.ok(!records.includes(CODE));assert.ok(!records.includes(HTML));
});
test("A039-01 an advertised but failed post-apply read remains visibly unverified",async()=>{
  const h=harness({failRead:true}),result=await h.create();
  assert.equal(result.deployment.confirmed.baselineHash,null);
  assert.equal((await h.obs.get("gen:alpha")).observation.method,"OPERATOR_CONFIRMED");
  assert.deepEqual((await h.generators.list()).rows[0].notes,["not verified"]);
});
test("A039-02 a failed post-apply baseline remains uncertain across reconciliation and cannot dispatch again",async()=>{
  const h=harness({enabled:false});await h.create();h.emulator.setCapabilities({observe:true});
  await h.alter("alpha",{code:"unapplied content"});
  await h.obs.verifyNow("gen:alpha");let d=await h.deployer.getDeployment("gen:alpha");
  assert.equal(d.operation.status,"RECONCILE");assert.equal(d.confirmed.baselineHash,null);
  const dispatches=h.emulator.dispatched().length;
  const list=await h.deployer.listDeployments();await assert.rejects(h.deployer.deploy("gen:alpha",{expectedRevision:list.revision,payload:{code:CODE,html:HTML,thumbnail:null}}));
  h.advance();await h.deployer.reconcileDeployment("gen:alpha",{expectedRevision:list.revision});
  assert.equal((await h.deployer.getDeployment("gen:alpha")).operation.status,"RECONCILE");
  assert.equal(h.emulator.dispatched().length,dispatches);
  h.advance();await h.alter();await h.obs.verifyNow("gen:alpha");
  assert.equal((await h.deployer.getDeployment("gen:alpha")).operation.status,"SUCCEEDED");
});
test("A039-02 repository intent changes are not drift; later provider changes pause only that target",async()=>{
  const h=harness();await h.create("alpha","REPOSITORY");h.advance();await h.create("beta");
  let list=await h.deployer.listDeployments(),d=list.deployments.find(d=>d.deploymentId==="gen:alpha");
  await h.deployer.setDesired("gen:alpha",{expectedRevision:list.revision,expectedDesiredRevision:d.desired.revision,
    payloadHash:await generatorPayloadHash("new repo",HTML),thumbnailHash:null,listing:"PUBLICLY_LISTED",
    origin:{kind:"REPOSITORY",commitId:COMMIT,path:"alice/alpha",version:"2.0"}});
  h.advance();await h.obs.verifyNow("gen:alpha");assert.equal((await h.obs.get("gen:alpha")).drift,false);
  h.advance();await h.alter("alpha",{code:"local provider edit"});await h.obs.verifyNow("gen:alpha");
  assert.equal((await h.obs.get("gen:alpha")).drift,true);
  assert.equal((await h.deployer.getDeployment("gen:alpha")).policy.pauseReason,"DRIFT");
  assert.equal((await h.deployer.getDeployment("gen:beta")).policy.paused,false);
  list=await h.deployer.listDeployments();await assert.rejects(h.deployer.setPaused("gen:alpha",{expectedRevision:list.revision,paused:false}));
  assert.equal((await h.generators.list()).rows.find(r=>r.slug==="alpha").status.label,"Changed on Perchance");
});
test("A039-02 UNKNOWN listing is not a mismatch; known listing drift and missing generators are",async()=>{
  const h=harness();await h.create();h.advance();h.emulator.setSettingsShape({unexpected:true});
  await h.obs.verifyNow("gen:alpha");assert.equal((await h.obs.get("gen:alpha")).drift,false);
  h.advance();h.emulator.setSettingsShape({isPrivate:true});await h.obs.verifyNow("gen:alpha");
  assert.equal((await h.generators.list()).rows[0].status.label,"Listing differs");
  const rawProvider={...h.adapter,observe:async()=>({exists:false,payloadHash:null,thumbnailHash:null,listing:"UNKNOWN",challenge:false})};
  const missing=createDeployerObservations({...h.options,provider:rawProvider});h.advance();await missing.verifyNow("gen:alpha");
  assert.equal((await h.generators.list()).rows[0].status.label,"Missing on Perchance");
  await assert.rejects(missing.keep("gen:alpha",await h.choice()));
});
test("A039-02 Keep adopts the observed baseline, stays paused, and a newer repository release resumes",async()=>{
  const h=harness();await h.create("alpha","REPOSITORY");h.advance();await h.alter("alpha",{code:"kept provider edit",settings:{isPrivate:true}});
  await h.obs.verifyNow("gen:alpha");await h.obs.keep("gen:alpha",await h.choice());
  assert.equal((await h.obs.get("gen:alpha")).drift,false);
  assert.equal((await h.generators.list()).rows[0].status.label,"Diverged from repository");
  assert.equal((await h.deployer.getDeployment("gen:alpha")).policy.paused,true);
  h.advance();await h.obs.verifyNow("gen:alpha");assert.equal((await h.obs.get("gen:alpha")).drift,false);
  const list=await h.deployer.listDeployments(),d=list.deployments[0];
  const next=await h.deployer.setDesired("gen:alpha",{expectedRevision:list.revision,expectedDesiredRevision:d.desired.revision,
    payloadHash:await generatorPayloadHash("next release",HTML),thumbnailHash:null,listing:"PUBLICLY_LISTED",
    origin:{kind:"REPOSITORY",commitId:COMMIT,path:"alice/alpha",version:"2.0"}});
  assert.equal(next.deployment.policy.paused,false);assert.equal(next.revision,(await h.deployer.listDeployments()).revision);
  assert.equal(next.revision,list.revision+1); // No crash window between intent and resume.
  await createDeployerObservations(h.options).recover();
  assert.equal((await h.deployer.getDeployment("gen:alpha")).policy.paused,false);
});
test("A039-02 a new release with identical repository bytes resumes Keep atomically, while fresh drift stays paused",async()=>{
  for(const freshDrift of [false,true]){
    const h=harness();await h.create("alpha","REPOSITORY");h.advance();await h.alter("alpha",{code:"kept provider edit"});
    await h.obs.verifyNow("gen:alpha");await h.obs.keep("gen:alpha",await h.choice());
    if(freshDrift){h.advance();await h.alter("alpha",{code:"another provider edit"});await h.obs.verifyNow("gen:alpha");}
    const before=await h.deployer.listDeployments(),old=before.deployments[0],dispatches=h.emulator.dispatched().length;
    const result=await h.deployer.setRepositoryOrigin("gen:alpha",{expectedRevision:before.revision,
      expectedDesiredRevision:old.desired.revision,payloadHash:old.desired.payloadHash,thumbnailHash:old.desired.thumbnailHash,
      listing:old.desired.listing,origin:{...old.desired.origin,version:"2.0"}});
    assert.equal(result.revision,before.revision+1);
    assert.equal(result.deployment.policy.paused,freshDrift);
    assert.equal(result.deployment.desired.revision,old.desired.revision+(freshDrift?0:1));
    assert.equal(result.deployment.operation.operationId===old.operation.operationId,freshDrift);
    assert.equal((await h.generators.list()).rows[0].status.label,freshDrift?"Changed on Perchance":"Update ready");
    assert.equal(h.emulator.dispatched().length,dispatches);
  }
});
test("A039-02 explicit resume after Keep prepares a fresh operation and reports the remaining repository change",async()=>{
  for(const [change,label] of [
    [{code:"kept provider edit"},"Update ready"],
    [{settings:{isPrivate:true}},"Listing change ready"],
    [{thumbnail:"/9j/AA=="},"Update ready"]
  ]){
    const h=harness();await h.create("alpha","REPOSITORY");h.advance();await h.alter("alpha",change);
    await h.obs.verifyNow("gen:alpha");await h.obs.keep("gen:alpha",await h.choice());
    h.advance();await h.obs.verifyNow("gen:alpha");
    assert.deepEqual((await h.deployer.getDeployment("gen:alpha")).policy,{paused:true,pauseReason:"OPERATOR"});
    const before=await h.deployer.listDeployments(),old=before.deployments[0],dispatches=h.emulator.dispatched().length;
    const resumed=await h.deployer.setPaused("gen:alpha",{expectedRevision:before.revision,paused:false});
    assert.equal(resumed.deployment.desired.revision,old.desired.revision+1);
    assert.notEqual(resumed.deployment.operation.operationId,old.operation.operationId);
    assert.equal(resumed.deployment.operation.status,"PENDING");
    assert.equal(resumed.deployment.confirmed.baselineHash,old.confirmed.baselineHash);
    assert.equal(h.emulator.dispatched().length,dispatches);
    assert.equal((await h.obs.get("gen:alpha")).drift,false);
    assert.equal((await h.generators.list()).rows[0].status.label,label);
    const unchanged=await h.deployer.setPaused("gen:alpha",{expectedRevision:resumed.revision,paused:false});
    assert.equal(unchanged.changed,false);assert.equal(unchanged.revision,resumed.revision);
    h.advance();const applied=await h.deployer.deploy("gen:alpha",{expectedRevision:resumed.revision,payload:{code:CODE,html:HTML,thumbnail:null}});
    assert.equal(applied.deployment.confirmed.operationId,resumed.deployment.operation.operationId);
    assert.equal((await h.generators.list()).rows[0].status.label,"In sync");
    assert.equal(h.emulator.dispatched().length,dispatches+1);
  }
});
test("A039-02 only explicit, current, typed overwrite creates a new revision and operation",async()=>{
  const h=harness();await h.create("alpha","REPOSITORY");h.advance();await h.alter("alpha",{code:"provider edit"});await h.obs.verifyNow("gen:alpha");
  const d=await h.deployer.getDeployment("gen:alpha"),choice=await h.choice();
  await assert.rejects(h.obs.overwrite("gen:alpha",{...choice,confirmation:"wrong"}));
  const result=await h.obs.overwrite("gen:alpha",choice);
  assert.notEqual(result.deployment.operation.operationId,d.operation.operationId);assert.equal(result.deployment.desired.revision,d.desired.revision+1);
  assert.equal(h.emulator.dispatched().length,2);h.advance();await h.timers.runDue({now:h.clock()});
  assert.equal((await h.obs.get("gen:alpha")).drift,false);
  await assert.rejects(h.obs.keep("gen:alpha",choice));
});
test("A039-02 comparison content is returned in memory, with no content in durable rows",async()=>{
  const h=harness();await h.create();h.advance();await h.alter("alpha",{code:"<script>untrusted()</script>"});
  const compare=await h.obs.compare("gen:alpha");assert.equal(compare.desired.code,CODE);assert.equal(compare.observed.code,"<script>untrusted()</script>");
  const json=JSON.stringify([...h.storage.shared.rows.values()]);assert.ok(!json.includes("untrusted"));assert.ok(!json.includes(CODE));
});
test("A039-03 sweeps run one read per occurrence, oldest-first, with a durable maximum and 10s spacing",async()=>{
  const h=harness();for(const slug of ["alpha","beta","gamma"]){await h.create(slug);h.advance();}
  await h.obs.configure({sweepLimit:2});await h.obs.enqueueSweep(h.clock());
  assert.deepEqual((await h.obs.readControl()).value.queue,["gen:alpha","gen:beta"]);
  await h.timers.runDue({now:h.clock()});assert.equal((await h.obs.readControl()).value.queue.length,1);
  await h.timers.runDue({now:h.clock()});assert.equal((await h.obs.readControl()).value.queue.length,1);
  h.advance(9999);await h.timers.runDue({now:h.clock()});assert.equal((await h.obs.readControl()).value.queue.length,1);
  h.advance(1);await h.timers.runDue({now:h.clock()});assert.equal((await h.obs.readControl()).value.queue.length,0);
  assert.ok(!(await h.timers.list()).some(r=>VERIFICATION_TIMERS.includes(r.value.timerId)&&r.value.state==="SCHEDULED"));
});
test("A039-03 a provider challenge opens one durable HumanTask and stops all automatic reads",async()=>{
  const h=harness();await h.create();h.advance();h.emulator.setChallenge(true);
  await h.obs.enqueueSweep(h.clock());await h.timers.runDue({now:h.clock()});
  let attention=await h.humanTasks.listAttention();assert.equal(attention.length,1);assert.equal(attention[0].value.taskKind,"provider.observation-challenge");
  h.advance();const recreated=createDeployerObservations(h.options);
  assert.equal((await recreated.verifyNow("gen:alpha")).status,"CHALLENGE");assert.equal((await h.humanTasks.listAttention()).length,1);
  assert.ok(!(await h.timers.list()).some(r=>r.value.state==="SCHEDULED"));
  h.emulator.setChallenge(false);await h.humanTasks.resolve(attention[0].value.taskId,{expectedRevision:attention[0].revision});
  await h.sweep.declare();await h.timers.runDue({now:h.clock()});assert.equal((await h.obs.readControl()).value.queue.length,0);
});
test("A039-03 recovery hold retains verification work without replaying it",async()=>{
  const h=harness();await h.create();h.advance();await h.obs.enqueueSweep(h.clock());
  await h.recoveryHold.enterRecoveryHold({reason:"fixture-restore"});await h.sweep.declare();
  assert.equal((await h.obs.readControl()).value.queue.length,1);
  assert.equal((await h.obs.verifyNext()).status,"HELD");
  assert.ok(!(await h.timers.list()).some(r=>r.value.state==="SCHEDULED"));
});
test("A039-02 an account rebind while a read is in flight discards the observation",async()=>{
  const h=harness();await h.create();h.advance();
  let release;const pending=new Promise(r=>release=r);
  const obs=createDeployerObservations({...h.options,provider:{...h.adapter,async observe(...args){await pending;return h.adapter.observe(...args);}}});
  const promise=obs.verifyNow("gen:alpha");await new Promise(r=>setTimeout(r,5));
  const original=h.accounts.service.getAccount;let changed=false;
  const accounts={async getAccount(id){const value=await original(id);return changed?{...value,bindingEpoch:value.bindingEpoch+1}:value;}};
  // New service snapshots this reader; change is observed after the pending provider read.
  const guarded=createDeployerObservations({...h.options,accounts,provider:{...h.adapter,async observe(...args){changed=true;return h.adapter.observe(...args);}}});
  release();await promise;h.advance();const result=await guarded.verifyNow("gen:alpha");assert.equal(result.status,"STALE");
});
test("A039-02 an interrupted metadata transition is repaired without another provider read or mutation",async()=>{
  const h=harness();await h.create();h.advance();await h.alter("alpha",{code:"changed before crash"});
  const interrupted=createDeployerObservations({...h.options,deployer:{...h.deployer,async recordProviderObservation(){throw new Error("event page stopped");}}});
  await assert.rejects(interrupted.verifyNow("gen:alpha"));
  assert.equal((await h.deployer.getDeployment("gen:alpha")).policy.paused,false);
  const dispatches=h.emulator.dispatched().length;
  const recovered=createDeployerObservations({...h.options,provider:{async probeCompatibility(){throw new Error("must not read");}}});
  await recovered.recover();
  assert.equal((await h.deployer.getDeployment("gen:alpha")).policy.pauseReason,"DRIFT");
  assert.equal(h.emulator.dispatched().length,dispatches);
});
test("A039-02 a failed keep CAS cannot adopt listing or thumbnail metadata or clear drift",async()=>{
  const h=harness();await h.create("alpha","REPOSITORY");h.advance();await h.alter("alpha",{settings:{isPrivate:true}});await h.obs.verifyNow("gen:alpha");
  const failed=createDeployerObservations({...h.options,deployer:{...h.deployer,async recordProviderObservation(){throw new Error("conflicting revision");}}});
  await assert.rejects(failed.keep("gen:alpha",await h.choice()));
  assert.equal((await h.obs.get("gen:alpha")).drift,true);
  await h.obs.recover();assert.equal((await h.obs.get("gen:alpha")).drift,true);
  assert.equal((await h.deployer.getDeployment("gen:alpha")).confirmed.listing,"PUBLICLY_LISTED");
});
test("A039-03 persisted spacing survives service reconstruction and a crashed challenge still opens just one task",async()=>{
  const h=harness();await h.create();h.advance();h.emulator.setChallenge(true);
  const failing=createDeployerObservations({...h.options,humanTasks:{...h.humanTasks,async open(){throw new Error("stopped before task");}}});
  await assert.rejects(failing.verifyNow("gen:alpha"));
  const restarted=createDeployerObservations(h.options);await restarted.recover();await restarted.recover();
  assert.equal((await h.humanTasks.listAttention()).length,1);
  const task=(await h.humanTasks.listAttention())[0];await h.humanTasks.resolve(task.value.taskId,{expectedRevision:task.revision});
  await restarted.recover();assert.equal((await h.humanTasks.listAttention()).length,0);
  h.emulator.setChallenge(false);assert.equal((await restarted.verifyNow("gen:alpha")).status,"DEFERRED");
  h.advance();assert.equal((await restarted.verifyNow("gen:alpha")).status,"OBSERVED");
});
