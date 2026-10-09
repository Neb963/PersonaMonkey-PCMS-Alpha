import { isSecretRef } from "../../extension/pcms/secrets/secret-ref.js";
import { normalizeAccountId, normalizePersonaUid } from "../p014/schema.js";
import { PROVISIONING_ERROR_CODES, provisioningError } from "./errors.js";
import {
  PROVISIONING_HUMAN_REASONS,
  PROVISIONING_PROVIDER_ID,
  PROVISIONING_REMOTE_ACTION,
  PROVISIONING_REMOTE_TARGET_KIND,
  normalizeAttemptId,
  provisioningIntentFingerprint
} from "./schema.js";

export const PROVISIONING_DRIVER_CONTRACT_ID = "pcms.perchance.provisioning";
export const PROVISIONING_DRIVER_CONTRACT_VERSION = 1;

function fail(code = PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL) { throw provisioningError(code); }
function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype || proto===null;
}
function exact(value,names,code=PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL){
  if(!plain(value)||Object.getOwnPropertySymbols(value).length) fail(code);
  const d=Object.getOwnPropertyDescriptors(value);
  if(Object.keys(d).length!==names.length||!names.every((name)=>Object.hasOwn(d,name))) fail(code);
  for(const descriptor of Object.values(d)) if(!descriptor.enumerable||!Object.hasOwn(descriptor,"value")) fail(code);
  return d;
}
function mapNormalizer(fn,value,code){ try{return fn(value);}catch{fail(code);} }
function normalizeDriver(driver){
  const names=["probe","preflight","provisionAccount","reconcileAccountProvisioning"];
  if(!plain(driver)||Object.getOwnPropertySymbols(driver).length) throw new TypeError("Provisioning driver is invalid");
  const d=Object.getOwnPropertyDescriptors(driver);
  if(Object.keys(d).length!==names.length||!names.every((name)=>Object.hasOwn(d,name)&&d[name].enumerable&&Object.hasOwn(d[name],"value")&&typeof d[name].value==="function")) {
    throw new TypeError("Provisioning driver is invalid");
  }
  return Object.freeze(Object.fromEntries(names.map((name)=>[name,d[name].value])));
}
function normalizeCompatibility(raw){
  const d=exact(raw,["contractId","contractVersion","providerId","operations"]);
  const operations=d.operations.value;
  if(d.contractId.value!==PROVISIONING_DRIVER_CONTRACT_ID||d.contractVersion.value!==PROVISIONING_DRIVER_CONTRACT_VERSION||d.providerId.value!==PROVISIONING_PROVIDER_ID
      ||!Array.isArray(operations)||Object.getPrototypeOf(operations)!==Array.prototype||Object.getOwnPropertySymbols(operations).length
      ||operations.length!==1) fail();
  const od=Object.getOwnPropertyDescriptors(operations);
  if(Object.keys(od).some((key)=>key!=="0"&&key!=="length") || !od["0"]?.enumerable || !Object.hasOwn(od["0"],"value")
      || od["0"].value!==PROVISIONING_REMOTE_ACTION) fail();
  return Object.freeze({contractId:d.contractId.value,contractVersion:d.contractVersion.value,providerId:d.providerId.value,operations:Object.freeze([...operations])});
}
function normalizePreflightInput(raw){
  const d=exact(raw,["attemptId","accountId","personaUid","credentialRef","sessionHandle"],PROVISIONING_ERROR_CODES.INVALID_ARGUMENT);
  if(!isSecretRef(d.credentialRef.value)||d.sessionHandle.value===null||d.sessionHandle.value===undefined) fail(PROVISIONING_ERROR_CODES.INVALID_ARGUMENT);
  return Object.freeze({
    attemptId:normalizeAttemptId(d.attemptId.value),
    accountId:mapNormalizer(normalizeAccountId,d.accountId.value,PROVISIONING_ERROR_CODES.INVALID_ARGUMENT),
    personaUid:mapNormalizer(normalizePersonaUid,d.personaUid.value,PROVISIONING_ERROR_CODES.INVALID_ARGUMENT),
    credentialRef:d.credentialRef.value.toLowerCase(),
    sessionHandle:d.sessionHandle.value
  });
}
function normalizePreflightOutcome(raw){
  const d=exact(raw,["status","reason"]);
  if(d.status.value==="READY"&&d.reason.value===null) return Object.freeze({status:"READY",reason:null});
  if(d.status.value==="HUMAN_REQUIRED"&&Object.values(PROVISIONING_HUMAN_REASONS).includes(d.reason.value)) {
    return Object.freeze({status:"HUMAN_REQUIRED",reason:d.reason.value});
  }
  fail();
}
function parseOperationIdentity(operation){
  const d=exact(operation,["schemaVersion","kind","operationId","providerId","action","targetRef","intentFingerprint","state","attempt","createdAt","updatedAt","lastDispatchAt","resolvedAt","resolution"]);
  const operationId=d.operationId.value;
  const match=typeof operationId==="string"?/^p019:(.+):op:([1-9][0-9]*)$/.exec(operationId):null;
  if(!match) fail();
  const attemptId=normalizeAttemptId(match[1],PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  const operationEpoch=Number(match[2]);
  if(!Number.isSafeInteger(operationEpoch)||operationEpoch<1) fail();
  const targetRef=d.targetRef.value;
  if(d.schemaVersion.value!==1||d.kind.value!=="remote-operation"||d.providerId.value!==PROVISIONING_PROVIDER_ID||d.action.value!==PROVISIONING_REMOTE_ACTION
      ||!plain(targetRef)||targetRef.kind!==PROVISIONING_REMOTE_TARGET_KIND
      ||d.intentFingerprint.value!==provisioningIntentFingerprint(attemptId,operationEpoch)) fail();
  return Object.freeze({operationId,attemptId,operationEpoch,accountId:mapNormalizer(normalizeAccountId,targetRef.id,PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL),state:d.state.value});
}
function normalizeDispatchInput(raw,identity){
  const input=normalizePreflightInput(raw);
  if(input.attemptId!==identity.attemptId||input.accountId!==identity.accountId) fail(PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  return input;
}
function normalizeMutationOutcome(raw,{reconciliation=false}={}){
  const d=exact(raw,["status"]);
  const allowed=reconciliation?["APPLIED","NOT_APPLIED","UNKNOWN"]:["APPLIED","NOT_APPLIED"];
  if(!allowed.includes(d.status.value)) fail();
  return Object.freeze({status:d.status.value});
}

export function createProvisioningProviderAdapter({driver}={}){
  const transport=normalizeDriver(driver);
  async function probeCompatibility(){
    let raw; try{raw=await transport.probe();}catch{fail();}
    return normalizeCompatibility(raw);
  }
  async function compatibleCall(fn){
    await probeCompatibility();
    try{return await fn();}catch(error){if(error?.name==="PcmsProvisioningError") throw error; fail();}
  }
  async function preflight(raw){
    const input=normalizePreflightInput(raw);
    return compatibleCall(async()=>normalizePreflightOutcome(await transport.preflight(input)));
  }
  async function dispatch({operation,dispatchInput}={}){
    const identity=parseOperationIdentity(operation);
    if(identity.state!=="DISPATCHING") fail();
    const input=normalizeDispatchInput(dispatchInput,identity);
    return compatibleCall(async()=>normalizeMutationOutcome(await transport.provisionAccount(Object.freeze({
      operationId:identity.operationId,
      attemptId:identity.attemptId,
      accountId:identity.accountId,
      personaUid:input.personaUid,
      credentialRef:input.credentialRef,
      sessionHandle:input.sessionHandle
    }))));
  }
  async function reconcile({operation}={}){
    const identity=parseOperationIdentity(operation);
    if(identity.state!=="UNCERTAIN") fail();
    return compatibleCall(async()=>normalizeMutationOutcome(await transport.reconcileAccountProvisioning(Object.freeze({
      operationId:identity.operationId,attemptId:identity.attemptId,accountId:identity.accountId
    })),{reconciliation:true}));
  }
  return Object.freeze({
    providerId:PROVISIONING_PROVIDER_ID,
    probeCompatibility,
    preflight,
    providerDescriptor:Object.freeze({operations:Object.freeze({
      [PROVISIONING_REMOTE_ACTION]:Object.freeze({dispatch,reconcile})
    })})
  });
}
