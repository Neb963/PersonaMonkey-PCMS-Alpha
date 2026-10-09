export const PCMS_STATUS_TOKENS=Object.freeze({
  OK:Object.freeze({tone:"ok",label:"OK"}),
  INFO:Object.freeze({tone:"info",label:"Info"}),
  ACTIVE:Object.freeze({tone:"active",label:"Active"}),
  WAITING_HUMAN:Object.freeze({tone:"waiting",label:"Waiting for you"}),
  WARNING:Object.freeze({tone:"warning",label:"Warning"}),
  ERROR:Object.freeze({tone:"error",label:"Error"}),
  UNCERTAIN:Object.freeze({tone:"uncertain",label:"Outcome unknown"}),
  HELD:Object.freeze({tone:"held",label:"On hold"}),
  UNAVAILABLE:Object.freeze({tone:"unavailable",label:"Unavailable"})
});

export function pcmsStatusToken(token){
  return Object.hasOwn(PCMS_STATUS_TOKENS,token)?PCMS_STATUS_TOKENS[token]:PCMS_STATUS_TOKENS.INFO;
}

export function presentPcmsCoreStatus(status,{live=false,pending=false}={}){
  if(pending) return Object.freeze({state:"STARTING",token:"ACTIVE",label:"Starting",asOf:null});
  if(status?.state==="RUNNING"){
    return live
      ? Object.freeze({state:"RUNNING",token:"OK",label:"Running",asOf:status.asOf||null})
      : Object.freeze({state:"IDLE",token:"INFO",label:"Idle",asOf:status.asOf||null});
  }
  if(status?.state==="STARTING") return Object.freeze({state:"STARTING",token:"ACTIVE",label:"Starting",asOf:status.asOf||null});
  return Object.freeze({state:"UNAVAILABLE",token:"UNAVAILABLE",label:"Unavailable",asOf:status?.asOf||null});
}

export function presentPcmsHumanTask(task){
  const priority=String(task?.priority||"").toUpperCase();
  const kind=String(task?.taskKind||"");
  if(/uncertain|reconcile/i.test(kind)) return Object.freeze({token:"UNCERTAIN",label:"Check outcome"});
  if(priority==="CRITICAL") return Object.freeze({token:"WARNING",label:"Needs decision"});
  return Object.freeze({token:"WAITING_HUMAN",label:"Waiting for you"});
}

export function presentPcmsReceipt(receipt){
  const status=String(receipt?.status||"").toUpperCase();
  if(status==="COMPLETED") return Object.freeze({token:"OK",label:"Done"});
  if(status==="FAILED") return Object.freeze({token:"ERROR",label:"Failed"});
  if(status==="PENDING") return Object.freeze({token:"ACTIVE",label:"Running"});
  return Object.freeze({token:"UNCERTAIN",label:"Check outcome"});
}

export function presentPcmsModule(projection){
  return projection?.available===true
    ? Object.freeze({token:"OK",label:"Available"})
    : Object.freeze({token:"UNAVAILABLE",label:"Unavailable"});
}
