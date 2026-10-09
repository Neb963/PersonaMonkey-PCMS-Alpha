import { createHumanTaskService } from "../services/human-tasks.js";
import { createPcmsUiProjectionService } from "../app/projections.js";
import { createModuleLifecycleService } from "../modules/lifecycle.js";
import { createBackupRestoreService } from "../recovery/backup-restore.js";
import {
  createAccountProviderGateResolver,
  createKeyedStateStore,
  createPersonaResolverFromBroker,
  createProvisioningRemoteControl,
  createRemoteOperationReader,
  createSingletonStateStore
} from "./adapters.js";
import { createExplorerDeployerBridge } from "./explorer-deployer.js";
import { createGeneratorIndexService } from "./generator-index.js";
import { createGithubRepositoryProvider } from "../providers/repository/github.js";
import { createDeployerObservationIntegration } from "./deployer-observations.js";
import { createDeployerAutomaticIntegration } from "./deployer-automatic.js";
import { createSecretStore } from "../secrets/secret-store.js";
import { createNativeSecretBackend, createFirefoxNativeSecretTransport } from "../secrets/native-secret-backend.js";
import { createIntegrationRecoveryChecks } from "./recovery-checks.js";
import { createRemoteOperationCanceller, createUnattendedRefreshCapability } from "./refresher-background.js";

// Secrets are created and resolved in the privileged background only, through the dedicated
// secret host; values never enter PCMS storage, receipts, audit or dashboard results.
export function createNativeSecretStoreSession(){
  const runtime=globalThis.browser?.runtime;
  if(!runtime)throw new TypeError("Dedicated secret host is unavailable");
  return createSecretStore({backend:createNativeSecretBackend({
    sendNativeMessage:createFirefoxNativeSecretTransport(runtime)})});
}

export const PCMS_INTEGRATION_NAMESPACES=Object.freeze({
  accounts:"module.accounts",
  deployer:"module.deployer",
  explorer:"module.explorer",
  refresher:"module.refresher",
  provisioning:"module.provisioning"
});

const FACTORY_NAMES=Object.freeze(["accounts","deployer","explorer","refresher","statistics","provisioning"]);
const OPTIONAL_FACTORY="repository";

function plain(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const p=Object.getPrototypeOf(value);return p===Object.prototype||p===null;
}

function normalizeFactories(value){
  if(!plain(value)||Object.getOwnPropertySymbols(value).length)throw new TypeError("PCMS feature factories are invalid");
  const d=Object.getOwnPropertyDescriptors(value);
  if((Object.keys(d).length!==FACTORY_NAMES.length
        &&Object.keys(d).length!==FACTORY_NAMES.length+1)
      ||(Object.keys(d).length===FACTORY_NAMES.length+1
        &&(!Object.hasOwn(d,OPTIONAL_FACTORY)||!d[OPTIONAL_FACTORY].enumerable
          ||!Object.hasOwn(d[OPTIONAL_FACTORY],"value")||typeof d[OPTIONAL_FACTORY].value!=="function"))
      || !FACTORY_NAMES.every((name)=>Object.hasOwn(d,name)&&d[name].enumerable&&Object.hasOwn(d[name],"value")&&typeof d[name].value==="function")){
    throw new TypeError("PCMS feature factories are invalid");
  }
  return Object.freeze(Object.fromEntries([...FACTORY_NAMES,...(Object.hasOwn(d,OPTIONAL_FACTORY)?[OPTIONAL_FACTORY]:[])].map((name)=>[name,d[name].value])));
}

function requireMethods(value,names,label){
  if(!plain(value)||Object.getOwnPropertySymbols(value).length)throw new TypeError(label+" is invalid");
  const d=Object.getOwnPropertyDescriptors(value);
  if(!names.every((name)=>Object.hasOwn(d,name)&&d[name].enumerable&&Object.hasOwn(d[name],"value")&&typeof d[name].value==="function")){
    throw new TypeError(label+" is invalid");
  }
  return value;
}

export function createPcmsModuleIntegration({
  storageBroker,
  auditJournal,
  personaBroker,
  providerGate,
  remoteOps,
  recoveryHold,
  moduleRegistry,
  moduleRuntime,
  featureFactories,
  provisioning,
  operationContext=null,
  statisticsDefinitions=[],
  providerProbes=[],
  repositoryProvider=null,
  secretStoreFactory=createNativeSecretStoreSession,
  clock=()=>new Date().toISOString()
}={}) {
  if(!storageBroker||typeof storageBroker.namespace!=="function")throw new TypeError("PCMS integration requires storage");
  requireMethods(auditJournal,["read","transitionAndAppend"],"Audit Journal");
  requireMethods(personaBroker,["request"],"Persona Broker");
  requireMethods(providerGate,["mutate","reconcile"],"ProviderGate");
  requireMethods(remoteOps,["get","listUnresolved","recoverInterruptedDispatches","cancel"],"RemoteOps");
  requireMethods(recoveryHold,["getStatus","enterRecoveryHold","releaseRecoveryHold"],"Recovery hold");
  requireMethods(moduleRegistry,["getModule","getPackage"],"Module registry");
  requireMethods(moduleRuntime,["listStates","prepareUpdate","recoverAll"],"Module runtime");
  const factories=normalizeFactories(featureFactories);
  if(typeof clock!=="function")throw new TypeError("PCMS integration clock is invalid");
  if(typeof secretStoreFactory!=="function")throw new TypeError("PCMS secret store factory is invalid");
  if(!plain(provisioning))throw new TypeError("Provisioning integration is invalid");
  requireMethods(provisioning.sessionGuard,["acquire","validate","release"],"Provisioning session guard");
  requireMethods(provisioning.providerSession,["preflight"],"Provisioning provider session");

  const personaResolver=createPersonaResolverFromBroker({broker:personaBroker});
  const humanTasks=createHumanTaskService({storageBroker,auditJournal,clock});

  // Account rebind must never strand an unresolved provider mutation on a new
  // Persona. An operation without durable account correlation is ambiguous and
  // therefore blocks rebind until reconciled.
  const operationInspector=Object.freeze({
    async assertSafeRebind(accountId){
      const unresolved=await remoteOps.listUnresolved();
      if(!Array.isArray(unresolved))throw new Error("RemoteOperation state unavailable");
      for(const row of unresolved){
        const op=row?.value;
        if(typeof op?.operationId!=="string"||typeof op?.targetRef?.id!=="string"){
          throw Object.assign(new Error("Unresolved operation correlation is invalid"),{code:"PCMS_ACCOUNTS_UNRESOLVED_OPERATION"});
        }
        let related=null;
        if(operationContext&&typeof operationContext.get==="function"){
          let context;
          try{context=await operationContext.get(op.operationId);}catch{
            throw Object.assign(new Error("Operation correlation cannot be read"),{code:"PCMS_ACCOUNTS_UNRESOLVED_OPERATION"});
          }
          if(context){
            if(typeof context.accountId!=="string")throw Object.assign(
              new Error("Operation correlation is incomplete"),{code:"PCMS_ACCOUNTS_UNRESOLVED_OPERATION"});
            related=context.accountId===accountId;
          }
        }
        if(related===false)continue;
        if(op.targetRef.kind==="account"&&op.targetRef.id!==accountId&&related===null)continue;
        // Includes account targets, generator targets with unknown account linkage,
        // PREPARED operations and interrupted/UNCERTAIN outcomes.
        throw Object.assign(new Error("Rebind blocked until unresolved provider operations are reconciled"),{
          code:"PCMS_ACCOUNTS_UNRESOLVED_OPERATION"
        });
      }
    }
  });

  const accounts=factories.accounts({
    stateStore:createSingletonStateStore({storageBroker,namespace:PCMS_INTEGRATION_NAMESPACES.accounts}),
    personaResolver,
    operationInspector,
    clock
  });
  const providerGateResolver=createAccountProviderGateResolver({accountsService:accounts,providerGate,operationContext});
  const remoteOperationReader=createRemoteOperationReader({remoteOps});

  const deployer=factories.deployer({
    stateStore:createSingletonStateStore({storageBroker,namespace:PCMS_INTEGRATION_NAMESPACES.deployer}),
    accountsService:accounts,
    providerGateResolver,
    remoteOperationReader,
    clock
  });

  // P037: repository-only durable state, separate from the accepted Deployer
  // v2 migration and independent of runtime sandbox modules. The provider is shared with the
  // Refresher, which reads the Deployer-confirmed release from the same pinned commit (P040).
  const sharedRepositoryProvider=factories.repository?(repositoryProvider??createGithubRepositoryProvider({
    // Secrets are resolved in the privileged background only, never stored in the
    // repository state or returned to dashboard clients.
    secretResolver:async(secretRef)=>{
      const store=secretStoreFactory();
      try{return await store.resolveForPrivilegedUse(secretRef);}
      finally{store.close();}
    }
  })):null;
  let repository=factories.repository?factories.repository({
    stateStore:createSingletonStateStore({storageBroker,namespace:"module.deployer.repository"}),
    ledgerStore:storageBroker.namespace("module.deployer.repository.ledger"),
    repositoryProvider:sharedRepositoryProvider,
    deployer,accounts,recoveryHold,auditJournal,clock
  }):null;
  const observations=typeof deployer.recordProviderObservation==="function"?createDeployerObservationIntegration({
    deployer,accounts,providerProbes,storageBroker,humanTasks,recoveryHold,repository,clock
  }):null;
  // P042: Automatic mode is gated on the unattended driver, observation, recovery and challenge state.
  const automatic=createDeployerAutomaticIntegration({deployer,accounts,providerProbes,storageBroker,recoveryHold,
    repository,observations,clock});
  if(repository&&observations)repository=Object.freeze({...repository,observations,...(automatic?{automatic}:{})});

  const explorer=factories.explorer({
    stateStore:createSingletonStateStore({storageBroker,namespace:PCMS_INTEGRATION_NAMESPACES.explorer}),
    accountsService:accounts,
    clock
  });

  // P040: refresh content comes from the Deployer's confirmed release (read-only), never pasted.
  const refresher=factories.refresher({
    stateStore:createSingletonStateStore({storageBroker,namespace:PCMS_INTEGRATION_NAMESPACES.refresher}),
    accountsService:accounts,
    providerGateResolver,
    remoteOperationReader,
    remoteOperationCanceller:createRemoteOperationCanceller({remoteOps}),
    deployer,
    repository,
    repositoryProvider:sharedRepositoryProvider,
    clock
  });

  const statistics=factories.statistics({
    journal:auditJournal,
    definitions:statisticsDefinitions
  });

  const provisioningRemoteControl=createProvisioningRemoteControl({providerGate,remoteOps,operationContext});
  const accountProvisioning=factories.provisioning({
    attemptStore:createKeyedStateStore({
      storageBroker,
      namespace:PCMS_INTEGRATION_NAMESPACES.provisioning,
      keyPrefix:"attempt:"
    }),
    accounts,
    humanTasks,
    sessionGuard:provisioning.sessionGuard,
    providerSession:provisioning.providerSession,
    remoteControl:provisioningRemoteControl,
    clock
  });

  const uiProjection=createPcmsUiProjectionService({humanTasks,accounts});
  const explorerDeployer=createExplorerDeployerBridge({explorer,deployer});
  // pcms.generator-index/v1: a rebuildable Core view joined from module listings (P036).
  const generators=createGeneratorIndexService({deployer,accounts,humanTasks,recoveryHold,observations,automatic,clock});
  const recoveryChecks=createIntegrationRecoveryChecks({accounts,providerProbes});
  const moduleLifecycle=createModuleLifecycleService({storageBroker,moduleRegistry,moduleRuntime});
  const backupRestore=createBackupRestoreService({
    storageBroker,
    recoveryHold,
    remoteOps,
    providerGate,
    moduleRuntime,
    reconciliationChecks:recoveryChecks,
    clock
  });

  // P040 module UI service bundles: each built-in contribution (bundled-modules.js) gets exactly one.
  let refresherWake=async()=>null;
  const refresherUnattended=createUnattendedRefreshCapability({providerProbes});
  const refresherUi=Object.freeze({
    refresher,accounts,deployer,unattended:refresherUnattended,
    async wake(){try{return await refresherWake();}catch{return null;}}
  });
  const explorerUi=Object.freeze({explorer,explorerDeployer,deployer,accounts});
  const provisioningUi=Object.freeze({
    provisioning:accountProvisioning,accounts,
    // Only create/delete: a UI action stores a credential and keeps its SecretRef, nothing else.
    secrets:Object.freeze({
      async create(value){const store=secretStoreFactory();try{return await store.create(value);}finally{store.close();}},
      async delete(secretRef){const store=secretStoreFactory();try{return await store.delete(secretRef);}finally{store.close();}}
    })
  });

  return Object.freeze({
    accounts,
    deployer,
    repository,
    observations,
    automatic,
    explorer,
    refresher,
    statistics,
    provisioning:accountProvisioning,
    humanTasks,
    uiProjection,
    explorerDeployer,
    generators,
    recoveryChecks,
    moduleLifecycle,
    backupRestore,
    refresherUi,
    refresherUnattended,
    explorerUi,
    provisioningUi,
    bindRefresherWake(handler){
      if(typeof handler!=="function")throw new TypeError("Refresher wake handler is invalid");
      refresherWake=handler;
    }
  });
}
