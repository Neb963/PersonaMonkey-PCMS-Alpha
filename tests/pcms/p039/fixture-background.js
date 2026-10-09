// A039-01/02/03: separate test add-on; all product modules are copied from the XPI.
// Reads use the real PersonaMonkey broker and execution artifacts. Only seed
// mutations use the emulator. No read contents are written to fixture evidence.
export const P039_FIXTURE_PROBE="p039-status";
export async function createP039Background({pcmsBase,modulesBase,browserRef,origin,personaUid}){
  const load=(base,path)=>import(new URL(path,base).href);
  const [{createPcmsStorageBroker},{createPcmsAuditJournal},{createRemoteOps},{createRecoveryHoldController},
    {createProviderGate},{createPerchanceProviderAdapter},{createPerchanceEmulator},{createSingletonStateStore},
    {createCoreServiceRegistry},{createTimerService},{createPcmsAlarmCoordinator},{createHumanTaskService},
    {createPersonaBroker},{createLiveBrokerClient},{createPerchanceExecutionReadDriver},{generatorPayloadHash},
    {createDeployerService},{createDeployerObservations,OBSERVATION_NAMESPACE},{createVerificationSweep,VERIFICATION_SERVICE}]
    =await Promise.all([
      load(pcmsBase,"storage/storage-broker.js"),load(pcmsBase,"audit/journal.js"),load(pcmsBase,"remoteops/remote-ops.js"),
      load(pcmsBase,"remoteops/recovery-hold.js"),load(pcmsBase,"remoteops/provider-gate.js"),load(pcmsBase,"providers/perchance/adapter.js"),
      load(pcmsBase,"providers/perchance/emulator.js"),load(pcmsBase,"integration/adapters.js"),load(pcmsBase,"services/registry.js"),
      load(pcmsBase,"services/timers.js"),load(pcmsBase,"background/alarms/coordinator.js"),load(pcmsBase,"services/human-tasks.js"),
      load(pcmsBase,"core/persona-broker.js"),load(pcmsBase,"integration/live-mutations.js"),load(pcmsBase,"providers/perchance/execution-read-driver.js"),
      load(pcmsBase,"providers/perchance/contract.js"),load(modulesBase,"p015/deployer.js"),load(modulesBase,"p015/observations.js"),
      load(modulesBase,"p015/verification-sweep.js")]);
  const storage=createPcmsStorageBroker(),audit=createPcmsAuditJournal();await storage.open();await audit.open();
  const fixture=storage.namespace("p039.fixture"),store=storage.namespace(OBSERVATION_NAMESPACE);
  const broker=createPersonaBroker({transport:{send:message=>browserRef.runtime.sendMessage("persona-route-manager@local",message),
    openEvents:()=>browserRef.runtime.connect("persona-route-manager@local",{name:"PERSONAMONKEY_INTEGRATION_EVENTS"})}});
  const rawClient=createLiveBrokerClient({broker});
  const trace=[];
  const client={async request(command,...args){
    try{
      const result=await rawClient.request(command,...args);
      trace.push({command,state:result?.state??null,...(command==="system.describe"?{externalAutomation:result.externalAutomation}:{}),
        ...(command==="execution.result.get"?{keys:Object.keys(result),tasks:result.tasks?.map(t=>({keys:Object.keys(t),state:t.state,error:t.error,truncated:t.truncated??null,
          resultOmitted:t.resultOmitted??null,resultKeys:Object.keys(t.result??{})}))}: {})});return result;
    }catch(error){trace.push({command,error:String(error),code:error?.code??null});throw error;}
  }};
  let account=(await fixture.get("account"))?.value;
  if(!account){
    account={accountId:"acct-1",providerId:"perchance",displayName:"P039 fixture",personaUid,bindingEpoch:1};
    await fixture.compareAndSwap("account",{expectedRevision:0,value:account});
  }
  const accounts={getAccount:async id=>id===account.accountId?account:null};
  const remoteOps=createRemoteOps({storageBroker:storage}),recoveryHold=createRecoveryHoldController({storageBroker:storage,remoteOps});
  const emulator=createPerchanceEmulator({contractVersion:2}),mutationAdapter=createPerchanceProviderAdapter({driver:emulator.driver});
  const gate=createProviderGate({remoteOps,recoveryHold,providers:{perchance:mutationAdapter.providerDescriptor}});
  const deployer=createDeployerService({stateStore:createSingletonStateStore({storageBroker:storage,namespace:"module.deployer"}),
    accountsService:accounts,providerGateResolver:{get:async()=>gate},remoteOperationReader:remoteOps});
  const humanTasks=createHumanTaskService({storageBroker:storage,auditJournal:audit});
  const readDriver=createPerchanceExecutionReadDriver({client,profile:{kind:"fixture",origin},allowDirect:true});
  const reads={...emulator.driver,async probe(){return {contractId:"pcms.perchance.driver",contractVersion:2,providerId:"perchance",operations:["generator.update","generator.observe"],
    capabilities:{code:false,html:false,thumbnail:false,listing:false,observe:await readDriver.available(),unattended:false}};},observeGenerator:readDriver.observeGenerator};
  const provider=createPerchanceProviderAdapter({driver:reads});
  async function append(key,value){
    const row=await fixture.get(key);await fixture.compareAndSwap(key,{expectedRevision:row?.revision??0,value:[...(row?.value??[]),value]});
  }
  const observedProvider={probeCompatibility:provider.probeCompatibility,async observe(...args){
    await append("reads",{at:new Date().toISOString(),slug:args[0]});return provider.observe(...args);
  }};
  const observations=createDeployerObservations({deployer,accounts,provider:observedProvider,store,humanTasks,recoveryHold});
  const registry=createCoreServiceRegistry();let coordinator;
  const timers=createTimerService({storageBroker:storage,auditJournal:audit,serviceRegistry:registry,
    onChanged:async()=>{if(coordinator)await coordinator.armNext();}});
  const sweep=createVerificationSweep({observations,timers});
  registry.register(VERIFICATION_SERVICE,{onTimer:sweep.onTimer},{ownerId:"core",generation:0});
  coordinator=createPcmsAlarmCoordinator({alarms:browserRef.alarms,timers,declareSchedules:async()=>{await observations.recover();await sweep.declare();}});
  const CODE="fixture source\n  exact bytes",HTML="<h1>fixture</h1>";
  async function seed(){
    if(await fixture.get("seed"))return;
    const hash=await generatorPayloadHash(CODE,HTML);
    for(const slug of ["alpha","beta","gamma"]){
      const all=await deployer.listDeployments(),d=await deployer.createDeployment({deploymentId:"gen:"+slug,accountId:account.accountId,generatorId:slug,
        payloadHash:hash,thumbnailHash:null,listing:"PUBLICLY_LISTED",origin:{kind:"MANUAL"}},{expectedRevision:all.revision});
      const saved=await deployer.deploy(d.deployment.deploymentId,{expectedRevision:d.revision,payload:{code:CODE,html:HTML,thumbnail:null}});
      // Deterministic fixture baseline; the real read below verifies alpha's bytes.
      await deployer.recordProviderObservation(saved.deployment.deploymentId,{expectedRevision:saved.revision,
        confirmedOperationId:saved.deployment.confirmed.operationId,observation:{method:"PROVIDER_READ",exists:true,challenge:false,
          payloadHash:hash,thumbnailHash:null,listing:"PUBLICLY_LISTED",observedAt:new Date().toISOString()}});
    }
    const alpha=await observations.verifyNow("gen:alpha");
    if(alpha.status!=="OBSERVED"||alpha.observation.payloadHash!==hash)throw new Error("Real execution did not verify fixture alpha: "+JSON.stringify({alpha,trace}));
    // Defer the sweep long enough to close the probe and unload the event page.
    const control=await observations.readControl();
    await store.compareAndSwap("control",{expectedRevision:control.revision,value:{...control.value,sweepLimit:2,nextReadAt:new Date(Date.now()+35000).toISOString()}});
    await observations.enqueueSweep(new Date().toISOString());
    await fixture.compareAndSwap("seed",{expectedRevision:0,value:{seededAt:new Date().toISOString(),baselineHash:hash}});
  }
  await seed();deployer.bindObservations(observations);
  async function status(){
    const all=await deployer.listDeployments(),rows=await store.list(),serial=JSON.stringify(rows);
    return {seed:(await fixture.get("seed"))?.value,starts:(await fixture.get("starts"))?.value??[],reads:(await fixture.get("reads"))?.value??[],
      control:(await observations.readControl()).value,timers:(await timers.list()).map(r=>r.value),attention:(await humanTasks.listAttention()).map(r=>r.value),
      deployments:await Promise.all(all.deployments.map(async d=>({slug:d.targetRef.id,baselineHash:d.confirmed.baselineHash,policy:d.policy,
        status:await observations.get(d.deploymentId)}))),storedContent:serial.includes(CODE)||serial.includes(HTML)||serial.includes("provider changed"),
      operations:(await remoteOps.list()).map(r=>({id:r.value.operationId,state:r.value.state})),alarms:await browserRef.alarms.getAll()};
  }
  return {async start(wake){await append("starts",{at:new Date().toISOString(),wake});return coordinator.start({wake});},
    handleAlarm:name=>coordinator.handleAlarm(name),status};
}
