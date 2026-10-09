import { BACKUP_ERROR_CODES, backupError } from "./errors.js";
import {
  PCMS_BACKUP_EXCLUDED_NAMESPACES,
  PCMS_BACKUP_KIND,
  PCMS_BACKUP_MAX_RECORDS,
  PCMS_BACKUP_SCHEMA_VERSION,
  PCMS_RESTORE_PREVIEW_TTL_MS,
  PCMS_STAGED_RESTORE_KIND,
  assertNoCredentialValues,
  backupDigestPayload,
  normalizeBackupEnvelope,
  normalizeBackupId,
  normalizeStagedRestore
} from "./schema.js";
import { planBackupRetention } from "./retention.js";
import { buildRestorePreview, restorePreviewBinding } from "./preview.js";

function fail(code) { throw backupError(code); }

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype || proto===null;
}

function snapshotMethods(value,names,label) {
  if(!plain(value)||Object.getOwnPropertySymbols(value).length) throw new TypeError(label+" is invalid");
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(!names.every((name)=>Object.hasOwn(descriptors,name)
      &&descriptors[name].enumerable
      &&Object.hasOwn(descriptors[name],"value")
      &&typeof descriptors[name].value==="function")) throw new TypeError(label+" is invalid");
  return Object.freeze(Object.fromEntries(names.map((name)=>[name,descriptors[name].value])));
}

function isoNow(clock) {
  let value;
  try { value=new Date(clock()).toISOString(); }
  catch { fail(BACKUP_ERROR_CODES.INVALID_ARGUMENT); }
  return value;
}

async function defaultSha256Hex(text) {
  if(typeof text!=="string"||!globalThis.crypto?.subtle?.digest) fail(BACKUP_ERROR_CODES.INTEGRITY_MISMATCH);
  const bytes=new TextEncoder().encode(text);
  let digest;
  try { digest=new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",bytes)); }
  catch { fail(BACKUP_ERROR_CODES.INTEGRITY_MISMATCH); }
  return [...digest].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

function stateOf(record) {
  return record?.value?.state;
}

export function createBackupRestoreService({
  storageBroker,
  recoveryHold,
  remoteOps,
  providerGate,
  moduleRuntime,
  reconciliationChecks,
  clock=()=>new Date().toISOString(),
  sha256Hex=defaultSha256Hex
}={}) {
  if(!storageBroker?.admin) throw new TypeError("Backup service requires privileged PCMS storage administration");
  const storage=snapshotMethods(storageBroker.admin,["snapshotRecords","validateRecords","replaceAllRecords"],"Storage administration");
  const hold=snapshotMethods(recoveryHold,["getStatus","enterRecoveryHold","releaseRecoveryHold"],"Recovery hold");
  const ops=snapshotMethods(remoteOps,["listUnresolved","recoverInterruptedDispatches","cancel"],"RemoteOps");
  const gate=snapshotMethods(providerGate,["reconcile"],"ProviderGate");
  const runtime=snapshotMethods(moduleRuntime,["listStates","prepareUpdate","recoverAll"],"Module runtime");
  const checks=snapshotMethods(reconciliationChecks,["personaBindings","providerCapabilities"],"Recovery reconciliation checks");
  if(typeof clock!=="function"||typeof sha256Hex!=="function") throw new TypeError("Backup service clock/hash is invalid");

  async function digestPayload(payload) {
    const digest=await sha256Hex(JSON.stringify(payload));
    if(typeof digest!=="string"||!/^[a-f0-9]{64}$/.test(digest)) fail(BACKUP_ERROR_CODES.INTEGRITY_MISMATCH);
    return digest;
  }

  async function normalizeAndVerifyBackup(raw) {
    const normalized=normalizeBackupEnvelope(raw,storage.validateRecords);
    const actual=await digestPayload(backupDigestPayload(normalized));
    if(actual!==normalized.sha256) fail(BACKUP_ERROR_CODES.INTEGRITY_MISMATCH);
    assertNoCredentialValues(normalized.records);
    return normalized;
  }

  async function previewDigestOf(backup) {
    const digest=await sha256Hex(restorePreviewBinding(backup));
    if(typeof digest!=="string"||!/^[a-f0-9]{64}$/.test(digest)) fail(BACKUP_ERROR_CODES.INTEGRITY_MISMATCH);
    return digest;
  }

  async function createBackup({backupId}={}) {
    const id=normalizeBackupId(backupId);
    const all=await storage.snapshotRecords();
    const records=storage.validateRecords(all.filter((record)=>!PCMS_BACKUP_EXCLUDED_NAMESPACES.includes(record.namespace)));
    if(records.length>PCMS_BACKUP_MAX_RECORDS) fail(BACKUP_ERROR_CODES.CAPACITY);
    assertNoCredentialValues(records);
    const payload=Object.freeze({
      schemaVersion:PCMS_BACKUP_SCHEMA_VERSION,
      kind:PCMS_BACKUP_KIND,
      backupId:id,
      createdAt:isoNow(clock),
      recordCount:records.length,
      records
    });
    const sha256=await digestPayload(payload);
    return Object.freeze({...payload,sha256});
  }

  // Read-only: verifies the backup and previews it against current data. Nothing changes.
  async function stageRestore(rawBackup) {
    const backup=await normalizeAndVerifyBackup(rawBackup);
    const stagedAt=isoNow(clock);
    const preview=buildRestorePreview({
      backup,
      currentRecords:await storage.snapshotRecords(),
      previewDigest:await previewDigestOf(backup),
      previewedAt:stagedAt
    });
    return Object.freeze({
      schemaVersion:PCMS_BACKUP_SCHEMA_VERSION,
      kind:PCMS_STAGED_RESTORE_KIND,
      stagedAt,
      backup,
      preview
    });
  }

  // A041-01: a restore starts only from a staged preview the operator confirmed by typing
  // RESTORE. Core recomputes the preview digest from the verified backup and rejects a
  // confirmation for any other backup, a forged digest, or a preview that has expired.
  async function verifyStage(rawStage) {
    const stage=normalizeStagedRestore(rawStage,(backup)=>normalizeBackupEnvelope(backup,storage.validateRecords),{requireConfirmation:true});
    const backup=await normalizeAndVerifyBackup(stage.backup);
    if(await previewDigestOf(backup)!==stage.previewDigest) fail(BACKUP_ERROR_CODES.PREVIEW_MISMATCH);
    const age=Date.parse(isoNow(clock))-Date.parse(stage.stagedAt);
    if(!Number.isFinite(age)||age<-5*60*1000||age>PCMS_RESTORE_PREVIEW_TTL_MS) fail(BACKUP_ERROR_CODES.PREVIEW_MISMATCH);
    return Object.freeze({...stage,backup});
  }

  async function quiesceRuntimes() {
    const states=await runtime.listStates();
    if(!Array.isArray(states)) fail(BACKUP_ERROR_CODES.RESTORE_STATE);
    const quiesced=[];
    for(const row of states) {
      const state=stateOf(row);
      if(state==="ACTIVE"||state==="DRAINING") {
        await runtime.prepareUpdate(row.moduleId,{expectedRevision:row.revision});
        quiesced.push(row.moduleId);
      } else if(state!=="IDLE"&&state!=="DISABLED") {
        fail(BACKUP_ERROR_CODES.RESTORE_STATE);
      }
    }
    return Object.freeze(quiesced.sort());
  }

  async function applyStagedRestore(rawStage) {
    const stage=await verifyStage(rawStage);
    const entered=await hold.enterRecoveryHold({reason:"restore:"+stage.backup.backupId});
    if(stateOf(entered?.hold)!=="RECOVERY_HOLD") fail(BACKUP_ERROR_CODES.RESTORE_STATE);

    const quiescedModuleIds=await quiesceRuntimes();
    const current=await storage.snapshotRecords();
    const preserved=current.filter((record)=>PCMS_BACKUP_EXCLUDED_NAMESPACES.includes(record.namespace));
    const replacement=storage.validateRecords([...stage.backup.records,...preserved]);
    await storage.replaceAllRecords(replacement);

    const recoveredModuleIds=await runtime.recoverAll();
    const recoveredOperationIds=await ops.recoverInterruptedDispatches();
    const currentHold=await hold.getStatus();
    if(stateOf(currentHold)!=="RECOVERY_HOLD") fail(BACKUP_ERROR_CODES.RESTORE_STATE);

    return Object.freeze({
      backupId:stage.backup.backupId,
      holdRevision:currentHold.revision,
      quiescedModuleIds:Object.freeze([...quiescedModuleIds]),
      recoveredModuleIds:Object.freeze([...recoveredModuleIds]),
      recoveredOperationIds:Object.freeze([...recoveredOperationIds])
    });
  }

  async function reconcileRemoteOperations() {
    await ops.recoverInterruptedDispatches();
    const before=await ops.listUnresolved();
    for(const row of before) {
      const id=row?.value?.operationId;
      const state=stateOf(row);
      if(typeof id!=="string") fail(BACKUP_ERROR_CODES.RESTORE_STATE);
      if(state==="PREPARED"||state==="RETRYABLE") {
        await ops.cancel(id,{expectedRevision:row.revision});
        continue;
      }
      if(state==="UNCERTAIN") {
        try {
          const reconciled=await gate.reconcile(id);
          if(stateOf(reconciled)==="RETRYABLE") {
            await ops.cancel(id,{expectedRevision:reconciled.revision});
          }
        } catch {}
      }
    }
    return ops.listUnresolved();
  }

  async function safeBooleanCheck(fn) {
    try { return (await fn())===true; }
    catch { return false; }
  }

  function holdView(status) {
    return Object.freeze({
      state:stateOf(status),
      reason:status?.value?.reason??null,
      enteredAt:status?.value?.enteredAt??null,
      revision:status?.revision??0
    });
  }

  function operationItem(row) {
    const value=row.value;
    const target=value.targetRef&&typeof value.targetRef.kind==="string"&&typeof value.targetRef.id==="string"
      ?Object.freeze({kind:value.targetRef.kind,id:value.targetRef.id})
      :Object.freeze({kind:"operation",id:value.operationId});
    return Object.freeze({
      id:"operation:"+value.operationId,
      kind:"operation",
      label:(typeof value.action==="string"?value.action:"operation")+" · "+target.kind+" "+target.id,
      status:"FAIL",
      state:value.state,
      detail:value.state==="UNCERTAIN"
        ?"Outcome unknown — check with the provider before anything else changes."
        :value.state==="DISPATCHING"
          ?"Was being sent when PCMS stopped — check its outcome."
          :"Prepared but never confirmed — checking cancels it.",
      operationId:value.operationId,
      providerId:typeof value.providerId==="string"?value.providerId:null,
      subject:target,
      reconcilable:true
    });
  }

  // T041.2: every check that must pass before the hold can be released, one row per subject.
  // Read-only; a failing row always names the subject it is about (A041-02).
  async function recoveryChecklist() {
    const status=await hold.getStatus();
    const held=stateOf(status)==="RECOVERY_HOLD";
    const items=[];
    const states=await runtime.listStates();
    const busy=Array.isArray(states)?states.filter((row)=>!["IDLE","DISABLED"].includes(stateOf(row))):null;
    items.push(Object.freeze({
      id:"check:moduleGenerations",kind:"check",label:"Module versions match",
      status:busy&&busy.length===0?"PASS":"FAIL",
      detail:busy===null?"Module runtime state could not be read.":busy.length?busy.length+" module(s) still running from before the restore.":null,
      subject:Object.freeze({kind:"settings",id:"modules"}),reconcilable:false
    }));
    for(const row of busy||[]) {
      items.push(Object.freeze({
        id:"module:"+row.moduleId,kind:"module",label:"Module "+row.moduleId+" is still running",
        status:"FAIL",state:stateOf(row),detail:"Stop or disable it in Settings → Modules, then check again.",
        subject:Object.freeze({kind:"module",id:row.moduleId}),reconcilable:false
      }));
    }
    const bindings=await safeBooleanCheck(checks.personaBindings);
    items.push(Object.freeze({
      id:"check:personaBindings",kind:"check",label:"Account ↔ Persona bindings resolved",
      status:bindings?"PASS":"FAIL",
      detail:bindings?null:"One or more accounts point at a missing or changed Persona.",
      subject:Object.freeze({kind:"accounts",id:null}),reconcilable:false
    }));
    const provider=await safeBooleanCheck(checks.providerCapabilities);
    items.push(Object.freeze({
      id:"check:providerCapabilities",kind:"check",label:"Provider compatibility confirmed",
      status:provider?"PASS":"FAIL",
      detail:provider?null:"A provider compatibility probe failed.",
      subject:Object.freeze({kind:"settings",id:"diagnostics"}),reconcilable:false
    }));
    const unresolved=await ops.listUnresolved();
    items.push(Object.freeze({
      id:"check:remoteOperations",kind:"check",label:"Pending operations checked",
      status:unresolved.length?"FAIL":"PASS",
      detail:unresolved.length?unresolved.length+" operation(s) need checking.":null,
      subject:Object.freeze({kind:"attention",id:null}),reconcilable:false
    }));
    for(const row of unresolved) items.push(operationItem(row));
    const failing=items.filter((item)=>item.status!=="PASS").length;
    return Object.freeze({
      hold:holdView(status),
      items:Object.freeze(items),
      failing,
      releasable:held&&failing===0
    });
  }

  // T041.2 per-item reconciliation: settles exactly one pending operation while on hold.
  // Never dispatches: a prepared/retryable operation is cancelled, an uncertain one is
  // reconciled through the provider gate (an unknown answer stays uncertain).
  async function reconcileOperation(operationId) {
    if(typeof operationId!=="string"||operationId.length<1||operationId.length>256) fail(BACKUP_ERROR_CODES.INVALID_ARGUMENT);
    if(stateOf(await hold.getStatus())!=="RECOVERY_HOLD") fail(BACKUP_ERROR_CODES.NOT_HELD);
    await ops.recoverInterruptedDispatches();
    const find=async()=>(await ops.listUnresolved()).find((row)=>row?.value?.operationId===operationId)||null;
    const row=await find();
    if(!row) fail(BACKUP_ERROR_CODES.OPERATION_NOT_FOUND);
    const state=stateOf(row);
    if(state==="PREPARED"||state==="RETRYABLE") {
      await ops.cancel(operationId,{expectedRevision:row.revision});
    } else if(state==="UNCERTAIN") {
      const reconciled=await gate.reconcile(operationId);
      if(stateOf(reconciled)==="RETRYABLE") await ops.cancel(operationId,{expectedRevision:reconciled.revision});
    }
    const after=await find();
    return Object.freeze({
      operationId,
      resolved:after===null,
      state:after?stateOf(after):null
    });
  }

  async function reconcileAndRelease() {
    const currentHold=await hold.getStatus();
    if(stateOf(currentHold)!=="RECOVERY_HOLD") fail(BACKUP_ERROR_CODES.RESTORE_STATE);

    await runtime.recoverAll();
    const remaining=await reconcileRemoteOperations();
    const states=await runtime.listStates();
    const moduleGenerations=Array.isArray(states)&&states.every((row)=>["IDLE","DISABLED"].includes(stateOf(row)));
    const personaBindings=await safeBooleanCheck(checks.personaBindings);
    const providerCapabilities=await safeBooleanCheck(checks.providerCapabilities);

    const reconciliation=Object.freeze({moduleGenerations,personaBindings,providerCapabilities});
    if(remaining.length||!moduleGenerations||!personaBindings||!providerCapabilities) {
      return Object.freeze({
        released:false,
        reconciliation,
        unresolvedOperationIds:Object.freeze(remaining.map((row)=>row.value.operationId).sort())
      });
    }

    const latest=await hold.getStatus();
    if(stateOf(latest)!=="RECOVERY_HOLD") fail(BACKUP_ERROR_CODES.RESTORE_STATE);
    const released=await hold.releaseRecoveryHold({expectedRevision:latest.revision,checks:reconciliation});
    return Object.freeze({released:true,reconciliation,unresolvedOperationIds:Object.freeze([]),hold:released});
  }

  return Object.freeze({
    createBackup,
    stageRestore,
    applyStagedRestore,
    reconcileAndRelease,
    recoveryChecklist,
    reconcileOperation,
    planRetention:planBackupRetention
  });
}
