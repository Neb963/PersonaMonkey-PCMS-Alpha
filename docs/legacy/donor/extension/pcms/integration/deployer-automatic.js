// P042: keep automatic-mode policy in the Deployer module; composition supplies bounded Core
// services. The pass dispatches only through the repository release and the Deployer.
const url=import.meta.url.startsWith("file:")
  ?new URL("../../../pcms-modules/p015/automatic.js",import.meta.url).href
  :"/pcms-modules/p015/automatic.js";
const {createDeployerAutomatic,AUTOMATIC_NAMESPACE}=await import(url);
const SYNC_NAMESPACE="module.deployer.repository.sync";
const DEFAULT_CADENCE_MINUTES=60;
export function createDeployerAutomaticIntegration({deployer,accounts,providerProbes,storageBroker,recoveryHold,repository,observations,clock}){
  if(!repository||!observations||typeof deployer?.pauseRepeatedFailure!=="function")return null;
  const provider=providerProbes.find(p=>p.providerId==="perchance"&&typeof p.probeCompatibility==="function")??null;
  const sync=storageBroker.namespace(SYNC_NAMESPACE);
  // 04 §E.9: a snapshot is fresh for two scheduled check intervals (2·I).
  async function freshnessMs(){
    let minutes=DEFAULT_CADENCE_MINUTES;
    try{const row=await sync.get("state");if(Number.isSafeInteger(row?.value?.cadenceMinutes))minutes=row.value.cadenceMinutes;}catch{}
    return 2*minutes*60000;
  }
  return createDeployerAutomatic({deployer,repository,observations,provider,accounts,recoveryHold,
    store:storageBroker.namespace(AUTOMATIC_NAMESPACE),clock,freshnessMs});
}
