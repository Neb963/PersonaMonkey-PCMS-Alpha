export const PCMS_STARTUP_RETRY_DELAYS_MS=Object.freeze([0,100,250,500,1000,2000]);

function wait(ms,setTimeoutRef){
  return ms===0?Promise.resolve():new Promise((resolve)=>setTimeoutRef(resolve,ms));
}

export async function startPcmsRuntimeWithRetry({
  startRuntime,
  delays=PCMS_STARTUP_RETRY_DELAYS_MS,
  setTimeoutRef=globalThis.setTimeout
}={}){
  if(typeof startRuntime!=="function")throw new TypeError("PCMS startup retry requires startRuntime");
  if(!Array.isArray(delays)||delays.length<1||delays.length>16
      ||delays.some((value)=>!Number.isSafeInteger(value)||value<0||value>10000)) {
    throw new TypeError("PCMS startup retry delays are invalid");
  }
  if(typeof setTimeoutRef!=="function")throw new TypeError("PCMS startup retry requires setTimeout");
  let lastError=null;
  for(let index=0;index<delays.length;index+=1){
    await wait(delays[index],setTimeoutRef);
    try{return await startRuntime();}
    catch(error){lastError=error;}
  }
  throw lastError||new Error("PCMS runtime startup failed");
}
