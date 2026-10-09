// PCMS background entry (ADR-002 §2).
//
// Imported statically by extension/lib/recovery-bootstrap.js after the fail-closed
// routing gate. It must never break PersonaMonkey's static module graph, so it has no
// static imports and its top level cannot throw. During evaluation it synchronously
// registers its own listeners; they only enqueue work. Core work starts after
// PersonaMonkey's bootstrap has completed (see core-host.js).

const PCMS_UI_REQUEST_TYPE="PCMS_UI_REQUEST";
const PCMS_ALARM_PREFIX="pcms.";

export function createPcmsBackgroundEntry({
  browserRef=globalThis.browser,
  loadHost=(options)=>import("./core-host.js").then((module)=>module.createFirefoxPcmsCoreHost(options))
}={}){
  let resolveBootstrap;
  const bootstrapHook=new Promise((resolve)=>{resolveBootstrap=resolve;});
  let bootstrapSet=false;
  let hostPromise=null;

  function setPersonaMonkeyBootstrap(bootstrap){
    if(typeof bootstrap!=="function") throw new TypeError("PersonaMonkey bootstrap must be a function");
    if(bootstrapSet) return false;
    bootstrapSet=true;
    resolveBootstrap(bootstrap);
    return true;
  }

  async function personaMonkeyReady(){
    const bootstrap=await bootstrapHook;
    await bootstrap();
  }

  function host(){
    if(!hostPromise){
      const attempt=Promise.resolve().then(()=>loadHost({personaMonkeyReady,browserRef}));
      hostPromise=attempt;
      attempt.catch(()=>{if(hostPromise===attempt) hostPromise=null;});
    }
    return hostPromise;
  }

  function wake(){
    void host().then((current)=>current.wake()).catch(()=>{});
  }

  function onMessage(message,sender){
    // Every other message belongs to PersonaMonkey's own listener.
    if(message?.type!==PCMS_UI_REQUEST_TYPE) return undefined;
    return host().then(
      (current)=>current.handleUiMessage(message,sender),
      ()=>({type:"PCMS_UI_RESPONSE",version:1,requestId:null,ok:false,
        error:{code:"PCMS_CORE_UNAVAILABLE",message:"PCMS Core is unavailable"}})
    );
  }

  function onAlarm(alarm){
    if(typeof alarm?.name!=="string"||!alarm.name.startsWith(PCMS_ALARM_PREFIX)) return;
    void host().then((current)=>typeof current.handleAlarm==="function"?current.handleAlarm(alarm):current.wake()).catch(()=>{});
  }

  function install(){
    const registered=[];
    try{browserRef.runtime.onMessage.addListener(onMessage);registered.push("runtime.onMessage");}catch{}
    try{browserRef.alarms.onAlarm.addListener(onAlarm);registered.push("alarms.onAlarm");}catch{}
    try{browserRef.runtime.onStartup.addListener(wake);registered.push("runtime.onStartup");}catch{}
    try{browserRef.runtime.onInstalled.addListener(wake);registered.push("runtime.onInstalled");}catch{}
    // Any wake initialises Core (ADR-002 §5); work waits for PersonaMonkey's bootstrap.
    if(registered.length) wake();
    return Object.freeze(registered);
  }

  return Object.freeze({install,setPersonaMonkeyBootstrap,onMessage,onAlarm,host});
}

let entry=null;
try{
  entry=createPcmsBackgroundEntry();
  if(globalThis.browser?.runtime) entry.install();
}catch{
  entry=null;
}

export function setPcmsPersonaMonkeyBootstrap(bootstrap){
  try{return entry?entry.setPersonaMonkeyBootstrap(bootstrap):false;}
  catch{return false;}
}
