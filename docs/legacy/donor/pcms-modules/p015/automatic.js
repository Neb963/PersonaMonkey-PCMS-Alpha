// P042 Automatic deployment mode (04 §E.9, A042-02). Module-owned gates, per-target eligibility
// and a bounded serial background pass. The Core timer service is the only wake authority, so
// passes run with zero PCMS tabs; each timer occurrence performs at most one provider dispatch,
// reserved durably before it starts. Dispatch always goes through the repository release and the
// Deployer, so the durable RemoteOperation exists before the provider is touched.
import { DEPLOYMENT_OPERATION_STATUS as S, confirmedMatchesDesired } from "./schema.js";

export const AUTOMATIC_NAMESPACE="module.deployer.automatic";
export const AUTOMATIC_SERVICE="core.deployer-automatic";
export const AUTOMATIC_TIMERS=Object.freeze(["deployer.automatic.a","deployer.automatic.b"]);
export const AUTOMATIC_MAX_DISPATCHES=10;
export const AUTOMATIC_SPACING_MS=20000;
export const AUTOMATIC_REPEATED_FAILURES=2;
export const AUTOMATIC_GATES=Object.freeze([
  Object.freeze({id:"unattended",label:"Unattended Perchance driver is available (compatibility probe)"}),
  Object.freeze({id:"observe",label:"Post-apply verification (generator.observe) is available"}),
  Object.freeze({id:"provider",label:"Perchance provider is compatible"}),
  Object.freeze({id:"recovery",label:"Recovery state is normal"}),
  Object.freeze({id:"challenge",label:"No unresolved Perchance login or CAPTCHA task"}),
  Object.freeze({id:"operator",label:"Automatic deployment is turned on"})
]);
const DEFAULT_FRESHNESS_MS=2*60*60*1000;
const iso=n=>new Date(n).toISOString();
function invalid(message="Automatic deployment state changed; refresh and try again"){throw new Error(message);}
function gatedError(unmet){
  const error=new Error("Automatic deployment cannot be turned on: "+unmet.map(g=>g.label).join("; "));
  error.code="PCMS_DEPLOYER_AUTOMATIC_GATED";error.unmet=unmet.map(g=>g.id);return error;
}
const empty=()=>({schemaVersion:1,enabled:false,cycle:null,dispatched:0,nextDispatchAt:null,slot:0,sequence:0,failures:{},lastPass:null});
function control(value){
  if(!value||value.schemaVersion!==1||Object.keys(value).length!==9||typeof value.enabled!=="boolean"
    ||(value.cycle!==null&&!Number.isFinite(Date.parse(value.cycle)))||!Number.isSafeInteger(value.dispatched)
    ||value.dispatched<0||value.dispatched>AUTOMATIC_MAX_DISPATCHES||![0,1].includes(value.slot)
    ||!Number.isSafeInteger(value.sequence)||value.sequence<0
    ||(value.nextDispatchAt!==null&&!Number.isFinite(Date.parse(value.nextDispatchAt)))
    ||!value.failures||typeof value.failures!=="object"||Array.isArray(value.failures))invalid("Automatic deployment state is invalid");
  for(const failure of Object.values(value.failures)){
    if(!Number.isSafeInteger(failure?.desiredRevision)||!Number.isSafeInteger(failure?.notApplied))invalid("Automatic deployment state is invalid");
  }
  return value;
}

export function createDeployerAutomatic({deployer,repository,observations,provider=null,accounts,recoveryHold,store,timers=null,
  clock=()=>new Date().toISOString(),freshnessMs=async()=>DEFAULT_FRESHNESS_MS}={}){
  if(typeof deployer?.listDeployments!=="function"||typeof deployer?.pauseRepeatedFailure!=="function"
    ||typeof repository?.read!=="function"||typeof repository?.deployFromRepository!=="function"
    ||typeof observations?.available!=="function"||typeof observations?.challenged!=="function"
    ||typeof accounts?.getAccount!=="function"||typeof recoveryHold?.getStatus!=="function"
    ||typeof store?.get!=="function"||typeof store?.compareAndSwap!=="function"
    ||typeof clock!=="function"||typeof freshnessMs!=="function")invalid("Automatic deployment dependencies are invalid");
  let timerService=timers;
  const ms=()=>Date.parse(clock());

  async function readControl(){const row=await store.get("control");return {revision:row?.revision??0,value:row?control(row.value):empty()};}
  async function change(fn){
    for(let i=0;i<8;i++){
      const row=await readControl(),value=await fn(structuredClone(row.value));
      try{return await store.compareAndSwap("control",{expectedRevision:row.revision,value:control(value)});}
      catch(error){if(error?.code!=="PCMS_STORAGE_CAS_MISMATCH")throw error;}
    }invalid();
  }

  // Gates are evaluated from current authorities on every call; an unknown answer is unmet.
  async function gates(){
    let probe=null;
    try{probe=await provider?.probeCompatibility();}catch{probe=null;}
    const compatible=probe?.contractVersion===2&&probe?.providerId==="perchance";
    let observe=false,challenge=false,recovery=false;
    try{observe=await observations.available()===true;}catch{}
    try{challenge=await observations.challenged()===false;}catch{}
    try{recovery=(await recoveryHold.getStatus())?.value?.state==="NORMAL";}catch{}
    const {value}=await readControl();
    const met={unattended:compatible&&probe.capabilities?.unattended===true,observe,provider:compatible,recovery,challenge,operator:value.enabled};
    const list=AUTOMATIC_GATES.map(g=>Object.freeze({...g,met:met[g.id]===true}));
    return Object.freeze({ready:list.every(g=>g.met),gates:Object.freeze(list)});
  }

  async function enable(){
    const current=await gates();
    const unmet=current.gates.filter(g=>g.id!=="operator"&&!g.met);
    if(unmet.length)throw gatedError(unmet);
    await change(v=>({...v,enabled:true,cycle:v.cycle??clock(),dispatched:v.cycle?v.dispatched:0}));
    await wake();return status();
  }
  async function disable(){
    await change(v=>({...v,enabled:false,cycle:null,dispatched:0,nextDispatchAt:null}));
    await wake();return status();
  }

  async function snapshotIndex(){
    const repo=(await repository.read()).value;
    const fresh=repo.lastFailure===null&&typeof repo.lastCheckedAt==="string"
      &&ms()-Date.parse(repo.lastCheckedAt)<await freshnessMs();
    return {repo,fresh,items:new Map((repo.snapshot?.items??[]).map(item=>[item.slug,item]))};
  }

  // Returns null for an eligible target, otherwise the first reason it is not dispatched.
  async function ineligible(d,{repo,fresh,items},failures){
    if(d.desired.payloadKind!=="v2-release"||d.desired.origin.kind!=="REPOSITORY")return "MANUAL";
    const item=items.get(d.targetRef.id);
    if(!item||item.deploy!=="auto")return "NOT_AUTO";
    if(item.payloadHash!==d.desired.payloadHash||item.thumbnailHash!==d.desired.thumbnailHash||item.listing!==d.desired.listing
      ||d.desired.origin.commitId!==repo.snapshot.commitId)return "STALE_INTENT";
    if(d.policy.pauseReason==="DRIFT"||(typeof observations.isDrifted==="function"&&await observations.isDrifted(d)))return "DRIFT";
    if(d.policy.paused)return "PAUSED";
    if(d.operation.status===S.RECONCILE)return "UNCERTAIN";
    if(d.operation.status===S.FAILED||d.operation.status===S.CANCELLED)return "FAILED";
    if(d.operation.status!==S.PENDING)return "BUSY";
    if(confirmedMatchesDesired(d.confirmed,d.desired))return "IN_SYNC";
    const failure=failures[d.deploymentId];
    if(failure?.desiredRevision===d.desired.revision&&failure.notApplied>=AUTOMATIC_REPEATED_FAILURES)return "REPEATED_FAILURE";
    const account=await accounts.getAccount(d.accountId);
    if(!account||typeof account.personaUid!=="string")return "ACCOUNT";
    if(!fresh)return "SNAPSHOT_STALE";
    if(d.confirmed.payloadHash===null){
      // generator.create is not offered: a never-deployed target needs a fresh read proving it exists.
      const state=typeof observations.get==="function"?await observations.get(d.deploymentId):null;
      const v=state?.observation;
      if(!v||v.method!=="PROVIDER_READ"||v.challenge||ms()-Date.parse(v.observedAt)>=await freshnessMs())return "EXISTENCE_UNKNOWN";
      if(v.exists!==true)return "NEEDS_CREATION";
    }
    return null;
  }

  async function evaluate(){
    const {deployments}=await deployer.listDeployments(),index=await snapshotIndex(),{value}=await readControl();
    const rows=[];
    for(const d of [...deployments].sort((a,b)=>a.deploymentId.localeCompare(b.deploymentId))){
      rows.push({deploymentId:d.deploymentId,reason:await ineligible(d,index,value.failures)});
    }
    return rows;
  }

  // A repository check starts a cycle. A running cycle is never extended or reset.
  async function enqueueCycle(cycle){
    if(!Number.isFinite(Date.parse(cycle)))return {started:false};
    const {value}=await readControl();
    if(!value.enabled||value.cycle!==null)return {started:false};
    await change(v=>v.enabled&&v.cycle===null?{...v,cycle,dispatched:0}:v);
    await wake();return {started:true};
  }

  async function finish(lastPass){
    await change(v=>({...v,cycle:null,dispatched:0,lastPass:{...lastPass,at:clock()}}));
  }

  async function recordOutcome(deploymentId,desiredRevision,outcome){
    let paused=false;
    await change(v=>{
      const failures={...v.failures};
      if(outcome==="NOT_APPLIED"){
        const prior=failures[deploymentId];
        const notApplied=prior?.desiredRevision===desiredRevision?prior.notApplied+1:1;
        failures[deploymentId]={desiredRevision,notApplied};
        paused=notApplied>=AUTOMATIC_REPEATED_FAILURES;
      }else if(outcome==="APPLIED")delete failures[deploymentId];
      return {...v,failures};
    });
    if(paused){
      const list=await deployer.listDeployments();
      try{await deployer.pauseRepeatedFailure(deploymentId,{expectedRevision:list.revision,desiredRevision});}
      catch(error){if(!["PCMS_DEPLOYER_REVISION_CONFLICT","PCMS_DEPLOYER_INVALID_TRANSITION"].includes(error?.code))throw error;}
    }
    return paused;
  }

  // One bounded step of the serial pass. Never more than one dispatch, never a retry.
  async function step(){
    const before=await readControl();
    if(!before.value.enabled||before.value.cycle===null)return {status:"IDLE"};
    const current=await gates();
    if(!current.ready){
      await finish({gated:true,unmet:current.gates.filter(g=>!g.met).map(g=>g.id)});
      return {status:"GATED"};
    }
    if(before.value.dispatched>=AUTOMATIC_MAX_DISPATCHES){await finish({bounded:true});return {status:"BOUNDED"};}
    if(before.value.nextDispatchAt&&ms()<Date.parse(before.value.nextDispatchAt))return {status:"SPACED"};
    const rows=await evaluate();
    const target=rows.find(r=>r.reason===null);
    if(!target){
      // A never-deployed target is proven to exist with one spaced, hash-only read first.
      const unknown=rows.find(r=>r.reason==="EXISTENCE_UNKNOWN");
      if(unknown&&typeof observations.verifyNow==="function"){
        await change(v=>({...v,nextDispatchAt:iso(ms()+AUTOMATIC_SPACING_MS),slot:1-v.slot}));
        const read=await observations.verifyNow(unknown.deploymentId);
        return {status:"EXISTENCE_READ",deploymentId:unknown.deploymentId,read:read?.status??null};
      }
      await finish({dispatched:before.value.dispatched});return {status:"COMPLETE"};
    }
    // Durable reservation first: a crash during dispatch can never exceed the cycle bound.
    const reserved=await change(v=>({...v,dispatched:v.dispatched+1,sequence:v.sequence+1,
      nextDispatchAt:iso(ms()+AUTOMATIC_SPACING_MS),slot:1-v.slot}));
    if(reserved.value.sequence!==before.value.sequence+1)return {status:"RACED"};
    const list=await deployer.listDeployments(),d=list.deployments.find(v=>v.deploymentId===target.deploymentId);
    let outcome;
    try{
      const result=await repository.deployFromRepository({deploymentId:d.deploymentId,expectedRevision:list.revision});
      outcome=result?.status==="NOT_APPLIED"?"NOT_APPLIED":"APPLIED";
    }catch{outcome="ERROR";}
    const paused=await recordOutcome(d.deploymentId,d.desired.revision,outcome);
    const lastPass={at:clock(),deploymentId:d.deploymentId,outcome,paused};
    if(reserved.value.dispatched>=AUTOMATIC_MAX_DISPATCHES)await finish({...lastPass,bounded:true});
    else await change(v=>({...v,lastPass}));
    return {status:"DISPATCHED",deploymentId:d.deploymentId,outcome,paused};
  }

  async function status(){
    const {value}=await readControl(),current=await gates();
    return Object.freeze({enabled:value.enabled,ready:current.ready,gates:current.gates,cycle:value.cycle,
      dispatched:value.dispatched,nextDispatchAt:value.nextDispatchAt,lastPass:value.lastPass});
  }

  // Timer wiring (pcms.timers.ensure/v1), two alternating identities like the verification sweep.
  async function retire(id){const row=await timerService.get(id);if(row?.value?.state==="SCHEDULED")await timerService.cancel(id,{expectedRevision:row.revision});}
  async function declare(){
    if(!timerService)return {enabled:false};
    const {value}=await readControl();
    if(!value.enabled||value.cycle===null){for(const id of AUTOMATIC_TIMERS)await retire(id);return {enabled:false};}
    await retire(AUTOMATIC_TIMERS[1-value.slot]);
    const id=AUTOMATIC_TIMERS[value.slot];
    const dueAt=iso(Math.max(ms(),Date.parse(value.nextDispatchAt??clock())));
    const old=await timerService.get(id);
    if(old?.value?.state==="SCHEDULED"&&Date.parse(old.value.dueAt)<Date.parse(dueAt))await retire(id);
    try{return await timerService.ensure({name:id,serviceName:AUTOMATIC_SERVICE,ownerId:"core",generation:0,dueAt});}
    catch(error){if(error?.code==="PCMS_CORE_INVALID_TRANSITION")return null;throw error;}
  }
  async function onTimer({timerId}={}){
    if(timerId!==AUTOMATIC_TIMERS[(await readControl()).value.slot])return {ignored:true};
    let result;
    try{result=await step();}
    finally{
      // A spaced step keeps its slot; flip so the next occurrence has a fresh timer identity.
      const {value}=await readControl();
      if(value.enabled&&value.cycle!==null&&timerId===AUTOMATIC_TIMERS[value.slot])await change(v=>({...v,slot:1-v.slot}));
      await declare();
    }
    return result;
  }
  const wake=()=>declare();

  return Object.freeze({gates,status,enable,disable,evaluate,enqueueCycle,step,readControl,declare,onTimer,
    bindTimers(service){
      if(typeof service?.ensure!=="function"||typeof service?.get!=="function"||typeof service?.cancel!=="function")
        throw new TypeError("Automatic deployment timers are invalid");
      timerService=service;
    }});
}
