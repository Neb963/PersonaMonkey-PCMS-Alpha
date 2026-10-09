import { PROVISIONING_ERROR_CODES, provisioningError } from "./errors.js";
import {
  PROVISIONING_HUMAN_REASONS,
  PROVISIONING_MAX_ATTEMPTS,
  PROVISIONING_PROVIDER_ID,
  PROVISIONING_REMOTE_ACTION,
  PROVISIONING_REMOTE_TARGET_KIND,
  PROVISIONING_STATES,
  newAttempt,
  normalizeAttempt,
  normalizeAttemptId,
  provisioningHumanTaskId,
  provisioningIntentFingerprint,
  provisioningOperationId
} from "./schema.js";

const REMOTE_STATES = new Set(["PREPARED", "DISPATCHING", "UNCERTAIN", "RETRYABLE", "SUCCEEDED", "FAILED", "CANCELLED"]);
const HUMAN_STATES = new Set(["OPEN", "RESOLVED", "CANCELLED"]);

function fail(code, options = {}) { throw provisioningError(code, options); }
function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function snapshotMethods(value, names, label) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) throw new TypeError(label + " is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!names.every((name) => Object.hasOwn(descriptors, name)
        && descriptors[name].enumerable
        && Object.hasOwn(descriptors[name], "value")
        && typeof descriptors[name].value === "function")) throw new TypeError(label + " is invalid");
  return Object.freeze(Object.fromEntries(names.map((name) => [name, descriptors[name].value])));
}
function isoNow(clock) {
  let value;
  try { value = new Date(clock()).toISOString(); } catch { fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE); }
  return value;
}
function publicRecord(record, attemptId) {
  if (record === null) return null;
  if (!plain(record) || Object.getOwnPropertySymbols(record).length) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if (Object.keys(descriptors).length !== 2 || !Object.hasOwn(descriptors, "revision") || !Object.hasOwn(descriptors, "value")
      || !descriptors.revision.enumerable || !descriptors.value.enumerable
      || !Object.hasOwn(descriptors.revision, "value") || !Object.hasOwn(descriptors.value, "value")
      || !Number.isSafeInteger(descriptors.revision.value) || descriptors.revision.value < 1) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
  const value = normalizeAttempt(descriptors.value.value);
  if (value.attemptId !== attemptId) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({ revision: descriptors.revision.value, value });
}
function normalizeSession(raw) {
  if (!plain(raw) || Object.getOwnPropertySymbols(raw).length) fail(PROVISIONING_ERROR_CODES.SESSION_UNAVAILABLE);
  const d = Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(d).length !== 2 || !Object.hasOwn(d, "sessionKey") || !Object.hasOwn(d, "generation")
      || !Object.hasOwn(d.sessionKey, "value") || !Object.hasOwn(d.generation, "value")
      || typeof d.sessionKey.value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(d.sessionKey.value)
      || !Number.isSafeInteger(d.generation.value) || d.generation.value < 1) fail(PROVISIONING_ERROR_CODES.SESSION_UNAVAILABLE);
  return Object.freeze({ sessionKey:d.sessionKey.value, generation:d.generation.value });
}
function normalizeSessionValidation(raw) {
  if (!plain(raw) || Object.getOwnPropertySymbols(raw).length) fail(PROVISIONING_ERROR_CODES.SESSION_UNAVAILABLE);
  const d=Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(d).length !== 2 || !Object.hasOwn(d,"active") || !Object.hasOwn(d,"handle")
      || !Object.hasOwn(d.active,"value") || !Object.hasOwn(d.handle,"value") || typeof d.active.value !== "boolean") {
    fail(PROVISIONING_ERROR_CODES.SESSION_UNAVAILABLE);
  }
  if ((d.active.value && (d.handle.value === null || d.handle.value === undefined))
      || (!d.active.value && d.handle.value !== null)) fail(PROVISIONING_ERROR_CODES.SESSION_UNAVAILABLE);
  return Object.freeze({active:d.active.value,handle:d.handle.value});
}
function normalizePreflight(raw) {
  if (!plain(raw) || Object.getOwnPropertySymbols(raw).length) fail(PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  const d=Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(d).length !== 2 || !Object.hasOwn(d,"status") || !Object.hasOwn(d,"reason")
      || !Object.hasOwn(d.status,"value") || !Object.hasOwn(d.reason,"value")) fail(PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  const status=d.status.value, reason=d.reason.value;
  if (status === "READY" && reason === null) return Object.freeze({status,reason});
  if (status === "HUMAN_REQUIRED" && Object.values(PROVISIONING_HUMAN_REASONS).includes(reason)) return Object.freeze({status,reason});
  fail(PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
}
function normalizeRemoteRecord(raw, attempt) {
  if (raw === null) return null;
  if (!plain(raw) || Object.getOwnPropertySymbols(raw).length) fail(PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  const d=Object.getOwnPropertyDescriptors(raw);
  const names=["key","revision","updatedAt","value"];
  if(Object.keys(d).length!==names.length || !names.every((name)=>Object.hasOwn(d,name) && d[name].enumerable && Object.hasOwn(d[name],"value"))
      || !Number.isSafeInteger(d.revision.value) || d.revision.value < 1 || !plain(d.value.value)) fail(PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  const value=d.value.value;
  if (value.operationId !== attempt.remoteOperationId || value.providerId !== PROVISIONING_PROVIDER_ID || value.action !== PROVISIONING_REMOTE_ACTION
      || !plain(value.targetRef) || value.targetRef.kind !== PROVISIONING_REMOTE_TARGET_KIND || value.targetRef.id !== attempt.accountId
      || value.intentFingerprint !== provisioningIntentFingerprint(attempt.attemptId, attempt.operationEpoch)
      || !REMOTE_STATES.has(value.state)) {
    fail(PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  }
  return raw;
}
function humanTaskMeta(reason) {
  if (reason === PROVISIONING_HUMAN_REASONS.CAPTCHA) return Object.freeze({
    taskKind:"operator.captcha",
    title:"Complete provider CAPTCHA",
    instructions:"Use only the active guarded provisioning session. Resolve this task after the CAPTCHA is completed.",
    priority:"CRITICAL"
  });
  return Object.freeze({
    taskKind:"operator.provisioning-action",
    title:"Complete provider provisioning action",
    instructions:"Use only the active guarded provisioning session. Resolve this task after the requested provider action is completed.",
    priority:"HIGH"
  });
}

export function createProvisioningService({ attemptStore, accounts, humanTasks, sessionGuard, providerSession, remoteControl, clock = () => new Date().toISOString() } = {}) {
  const store=snapshotMethods(attemptStore,["get","list","compareAndSwap"],"Provisioning attempt store");
  const accountApi=snapshotMethods(accounts,["getAccount","listAccounts","createAccount"],"Accounts service");
  const tasks=snapshotMethods(humanTasks,["open","get","cancel"],"HumanTask service");
  const sessions=snapshotMethods(sessionGuard,["acquire","validate","release"],"Provisioning session guard");
  const provider=snapshotMethods(providerSession,["preflight"],"Provisioning provider session");
  const remote=snapshotMethods(remoteControl,["mutate","reconcile","get"],"Provisioning remote control");
  if(typeof clock!=="function") throw new TypeError("Provisioning clock must be a function");

  async function getAttempt(rawAttemptId) {
    const attemptId=normalizeAttemptId(rawAttemptId);
    let row;
    try { row=await store.get(attemptId); } catch { fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE); }
    return publicRecord(row,attemptId);
  }
  async function requireAttempt(attemptId) {
    const row=await getAttempt(attemptId); if(!row) fail(PROVISIONING_ERROR_CODES.NOT_FOUND); return row;
  }
  async function save(current,next) {
    const value=normalizeAttempt({...next,updatedAt:isoNow(clock)});
    let result;
    try { result=await store.compareAndSwap(Object.freeze({attemptId:value.attemptId,expectedRevision:current.revision,value})); }
    catch { fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE); }
    if (!plain(result) || Object.getOwnPropertySymbols(result).length) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
    if (result.ok === false) fail(PROVISIONING_ERROR_CODES.REVISION_CONFLICT,{currentRevision:result.currentRevision});
    if (result.ok !== true || !Number.isSafeInteger(result.revision) || result.revision < 1) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
    return publicRecord({revision:result.revision,value:result.value},value.attemptId);
  }
  async function listAttempts() {
    let rows; try { rows=await store.list(); } catch { fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE); }
    if(!Array.isArray(rows) || rows.length>PROVISIONING_MAX_ATTEMPTS) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
    const out=[];
    for(const row of rows){
      if(!plain(row) || !plain(row.value)) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
      out.push(publicRecord({revision:row.revision,value:row.value},normalizeAttempt(row.value).attemptId));
    }
    out.sort((a,b)=>a.value.attemptId.localeCompare(b.value.attemptId));
    return Object.freeze(out);
  }

  async function assertAccountAvailable(input) {
    const existing=await accountApi.getAccount(input.accountId);
    if(existing) fail(PROVISIONING_ERROR_CODES.ACCOUNT_CONFLICT);
    const listed=await accountApi.listAccounts();
    if(!plain(listed) || !Array.isArray(listed.accounts) || !Number.isSafeInteger(listed.revision) || listed.revision<0) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
    if(listed.accounts.some((account)=>account?.personaUid===input.personaUid)) fail(PROVISIONING_ERROR_CODES.PERSONA_CONFLICT);
  }

  async function createAttempt(input,{expectedRevision=0}={}) {
    if(expectedRevision!==0) fail(PROVISIONING_ERROR_CODES.REVISION_CONFLICT);
    const draft=newAttempt(input,isoNow(clock));
    if((await listAttempts()).length>=PROVISIONING_MAX_ATTEMPTS) fail(PROVISIONING_ERROR_CODES.CAPACITY);
    const existingAttempt=await getAttempt(draft.attemptId);
    if(existingAttempt) fail(PROVISIONING_ERROR_CODES.REVISION_CONFLICT,{currentRevision:existingAttempt.revision});
    await assertAccountAvailable(draft);
    let result;
    try { result=await store.compareAndSwap(Object.freeze({attemptId:draft.attemptId,expectedRevision:0,value:draft})); }
    catch { fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE); }
    if(result?.ok===false) fail(PROVISIONING_ERROR_CODES.REVISION_CONFLICT,{currentRevision:result.currentRevision});
    if(result?.ok!==true) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
    return publicRecord({revision:result.revision,value:result.value},draft.attemptId);
  }

  async function validateSession(attempt) {
    if(attempt.sessionKey===null) return Object.freeze({active:false,handle:null});
    try {
      return normalizeSessionValidation(await sessions.validate(Object.freeze({
        attemptId:attempt.attemptId,personaUid:attempt.personaUid,sessionKey:attempt.sessionKey,generation:attempt.sessionGeneration
      })));
    } catch { return Object.freeze({active:false,handle:null}); }
  }
  async function releaseSession(attempt) {
    if(attempt.sessionKey===null) return;
    try { await sessions.release(Object.freeze({attemptId:attempt.attemptId,personaUid:attempt.personaUid,sessionKey:attempt.sessionKey,generation:attempt.sessionGeneration})); } catch {}
  }
  function clearSession(attempt,state=PROVISIONING_STATES.SESSION_REQUIRED) {
    return {...attempt,state,sessionKey:null,sessionGeneration:null,humanTaskId:null,humanReason:null,completedAt:null};
  }

  async function acquireSession(rawAttemptId,{expectedRevision}={}) {
    const attemptId=normalizeAttemptId(rawAttemptId); const expected=expectedRevision===undefined?null:expectedRevision;
    const current=await requireAttempt(attemptId);
    if(expected!==null && current.revision!==expectedRevision) fail(PROVISIONING_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.state!==PROVISIONING_STATES.SESSION_REQUIRED) fail(PROVISIONING_ERROR_CODES.INVALID_TRANSITION);
    let acquired;
    try { acquired=normalizeSession(await sessions.acquire(Object.freeze({attemptId,personaUid:current.value.personaUid,sessionEpoch:current.value.sessionEpoch+1}))); }
    catch { fail(PROVISIONING_ERROR_CODES.SESSION_UNAVAILABLE); }
    try {
      return await save(current,{...current.value,state:PROVISIONING_STATES.SESSION_ACTIVE,sessionEpoch:current.value.sessionEpoch+1,sessionKey:acquired.sessionKey,sessionGeneration:acquired.generation});
    } catch(error) {
      try { await sessions.release(Object.freeze({attemptId,personaUid:current.value.personaUid,sessionKey:acquired.sessionKey,generation:acquired.generation})); } catch {}
      throw error;
    }
  }

  async function ensureHumanTask(attempt) {
    const meta=humanTaskMeta(attempt.humanReason);
    let existing;
    try { existing=await tasks.get(attempt.humanTaskId); } catch { fail(PROVISIONING_ERROR_CODES.HUMAN_TASK_CONFLICT); }
    if(existing){
      const v=existing.value;
      if(!v || v.taskId!==attempt.humanTaskId || v.taskKind!==meta.taskKind || !HUMAN_STATES.has(v.state)
          || v.subjectRef?.kind!=="provisioning-attempt" || v.subjectRef?.id!==attempt.attemptId) fail(PROVISIONING_ERROR_CODES.HUMAN_TASK_CONFLICT);
      return existing;
    }
    try {
      return await tasks.open(Object.freeze({taskId:attempt.humanTaskId,taskKind:meta.taskKind,title:meta.title,instructions:meta.instructions,priority:meta.priority,subjectRef:Object.freeze({kind:"provisioning-attempt",id:attempt.attemptId})}));
    } catch { fail(PROVISIONING_ERROR_CODES.HUMAN_TASK_CONFLICT); }
  }

  function operationDraft(attempt) {
    return Object.freeze({
      operationId:attempt.remoteOperationId,
      providerId:PROVISIONING_PROVIDER_ID,
      action:PROVISIONING_REMOTE_ACTION,
      targetRef:Object.freeze({kind:PROVISIONING_REMOTE_TARGET_KIND,id:attempt.accountId}),
      intentFingerprint:provisioningIntentFingerprint(attempt.attemptId,attempt.operationEpoch)
    });
  }
  async function inspectRemote(attempt) {
    if(attempt.remoteOperationId===null) return Object.freeze({kind:"ABSENT",record:null});
    let raw; try { raw=await remote.get(attempt.remoteOperationId); } catch { return Object.freeze({kind:"UNKNOWN",record:null}); }
    const record=normalizeRemoteRecord(raw,attempt);
    if(!record) return Object.freeze({kind:"ABSENT",record:null});
    const state=record.value.state;
    if(state==="SUCCEEDED") return Object.freeze({kind:"APPLIED",record});
    if(state==="PREPARED" || state==="RETRYABLE") return Object.freeze({kind:"REUSABLE",record});
    if(state==="FAILED" || state==="CANCELLED") return Object.freeze({kind:"PROVEN_NOT_APPLIED",record});
    return Object.freeze({kind:"UNKNOWN",record});
  }

  async function finalizeAccount(current) {
    const attempt=current.value;
    const existing=await accountApi.getAccount(attempt.accountId);
    if(existing){
      if(existing.personaUid!==attempt.personaUid || existing.displayName!==attempt.displayName || existing.providerId!==PROVISIONING_PROVIDER_ID) {
        fail(PROVISIONING_ERROR_CODES.ACCOUNT_CONFLICT);
      }
    } else {
      const listed=await accountApi.listAccounts();
      if(!plain(listed) || !Number.isSafeInteger(listed.revision) || listed.revision<0) fail(PROVISIONING_ERROR_CODES.CORRUPT_STATE);
      try {
        await accountApi.createAccount(Object.freeze({accountId:attempt.accountId,displayName:attempt.displayName,personaUid:attempt.personaUid}),Object.freeze({expectedRevision:listed.revision}));
      } catch(error) {
        const raced=await accountApi.getAccount(attempt.accountId);
        if(!raced || raced.personaUid!==attempt.personaUid || raced.displayName!==attempt.displayName || raced.providerId!==PROVISIONING_PROVIDER_ID) throw error;
      }
    }
    const completedAt=isoNow(clock);
    const saved=await save(current,{...attempt,state:PROVISIONING_STATES.COMPLETED,sessionKey:null,sessionGeneration:null,humanTaskId:null,humanReason:null,completedAt});
    await releaseSession(attempt);
    return saved;
  }

  async function recoverProvisioning(current) {
    const inspected=await inspectRemote(current.value);
    if(["ABSENT","REUSABLE","PROVEN_NOT_APPLIED"].includes(inspected.kind)) return save(current,{...current.value,state:PROVISIONING_STATES.RETRYABLE});
    if(inspected.kind==="APPLIED") {
      const next=await save(current,{...current.value,state:PROVISIONING_STATES.FINALIZING});
      return finalizeAccount(next);
    }
    return save(current,{...current.value,state:PROVISIONING_STATES.UNCERTAIN});
  }

  async function dispatchProvisioning(current, sessionHandle) {
    const attempt=current.value;
    let operationEpoch=attempt.operationEpoch;
    let remoteOperationId=attempt.remoteOperationId;
    if(remoteOperationId!==null){
      const inspected=await inspectRemote(attempt);
      if(inspected.kind==="APPLIED") {
        const next=await save(current,{...attempt,state:PROVISIONING_STATES.FINALIZING});
        return finalizeAccount(next);
      }
      if(inspected.kind==="UNKNOWN") return save(current,{...attempt,state:PROVISIONING_STATES.UNCERTAIN});
      if(inspected.kind==="PROVEN_NOT_APPLIED") {
        operationEpoch+=1;
        remoteOperationId=provisioningOperationId(attempt.attemptId,operationEpoch);
      }
    } else {
      operationEpoch=1;
      remoteOperationId=provisioningOperationId(attempt.attemptId,operationEpoch);
    }
    let progress=await save(current,{...attempt,state:PROVISIONING_STATES.PROVISIONING,operationEpoch,remoteOperationId});
    let outcome;
    try {
      outcome=await remote.mutate(Object.freeze({
        operation:operationDraft(progress.value),
        dispatchInput:Object.freeze({
          attemptId:progress.value.attemptId,
          accountId:progress.value.accountId,
          personaUid:progress.value.personaUid,
          credentialRef:progress.value.credentialRef,
          sessionHandle
        })
      }));
    } catch {
      return recoverProvisioning(progress);
    }
    if(!plain(outcome) || !["APPLIED","ALREADY_APPLIED","NOT_APPLIED"].includes(outcome.status)) return recoverProvisioning(progress);
    const settled=await inspectRemote(progress.value);
    if(outcome.status==="NOT_APPLIED") {
      if(settled.kind!=="PROVEN_NOT_APPLIED") return recoverProvisioning(progress);
      return save(progress,{...progress.value,state:PROVISIONING_STATES.RETRYABLE});
    }
    if(settled.kind!=="APPLIED") return recoverProvisioning(progress);
    progress=await save(progress,{...progress.value,state:PROVISIONING_STATES.FINALIZING});
    return finalizeAccount(progress);
  }

  async function advance(rawAttemptId,{expectedRevision}={}) {
    const attemptId=normalizeAttemptId(rawAttemptId); let current=await requireAttempt(attemptId);
    if(expectedRevision!==undefined && current.revision!==expectedRevision) fail(PROVISIONING_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    const state=current.value.state;
    if(state===PROVISIONING_STATES.UNCERTAIN) fail(PROVISIONING_ERROR_CODES.RECONCILE_REQUIRED);
    if(state===PROVISIONING_STATES.COMPLETED || state===PROVISIONING_STATES.CANCELLED) return current;
    if(state===PROVISIONING_STATES.SESSION_REQUIRED) fail(PROVISIONING_ERROR_CODES.INVALID_TRANSITION);
    if(state===PROVISIONING_STATES.PROVISIONING) return recoverProvisioning(current);
    if(state===PROVISIONING_STATES.FINALIZING) return finalizeAccount(current);

    if(state===PROVISIONING_STATES.WAITING_HUMAN){
      const task=await ensureHumanTask(current.value);
      if(task.value.state==="OPEN") return current;
      if(task.value.state==="CANCELLED"){
        const completedAt=isoNow(clock); const saved=await save(current,{...current.value,state:PROVISIONING_STATES.CANCELLED,sessionKey:null,sessionGeneration:null,humanTaskId:null,humanReason:null,completedAt});
        await releaseSession(current.value); return saved;
      }
      const session=await validateSession(current.value);
      if(!session.active){ const saved=await save(current,clearSession(current.value)); await releaseSession(current.value); return saved; }
      return save(current,{...current.value,state:PROVISIONING_STATES.SESSION_ACTIVE,humanTaskId:null,humanReason:null});
    }

    if(state===PROVISIONING_STATES.RETRYABLE){
      const session=await validateSession(current.value);
      if(!session.active){ const saved=await save(current,clearSession(current.value)); await releaseSession(current.value); return saved; }
      return save(current,{...current.value,state:PROVISIONING_STATES.SESSION_ACTIVE});
    }

    const session=await validateSession(current.value);
    if(!session.active){ const saved=await save(current,clearSession(current.value)); await releaseSession(current.value); return saved; }

    if(state===PROVISIONING_STATES.SESSION_ACTIVE){
      let preflight; try { preflight=normalizePreflight(await provider.preflight(Object.freeze({
        attemptId:current.value.attemptId,accountId:current.value.accountId,personaUid:current.value.personaUid,
        credentialRef:current.value.credentialRef,sessionHandle:session.handle
      }))); } catch(error) { if(error?.name==="PcmsProvisioningError") throw error; fail(PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL); }
      if(preflight.status==="READY") return save(current,{...current.value,state:PROVISIONING_STATES.READY_TO_PROVISION});
      const humanTaskEpoch=current.value.humanTaskEpoch+1;
      const humanTaskId=provisioningHumanTaskId(current.value.attemptId,humanTaskEpoch);
      const waiting=await save(current,{...current.value,state:PROVISIONING_STATES.WAITING_HUMAN,humanTaskEpoch,humanTaskId,humanReason:preflight.reason});
      await ensureHumanTask(waiting.value);
      return waiting;
    }

    if(state===PROVISIONING_STATES.READY_TO_PROVISION) return dispatchProvisioning(current,session.handle);
    fail(PROVISIONING_ERROR_CODES.INVALID_TRANSITION);
  }

  async function reconcileAttempt(rawAttemptId,{expectedRevision}={}) {
    const attemptId=normalizeAttemptId(rawAttemptId); let current=await requireAttempt(attemptId);
    if(expectedRevision!==undefined && current.revision!==expectedRevision) fail(PROVISIONING_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.state===PROVISIONING_STATES.PROVISIONING) current=await recoverProvisioning(current);
    if(current.value.state!==PROVISIONING_STATES.UNCERTAIN) fail(PROVISIONING_ERROR_CODES.INVALID_TRANSITION);
    let result; try { result=await remote.reconcile(current.value.remoteOperationId); } catch { return current; }
    const record=normalizeRemoteRecord(result,current.value);
    if(!record || ["DISPATCHING","UNCERTAIN"].includes(record.value.state)) return current;
    if(record.value.state==="SUCCEEDED"){
      const next=await save(current,{...current.value,state:PROVISIONING_STATES.FINALIZING});
      return finalizeAccount(next);
    }
    if(["RETRYABLE","FAILED","CANCELLED","PREPARED"].includes(record.value.state)) return save(current,{...current.value,state:PROVISIONING_STATES.RETRYABLE});
    fail(PROVISIONING_ERROR_CODES.REMOTE_PROTOCOL);
  }

  async function cancelAttempt(rawAttemptId,{expectedRevision}={}) {
    const attemptId=normalizeAttemptId(rawAttemptId); const current=await requireAttempt(attemptId);
    if(expectedRevision!==undefined && current.revision!==expectedRevision) fail(PROVISIONING_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(![PROVISIONING_STATES.SESSION_REQUIRED,PROVISIONING_STATES.SESSION_ACTIVE,PROVISIONING_STATES.WAITING_HUMAN,PROVISIONING_STATES.READY_TO_PROVISION,PROVISIONING_STATES.RETRYABLE].includes(current.value.state)) {
      fail(PROVISIONING_ERROR_CODES.INVALID_TRANSITION);
    }
    if(current.value.state===PROVISIONING_STATES.RETRYABLE && current.value.remoteOperationId!==null){
      const inspected=await inspectRemote(current.value);
      if(["REUSABLE","UNKNOWN","APPLIED"].includes(inspected.kind)) fail(PROVISIONING_ERROR_CODES.RECONCILE_REQUIRED);
    }
    if(current.value.state===PROVISIONING_STATES.WAITING_HUMAN){
      let task;
      try { task=await tasks.get(current.value.humanTaskId); } catch { fail(PROVISIONING_ERROR_CODES.HUMAN_TASK_CONFLICT); }
      if(!task || !task.value || !HUMAN_STATES.has(task.value.state)) fail(PROVISIONING_ERROR_CODES.HUMAN_TASK_CONFLICT);
      if(task.value.state==="OPEN") {
        try { await tasks.cancel(current.value.humanTaskId,{expectedRevision:task.revision,resolutionCode:"provisioning-cancelled"}); }
        catch { fail(PROVISIONING_ERROR_CODES.HUMAN_TASK_CONFLICT); }
      }
    }
    const completedAt=isoNow(clock);
    const saved=await save(current,{...current.value,state:PROVISIONING_STATES.CANCELLED,sessionKey:null,sessionGeneration:null,humanTaskId:null,humanReason:null,completedAt});
    await releaseSession(current.value);
    return saved;
  }

  async function recoverInterrupted() {
    const rows=await listAttempts(); const recovered=[];
    for(const row of rows){
      let next=row;
      if(row.value.state===PROVISIONING_STATES.PROVISIONING) next=await recoverProvisioning(row);
      else if(row.value.state===PROVISIONING_STATES.FINALIZING) next=await finalizeAccount(row);
      if(next.revision!==row.revision) recovered.push(next.value.attemptId);
    }
    return Object.freeze(recovered.sort());
  }

  return Object.freeze({createAttempt,getAttempt,listAttempts,acquireSession,advance,reconcileAttempt,cancelAttempt,recoverInterrupted});
}
