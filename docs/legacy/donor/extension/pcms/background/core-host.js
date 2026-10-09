// ADR-002 §1, §2, §5, §12: exactly one PCMS Core per background context.
//
// ensurePcmsCore() is idempotent and returns the same promise to every caller. It waits
// for PersonaMonkey's fail-closed bootstrap, classifies the wake from the storage.session
// marker (absent = cold start, present = warm wake), runs the matching recovery and then
// publishes the non-secret status summary and the UI revision signal.
import {
  PCMS_CORE_SESSION_KEY,
  PCMS_STATUS_KEY,
  PCMS_UI_REVISION_KEY,
  PCMS_UI_TOPICS
} from "../integration/ui-client-contract.js";
import { createPcmsUiDispatcher } from "./ui-dispatcher.js";

export const PCMS_CORE_STATES=Object.freeze({STARTING:"STARTING",RUNNING:"RUNNING",UNAVAILABLE:"UNAVAILABLE"});
const MAX_STATUS_PERSONAS=200;

function randomId(){
  const bytes=new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

export function createPcmsSessionSignals({sessionStore}={}){
  if(!sessionStore||typeof sessionStore.get!=="function"||typeof sessionStore.set!=="function") {
    throw new TypeError("PCMS session signals require session storage");
  }
  let tail=Promise.resolve();
  function serialized(run){const next=tail.then(run,run);tail=next.catch(()=>{});return next;}

  // The sequence continues across event-page unloads because it lives in storage.session.
  function signal(topics){
    const safe=[...new Set((Array.isArray(topics)?topics:[]).filter((topic)=>PCMS_UI_TOPICS.includes(topic)))].sort();
    return serialized(async()=>{
      const current=await sessionStore.get(PCMS_UI_REVISION_KEY);
      const seq=(Number.isSafeInteger(current?.seq)&&current.seq>=0?current.seq:0)+1;
      const value=Object.freeze({seq,topics:Object.freeze(safe)});
      await sessionStore.set(PCMS_UI_REVISION_KEY,value);
      return value;
    });
  }
  function publishStatus(summary){return serialized(()=>sessionStore.set(PCMS_STATUS_KEY,summary));}
  return Object.freeze({signal,publishStatus});
}

export function createPcmsCoreHost({
  personaMonkeyReady,
  createCore,
  createAlarmCoordinator=null,
  sessionStore,
  runtimeId,
  extensionBaseUrl,
  clock=()=>new Date().toISOString(),
  newSessionId=randomId
}={}){
  if(typeof personaMonkeyReady!=="function") throw new TypeError("PCMS Core host requires the PersonaMonkey bootstrap");
  if(typeof createCore!=="function") throw new TypeError("PCMS Core host requires a Core factory");
  if(createAlarmCoordinator!==null&&typeof createAlarmCoordinator!=="function") throw new TypeError("PCMS Core host alarm coordinator is invalid");
  const signals=createPcmsSessionSignals({sessionStore});

  let corePromise=null;
  let core=null;
  let state=PCMS_CORE_STATES.STARTING;
  let reason=null;
  let wake=null;
  let recovery=null;
  let alarmCoordinator=null;
  let constructed=0;

  async function summary(){
    const base={
      schemaVersion:1,
      state,
      reason,
      asOf:new Date(clock()).toISOString(),
      wake,
      recoveryState:recovery?.recoveryState??null,
      counts:null,
      personaAccounts:[]
    };
    if(!core||state!==PCMS_CORE_STATES.RUNNING) return Object.freeze(base);
    try{
      const [hold,unresolved,attention,accounts]=await Promise.all([
        core.recoveryHold.getStatus(),
        core.remoteOps.listUnresolved(),
        core.humanTasks.listAttention({limit:500}),
        core.accounts.listAccounts()
      ]);
      const byPersona=new Map();
      for(const account of accounts.accounts||[]){
        if(typeof account?.personaUid!=="string") continue;
        const list=byPersona.get(account.personaUid)||[];
        list.push(Object.freeze({accountId:String(account.accountId),displayName:String(account.displayName||account.accountId).slice(0,160)}));
        byPersona.set(account.personaUid,list);
      }
      return Object.freeze({
        ...base,
        recoveryState:hold.value.state,
        counts:Object.freeze({
          attention:attention.length,
          accounts:(accounts.accounts||[]).length,
          unresolvedOperations:unresolved.length
        }),
        personaAccounts:Object.freeze([...byPersona.entries()]
          .sort(([a],[b])=>a.localeCompare(b))
          .slice(0,MAX_STATUS_PERSONAS)
          .map(([personaUid,list])=>Object.freeze({personaUid,accounts:Object.freeze(list)})))
      });
    }catch{
      return Object.freeze(base);
    }
  }

  async function publish(topics=PCMS_UI_TOPICS){
    try{await signals.publishStatus(await summary());}catch{}
    try{await signals.signal(topics);}catch{}
  }

  async function start(){
    try{await personaMonkeyReady();}
    catch(error){
      state=PCMS_CORE_STATES.UNAVAILABLE;
      reason="personamonkey-bootstrap-failed";
      throw error;
    }
    let built;
    try{
      built=createCore();
      constructed+=1;
      const marker=await sessionStore.get(PCMS_CORE_SESSION_KEY);
      wake=marker&&typeof marker.sessionId==="string"?"WARM":"COLD";
      recovery=await built.initialize({wake});
      if(createAlarmCoordinator){
        alarmCoordinator=createAlarmCoordinator(built);
        built.bindTimerAlarmRearm?.(()=>alarmCoordinator.armNext());
        await alarmCoordinator.start({wake});
      }
      if(wake==="COLD"){
        await sessionStore.set(PCMS_CORE_SESSION_KEY,Object.freeze({sessionId:newSessionId(),startedAt:new Date(clock()).toISOString()}));
      }
    }catch(error){
      try{built?.bindTimerAlarmRearm?.(null);}catch{}
      try{built?.close?.();}catch{}
      alarmCoordinator=null;
      state=PCMS_CORE_STATES.UNAVAILABLE;
      reason="core-initialization-failed";
      throw error;
    }
    core=built;
    state=PCMS_CORE_STATES.RUNNING;
    reason=null;
    try{await dispatcher.pruneReceipts(core);}catch{}
    return core;
  }

  function ensurePcmsCore(){
    if(corePromise) return corePromise;
    const attempt=start();
    corePromise=attempt;
    void attempt.then(
      ()=>publish(),
      ()=>{
        // A later wake or request retries; UI clients see UNAVAILABLE meanwhile.
        if(corePromise===attempt) corePromise=null;
        return publish(["core"]);
      }
    );
    return attempt;
  }

  async function readStatus(){
    const current=await summary();
    return Object.freeze({...current,constructedCores:constructed});
  }

  async function handleAlarm(alarm){
    const wasRunning=core!==null;
    await ensurePcmsCore();
    if(wasRunning&&alarmCoordinator){
      await alarmCoordinator.handleAlarm(alarm?.name,{wake:"WARM"});
      await publish(["core"]);
    }
    return true;
  }

  const dispatcher=createPcmsUiDispatcher({
    ensureCore:ensurePcmsCore,
    readStatus,
    onCommitted:(topics)=>publish(topics),
    runtimeId,
    extensionBaseUrl,
    clock
  });

  return Object.freeze({
    ensurePcmsCore,
    handleUiMessage:(message,sender)=>dispatcher.handle(message,sender),
    handleAlarm,
    wake(){return ensurePcmsCore().then(()=>true,()=>false);},
    readStatus,
    get state(){return state;}
  });
}

function createStorageSessionStore(area){
  if(!area||typeof area.get!=="function"||typeof area.set!=="function") throw new TypeError("storage.session is unavailable");
  return Object.freeze({
    async get(key){const stored=await area.get(key);return stored?.[key]??null;},
    async set(key,value){await area.set({[key]:value});}
  });
}

// Firefox binding: in-process Persona Broker endpoint, storage.session, real feature modules.
export async function createFirefoxPcmsCoreHost({personaMonkeyReady,browserRef=globalThis.browser}={}){
  const [{createPcmsInternalBrokerEndpoint},{createBackgroundPcmsCore},{PCMS_BACKGROUND_FEATURE_FACTORIES},{createPcmsAlarmCoordinator}]=await Promise.all([
    import("../../lib/pcms-internal-broker-endpoint.js"),
    import("./core-factory.js"),
    import("./feature-factories.js"),
    import("./alarms/coordinator.js")
  ]);
  return createPcmsCoreHost({
    personaMonkeyReady,
    createCore:()=>createBackgroundPcmsCore({
      transport:createPcmsInternalBrokerEndpoint(),
      featureFactories:PCMS_BACKGROUND_FEATURE_FACTORIES
    }),
    createAlarmCoordinator:(core)=>createPcmsAlarmCoordinator({
      alarms:browserRef.alarms,
      timers:core.timers,
      declareSchedules:core.declareTimerSchedules
    }),
    sessionStore:createStorageSessionStore(browserRef.storage.session),
    runtimeId:browserRef.runtime.id,
    extensionBaseUrl:browserRef.runtime.getURL("")
  });
}
