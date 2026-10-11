/** Message-only dashboard client. No provider, storage or Core authority. */
export function createUiClient(runtime){
  let counter=0;
  const unavailable=requestId=>({ok:false,requestId,
    error:{code:'UNAVAILABLE',message:'Alpha Core is unavailable.',retryable:true},revision:0});
  return Object.freeze({async request(command,params={},expectedRevision){
    const requestId='ui.'+Date.now()+'.'+(++counter);
    if(typeof command!=='string'||!params||typeof params!=='object'||Array.isArray(params)||
      (expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)))
      return unavailable(requestId);
    const request={v:1,requestId,command,params,
      ...(expectedRevision===undefined?{}:{expectedRevision})};
    try{
      if(typeof runtime?.sendMessage!=='function')return unavailable(requestId);
      const reply=await runtime.sendMessage({type:'PCMS_UI_REQUEST',request});
      if(!reply||typeof reply!=='object'||reply.requestId!==requestId||
        typeof reply.ok!=='boolean'||!Number.isSafeInteger(reply.revision)||reply.revision<0)
        return unavailable(requestId);
      return reply;
    }catch{return unavailable(requestId);}
  }});
}
