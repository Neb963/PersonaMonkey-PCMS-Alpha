import { TIMER_STATES } from "../../services/timers.js";

export const PCMS_TIMER_ALARM_NEXT="pcms.timers.next";
export const PCMS_CORE_HEARTBEAT_ALARM="pcms.core.heartbeat";
export const PCMS_CORE_HEARTBEAT_MINUTES=5;
export const PCMS_TIMER_CONTINUATION_DELAY_MS=1000;

function timeMs(value){
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed))throw new TypeError("PCMS alarm clock is invalid");
  return parsed;
}

export function createPcmsAlarmCoordinator({
  alarms,
  timers,
  declareSchedules=null,
  clock=()=>new Date().toISOString(),
  limit=32
}={}){
  if(!alarms||typeof alarms.create!=="function"||typeof alarms.clear!=="function")throw new TypeError("PCMS alarms API is unavailable");
  if(!timers||typeof timers.list!=="function"||typeof timers.recoverInterrupted!=="function"||typeof timers.runDue!=="function")throw new TypeError("PCMS alarm coordinator requires timers");
  if(declareSchedules!==null&&typeof declareSchedules!=="function")throw new TypeError("PCMS schedule declarer is invalid");
  if(typeof clock!=="function")throw new TypeError("PCMS alarm coordinator clock is invalid");
  if(!Number.isSafeInteger(limit)||limit<1||limit>256)throw new RangeError("PCMS due-pass limit is invalid");

  let tail=Promise.resolve();
  function serialized(run){const next=tail.then(run,run);tail=next.catch(()=>{});return next;}
  async function create(name,info){await Promise.resolve(alarms.create(name,info));}

  async function ensureHeartbeat(){
    if(typeof alarms.get==="function"){
      try{
        const current=await alarms.get(PCMS_CORE_HEARTBEAT_ALARM);
        if(current&&current.periodInMinutes===PCMS_CORE_HEARTBEAT_MINUTES)return false;
      }catch{}
    }
    await create(PCMS_CORE_HEARTBEAT_ALARM,{periodInMinutes:PCMS_CORE_HEARTBEAT_MINUTES});
    return true;
  }

  async function armNext({continuationDelayMs=null}={}){
    if(continuationDelayMs!==null&&(!Number.isSafeInteger(continuationDelayMs)||continuationDelayMs<1))throw new TypeError("PCMS continuation delay is invalid");
    const now=timeMs(clock());
    const scheduled=(await timers.list())
      .filter((row)=>row.value.state===TIMER_STATES.SCHEDULED)
      .sort((a,b)=>a.value.dueAt.localeCompare(b.value.dueAt)||a.value.timerId.localeCompare(b.value.timerId));
    let when=scheduled.length?Date.parse(scheduled[0].value.dueAt):null;
    if(continuationDelayMs!==null){
      const continuation=now+continuationDelayMs;
      when=when===null||when<=now?continuation:Math.min(when,continuation);
    }else if(when!==null&&when<=now){
      when=now+50;
    }
    if(when===null){
      await Promise.resolve(alarms.clear(PCMS_TIMER_ALARM_NEXT));
      return null;
    }
    await create(PCMS_TIMER_ALARM_NEXT,{when});
    return Object.freeze({name:PCMS_TIMER_ALARM_NEXT,when,nextTimerId:scheduled[0]?.value?.timerId??null});
  }

  async function duePass(wake){
    const recovered=await timers.recoverInterrupted({limit});
    if(declareSchedules)await declareSchedules({wake,recovered:recovered.recovered});
    const due=await timers.runDue({limit});
    const remaining=recovered.remainingInterrupted+due.remainingDue;
    const progressed=recovered.recovered.length+due.processed.length;
    const continuationDelayMs=remaining>0
      ? (progressed>0?PCMS_TIMER_CONTINUATION_DELAY_MS:PCMS_CORE_HEARTBEAT_MINUTES*60*1000)
      : null;
    const next=await armNext({continuationDelayMs});
    return Object.freeze({wake,recovered,due,next});
  }

  function start({wake="COLD"}={}){
    if(wake!=="COLD"&&wake!=="WARM")throw new TypeError("PCMS alarm wake classification is invalid");
    return serialized(async()=>{await ensureHeartbeat();return duePass(wake);});
  }

  function handleAlarm(name,{wake="WARM"}={}){
    if(name!==PCMS_TIMER_ALARM_NEXT&&name!==PCMS_CORE_HEARTBEAT_ALARM)return Promise.resolve(Object.freeze({ignored:true}));
    return serialized(async()=>{await ensureHeartbeat();return duePass(wake);});
  }

  return Object.freeze({start,handleAlarm,armNext,ensureHeartbeat});
}
