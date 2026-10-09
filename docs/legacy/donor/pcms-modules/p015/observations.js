// P039: module-owned hash observations and bounded verification work. Repository
// intent, confirmed apply and provider reads remain three separate authorities.
import { deriveDrift } from "./status.js";
import { normalizeDeploymentId } from "./schema.js";

export const OBSERVATION_NAMESPACE="module.deployer.observations";
export const VERIFY_SPACING_MS=10000;
export const DEFAULT_SWEEP_LIMIT=20;
const iso=n=>new Date(n).toISOString();
function invalid(message="Observation state changed; refresh and try again") { throw new Error(message); }
const empty=()=>({schemaVersion:1,sweepLimit:DEFAULT_SWEEP_LIMIT,queue:[],cycle:null,sequence:0,nextReadAt:null,slot:0});
function control(value){
  if(!value||value.schemaVersion!==1||Object.keys(value).length!==7||!Number.isSafeInteger(value.sweepLimit)
    ||value.sweepLimit<1||value.sweepLimit>100||!Array.isArray(value.queue)||value.queue.length>100
    ||new Set(value.queue).size!==value.queue.length||!Number.isSafeInteger(value.sequence)||value.sequence<0
    ||![0,1].includes(value.slot)||(value.cycle!==null&&!Number.isFinite(Date.parse(value.cycle)))
    ||(value.nextReadAt!==null&&!Number.isFinite(Date.parse(value.nextReadAt))))invalid("Observation control state is invalid");
  for(const id of value.queue)normalizeDeploymentId(id);
  return value;
}
function summary(row){
  if(!row)return null;
  const v=row.value;
  if(v?.schemaVersion!==1||v.kind!=="perchance-observation"||!["PROVIDER_READ","OPERATOR_CONFIRMED"].includes(v.method)
    ||!Number.isFinite(Date.parse(v.observedAt))||![true,false,null].includes(v.exists)
    ||!['PUBLICLY_LISTED','UNLISTED','UNKNOWN'].includes(v.listing)||typeof v.challenge!=="boolean"
    ||[v.payloadHash,v.thumbnailHash].some(h=>h!==null&&!/^[a-f0-9]{64}$/.test(h)))invalid("Observation record is invalid");
  return v;
}
export function createDeployerObservations({deployer,accounts,provider=null,store,humanTasks,recoveryHold,
  readDesiredPayload=null,repository=null,clock=()=>new Date().toISOString()}={}){
  if(typeof deployer?.recordProviderObservation!=="function"||typeof store?.get!=="function"
    ||typeof store?.compareAndSwap!=="function"||typeof accounts?.getAccount!=="function"
    ||typeof humanTasks?.open!=="function"||typeof recoveryHold?.getStatus!=="function")invalid("Observation dependencies are invalid");
  let wake=async()=>null;
  const ms=()=>Date.parse(clock());
  async function readControl(){const row=await store.get("control");return {revision:row?.revision??0,value:row?control(row.value):empty()};}
  async function change(fn){
    for(let i=0;i<8;i++){
      const row=await readControl(),value=await fn(structuredClone(row.value));
      try{return await store.compareAndSwap("control",{expectedRevision:row.revision,value:control(value)});}
      catch(error){if(error?.code!=="PCMS_STORAGE_CAS_MISMATCH")throw error;}
    }invalid();
  }
  async function available(){
    try{const p=await provider?.probeCompatibility();return p?.contractVersion===2&&p.capabilities?.observe===true&&p.operations.includes("generator.observe");}
    catch{return false;}
  }
  async function held(){return (await recoveryHold.getStatus())?.value?.state!=="NORMAL";}
  async function ensureTask(value){
    let task=await humanTasks.get(value.taskId);
    if(!task){
      try{task=await humanTasks.open({taskId:value.taskId,taskKind:"provider.observation-challenge",priority:"HIGH",
        subjectRef:{kind:"account",id:value.accountId},title:"Perchance needs your attention",
        instructions:"Open Perchance in this account's bound Persona and complete the login or CAPTCHA yourself. Automatic provider passes stay stopped until this task is resolved. Then verify the generator again."});}
      catch(error){task=await humanTasks.get(value.taskId);if(!task)throw error;}
    }return task;
  }
  async function challenged(){
    for(const row of await store.list())if(row.key.startsWith("challenge:")){
      if((await ensureTask(row.value)).value.state==="OPEN")return true;
    }return false;
  }
  async function challenge(accountId,observedAt){
    const key="challenge:"+accountId,row=await store.get(key);
    // Replaying a stored challenge must not re-open an episode the operator resolved.
    if(row?.value?.observedAt===observedAt){await ensureTask(row.value);return row.value.taskId;}
    if(row&&(await ensureTask(row.value)).value.state==="OPEN")return row.value.taskId;
    const episode=(row?.value?.episode??0)+1;
    const value={accountId,observedAt,episode,taskId:"observe-challenge:"+accountId+":"+episode};
    try{await store.compareAndSwap(key,{expectedRevision:row?.revision??0,value});}
    catch(error){if(error?.code!=="PCMS_STORAGE_CAS_MISMATCH")throw error;return challenge(accountId,observedAt);}
    await ensureTask(value);return value.taskId;
  }
  async function statusObservation(deployment){
    const v=summary(await store.get("obs:"+deployment.deploymentId));
    if(!v||v.confirmedOperationId!==deployment.confirmed.operationId||v.accountId!==deployment.accountId)return null;
    const account=await accounts.getAccount(v.accountId);
    if(!account||account.personaUid!==v.personaUid||account.bindingEpoch!==v.bindingEpoch)return null;
    const keep=(await store.get("keep:"+deployment.deploymentId))?.value;
    // The keep intent is written first. Its metadata becomes authoritative only
    // after the domain CAS proves that exact baseline was actually adopted.
    if(keep?.confirmedOperationId===deployment.confirmed.operationId
      &&keep.observation?.payloadHash===deployment.confirmed.baselineHash
      &&keep.observation?.observedAt===deployment.confirmed.confirmedAt){
      return {...v,baselineListing:keep.observation.listing,baselineThumbnailHash:keep.observation.thumbnailHash,
        keptDesiredRevision:keep.desiredRevision};
    }
    return {...v,baselineListing:null,baselineThumbnailHash:null,keptDesiredRevision:null};
  }
  async function listForStatus(deployments){
    const out=new Map();for(const d of deployments){const v=await statusObservation(d);if(v)out.set(d.deploymentId,v);}return out;
  }
  async function isDrifted(d){return Boolean(deriveDrift({deployment:d,observation:await statusObservation(d)}));}
  async function keptCurrent(d){return (await statusObservation(d))?.keptDesiredRevision===d.desired.revision;}
  async function canOverwrite(d){
    const waiver=(await store.get("overwrite:"+d.deploymentId))?.value,v=await statusObservation(d);
    return Boolean(waiver&&v&&!v.challenge&&waiver.operationId===d.operation.operationId
      &&waiver.desiredRevision===d.desired.revision&&waiver.confirmedOperationId===d.confirmed.operationId
      &&waiver.observedAt===v.observedAt&&waiver.payloadHash===v.payloadHash);
  }
  async function get(id){
    const d=await deployer.getDeployment(normalizeDeploymentId(id));if(!d)return null;
    return {available:await available(),observation:await statusObservation(d),drift:await isDrifted(d),automaticBlocked:await challenged()};
  }
  async function saveObservation(d,account,observed,method="PROVIDER_READ"){
    const key="obs:"+d.deploymentId,prior=await store.get(key),old=summary(prior);
    const sameBaseline=old?.confirmedOperationId===d.confirmed.operationId;
    const value={schemaVersion:1,kind:"perchance-observation",deploymentId:d.deploymentId,accountId:d.accountId,
      personaUid:account.personaUid,bindingEpoch:account.bindingEpoch,confirmedOperationId:d.confirmed.operationId,
      method,observedAt:clock(),exists:observed.exists,payloadHash:observed.payloadHash,thumbnailHash:observed.thumbnailHash,
      listing:observed.listing,challenge:observed.challenge,
      baselineListing:sameBaseline?old.baselineListing:null,baselineThumbnailHash:sameBaseline?old.baselineThumbnailHash:null,
      keptDesiredRevision:sameBaseline?old.keptDesiredRevision:null};
    await store.compareAndSwap(key,{expectedRevision:prior?.revision??0,value});
    return value;
  }
  async function reserve(){
    const before=await readControl();
    if(before.value.nextReadAt&&ms()<Date.parse(before.value.nextReadAt))return null;
    try{
      const value={...before.value,sequence:before.value.sequence+1,nextReadAt:iso(ms()+VERIFY_SPACING_MS)};
      await store.compareAndSwap("control",{expectedRevision:before.revision,value});
      return "observe-"+value.sequence;
    }catch(error){if(error?.code==="PCMS_STORAGE_CAS_MISMATCH")return null;throw error;}
  }
  async function enqueue(id){
    await change(v=>({...v,queue:v.queue.includes(id)?v.queue:[...v.queue,id].slice(0,100)}));
    await wake();
  }
  async function readOne(id,{includeContent=false,automatic=false,enqueueDeferred=true}={}){
    const deploymentId=normalizeDeploymentId(id);
    if(!await available())return {status:"GATED"};
    if(await challenged())return {status:"CHALLENGE"};
    if(automatic&&await held())return {status:"HELD"};
    const d=await deployer.getDeployment(deploymentId);
    if(!d||d.desired.payloadKind!=="v2-release"||["ACTIVE","RETRYABLE"].includes(d.operation.status))return {status:"SKIPPED"};
    const account=await accounts.getAccount(d.accountId);
    if(!account||typeof account.personaUid!=="string"||!Number.isSafeInteger(account.bindingEpoch))return {status:"UNAVAILABLE"};
    const readId=await reserve();
    if(!readId){if(enqueueDeferred)await enqueue(deploymentId);return {status:"DEFERRED",nextReadAt:(await readControl()).value.nextReadAt};}
    let observed;
    try{observed=await provider.observe(d.targetRef.id,{personaUid:account.personaUid,readId,includeContent});}
    catch{return {status:"UNAVAILABLE"};}
    const current=await deployer.listDeployments(),latest=current.deployments.find(v=>v.deploymentId===deploymentId);
    const bound=await accounts.getAccount(d.accountId);
    if(!latest||latest.confirmed.operationId!==d.confirmed.operationId||latest.desired.revision!==d.desired.revision
      ||latest.operation.operationId!==d.operation.operationId||bound?.personaUid!==account.personaUid
      ||bound?.bindingEpoch!==account.bindingEpoch)return {status:"STALE"};
    const value=await saveObservation(d,account,observed);
    // Adopted listing/thumbnail baselines live in the fenced keep record. Apply
    // the same effective baseline used by status before updating domain policy.
    const effective=await statusObservation(d);
    if(!effective)return {status:"STALE"};
    if(observed.challenge){await challenge(d.accountId,value.observedAt);return {status:"CHALLENGE"};}
    if(d.confirmed.payloadHash!==null){
      try{await deployer.recordProviderObservation(deploymentId,{expectedRevision:current.revision,
        confirmedOperationId:d.confirmed.operationId,observation:effective});}
      catch(error){if(error?.code==="PCMS_DEPLOYER_REVISION_CONFLICT")return {status:"STALE"};throw error;}
    }
    return {status:"OBSERVED",observation:effective,...(includeContent?{content:observed.content}: {})};
  }
  async function verifyNow(id){return readOne(id);}
  async function afterConfirmed(d){
    const account=await accounts.getAccount(d.accountId);if(!account)return;
    if(!await available()){
      await saveObservation(d,account,{exists:null,payloadHash:null,thumbnailHash:null,listing:"UNKNOWN",challenge:false},"OPERATOR_CONFIRMED");
      return;
    }
    const result=await verifyNow(d.deploymentId);
    if(["UNAVAILABLE","GATED"].includes(result.status)){
      await saveObservation(d,account,{exists:null,payloadHash:null,thumbnailHash:null,listing:"UNKNOWN",challenge:false},"OPERATOR_CONFIRMED");
      await enqueue(d.deploymentId);
    }
  }
  async function enqueueSweep(cycle){
    if(!Number.isFinite(Date.parse(cycle))||!await available()||await held()||await challenged())return {queued:0};
    const current=await readControl();if(current.value.cycle===cycle)return {queued:current.value.queue.length};
    const {deployments}=await deployer.listDeployments(),statuses=await listForStatus(deployments);
    const candidates=deployments.filter(d=>d.desired.payloadKind==="v2-release"&&d.confirmed.payloadHash!==null
      &&!["ACTIVE","RETRYABLE"].includes(d.operation.status));
    const verifiedAt=id=>{const v=statuses.get(id);return v?.method==="PROVIDER_READ"&&!v.challenge?v.observedAt:"";};
    candidates.sort((a,b)=>verifiedAt(a.deploymentId).localeCompare(verifiedAt(b.deploymentId))
      ||a.deploymentId.localeCompare(b.deploymentId));
    // A new scan cannot extend a still-running sweep indefinitely.
    await change(v=>({...v,cycle,queue:v.queue.length?v.queue:candidates.slice(0,v.sweepLimit).map(d=>d.deploymentId)}));
    await wake();return {queued:(await readControl()).value.queue.length};
  }
  async function verifyNext(){
    const before=await readControl(),id=before.value.queue[0];if(!id)return {status:"IDLE"};
    const result=await readOne(id,{automatic:true,enqueueDeferred:false});
    const retain=["DEFERRED","CHALLENGE","HELD","GATED"].includes(result.status);
    await change(v=>({...v,queue:retain?v.queue:v.queue.filter(item=>item!==id),slot:1-v.slot}));
    return result;
  }
  async function configure({sweepLimit}={}){
    if(!Number.isSafeInteger(sweepLimit)||sweepLimit<1||sweepLimit>100)invalid("Verification sweep limit must be between 1 and 100");
    await change(v=>({...v,sweepLimit}));return {sweepLimit};
  }
  async function checked(id,{expectedRevision,expectedObservedAt}={}){
    const list=await deployer.listDeployments(),d=list.deployments.find(v=>v.deploymentId===normalizeDeploymentId(id));
    const observed=d?await statusObservation(d):null;
    if(list.revision!==expectedRevision||!observed||observed.observedAt!==expectedObservedAt
      ||!deriveDrift({deployment:d,observation:observed})||observed.challenge)invalid();
    return {d,observed};
  }
  async function keep(id,input){
    const {d,observed}=await checked(id,input);
    if(input.confirmation!==d.targetRef.id)invalid("Type the generator address to confirm keeping its Perchance version");
    if(observed.exists!==true||!observed.payloadHash)invalid("A missing generator cannot be kept");
    const row=await store.get("keep:"+id);
    const value={confirmedOperationId:d.confirmed.operationId,desiredRevision:d.desired.revision,observation:observed};
    await store.compareAndSwap("keep:"+id,{expectedRevision:row?.revision??0,value});
    await deployer.recordProviderObservation(id,{expectedRevision:input.expectedRevision,confirmedOperationId:d.confirmed.operationId,
      observation:observed,mode:"KEEP"});
    return {kept:true,paused:true};
  }
  async function overwrite(id,input){
    const {d,observed}=await checked(id,input);
    if(input.confirmation!==d.targetRef.id)invalid("Type the generator address to confirm overwriting its Perchance version");
    if(await held()||await challenged())invalid("Provider work is on hold");
    if(typeof repository?.deployFromRepository!=="function")invalid("Repository deployment is unavailable");
    const prepared=await deployer.prepareOverwrite(id,{expectedRevision:input.expectedRevision});
    const row=await store.get("overwrite:"+id);
    await store.compareAndSwap("overwrite:"+id,{expectedRevision:row?.revision??0,value:{
      operationId:prepared.deployment.operation.operationId,desiredRevision:prepared.deployment.desired.revision,
      confirmedOperationId:d.confirmed.operationId,observedAt:observed.observedAt,payloadHash:observed.payloadHash}});
    return repository.deployFromRepository({deploymentId:id,expectedRevision:prepared.revision});
  }
  async function compare(id){
    const result=await readOne(id,{includeContent:true});
    if(result.status!=="OBSERVED"||!result.content)invalid(result.status==="DEFERRED"?"Verification is spaced by 10 seconds; try again shortly":"Provider comparison is unavailable");
    if(typeof readDesiredPayload!=="function")invalid("Repository comparison is unavailable");
    const desired=await readDesiredPayload(id);
    return {desired,observed:result.content,desiredListing:(await deployer.getDeployment(id)).desired.listing,
      observedListing:result.observation.listing,observedAt:result.observation.observedAt};
  }
  async function canResumeForRelease(before,origin){
    const v=await statusObservation(before);
    return Boolean(v?.keptDesiredRevision===before.desired.revision&&before.policy.pauseReason==="OPERATOR"
      &&before.desired.origin.kind==="REPOSITORY"&&origin.kind==="REPOSITORY"
      &&before.desired.origin.version!==origin.version&&!deriveDrift({deployment:before,observation:v}));
  }
  async function recover(){
    // Repair a crash between the observation row and the domain transition using
    // current CAS revisions and the immutable confirmation/account fences. This
    // performs no provider reads and never replays an external mutation.
    for(const d of (await deployer.listDeployments()).deployments){
      const v=await statusObservation(d);if(!v||v.method!=="PROVIDER_READ")continue;
      if(v.challenge){await challenge(d.accountId,v.observedAt);continue;}
      if(d.confirmed.payloadHash===null||Date.parse(v.observedAt)<Date.parse(d.confirmed.confirmedAt))continue;
      if(d.confirmed.baselineHash!==null&&!deriveDrift({deployment:d,observation:v}))continue;
      const latest=await deployer.listDeployments();
      try{await deployer.recordProviderObservation(d.deploymentId,{expectedRevision:latest.revision,
        confirmedOperationId:d.confirmed.operationId,observation:v});}
      catch(error){if(error?.code!=="PCMS_DEPLOYER_REVISION_CONFLICT"&&error?.code!=="PCMS_DEPLOYER_INVALID_TRANSITION")throw error;}
    }
  }
  return Object.freeze({get,available,listForStatus,isDrifted,keptCurrent,canOverwrite,readControl,verifyNow,afterConfirmed,enqueueSweep,verifyNext,configure,
    keep,overwrite,compare,canResumeForRelease,recover,challenged,held,bindWake(fn){wake=fn;}});
}
