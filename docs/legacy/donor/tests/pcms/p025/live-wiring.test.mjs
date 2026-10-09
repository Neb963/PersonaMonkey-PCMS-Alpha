import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PCMS_INTERNAL_BROKER_EVENTS_PORT,
  PCMS_INTERNAL_BROKER_REQUEST_TYPE,
  createFirefoxPersonaBrokerTransport
} from "../../../extension/pcms/platform/firefox-persona-broker-transport.js";
import { PERSONA_BROKER_INTEGRATION_EVENTS_PORT } from "../../../extension/pcms/core/persona-broker.js";
import { createPcmsModuleProjectionService } from "../../../extension/pcms/app/module-projections.js";
import { parsePcmsDeepLink, pcmsRouteHref } from "../../../extension/pcms/app/deep-links.js";

test("P025 Firefox Persona Broker transport uses only bounded same-extension messages", async () => {
  const sent=[];
  let eventListener=null;
  let disconnected=false;
  const runtime={
    async sendMessage(message){sent.push(message);return {ok:true};},
    connect({name}){
      assert.equal(name,PCMS_INTERNAL_BROKER_EVENTS_PORT);
      return {
        onMessage:{
          addListener(listener){eventListener=listener;},
          removeListener(listener){if(eventListener===listener)eventListener=null;}
        },
        disconnect(){disconnected=true;}
      };
    }
  };
  const transport=createFirefoxPersonaBrokerTransport({runtime});
  const envelope=Object.freeze({type:"PERSONAMONKEY_INTEGRATION_REQUEST",version:1,requestId:"r1",command:"system.status",params:Object.freeze({})});
  assert.deepEqual(await transport.send(envelope),{ok:true});
  assert.equal(sent.length,1);
  assert.equal(sent[0].type,PCMS_INTERNAL_BROKER_REQUEST_TYPE);
  assert.equal(sent[0].request,envelope);

  const events=[];
  const subscription=transport.openEvents(PERSONA_BROKER_INTEGRATION_EVENTS_PORT,(event)=>events.push(event));
  assert.equal(typeof eventListener,"function");
  eventListener({sequence:1});
  assert.deepEqual(events,[{sequence:1}]);
  subscription.disconnect();
  assert.equal(disconnected,true);
  assert.equal(eventListener,null);
  assert.throws(()=>transport.openEvents("wrong-port",()=>{}),TypeError);
});

test("P025 installed product identifies and opens as PCMS", async () => {
  const [manifestText,popup,index]=await Promise.all([
    readFile("extension/manifest.json","utf8"),
    readFile("extension/popup/popup.html","utf8"),
    readFile("extension/pcms/app/index.html","utf8")
  ]);
  const manifest=JSON.parse(manifestText);
  assert.equal(manifest.name,"PersonaMonkey PCMS");
  assert.equal(manifest.action.default_title,"PersonaMonkey PCMS");
  assert.equal(manifest.options_ui.page,"pcms/app/index.html");
  assert.match(popup,/PersonaMonkey PCMS/);
  assert.match(popup,/<button id="options" class="primary">Open PCMS<\/button>/);
  assert.match(popup,/PersonaMonkey settings/);
  assert.match(index,/PCMS modules/);
  // A040-03: the module cards of the P026 page are superseded by contributed module pages;
  // each feature module still names itself, now in its built-in contribution.
  for(const [module,path] of [["Explorer","p016"],["Deployer","p015"],["Refresher","p017"],["Statistics","p018"],["Provisioning","p019"]]) {
    assert.match(await readFile("pcms-modules/"+path+"/ui.js","utf8"),new RegExp("title:\\s*\""+module+"\""));
  }
});

test("P025 production runtime composes and surfaces all accepted feature modules", async () => {
  const [app,liveRuntime,liveCore,builder]=await Promise.all([
    readFile("extension/pcms/app/app.js","utf8"),
    readFile("extension/pcms/app/live-runtime.js","utf8"),
    readFile("extension/pcms/integration/live-core.js","utf8"),
    readFile("scripts/build-extension.mjs","utf8")
  ]);
  assert.match(app,/createPcmsModuleProjectionService/);
  // A040-03: the legacy module cards (renderModules) are superseded by contributed module pages.
  assert.match(app,/renderModulePage/);
  assert.match(app,/renderOverviewCards/);
  assert.doesNotMatch(app,/emptyProjection/);
  for(const phase of ["p014","p015","p016","p017","p018","p019"]) {
    assert.match(liveRuntime,new RegExp("/pcms-modules/"+phase+"/"));
  }
  assert.match(liveCore,/createPcmsModuleIntegration/);
  assert.match(liveCore,/createProviderGate/);
  assert.match(liveCore,/providers:Object\.freeze\(\{\}\)/);
  assert.match(liveRuntime,/command:"system\.status"/);
  assert.match(builder,/const moduleSource = resolve\(root, "pcms-modules"\)/);
  assert.match(builder,/copyModuleTree\(moduleSource, resolve\(stage, "pcms-modules"\)\)/);
  assert.match(builder,/relocateModuleSource/);
  assert.match(builder,/verifyPackagedModuleGraph/);
  assert.doesNotMatch(builder,/copyTree\(moduleSource, resolve\(stage, "pcms-modules"\)\)/);
  assert.equal(pcmsRouteHref("modules"),"#/modules");
  assert.equal(parsePcmsDeepLink("#/modules").route,"modules");
});

test("P025 module projection reads Explorer, Deployer, Refresher, Statistics and Provisioning", async () => {
  const runtime={
    deployer:{async listDeploymentViews(){return {revision:1,deployments:[{deploymentId:"dep-1",accountId:"acct-1",generatorId:"gen-1",syncState:"IN_SYNC"}]};}},
    explorer:{
      async listCandidates(){return {revision:2,candidates:[{candidateId:"cand-1",accountId:"acct-1",generatorId:"gen-2",freshness:"CURRENT"}]};},
      async listReservations(){return {revision:2,reservations:[{claimId:"claim-1",deploymentId:"dep-2",accountId:"acct-1",status:"READY",ready:true}]};}
    },
    refresher:{async listCohortViews(){return {revision:3,cohorts:[{cohortId:"cohort-1",accountId:"acct-1",mode:"MANUAL",budget:{limit:10,used:1}}]};}},
    statistics:{
      async rebuild(){return {cursor:0};},
      view(){return {cursor:4,lateEventCount:0,metrics:[{metricId:"attention_opened",label:"Attention opened",value:2,matchedEvents:2,series:[]}]};}
    },
    provisioning:{async listAttempts(){return [{revision:1,value:{attemptId:"attempt-1",accountId:"acct-1",state:"WAITING_HUMAN",humanReason:"CAPTCHA"}}];}}
  };
  const service=createPcmsModuleProjectionService({runtime});
  const snapshot=await service.snapshot();
  assert.equal(snapshot.deployer.items.length,1);
  assert.equal(snapshot.explorer.candidates.length,1);
  assert.equal(snapshot.explorer.reservations.length,1);
  assert.equal(snapshot.refresher.items.length,1);
  assert.equal(snapshot.statistics.items[0].value,2);
  assert.equal(snapshot.provisioning.items[0].state,"WAITING_HUMAN");
});

test("P025 built-in principal reuses Integration-v1 policy rather than legacy management API", async () => {
  const [integration,background,liveCore]=await Promise.all([
    readFile("extension/lib/management-integration.js","utf8"),
    readFile("extension/background.js","utf8"),
    readFile("extension/pcms/integration/live-core.js","utf8")
  ]);
  assert.match(integration,/INTERNAL_PCMS_INTEGRATION_SENDER_ID = "pcms-internal@personamonkey\.local"/);
  assert.match(integration,/return Object\.freeze\(\{ \.\.\.current, enabled:true \}\)/);
  assert.doesNotMatch(integration,/\.\.\.current, enabled:true, allowDirect:true/);
  assert.doesNotMatch(integration,/\.\.\.current, enabled:true, allowDestructive:true/);
  assert.doesNotMatch(integration,/\.\.\.current, enabled:true, allowExternalAutomation:true/);
  assert.doesNotMatch(integration,/\.\.\.current, enabled:true, allowExecutableInstall:true/);
  assert.match(integration,/handleInternalRequest/);
  assert.match(integration,/attachInternalPort/);
  assert.match(background,/isPcmsExtensionPageSender/);
  assert.match(background,/managementIntegration\.handleInternalRequest\(message\.request\)/);
  assert.match(background,/managementIntegration\.attachInternalPort\(port\)/);
  assert.doesNotMatch(liveCore,/pcms-client|PCMS_REQUEST|browser\.|nativeMessaging|personaApi|stateManager/);
});


test("P025 packaging regression: repository-relative module imports require relocation inside the XPI", async () => {
  const sources=await Promise.all([
    readFile("pcms-modules/p015/deployer.js","utf8"),
    readFile("pcms-modules/p016/schema.js","utf8"),
    readFile("pcms-modules/p017/refresher-helpers.js","utf8"),
    readFile("pcms-modules/p019/schema.js","utf8")
  ]);
  assert.equal(sources.some((source)=>source.includes("../../extension/pcms/")),true);
  const builder=await readFile("scripts/build-extension.mjs","utf8");
  assert.match(builder,/Unresolved repository-relative extension import/);
  assert.match(builder,/Broken packaged PCMS import/);
});
