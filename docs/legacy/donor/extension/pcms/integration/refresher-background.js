// P040 Refresher background wiring (A040-02).
//
// - The Refresher's release source (pcms-modules/p017/release-source.js) is a read-only query over
//   the Deployer and the repository; composition.js hands it those services.
// - The scheduler is a Core timer service (pcms.timers.ensure/v1). browser.alarms only wake the
//   background; the durable timer decides when a bounded pass runs, with zero PCMS tabs.

export const REFRESHER_BACKGROUND_SERVICE="refresher.background";
export const REFRESHER_BACKGROUND_TIMER_ID="refresher.background-pass";
export const REFRESHER_BACKGROUND_OWNER="core";
export const REFRESHER_BACKGROUND_GENERATION=0;

function requireMethods(value,names,label){
  if(!value||typeof value!=="object"||!names.every((name)=>typeof value[name]==="function")) throw new TypeError(label+" is invalid");
  return value;
}

// Cancels a RemoteOperation that is provably not dispatched (PREPARED or RETRYABLE).
export function createRemoteOperationCanceller({remoteOps}={}){
  requireMethods(remoteOps,["get","cancel"],"RemoteOps");
  return Object.freeze({
    async cancel(operationId){
      const row=await remoteOps.get(operationId);
      if(!row) throw new Error("RemoteOperation not found");
      return remoteOps.cancel(operationId,{expectedRevision:row.revision});
    }
  });
}

// Unattended Perchance mutation is capability-gated (P042/P044): a background pass dispatches
// only while the Perchance provider's probe declares `unattended`. Unknown fails closed.
export function createUnattendedRefreshCapability({providerProbes=[]}={}){
  return async function unattended(){
    for(const probe of Array.isArray(providerProbes)?providerProbes:[]){
      if(probe?.providerId!=="perchance"||typeof probe.probeCompatibility!=="function") continue;
      try{
        const compatibility=await probe.probeCompatibility();
        return compatibility?.contractVersion===2&&compatibility.capabilities?.unattended===true;
      }catch{return false;}
    }
    return false;
  };
}

export function createRefresherBackgroundScheduler({refresher,timers,recoveryHold=null,canDispatch=async()=>false,clock=()=>new Date().toISOString()}={}){
  requireMethods(refresher,["runBackgroundPass","nextWakeAt"],"Refresher service");
  requireMethods(timers,["ensure","get"],"Core timers");
  if(typeof clock!=="function") throw new TypeError("Refresher scheduler clock is invalid");
  if(typeof canDispatch!=="function") throw new TypeError("Refresher dispatch capability is invalid");
  async function dispatchAllowed(){try{return (await canDispatch())===true;}catch{return false;}}
  let lastPass=null;

  async function held(){
    if(!recoveryHold) return false;
    try{return (await recoveryHold.getStatus())?.value?.state==="RECOVERY_HOLD";}catch{return true;}
  }

  // Declares the next occurrence. Idempotent: ensure keeps the earlier due time and never moves
  // an occurrence that is being delivered (it is re-declared once delivery completes).
  async function declare(){
    let dueAt=await refresher.nextWakeAt({at:clock()});
    if(dueAt===null) return null;
    // Without unattended dispatch a pass only re-evaluates; never wake every minute for it.
    if(!await dispatchAllowed()){
      const horizon=new Date(Date.parse(clock())+6*60*60*1000).toISOString();
      if(Date.parse(dueAt)<Date.parse(horizon)) dueAt=horizon;
    }
    try{
      return await timers.ensure({name:REFRESHER_BACKGROUND_TIMER_ID,serviceName:REFRESHER_BACKGROUND_SERVICE,
        ownerId:REFRESHER_BACKGROUND_OWNER,generation:REFRESHER_BACKGROUND_GENERATION,dueAt});
    }catch(error){
      if(error?.code==="PCMS_CORE_INVALID_TRANSITION") return null;
      throw error;
    }
  }

  const service=Object.freeze({
    async onTimer(){
      // Recovery hold blocks external mutation; the pass waits for reconciliation.
      if(await held()){lastPass=Object.freeze({at:new Date(clock()).toISOString(),held:true});return Object.freeze({completed:true,held:true});}
      // Assisted-only provider: nothing is dispatched; due refreshes surface in Attention.
      if(!await dispatchAllowed()){lastPass=Object.freeze({at:new Date(clock()).toISOString(),held:false,gated:true});return Object.freeze({completed:true,gated:true});}
      const result=await refresher.runBackgroundPass({at:clock()});
      lastPass=Object.freeze({at:result.at,held:false,dispatched:result.dispatched.length,cancelled:result.cancelled.length,
        skipped:result.skipped.length,errors:result.errors.length});
      return Object.freeze({completed:true,dispatched:result.dispatched.length});
    }
  });

  return Object.freeze({
    serviceName:REFRESHER_BACKGROUND_SERVICE,
    timerId:REFRESHER_BACKGROUND_TIMER_ID,
    ownerId:REFRESHER_BACKGROUND_OWNER,
    generation:REFRESHER_BACKGROUND_GENERATION,
    service,
    declare,
    async status(){
      const timer=await timers.get(REFRESHER_BACKGROUND_TIMER_ID);
      return Object.freeze({next:timer?.value?.state==="SCHEDULED"?timer.value.dueAt:null,lastPass});
    }
  });
}
