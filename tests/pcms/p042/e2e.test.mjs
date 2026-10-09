import assert from "node:assert/strict";
import test from "node:test";
import { harness, HTML } from "./harness.mjs";
import { AUTOMATIC_SPACING_MS } from "../../../pcms-modules/p015/automatic.js";
import { generatorPayloadHash } from "../../../extension/pcms/providers/perchance/contract.js";
import { createPcmsLiveMutationIntegration } from "../../../extension/pcms/integration/live-mutations.js";
import { createDeployerAutomatic } from "../../../pcms-modules/p015/automatic.js";
import { makeStorage } from "../p010-harness.mjs";

test("A042-03 emulator end-to-end: a repository release deploys automatically and post-apply verification proves it",async()=>{
  const h=await harness();await h.create("alpha",{deployed:true});
  const released=await h.release("alpha","release two");
  assert.equal(released.deployment.operation.status,"PENDING");
  await h.automatic.enable();h.advance(AUTOMATIC_SPACING_MS);
  for(let i=0;i<4;i++){await h.runDue();h.advance(AUTOMATIC_SPACING_MS);}
  const d=await h.deployer.getDeployment("gen:alpha"),hash=await generatorPayloadHash("release two",HTML);
  assert.equal(d.operation.status,"SUCCEEDED");assert.equal(d.confirmed.payloadHash,hash);
  // generator.observe read back exactly the deployed bytes and established the provider baseline.
  assert.equal(d.confirmed.baselineHash,hash);
  const state=await h.obs.get("gen:alpha");assert.equal(state.observation.method,"PROVIDER_READ");assert.equal(state.drift,false);
  assert.equal(h.emulator.getGenerator("alpha").code,"release two");
  assert.equal((await h.remoteOps.get(d.operation.operationId)).value.state,"SUCCEEDED");
  // A later provider-side edit is drift: paused, never overwritten automatically.
  h.emulator.seedGenerator({generatorId:"alpha",code:"hand edit",html:HTML,settings:{isPrivate:false}});
  h.advance(AUTOMATIC_SPACING_MS);await h.obs.verifyNow("gen:alpha");
  await h.release("alpha","release three").catch(()=>null);
  const dispatched=h.emulator.dispatched().length;
  await h.automatic.enqueueCycle(h.clock());for(let i=0;i<3;i++){await h.runDue();h.advance(AUTOMATIC_SPACING_MS);}
  assert.equal(h.emulator.dispatched().length,dispatched);
  assert.equal((await h.deployer.getDeployment("gen:alpha")).policy.pauseReason,"DRIFT");
  assert.equal(h.emulator.getGenerator("alpha").code,"hand edit");
});

test("A042-03 the unattended capability stays disabled for real Perchance, so Automatic cannot be turned on",async()=>{
  const storageBroker=makeStorage();
  const broker={async request(envelope){return {ok:true,bootId:"b",revision:0,result:envelope.command==="system.describe"
    ?{commands:[],externalAutomation:{executionAvailable:true}}:{}};}};
  const live=createPcmsLiveMutationIntegration({storageBroker,personaBroker:broker,operator:{choose:async()=>null}});
  const provider=live.providerProbes[0];
  const probe=await provider.probeCompatibility();
  assert.equal(probe.capabilities.unattended,false);assert.equal(probe.capabilities.observe,false);
  const h=await harness();
  const automatic=createDeployerAutomatic({deployer:h.deployer,repository:h.repository,observations:h.obs,provider,
    accounts:h.accounts.service,recoveryHold:h.recoveryHold,store:storageBroker.namespace("module.deployer.automatic")});
  await assert.rejects(automatic.enable(),e=>e.unmet.includes("unattended"));
});
