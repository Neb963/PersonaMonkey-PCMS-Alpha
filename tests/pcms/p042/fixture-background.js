// A042-02/A042-03: separate test add-on; every product module is copied byte for byte from the
// XPI. Provider reads and the unattended deployment run through the real PersonaMonkey broker as
// execution artifacts, composed by the shipped live-mutation wiring with the reviewed loopback
// fixture profiles. The repository is a pinned in-fixture snapshot; no release content is stored.
export const P042_FIXTURE_PROBE="p042-status";
export async function createP042Background({pcmsBase,modulesBase,browserRef,origin,personaUid}){
  const load=(base,path)=>import(new URL(path,base).href);
  const [{createPcmsStorageBroker},{createPcmsAuditJournal},{createRemoteOps},{createRecoveryHoldController},
    {createProviderGate},{createSingletonStateStore},{createCoreServiceRegistry},{createTimerService},{createPcmsAlarmCoordinator},
    {createHumanTaskService},{createPersonaBroker},{createPcmsLiveMutationIntegration},{createProviderHandoff},
    {generatorPayloadHash},{createDeployerService},{createDeployerObservations,OBSERVATION_NAMESPACE},
    {createVerificationSweep,VERIFICATION_SERVICE},{createDeployerAutomatic,AUTOMATIC_NAMESPACE,AUTOMATIC_SERVICE}]
    =await Promise.all([
      load(pcmsBase,"storage/storage-broker.js"),load(pcmsBase,"audit/journal.js"),load(pcmsBase,"remoteops/remote-ops.js"),
      load(pcmsBase,"remoteops/recovery-hold.js"),load(pcmsBase,"remoteops/provider-gate.js"),load(pcmsBase,"integration/adapters.js"),
      load(pcmsBase,"services/registry.js"),load(pcmsBase,"services/timers.js"),load(pcmsBase,"background/alarms/coordinator.js"),
      load(pcmsBase,"services/human-tasks.js"),load(pcmsBase,"core/persona-broker.js"),load(pcmsBase,"integration/live-mutations.js"),
      load(pcmsBase,"integration/provider-handoff.js"),load(pcmsBase,"providers/perchance/contract.js"),
      load(modulesBase,"p015/deployer.js"),load(modulesBase,"p015/observations.js"),load(modulesBase,"p015/verification-sweep.js"),
      load(modulesBase,"p015/automatic.js")]);
  const storage=createPcmsStorageBroker(),audit=createPcmsAuditJournal();await storage.open();await audit.open();
  const fixture=storage.namespace("p042.fixture");
  const broker=createPersonaBroker({transport:{send:message=>browserRef.runtime.sendMessage("persona-route-manager@local",message),
    openEvents:()=>browserRef.runtime.connect("persona-route-manager@local",{name:"PERSONAMONKEY_INTEGRATION_EVENTS"})}});
  async function append(key,value){
    const row=await fixture.get(key);await fixture.compareAndSwap(key,{expectedRevision:row?.revision??0,value:[...(row?.value??[]),value]});
  }
  // Records only command names and states, never parameters or results.
  const traced={async request(envelope){
    const response=await broker.request(envelope);
    if(["execution.start","persona.control.acquire","persona.control.release","userscript.artifact.install","execution.input.commit"].includes(envelope.command))
      await append("broker",{at:new Date().toISOString(),command:envelope.command,ok:response?.ok===true});
    return response;
  },close(){broker.close?.();}};
  let account=(await fixture.get("account"))?.value;
  if(!account){
    account={accountId:"acct-1",providerId:"perchance",displayName:"P042 fixture",personaUid,bindingEpoch:1};
    await fixture.compareAndSwap("account",{expectedRevision:0,value:account});
  }
  const accounts={getAccount:async id=>id===account.accountId?account:null};
  const remoteOps=createRemoteOps({storageBroker:storage}),recoveryHold=createRecoveryHoldController({storageBroker:storage,remoteOps});
  const humanTasks=createHumanTaskService({storageBroker:storage,auditJournal:audit});
  const handoff=createProviderHandoff({storageBroker:storage,humanTasks});
  const profile={kind:"fixture",origin};
  const live=createPcmsLiveMutationIntegration({storageBroker:storage,personaBroker:traced,operator:handoff,
    observationProfile:profile,automationProfile:profile,allowDirect:true});
  const gate=createProviderGate({remoteOps,recoveryHold,providers:live.providers});
  // Same account→gate binding as the product: the operation context exists before dispatch.
  const gateFor={async get(accountId){
    const bound=await accounts.getAccount(accountId);if(!bound)return null;
    return {async mutate(input){await live.operationContext.bind({operation:input.operation,accountId,personaUid:bound.personaUid});return gate.mutate(input);},
      reconcile:id=>gate.reconcile(id)};
  }};
  const deployer=createDeployerService({stateStore:createSingletonStateStore({storageBroker:storage,namespace:"module.deployer"}),
    accountsService:accounts,providerGateResolver:gateFor,remoteOperationReader:remoteOps});
  const provider=live.providerProbes[0];
  const observedProvider={providerId:"perchance",probeCompatibility:provider.probeCompatibility,async observe(...args){
    await append("reads",{at:new Date().toISOString(),slug:args[0]});return provider.observe(...args);
  }};
  const CODE="automatic fixture source\n  exact bytes 雪",HTML="<h1>deployed by PCMS</h1>";
  const payloadHash=await generatorPayloadHash(CODE,HTML),COMMIT="d".repeat(40);
  const snapshot={commitId:COMMIT,items:[{slug:"alpha",deploy:"auto",payloadHash,thumbnailHash:null,listing:"PUBLICLY_LISTED"}]};
  const repository={
    async read(){return {revision:1,value:{snapshot,lastCheckedAt:new Date().toISOString(),lastFailure:null}};},
    async deployFromRepository({deploymentId,expectedRevision}){
      await append("dispatches",{at:new Date().toISOString(),deploymentId});
      return deployer.deploy(deploymentId,{expectedRevision,payload:{code:CODE,html:HTML,thumbnail:null}});
    }
  };
  const observations=createDeployerObservations({deployer,accounts,provider:observedProvider,store:storage.namespace(OBSERVATION_NAMESPACE),
    humanTasks,recoveryHold,repository});
  deployer.bindObservations(observations);
  const registry=createCoreServiceRegistry();let coordinator;
  const timers=createTimerService({storageBroker:storage,auditJournal:audit,serviceRegistry:registry,
    onChanged:async()=>{if(coordinator)await coordinator.armNext();}});
  const sweep=createVerificationSweep({observations,timers});
  registry.register(VERIFICATION_SERVICE,{onTimer:sweep.onTimer},{ownerId:"core",generation:0});
  const automatic=createDeployerAutomatic({deployer,repository,observations,provider:observedProvider,accounts,recoveryHold,
    store:storage.namespace(AUTOMATIC_NAMESPACE),timers});
  registry.register(AUTOMATIC_SERVICE,{async onTimer(event){
    const result=await automatic.onTimer(event);
    await append("steps",{at:new Date().toISOString(),status:result?.status??null,outcome:result?.outcome??null});
    return result;
  }},{ownerId:"core",generation:0});
  coordinator=createPcmsAlarmCoordinator({alarms:browserRef.alarms,timers,declareSchedules:async()=>{
    await observations.recover();await sweep.declare();await automatic.declare();
  }});
  async function seed(){
    if(await fixture.get("seed"))return;
    const all=await deployer.listDeployments();
    await deployer.createDeployment({deploymentId:"gen:alpha",accountId:account.accountId,generatorId:"alpha",payloadHash,thumbnailHash:null,
      listing:"PUBLICLY_LISTED",origin:{kind:"REPOSITORY",commitId:COMMIT,path:"alice/alpha",version:"1.0"}},{expectedRevision:all.revision});
    // The real probe through PersonaMonkey must report every gate before Automatic can turn on.
    const gates=await automatic.gates();
    const unmetBefore=gates.gates.filter(g=>!g.met).map(g=>g.id);
    await automatic.enable();
    // Defer the first step so the test can close every page and unload the event page first.
    const control=await automatic.readControl();
    await storage.namespace(AUTOMATIC_NAMESPACE).compareAndSwap("control",{expectedRevision:control.revision,
      value:{...control.value,nextDispatchAt:new Date(Date.now()+30000).toISOString()}});
    await automatic.declare();
    await fixture.compareAndSwap("seed",{expectedRevision:0,value:{seededAt:new Date().toISOString(),payloadHash,unmetBefore}});
  }
  await seed();
  async function status(){
    const rows=JSON.stringify([...await storage.namespace(OBSERVATION_NAMESPACE).list(),...await storage.namespace(AUTOMATIC_NAMESPACE).list(),
      ...await storage.namespace("module.deployer").list(),...await remoteOps.list()]);
    const d=await deployer.getDeployment("gen:alpha");
    return {seed:(await fixture.get("seed"))?.value,starts:(await fixture.get("starts"))?.value??[],reads:(await fixture.get("reads"))?.value??[],
      dispatches:(await fixture.get("dispatches"))?.value??[],steps:(await fixture.get("steps"))?.value??[],broker:(await fixture.get("broker"))?.value??[],
      automatic:await automatic.status(),deployment:{operation:d.operation,confirmed:d.confirmed,policy:d.policy},
      observation:await observations.get("gen:alpha"),attention:(await humanTasks.listAttention()).map(r=>r.value),
      operations:(await remoteOps.list()).map(r=>({id:r.value.operationId,state:r.value.state})),
      timers:(await timers.list()).map(r=>r.value),storedContent:rows.includes("exact bytes")||rows.includes("deployed by PCMS"),
      alarms:await browserRef.alarms.getAll()};
  }
  return {async start(wake){await append("starts",{at:new Date().toISOString(),wake});return coordinator.start({wake});},
    handleAlarm:name=>coordinator.handleAlarm(name),status};
}
