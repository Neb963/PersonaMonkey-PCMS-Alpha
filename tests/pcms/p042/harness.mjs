// Deterministic P042 wiring: real RemoteOps, ProviderGate, recovery hold, HumanTasks, Deployer,
// observations, verification sweep, Core timers and the automatic pass over in-memory storage,
// with the v2 emulator as provider. The repository is a pinned snapshot stand-in.
import { setup } from "../p036/harness.mjs";
import { createDeployerObservations, OBSERVATION_NAMESPACE } from "../../../pcms-modules/p015/observations.js";
import { createVerificationSweep, VERIFICATION_SERVICE } from "../../../pcms-modules/p015/verification-sweep.js";
import { createDeployerAutomatic, AUTOMATIC_NAMESPACE, AUTOMATIC_SERVICE } from "../../../pcms-modules/p015/automatic.js";
import { createTimerService } from "../../../extension/pcms/services/timers.js";
import { createCoreServiceRegistry } from "../../../extension/pcms/services/registry.js";
import { generatorPayloadHash } from "../../../extension/pcms/providers/perchance/contract.js";

export const CODE="automatic\n  exact source",HTML="<main>automatic</main>",COMMIT="b".repeat(40);

export async function harness({unattended=true,observe=true,slugs=["alpha"],deploy="auto"}={}){
  const h=setup();let time=Date.parse("2026-10-08T12:00:00.000Z");const clock=()=>new Date(time).toISOString();
  h.emulator.setCapabilities({unattended,observe});
  const payloadHash=await generatorPayloadHash(CODE,HTML);
  const repo={snapshot:{commitId:COMMIT,items:[]},lastCheckedAt:clock(),lastFailure:null};
  const reads=[],content=new Map();
  for(const slug of slugs){
    repo.snapshot.items.push({slug,deploy,payloadHash,thumbnailHash:null,listing:"PUBLICLY_LISTED"});
    h.emulator.seedGenerator({generatorId:slug,code:"old",html:"old",settings:{isPrivate:false}});
  }
  const repository={
    async read(){return {revision:1,value:structuredClone(repo)};},
    async deployFromRepository({deploymentId,expectedRevision}){
      const slug=deploymentId.slice(4);
      return h.deployer.deploy(deploymentId,{expectedRevision,payload:{code:content.get(slug)??CODE,html:HTML,thumbnail:null}});
    }
  };
  const provider={providerId:"perchance",probeCompatibility:()=>h.adapter.probeCompatibility(),
    async observe(...args){reads.push(args[0]);return h.adapter.observe(...args);}};
  const obs=createDeployerObservations({deployer:h.deployer,accounts:h.accounts.service,provider,
    store:h.storage.namespace(OBSERVATION_NAMESPACE),humanTasks:h.humanTasks,recoveryHold:h.recoveryHold,clock,repository});
  h.deployer.bindObservations(obs);
  const registry=createCoreServiceRegistry();
  const timers=createTimerService({storageBroker:h.storage,auditJournal:h.audit.journal,serviceRegistry:registry,clock});
  const sweep=createVerificationSweep({observations:obs,timers,clock});
  registry.register(VERIFICATION_SERVICE,{onTimer:sweep.onTimer},{ownerId:"core",generation:0});
  const automatic=createDeployerAutomatic({deployer:h.deployer,repository,observations:obs,provider,accounts:h.accounts.service,
    recoveryHold:h.recoveryHold,store:h.storage.namespace(AUTOMATIC_NAMESPACE),timers,clock});
  registry.register(AUTOMATIC_SERVICE,{onTimer:automatic.onTimer},{ownerId:"core",generation:0});
  async function create(slug,{deployed=false}={}){
    const list=await h.deployer.listDeployments();
    const made=await h.deployer.createDeployment({deploymentId:"gen:"+slug,accountId:"acct-1",generatorId:slug,payloadHash,
      thumbnailHash:null,listing:"PUBLICLY_LISTED",origin:{kind:"REPOSITORY",commitId:COMMIT,path:"alice/"+slug,version:"1.0"}},
      {expectedRevision:list.revision});
    if(!deployed)return made;
    return h.deployer.deploy(made.deployment.deploymentId,{expectedRevision:made.revision,payload:{code:CODE,html:HTML,thumbnail:null}});
  }
  // A new repository release for an already-deployed target (state "Update ready").
  async function release(slug,code){
    const hash=await generatorPayloadHash(code,HTML);
    const item=repo.snapshot.items.find(i=>i.slug===slug);item.payloadHash=hash;content.set(slug,code);
    const list=await h.deployer.listDeployments(),d=list.deployments.find(v=>v.targetRef.id===slug);
    return h.deployer.setDesired(d.deploymentId,{expectedRevision:list.revision,expectedDesiredRevision:d.desired.revision,
      payloadHash:hash,thumbnailHash:null,listing:"PUBLICLY_LISTED",origin:{kind:"REPOSITORY",commitId:COMMIT,path:"alice/"+slug,version:"2.0"}});
  }
  async function runDue(){return timers.runDue({now:clock()});}
  return {...h,clock,repo,repository,provider,reads,obs,timers,sweep,automatic,create,release,runDue,payloadHash,
    advance(ms){time+=ms;repo.lastCheckedAt??=clock();}, now:()=>time};
}
