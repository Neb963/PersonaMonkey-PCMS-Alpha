import { createPcmsStorageBroker } from "../storage/storage-broker.js";
import { createPcmsAuditJournal } from "../audit/journal.js";
import { createRemoteOps } from "../remoteops/remote-ops.js";
import { createRecoveryHoldController } from "../remoteops/recovery-hold.js";
import { createProviderGate } from "../remoteops/provider-gate.js";
import { createModulePackageRegistry } from "../modules/registry.js";
import { createModuleRuntimeBroker } from "../runtime/module-runtime.js";
import { createPcmsModuleIntegration } from "./composition.js";

export async function recoverPcmsLiveStartup({remoteOps,recoveryHold,moduleRuntime}={}) {
  if(!remoteOps||typeof remoteOps.listUnresolved!=="function") throw new TypeError("Startup recovery requires RemoteOps");
  if(!recoveryHold||typeof recoveryHold.getStatus!=="function"||typeof recoveryHold.enterRecoveryHold!=="function") {
    throw new TypeError("Startup recovery requires recovery hold");
  }
  if(!moduleRuntime||typeof moduleRuntime.recoverAll!=="function") throw new TypeError("Startup recovery requires module runtime");

  const unresolvedBefore=await remoteOps.listUnresolved();
  const holdBefore=await recoveryHold.getStatus();
  let interruptedOperationIds=Object.freeze([]);

  if(holdBefore.value.state==="RECOVERY_HOLD"||unresolvedBefore.length>0) {
    const entered=await recoveryHold.enterRecoveryHold({
      reason:holdBefore.value.state==="RECOVERY_HOLD"
        ? (holdBefore.value.reason||"restart-recovery")
        : "restart-unresolved-remote-operations"
    });
    interruptedOperationIds=entered.recoveredOperationIds;
  }

  const recoveredModuleIds=await moduleRuntime.recoverAll();
  const holdAfter=await recoveryHold.getStatus();
  return Object.freeze({
    interruptedOperationIds,
    recoveredModuleIds,
    recoveryState:holdAfter.value.state
  });
}

// ADR-002 §5: a warm wake (same browser session, new event-page context) can
// only find DISPATCHING operations that the previous context left interrupted.
// Those become UNCERTAIN under RECOVERY_HOLD exactly as on a cold start. Other
// unresolved states were already fenced per target and do not by themselves
// put PCMS into global hold, or every idle unload would hold PCMS.
export async function recoverPcmsWarmWake({remoteOps,recoveryHold,moduleRuntime}={}) {
  if(!remoteOps||typeof remoteOps.listUnresolved!=="function") throw new TypeError("Warm-wake recovery requires RemoteOps");
  if(!recoveryHold||typeof recoveryHold.getStatus!=="function"||typeof recoveryHold.enterRecoveryHold!=="function") {
    throw new TypeError("Warm-wake recovery requires recovery hold");
  }
  if(!moduleRuntime||typeof moduleRuntime.recoverAll!=="function") throw new TypeError("Warm-wake recovery requires module runtime");

  const unresolved=await remoteOps.listUnresolved();
  const interrupted=unresolved.some((row)=>row?.value?.state==="DISPATCHING");
  let interruptedOperationIds=Object.freeze([]);
  if(interrupted) {
    const entered=await recoveryHold.enterRecoveryHold({reason:"warm-wake-interrupted-dispatch"});
    interruptedOperationIds=entered.recoveredOperationIds;
  }

  const recoveredModuleIds=await moduleRuntime.recoverAll();
  const holdAfter=await recoveryHold.getStatus();
  return Object.freeze({
    interruptedOperationIds,
    recoveredModuleIds,
    recoveryState:holdAfter.value.state
  });
}

export function createPcmsLiveCore({
  personaBroker,
  featureFactories,
  provisioning,
  statisticsDefinitions,
  providerProbes=[],
  liveMutationFactory=null,
  clock=()=>new Date().toISOString(),
  storageBroker:injectedStorageBroker=null,
  auditJournal:injectedAuditJournal=null,
  moduleRuntimeOptions=null
}={}) {
  if(!personaBroker||typeof personaBroker.request!=="function") throw new TypeError("PCMS live Core requires Persona Broker");
  if(!featureFactories||typeof featureFactories!=="object") throw new TypeError("PCMS live Core requires feature factories");
  if(!provisioning||typeof provisioning!=="object") throw new TypeError("PCMS live Core requires provisioning adapters");
  if(!Array.isArray(statisticsDefinitions)||statisticsDefinitions.length<1) throw new TypeError("PCMS live Core requires statistics definitions");
  if(!Array.isArray(providerProbes)) throw new TypeError("PCMS live Core provider probes are invalid");
  if(liveMutationFactory!==null&&typeof liveMutationFactory!=="function") throw new TypeError("PCMS live mutation factory is invalid");
  if(typeof clock!=="function") throw new TypeError("PCMS live Core clock is invalid");
  if(moduleRuntimeOptions!==null&&(typeof moduleRuntimeOptions!=="object"||Array.isArray(moduleRuntimeOptions))) {
    throw new TypeError("PCMS live module runtime options are invalid");
  }

  // Injection exists for deterministic Node tests over one shared durable store.
  const storageBroker=injectedStorageBroker||createPcmsStorageBroker({clock});
  const auditJournal=injectedAuditJournal||createPcmsAuditJournal({clock});
  const remoteOps=createRemoteOps({storageBroker,clock});
  const recoveryHold=createRecoveryHoldController({storageBroker,remoteOps,clock});
  const liveMutations=liveMutationFactory
    ? liveMutationFactory({storageBroker,auditJournal,personaBroker,remoteOps,recoveryHold,clock})
    : null;
  const activeProviders=liveMutations?.providers||Object.freeze({});
  const activeProvisioning=liveMutations?.provisioning||provisioning;
  const activeProviderProbes=liveMutations?.providerProbes||providerProbes;
  const operationContext=liveMutations?.operationContext||null;
  const providerGate=createProviderGate({
    remoteOps,
    recoveryHold,
    providers:activeProviders
  });
  const moduleRegistry=createModulePackageRegistry({storageBroker,clock});
  // ADR-003 §1: the background supplies the sandbox frame factory, browser-floor
  // support detection and the capability set v1 handlers (P031 live wiring).
  const moduleRuntime=createModuleRuntimeBroker({
    storageBroker,
    moduleRegistry,
    recoveryHold,
    frameFactory:moduleRuntimeOptions?.frameFactory??null,
    capabilities:moduleRuntimeOptions?.capabilities??{},
    support:moduleRuntimeOptions?.support??null
  });

  const integration=createPcmsModuleIntegration({
    storageBroker,
    auditJournal,
    personaBroker,
    providerGate,
    remoteOps,
    recoveryHold,
    moduleRegistry,
    moduleRuntime,
    featureFactories,
    provisioning:activeProvisioning,
    operationContext,
    statisticsDefinitions,
    providerProbes:activeProviderProbes,
    clock
  });

  async function initialize({wake="COLD"}={}) {
    if(wake!=="COLD"&&wake!=="WARM") throw new TypeError("PCMS live Core wake classification is invalid");
    await storageBroker.open();
    await auditJournal.open();

    return wake==="WARM"
      ? recoverPcmsWarmWake({remoteOps,recoveryHold,moduleRuntime})
      : recoverPcmsLiveStartup({remoteOps,recoveryHold,moduleRuntime});
  }

  function close() {
    try{personaBroker.close?.();}catch{}
    try{auditJournal.close();}catch{}
    try{storageBroker.close();}catch{}
  }

  return Object.freeze({
    initialize,
    close,
    storageBroker,
    auditJournal,
    remoteOps,
    recoveryHold,
    providerGate,
    moduleRegistry,
    moduleRuntime,
    liveMutations,
    ...integration
  });
}
