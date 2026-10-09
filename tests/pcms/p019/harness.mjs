import {
  PROVISIONING_PROVIDER_ID,
  PROVISIONING_REMOTE_ACTION,
  PROVISIONING_REMOTE_TARGET_KIND,
  provisioningIntentFingerprint
} from "../../../pcms-modules/p019/schema.js";

export const UID_A="11111111-1111-1111-1111-111111111111";
export const UID_B="22222222-2222-2222-2222-222222222222";
export const SECRET_REF="pcms-secret:v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const clone=(value)=>structuredClone(value);

export function makeClock(start="2026-10-05T12:00:00.000Z") {
  let tick=Date.parse(start);
  return ()=>new Date(tick++).toISOString();
}

export function makeAttemptStore() {
  const rows=new Map();
  return Object.freeze({
    api:Object.freeze({
      async get(id){ const row=rows.get(id); return row?clone(row):null; },
      async list(){ return [...rows.values()].map(clone); },
      async compareAndSwap({attemptId,expectedRevision,value}){
        const current=rows.get(attemptId); const revision=current?.revision||0;
        if(revision!==expectedRevision) return {ok:false,currentRevision:revision};
        const next={revision:revision+1,value:clone(value)};
        rows.set(attemptId,next);
        return {ok:true,revision:next.revision,value:clone(next.value)};
      }
    }),
    force(id,value){
      const current=rows.get(id); const revision=(current?.revision||0)+1;
      rows.set(id,{revision,value:clone(value)});
      return revision;
    },
    raw(id){ const row=rows.get(id); return row?clone(row):null; }
  });
}

export function makeAccounts() {
  const rows=[]; let revision=0; let createCalls=0;
  return Object.freeze({
    api:Object.freeze({
      async getAccount(accountId){ return clone(rows.find((x)=>x.accountId===accountId)||null); },
      async listAccounts(){ return {revision,accounts:clone(rows)}; },
      async createAccount(input,{expectedRevision}={}){
        createCalls+=1;
        if(expectedRevision!==revision) { const e=new Error("revision"); e.code="PCMS_ACCOUNTS_REVISION_CONFLICT"; throw e; }
        if(rows.some((x)=>x.accountId===input.accountId||x.personaUid===input.personaUid)) throw new Error("conflict");
        const account={...clone(input),providerId:PROVISIONING_PROVIDER_ID,bindingEpoch:1};
        rows.push(account); revision+=1;
        return {revision,account:clone(account)};
      },
      async rebindPersona(){ throw new Error("not used by provisioning"); },
      async reconcileBindings(){ return {revision,complete:true,bindings:[]}; }
    }),
    seed(account){ rows.push(clone(account)); revision+=1; },
    get createCalls(){ return createCalls; },
    get rows(){ return clone(rows); }
  });
}

export function makeHumanTasks() {
  const rows=new Map();
  return Object.freeze({
    api:Object.freeze({
      async open(input){
        if(rows.has(input.taskId)) throw new Error("duplicate");
        const row={revision:1,value:{...clone(input),state:"OPEN",resolutionCode:null}};
        rows.set(input.taskId,row); return clone(row);
      },
      async get(id){ const row=rows.get(id); return row?clone(row):null; },
      async cancel(id,{expectedRevision,resolutionCode}={}){
        const row=rows.get(id); if(!row||row.revision!==expectedRevision||row.value.state!=="OPEN") throw new Error("conflict");
        row.revision+=1; row.value.state="CANCELLED"; row.value.resolutionCode=resolutionCode; return clone(row);
      },
      async resolve(){ throw new Error("not used directly by provisioning"); },
      async listAttention(){ return []; }
    }),
    resolve(id,resolutionCode="completed"){
      const row=rows.get(id); if(!row||row.value.state!=="OPEN") throw new Error("not open");
      row.revision+=1; row.value.state="RESOLVED"; row.value.resolutionCode=resolutionCode;
    },
    raw(id){ const row=rows.get(id); return row?clone(row):null; }
  });
}

export function makeSessionGuard() {
  let sequence=0; const sessions=new Map(); let acquireCalls=0, releaseCalls=0;
  return Object.freeze({
    api:Object.freeze({
      async acquire({attemptId,personaUid,sessionEpoch}){
        acquireCalls+=1; sequence+=1;
        const sessionKey=`guard-${attemptId}-${sessionEpoch}-${sequence}`;
        const generation=sequence;
        sessions.set(sessionKey,{attemptId,personaUid,generation,active:true,handle:Object.freeze({opaque:`handle-${sequence}`})});
        return {sessionKey,generation};
      },
      async validate({attemptId,personaUid,sessionKey,generation}){
        const s=sessions.get(sessionKey);
        const active=Boolean(s&&s.active&&s.attemptId===attemptId&&s.personaUid===personaUid&&s.generation===generation);
        return {active,handle:active?s.handle:null};
      },
      async release({sessionKey,generation}){
        releaseCalls+=1; const s=sessions.get(sessionKey); if(s&&s.generation===generation) s.active=false;
        return {released:true};
      }
    }),
    invalidate(sessionKey){ const s=sessions.get(sessionKey); if(s) s.active=false; },
    get acquireCalls(){ return acquireCalls; },
    get releaseCalls(){ return releaseCalls; }
  });
}

export function makeProviderSession() {
  let outcome={status:"READY",reason:null}; const calls=[];
  return Object.freeze({
    api:Object.freeze({
      providerId:PROVISIONING_PROVIDER_ID,
      async probeCompatibility(){ return {providerId:PROVISIONING_PROVIDER_ID}; },
      async preflight(input){ calls.push(clone(input)); return clone(outcome); },
      providerDescriptor:Object.freeze({operations:Object.freeze({})})
    }),
    setReady(){ outcome={status:"READY",reason:null}; },
    requireHuman(reason="CAPTCHA"){ outcome={status:"HUMAN_REQUIRED",reason}; },
    get calls(){ return clone(calls); }
  });
}

function fullOperation(draft,state,{attempt=1,resolution=null}={}) {
  const now="2026-10-05T12:30:00.000Z";
  return {
    schemaVersion:1,kind:"remote-operation",...clone(draft),state,attempt,
    createdAt:now,updatedAt:now,lastDispatchAt:attempt?now:null,
    resolvedAt:["SUCCEEDED","FAILED","CANCELLED"].includes(state)?now:null,resolution
  };
}

export function makeRemoteControl() {
  const rows=new Map(); const events=[]; let mode="APPLIED", reconcileOutcome="APPLIED", mutateCalls=0;
  const put=(draft,state,options={})=>{
    const previous=rows.get(draft.operationId); const revision=(previous?.revision||0)+1;
    const value=fullOperation(draft,state,options);
    const row={key:`operation:${draft.operationId}`,revision,updatedAt:value.updatedAt,value}; rows.set(draft.operationId,row); return row;
  };
  return Object.freeze({
    api:Object.freeze({
      async mutate({operation,dispatchInput}){
        mutateCalls+=1;
        let row=rows.get(operation.operationId);
        if(!row){ events.push(`prepare:${operation.operationId}`); row=put(operation,"PREPARED",{attempt:0,resolution:null}); }
        if(mode==="THROW_PREPARED") throw new Error("before dispatch");
        events.push(`dispatch:${operation.operationId}`);
        row=put(operation,"DISPATCHING",{attempt:(row.value.attempt||0)+1,resolution:null});
        if(mode==="THROW_UNCERTAIN") { put(operation,"UNCERTAIN",{attempt:row.value.attempt,resolution:"AMBIGUOUS"}); throw new Error("ambiguous"); }
        if(mode==="MALFORMED_UNCERTAIN") { put(operation,"UNCERTAIN",{attempt:row.value.attempt,resolution:"AMBIGUOUS"}); return {status:"BROKEN"}; }
        if(mode==="NOT_APPLIED") { row=put(operation,"FAILED",{attempt:row.value.attempt,resolution:"NOT_APPLIED"}); return {operation:clone(row),status:"NOT_APPLIED"}; }
        row=put(operation,"SUCCEEDED",{attempt:row.value.attempt,resolution:"APPLIED"});
        return {operation:clone(row),status:"APPLIED",dispatchInput:clone(dispatchInput)};
      },
      async reconcile(operationId){
        const row=rows.get(operationId); if(!row||row.value.state!=="UNCERTAIN") throw new Error("not uncertain");
        const draft={operationId:row.value.operationId,providerId:row.value.providerId,action:row.value.action,targetRef:row.value.targetRef,intentFingerprint:row.value.intentFingerprint};
        if(reconcileOutcome==="UNKNOWN") return clone(put(draft,"UNCERTAIN",{attempt:row.value.attempt,resolution:"RECONCILED_UNKNOWN"}));
        if(reconcileOutcome==="NOT_APPLIED") return clone(put(draft,"RETRYABLE",{attempt:row.value.attempt,resolution:"RECONCILED_NOT_APPLIED"}));
        return clone(put(draft,"SUCCEEDED",{attempt:row.value.attempt,resolution:"RECONCILED_APPLIED"}));
      },
      async get(operationId){ const row=rows.get(operationId); return row?clone(row):null; },
      async list(){ return [...rows.values()].map(clone); }
    }),
    setMode(value){ mode=value; },
    setReconcile(value){ reconcileOutcome=value; },
    seedForAttempt(attempt,state,resolution="APPLIED"){
      const draft={operationId:attempt.remoteOperationId,providerId:PROVISIONING_PROVIDER_ID,action:PROVISIONING_REMOTE_ACTION,targetRef:{kind:PROVISIONING_REMOTE_TARGET_KIND,id:attempt.accountId},intentFingerprint:provisioningIntentFingerprint(attempt.attemptId,attempt.operationEpoch)};
      put(draft,state,{attempt:1,resolution});
    },
    get mutateCalls(){ return mutateCalls; },
    get events(){ return [...events]; },
    get rows(){ return new Map([...rows].map(([k,v])=>[k,clone(v)])); }
  });
}

export function attemptInput(overrides={}) {
  return {
    attemptId:"attempt-1",accountId:"account-1",displayName:"Account One",personaUid:UID_A,credentialRef:SECRET_REF,...overrides
  };
}
