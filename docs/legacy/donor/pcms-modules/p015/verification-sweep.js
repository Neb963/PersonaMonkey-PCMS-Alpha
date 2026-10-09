export const VERIFICATION_SERVICE="core.deployer-verification";
export const VERIFICATION_TIMERS=Object.freeze(["deployer.verify.a","deployer.verify.b"]);
export function createVerificationSweep({observations,timers,clock=()=>new Date().toISOString()}={}){
  async function retire(id){const row=await timers.get(id);if(row?.value?.state==="SCHEDULED")await timers.cancel(id,{expectedRevision:row.revision});}
  async function declare(){
    const {value}=await observations.readControl();
    if(!value.queue.length||!await observations.available()||await observations.held()||await observations.challenged()){
      for(const id of VERIFICATION_TIMERS)await retire(id);return {enabled:false};
    }
    await retire(VERIFICATION_TIMERS[1-value.slot]);
    const id=VERIFICATION_TIMERS[value.slot];
    const dueAt=new Date(Math.max(Date.parse(clock()),Date.parse(value.nextReadAt??clock()))).toISOString();
    const old=await timers.get(id);
    if(old?.value?.state==="SCHEDULED"&&Date.parse(old.value.dueAt)<Date.parse(dueAt))await retire(id);
    return timers.ensure({name:id,serviceName:VERIFICATION_SERVICE,ownerId:"core",generation:0,dueAt});
  }
  async function onTimer({timerId}={}){
    if(timerId!==VERIFICATION_TIMERS[(await observations.readControl()).value.slot])return {ignored:true};
    const result=await observations.verifyNext();
    // A deferred occurrence must use a fresh timer identity; a fired occurrence
    // cannot be reset by ensure(v1). Normally the read advances the durable slot.
    await declare();return result;
  }
  observations.bindWake(declare);
  return Object.freeze({declare,onTimer});
}
