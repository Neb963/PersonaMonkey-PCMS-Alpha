// Keep module policy in Deployer; composition supplies bounded Core services.
const url=import.meta.url.startsWith("file:")
  ?new URL("../../../pcms-modules/p015/observations.js",import.meta.url).href
  :"/pcms-modules/p015/observations.js";
const {createDeployerObservations,OBSERVATION_NAMESPACE}=await import(url);
export function createDeployerObservationIntegration({deployer,accounts,providerProbes,storageBroker,humanTasks,recoveryHold,repository,clock}){
  const provider=providerProbes.find(p=>p.providerId==="perchance"&&typeof p.observe==="function")??null;
  const service=createDeployerObservations({deployer,accounts,provider,store:storageBroker.namespace(OBSERVATION_NAMESPACE),
    humanTasks,recoveryHold,repository,readDesiredPayload:repository?.readDesiredPayload??null,clock});
  deployer.bindObservations?.(service);
  return service;
}
