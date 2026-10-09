import { INTEGRATION_ERROR_CODES, integrationError } from "./errors.js";

const HASH=/^[a-f0-9]{64}$/;

function fail(code){throw integrationError(code);}
function plain(value){if(!value||typeof value!=="object"||Array.isArray(value))return false;const p=Object.getPrototypeOf(value);return p===Object.prototype||p===null;}
function methods(value,names,label){
  if(!plain(value)||Object.getOwnPropertySymbols(value).length)throw new TypeError(label+" is invalid");
  const d=Object.getOwnPropertyDescriptors(value);
  if(!names.every((name)=>Object.hasOwn(d,name)&&d[name].enumerable&&Object.hasOwn(d[name],"value")&&typeof d[name].value==="function"))throw new TypeError(label+" is invalid");
  return Object.freeze(Object.fromEntries(names.map((name)=>[name,d[name].value])));
}
function sameDeployment(existing,reservation){
  return existing
    && existing.deploymentId===reservation.deploymentId
    && existing.accountId===reservation.accountId
    && existing.providerId===reservation.providerId
    && existing.targetRef?.id===reservation.targetRef?.id
    && existing.desired?.payloadHash===reservation.observedSourceHash;
}

export function createExplorerDeployerBridge({explorer,deployer}={}) {
  const discovery=methods(explorer,["getDeploymentReservation"],"Explorer service");
  const deployments=methods(deployer,["getDeployment","createDeployment"],"Deployer service");

  async function createDeploymentFromClaim(claimId,{expectedDeployerRevision}={}) {
    if(!Number.isSafeInteger(expectedDeployerRevision)||expectedDeployerRevision<0) {
      fail(INTEGRATION_ERROR_CODES.INVALID_ARGUMENT);
    }
    const reservation=await discovery.getDeploymentReservation(claimId);
    if(!reservation||reservation.ready!==true||reservation.actions?.canCreateDeployment!==true
        || typeof reservation.deploymentId!=="string"
        || typeof reservation.accountId!=="string"
        || reservation.providerId!=="perchance"
        || reservation.targetRef?.kind!=="generator"
        || typeof reservation.targetRef.id!=="string"
        || typeof reservation.observedSourceHash!=="string"
        || !HASH.test(reservation.observedSourceHash)) {
      fail(INTEGRATION_ERROR_CODES.RESERVATION_NOT_READY);
    }

    const existing=await deployments.getDeployment(reservation.deploymentId);
    if(existing) {
      if(!sameDeployment(existing,reservation)) fail(INTEGRATION_ERROR_CODES.CROSS_MODULE_CONFLICT);
      return Object.freeze({created:false,deployment:existing});
    }

    let created;
    try {
      created=await deployments.createDeployment(Object.freeze({
        deploymentId:reservation.deploymentId,
        accountId:reservation.accountId,
        generatorId:reservation.targetRef.id,
        sourceHash:reservation.observedSourceHash
      }),{expectedRevision:expectedDeployerRevision});
    } catch {
      const raced=await deployments.getDeployment(reservation.deploymentId);
      if(raced&&sameDeployment(raced,reservation)) return Object.freeze({created:false,deployment:raced});
      fail(INTEGRATION_ERROR_CODES.CROSS_MODULE_CONFLICT);
    }
    return Object.freeze({created:true,deployment:created.deployment,revision:created.revision});
  }

  return Object.freeze({createDeploymentFromClaim});
}
