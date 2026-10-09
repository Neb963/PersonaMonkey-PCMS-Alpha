export const PCMS_CONTINUITY_FIXTURE_TIMER_ID="core.p029.continuity";
export const PCMS_CONTINUITY_FIXTURE_SERVICE="core.timer-continuity";
export const PCMS_CONTINUITY_FIXTURE_OWNER="core";
export const PCMS_CONTINUITY_FIXTURE_GENERATION=0;
export const PCMS_CONTINUITY_FIXTURE_DELAY_MS=30000;

export function createPcmsContinuityFixture({
  timers,
  clock=()=>new Date().toISOString(),
  delayMs=PCMS_CONTINUITY_FIXTURE_DELAY_MS
}={}){
  if(!timers||typeof timers.ensure!=="function")throw new TypeError("PCMS continuity fixture requires timers");
  if(typeof clock!=="function")throw new TypeError("PCMS continuity fixture clock is invalid");
  if(!Number.isSafeInteger(delayMs)||delayMs<1000||delayMs>60000)throw new RangeError("PCMS continuity fixture delay is invalid");

  async function declare({wake="COLD",recovered=[]}={}){
    const interrupted=(Array.isArray(recovered)?recovered:[]).find((row)=>row?.value?.timerId===PCMS_CONTINUITY_FIXTURE_TIMER_ID);
    if(wake!=="COLD"&&!interrupted)return null;
    const dueAt=interrupted?.value?.dueAt??new Date(Date.parse(clock())+delayMs).toISOString();
    return timers.ensure({
      name:PCMS_CONTINUITY_FIXTURE_TIMER_ID,
      serviceName:PCMS_CONTINUITY_FIXTURE_SERVICE,
      ownerId:PCMS_CONTINUITY_FIXTURE_OWNER,
      generation:PCMS_CONTINUITY_FIXTURE_GENERATION,
      dueAt
    });
  }

  return Object.freeze({declare});
}
