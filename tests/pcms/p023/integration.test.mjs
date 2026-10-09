import test from "node:test";
import assert from "node:assert/strict";

import { createPcmsModuleIntegration } from "../../../extension/pcms/integration/composition.js";
import { createAccountsService } from "../../../pcms-modules/p014/accounts.js";
import { createDeployerService } from "../../../pcms-modules/p015/deployer.js";
import { createExplorerService } from "../../../pcms-modules/p016/explorer.js";
import { createRefresherService, REFRESHER_MODE } from "../../../pcms-modules/p017/refresher.js";
import { createStatisticsService } from "../../../pcms-modules/p018/statistics.js";
import { createProvisioningService } from "../../../pcms-modules/p019/provisioning.js";
import { makeCore, UID_A, HASH_A } from "./harness.mjs";
import { confirmStagedRestore } from "../../../extension/pcms/recovery/schema.js";

const factories=Object.freeze({
  accounts:createAccountsService,
  deployer:createDeployerService,
  explorer:createExplorerService,
  refresher:createRefresherService,
  statistics:createStatisticsService,
  provisioning:createProvisioningService
});

function compose(){
  const core=makeCore();
  const integration=createPcmsModuleIntegration({
    storageBroker:core.storageBroker,
    auditJournal:core.auditJournal,
    personaBroker:core.personaBroker,
    providerGate:core.providerGate,
    remoteOps:core.remoteOps,
    recoveryHold:core.recoveryHold,
    moduleRegistry:core.moduleRegistry,
    moduleRuntime:core.moduleRuntime,
    featureFactories:factories,
    provisioning:core.provisioning,
    statisticsDefinitions:[{
      metricId:"attention_opened",
      label:"Attention opened",
      eventType:"human-task.opened",
      aggregation:"COUNT",
      valuePath:null,
      subjectKind:"human-task"
    }],
    providerProbes:core.providerProbes,
    clock:core.clock
  });
  return {core,integration};
}

test("A023-01 composition binds all accepted feature factories to shared Core services and live UI projections",async()=>{
  const {integration}=compose();
  assert.equal(typeof integration.deployer.createDeployment,"function");
  assert.equal(typeof integration.explorer.recordDiscovery,"function");
  assert.equal(typeof integration.refresher.createCohort,"function");
  assert.equal(typeof integration.statistics.refresh,"function");
  assert.equal(typeof integration.provisioning.createAttempt,"function");
  assert.equal(typeof integration.moduleLifecycle.stageInstall,"function");
  assert.equal(typeof integration.backupRestore.createBackup,"function");

  await integration.accounts.createAccount({
    accountId:"acct-1",
    displayName:"Primary",
    personaUid:UID_A
  },{expectedRevision:0});
  await integration.humanTasks.open({
    taskId:"task-1",
    taskKind:"operator.review",
    title:"Review primary account",
    priority:"HIGH",
    subjectRef:{kind:"account",id:"acct-1"}
  });

  const ui=await integration.uiProjection.snapshot({query:"Primary"});
  assert.equal(ui.accounts.accounts.length,1);
  assert.equal(ui.notifications.count,1);
  assert.deepEqual(ui.search.results.map(x=>x.kind),["account"]);

  const stats=await integration.statistics.rebuild();
  const view=integration.statistics.view(stats);
  assert.equal(view.metrics[0].value,1);

  const cohort=await integration.refresher.createCohort({
    cohortId:"cohort-1",
    accountId:"acct-1",
    enabled:true,
    policy:{
      mode:REFRESHER_MODE.MANUAL,
      dailyBudget:1,
      dayOffsetMinutes:0,
      activeHours:1,
      sleepDays:1,
      anchorAt:"2026-10-05T12:00:00.000Z"
    },
    members:[{generatorId:"gen-refresh",sourceHash:HASH_A}]
  },{expectedRevision:0});
  assert.equal(cohort.cohort.accountId,"acct-1");
});

test("A023-01 Explorer reservation materializes one idempotent Deployer target through the bridge",async()=>{
  const {integration}=compose();
  await integration.accounts.createAccount({
    accountId:"acct-1",displayName:"Primary",personaUid:UID_A
  },{expectedRevision:0});

  const discovered=await integration.explorer.recordDiscovery({
    accountId:"acct-1",
    discoveryId:"scan-1",
    candidates:[{generatorId:"gen-1",observedSourceHash:HASH_A}]
  },{expectedRevision:0});
  const candidate=discovered.candidates[0];
  const claimed=await integration.explorer.claimCandidate(candidate.candidateId,{
    claimId:"claim-1",
    deploymentId:"dep-1"
  },{expectedRevision:discovered.revision});
  assert.equal(claimed.reservation.ready,true);

  const created=await integration.explorerDeployer.createDeploymentFromClaim("claim-1",{expectedDeployerRevision:0});
  assert.equal(created.created,true);
  assert.equal(created.deployment.deploymentId,"dep-1");
  assert.equal(created.deployment.targetRef.id,"gen-1");

  const replay=await integration.explorerDeployer.createDeploymentFromClaim("claim-1",{expectedDeployerRevision:1});
  assert.equal(replay.created,false);
  assert.equal(replay.deployment.deploymentId,"dep-1");
  assert.equal((await integration.deployer.listDeployments()).deployments.length,1);
});

test("A023-03 backup/restore restores integrated module + Attention state and releases hold only after shared checks pass",async()=>{
  const {core,integration}=compose();
  await integration.accounts.createAccount({
    accountId:"acct-1",displayName:"Primary",personaUid:UID_A
  },{expectedRevision:0});
  await integration.humanTasks.open({
    taskId:"task-before",
    taskKind:"operator.review",
    title:"Before backup",
    priority:"NORMAL",
    subjectRef:{kind:"account",id:"acct-1"}
  });
  const discovered=await integration.explorer.recordDiscovery({
    accountId:"acct-1",
    discoveryId:"scan-before",
    candidates:[{generatorId:"gen-before",observedSourceHash:HASH_A}]
  },{expectedRevision:0});
  await integration.explorer.claimCandidate(discovered.candidates[0].candidateId,{
    claimId:"claim-before",deploymentId:"dep-before"
  },{expectedRevision:discovered.revision});
  await integration.explorerDeployer.createDeploymentFromClaim("claim-before",{expectedDeployerRevision:0});

  const backup=await integration.backupRestore.createBackup({backupId:"integration-1"});

  await integration.accounts.createAccount({
    accountId:"acct-2",
    displayName:"After",
    personaUid:"22222222-2222-4222-8222-222222222222"
  },{expectedRevision:1});
  await integration.humanTasks.open({
    taskId:"task-after",
    taskKind:"operator.review",
    title:"After backup",
    priority:"LOW",
    subjectRef:{kind:"account",id:"acct-2"}
  });
  assert.equal((await integration.accounts.listAccounts()).accounts.length,2);
  assert.equal((await integration.humanTasks.listAttention()).length,2);

  const staged=await integration.backupRestore.stageRestore(backup);
  const applied=await integration.backupRestore.applyStagedRestore(confirmStagedRestore(staged,"RESTORE"));
  assert.equal(applied.backupId,"integration-1");
  assert.equal((await core.recoveryHold.getStatus()).value.state,"RECOVERY_HOLD");

  const accounts=await integration.accounts.listAccounts();
  const attention=await integration.humanTasks.listAttention();
  assert.deepEqual(accounts.accounts.map(x=>x.accountId),["acct-1"]);
  assert.deepEqual(attention.map(x=>x.value.taskId),["task-before"]);
  assert.deepEqual((await integration.deployer.listDeployments()).deployments.map(x=>x.deploymentId),["dep-before"]);

  const reconciliation=await integration.backupRestore.reconcileAndRelease();
  assert.equal(reconciliation.released,true);
  assert.deepEqual(reconciliation.reconciliation,{
    moduleGenerations:true,
    personaBindings:true,
    providerCapabilities:true
  });
  assert.equal((await core.recoveryHold.getStatus()).value.state,"NORMAL");

  const ui=await integration.uiProjection.snapshot();
  assert.equal(ui.accounts.accounts.length,1);
  assert.equal(ui.notifications.count,1);
  const stats=integration.statistics.view(await integration.statistics.rebuild());
  assert.equal(stats.metrics[0].value,1);
});
