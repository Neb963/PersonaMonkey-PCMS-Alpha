import test from "node:test";
import assert from "node:assert/strict";

import { createPcmsInternalBrokerEndpointRegistry } from "../../../extension/lib/pcms-internal-broker-endpoint.js";
import { createBackgroundPcmsCore } from "../../../extension/pcms/background/core-factory.js";
import { createPcmsCoreHost } from "../../../extension/pcms/background/core-host.js";
import { PCMS_CORE_SESSION_KEY, PCMS_STATUS_KEY, PCMS_UI_REVISION_KEY } from "../../../extension/pcms/integration/ui-client-contract.js";
import { createPcmsUiClient } from "../../../extension/pcms/app/ui-client.js";
import { sha256Hex } from "../../../extension/pcms/providers/perchance/contract.js";
import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { createAccountsService } from "../../../pcms-modules/p014/accounts.js";
import { createDeployerService } from "../../../pcms-modules/p015/deployer.js";
import { createExplorerService } from "../../../pcms-modules/p016/explorer.js";
import { createRefresherService } from "../../../pcms-modules/p017/refresher.js";
import { createStatisticsService } from "../../../pcms-modules/p018/statistics.js";
import { createProvisioningService } from "../../../pcms-modules/p019/provisioning.js";
import { BASE_URL, PCMS_SENDER, RUNTIME_ID, UID, integrationHandler, makeDurable, makeSessionStore } from "./harness.mjs";

const featureFactories=Object.freeze({
  accounts:createAccountsService,
  deployer:createDeployerService,
  explorer:createExplorerService,
  refresher:createRefresherService,
  statistics:createStatisticsService,
  provisioning:createProvisioningService
});

// One background context: a host over durable storage, session storage and PersonaMonkey.
function backgroundContext({durable,session,handler,personaMonkeyReady=async()=>{}}){
  const registry=createPcmsInternalBrokerEndpointRegistry();
  registry.register({ready:async()=>{},handleRequest:(request)=>handler.handleRequest(request),attachEvents:async()=>true});
  let constructed=0;
  const host=createPcmsCoreHost({
    personaMonkeyReady,
    createCore:()=>{
      constructed+=1;
      return createBackgroundPcmsCore({
        transport:registry.createEndpoint(),
        featureFactories,
        storageBroker:durable.storageBroker,
        auditJournal:durable.auditJournal,
        clock:durable.clock
      });
    },
    sessionStore:session,
    runtimeId:RUNTIME_ID,
    extensionBaseUrl:BASE_URL,
    clock:durable.clock
  });
  return {host,get constructed(){return constructed;}};
}

// A dashboard tab: a UI client whose transport is runtime.sendMessage to that background.
function tab(context,{sender=PCMS_SENDER}={}){
  const listeners=new Set();
  const sent=[];
  const client=createPcmsUiClient({
    transport:{
      async send(message){sent.push(structuredClone(message));return structuredClone(await context.host.handleUiMessage(structuredClone(message),sender));},
      subscribeRevision(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
    }
  });
  return {client,sent,runtime:client.runtime};
}

async function settle(){for(let i=0;i<20;i+=1) await new Promise((resolve)=>setImmediate(resolve));}

test("A028-01 exactly one Core per background context, however many tabs and requests",async()=>{
  const durable=makeDurable();
  const session=makeSessionStore();
  const background=backgroundContext({durable,session,handler:integrationHandler()});
  const [a,b]=await Promise.all([background.host.ensurePcmsCore(),background.host.ensurePcmsCore()]);
  assert.equal(a,b);
  const tabs=[tab(background),tab(background),tab(background)];
  await Promise.all(tabs.map(({client})=>client.status()));
  await Promise.all(tabs.map(({runtime})=>runtime.accounts.listAccounts()));
  for(const {client} of tabs) client.close();
  await Promise.all([tab(background),tab(background)].map(({client})=>client.status()));
  const status=await tab(background).client.status();
  assert.equal(status.state,"RUNNING");
  assert.equal(status.constructedCores,1);
  assert.equal(background.constructed,1,"opening and closing tabs never constructs another Core");
});

test("A028-01 Core waits for PersonaMonkey bootstrap and reports UNAVAILABLE when it fails",async()=>{
  const durable=makeDurable();
  const session=makeSessionStore();
  let release;
  let fail=true;
  const gate=new Promise((resolve)=>{release=resolve;});
  const background=backgroundContext({
    durable,session,handler:integrationHandler(),
    personaMonkeyReady:async()=>{await gate;if(fail) throw new Error("routing blocked");}
  });
  const pending=background.host.ensurePcmsCore();
  await settle();
  assert.equal(background.constructed,0,"Core must not exist before PersonaMonkey bootstrap completes");
  assert.equal(background.host.state,"STARTING");
  release();
  await assert.rejects(pending,/routing blocked/);
  await settle();
  assert.equal(background.constructed,0);
  const failed=await tab(background).client.status();
  assert.equal(failed.state,"UNAVAILABLE");
  assert.equal(failed.reason,"personamonkey-bootstrap-failed");
  assert.equal((await session.get(PCMS_STATUS_KEY)).state,"UNAVAILABLE");
  await assert.rejects(tab(background).runtime.accounts.listAccounts(),(error)=>error.code==="PCMS_CORE_UNAVAILABLE");
  fail=false;
  await background.host.ensurePcmsCore();
  assert.equal((await tab(background).client.status()).state,"RUNNING");
  assert.equal(background.constructed,1);
});

test("A028-02 cold start writes the session marker; a woken context classifies as warm and recovers interrupted dispatch",async()=>{
  const durable=makeDurable();
  const session=makeSessionStore();
  const first=backgroundContext({durable,session,handler:integrationHandler()});
  await first.host.ensurePcmsCore();
  assert.equal((await tab(first).client.status()).wake,"COLD");
  const marker=await session.get(PCMS_CORE_SESSION_KEY);
  assert.match(marker.sessionId,/^[0-9a-f]{32}$/);

  // The first context is mid-dispatch when Firefox unloads the event page.
  const remoteOps=createRemoteOps({storageBroker:durable.storageBroker,clock:durable.clock});
  let row=await remoteOps.prepare({operationId:"warm-1",providerId:"perchance",action:"generator.update",
    targetRef:{kind:"generator",id:"gen-warm"},intentFingerprint:"intent:v1:warm"});
  await remoteOps.beginDispatch("warm-1",{expectedRevision:row.revision});

  const second=backgroundContext({durable,session,handler:integrationHandler()});
  const status=await tab(second).client.status();
  assert.equal(status.wake,"WARM");
  assert.equal(status.recoveryState,"RECOVERY_HOLD");
  assert.equal(status.counts.unresolvedOperations,1);
  assert.equal((await remoteOps.get("warm-1")).value.state,"UNCERTAIN");
  assert.deepEqual(await session.get(PCMS_CORE_SESSION_KEY),marker,"warm wake keeps the session marker");

  // Browser restart clears storage.session: cold start, P026 recovery unchanged.
  const restarted=backgroundContext({durable,session:makeSessionStore(),handler:integrationHandler()});
  const cold=await tab(restarted).client.status();
  assert.equal(cold.wake,"COLD");
  assert.equal(cold.recoveryState,"RECOVERY_HOLD");
});

test("A028-02 assisted provider step is a durable HumanTask reconciled after every tab closed and the page unloaded",async()=>{
  const durable=makeDurable();
  const session=makeSessionStore();
  const handler=integrationHandler();
  const first=backgroundContext({durable,session,handler});
  const dashboard=tab(first);
  const r=dashboard.runtime;

  const listed=await r.accounts.listAccounts();
  await r.accounts.createAccount({accountId:"acct-1",displayName:"Primary",personaUid:UID},{expectedRevision:listed.revision});
  const source="p028 representative source";
  const sourceHash=await sha256Hex(source);
  const deployments=await r.deployer.listDeployments();
  const created=await r.deployer.createDeployment({deploymentId:"dep-1",accountId:"acct-1",generatorId:"gen-1",sourceHash},{expectedRevision:deployments.revision});
  await assert.rejects(r.deployer.deploy("dep-1",{expectedRevision:created.revision,source}),
    (error)=>/PROVIDER_PROTOCOL$/.test(error.code),"the handoff leaves the outcome unknown");

  const attention=await r.humanTasks.listAttention({limit:50});
  const task=attention.find((item)=>item.value.taskKind==="provider.confirm-apply");
  assert.ok(task,"a durable confirmation HumanTask is open");
  assert.deepEqual(task.value.subjectRef,{kind:"generator",id:"gen-1"});
  const unresolved=await r.remoteOps.listUnresolved();
  assert.equal(unresolved.length,1);
  assert.equal(unresolved[0].value.state,"UNCERTAIN");
  const opensAfterDispatch=handler.seen.filter((request)=>request.command==="persona.open").length;
  assert.equal(opensAfterDispatch,1);

  // Every tab closes and the event page unloads. A new tab in a new context answers.
  dashboard.client.close();
  const second=backgroundContext({durable,session,handler});
  const later=tab(second);
  assert.equal((await later.client.status()).wake,"WARM");
  const detail=await later.runtime.providerHandoff.describe(task.value.taskId);
  assert.equal(detail.source,source);
  assert.equal(detail.sourceHash,sourceHash);
  assert.equal(detail.state,"OPEN");

  // UNKNOWN keeps the target UNCERTAIN, asks again and never replays.
  const unknown=await later.runtime.providerHandoff.answer(task.value.taskId,"UNKNOWN");
  assert.equal(unknown.operationState,"UNCERTAIN");
  const reopened=(await later.runtime.humanTasks.listAttention({limit:50})).find((item)=>item.value.taskKind==="provider.confirm-apply");
  assert.ok(reopened&&reopened.value.taskId!==task.value.taskId,"a fresh confirmation task replaces the unknown answer");

  const applied=await later.runtime.providerHandoff.answer(reopened.value.taskId,"APPLIED");
  assert.equal(applied.operationState,"SUCCEEDED");
  const current=await later.runtime.deployer.listDeployments();
  const reconciled=await later.runtime.deployer.reconcileDeployment("dep-1",{expectedRevision:current.revision});
  assert.equal(reconciled.deployment.operation.status,"SUCCEEDED");
  assert.equal((await later.runtime.remoteOps.listUnresolved()).length,0);
  const dispatchOpens=handler.seen.filter((request)=>request.command==="persona.open"&&/:open$/.test(request.operationId));
  assert.equal(dispatchOpens.length,1,"the provider dispatch is never replayed");
  assert.equal((await later.runtime.humanTasks.listAttention({limit:50})).filter((item)=>item.value.taskKind==="provider.confirm-apply").length,0);
});

test("A028-03 commands publish the storage.session revision signal and the non-secret status summary",async()=>{
  const durable=makeDurable();
  const session=makeSessionStore();
  const background=backgroundContext({durable,session,handler:integrationHandler()});
  const {runtime}=tab(background);
  await runtime.accounts.listAccounts();
  await settle();
  const before=await session.get(PCMS_UI_REVISION_KEY);
  await runtime.accounts.createAccount({accountId:"acct-2",displayName:"Second",personaUid:UID},{expectedRevision:0});
  await settle();
  const after=await session.get(PCMS_UI_REVISION_KEY);
  assert.ok(after.seq>before.seq);
  assert.deepEqual(after.topics,["accounts","attention"]);
  const status=await session.get(PCMS_STATUS_KEY);
  assert.equal(status.state,"RUNNING");
  assert.deepEqual(status.personaAccounts,[{personaUid:UID,accounts:[{accountId:"acct-2",displayName:"Second"}]}]);
  assert.equal(status.counts.accounts,1);
  assert.doesNotMatch(JSON.stringify(status),/cookieStoreId|credential|secret|firefox-container/i);
});
