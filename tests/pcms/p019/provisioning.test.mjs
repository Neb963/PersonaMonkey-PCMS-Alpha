import test from "node:test";
import assert from "node:assert/strict";
import { createProvisioningService } from "../../../pcms-modules/p019/provisioning.js";
import { PROVISIONING_ERROR_CODES } from "../../../pcms-modules/p019/errors.js";
import { PROVISIONING_STATES, provisioningOperationId } from "../../../pcms-modules/p019/schema.js";
import { attemptInput, makeAccounts, makeAttemptStore, makeClock, makeHumanTasks, makeProviderSession, makeRemoteControl, makeSessionGuard } from "./harness.mjs";

function fixture(){
  const store=makeAttemptStore(), accounts=makeAccounts(), human=makeHumanTasks(), sessions=makeSessionGuard(), provider=makeProviderSession(), remote=makeRemoteControl();
  const service=createProvisioningService({attemptStore:store.api,accounts:accounts.api,humanTasks:human.api,sessionGuard:sessions.api,providerSession:provider.api,remoteControl:remote.api,clock:makeClock()});
  return {store,accounts,human,sessions,provider,remote,service};
}
async function ready(f){
  let row=await f.service.createAttempt(attemptInput());
  assert.equal(row.value.state,PROVISIONING_STATES.SESSION_REQUIRED);
  row=await f.service.acquireSession("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.SESSION_ACTIVE);
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.READY_TO_PROVISION);
  return row;
}

test("A019-01: guarded happy path durably dispatches before idempotent Accounts finalization", async()=>{
  const f=fixture(); let row=await ready(f);
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.COMPLETED);
  assert.equal(row.value.operationEpoch,1);
  assert.equal(row.value.remoteOperationId,provisioningOperationId("attempt-1",1));
  assert.equal(f.remote.mutateCalls,1);
  assert.deepEqual(f.remote.events,["prepare:p019:attempt-1:op:1","dispatch:p019:attempt-1:op:1"]);
  assert.equal(f.accounts.createCalls,1);
  assert.deepEqual(f.accounts.rows.map(x=>({accountId:x.accountId,personaUid:x.personaUid})),[{accountId:"account-1",personaUid:row.value.personaUid}]);
  assert.equal(row.value.sessionKey,null);
  assert.equal(row.value.completedAt!==null,true);
  assert.equal(JSON.stringify(row).includes("plaintext-password"),false);
});

test("A019-02: CAPTCHA becomes HumanTask and a resolved task cannot cross a stale session", async()=>{
  const f=fixture(); f.provider.requireHuman("CAPTCHA");
  let row=await f.service.createAttempt(attemptInput());
  row=await f.service.acquireSession("attempt-1",{expectedRevision:row.revision});
  const originalSession=row.value.sessionKey;
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.WAITING_HUMAN);
  assert.equal(row.value.humanReason,"CAPTCHA");
  const task=f.human.raw(row.value.humanTaskId);
  assert.equal(task.value.taskKind,"operator.captcha");
  assert.equal(task.value.priority,"CRITICAL");
  assert.equal(f.remote.mutateCalls,0);
  f.human.resolve(row.value.humanTaskId,"completed");
  f.sessions.invalidate(originalSession);
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.SESSION_REQUIRED);
  assert.equal(row.value.humanTaskId,null);
  assert.equal(f.remote.mutateCalls,0);
  f.provider.setReady();
  row=await f.service.acquireSession("attempt-1",{expectedRevision:row.revision});
  assert.notEqual(row.value.sessionKey,originalSession);
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.READY_TO_PROVISION);
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.COMPLETED);
});

test("A019-02: cancelling a waiting attempt closes its HumanTask and releases the session", async()=>{
  const f=fixture(); f.provider.requireHuman("OPERATOR_ACTION");
  let row=await f.service.createAttempt(attemptInput());
  row=await f.service.acquireSession("attempt-1",{expectedRevision:row.revision});
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  const taskId=row.value.humanTaskId;
  row=await f.service.cancelAttempt("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.CANCELLED);
  assert.equal(f.human.raw(taskId).value.state,"CANCELLED");
  assert.equal(f.sessions.releaseCalls,1);
});

test("A019-03: ambiguous dispatch remains UNCERTAIN until reconciliation proves outcome", async()=>{
  const f=fixture(); let row=await ready(f); f.remote.setMode("THROW_UNCERTAIN");
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.UNCERTAIN);
  await assert.rejects(()=>f.service.advance("attempt-1",{expectedRevision:row.revision}),(e)=>e.code===PROVISIONING_ERROR_CODES.RECONCILE_REQUIRED);
  assert.equal(f.remote.mutateCalls,1);
  f.remote.setReconcile("UNKNOWN");
  const unchanged=await f.service.reconcileAttempt("attempt-1",{expectedRevision:row.revision});
  assert.equal(unchanged.value.state,PROVISIONING_STATES.UNCERTAIN);
  assert.equal(unchanged.revision,row.revision);
  f.remote.setReconcile("APPLIED");
  row=await f.service.reconcileAttempt("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.COMPLETED);
  assert.equal(f.remote.mutateCalls,1);
  assert.equal(f.accounts.createCalls,1);
});

test("A019-03: proven NOT_APPLIED permits retry with a new operation identity", async()=>{
  const f=fixture(); let row=await ready(f); f.remote.setMode("NOT_APPLIED");
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.RETRYABLE);
  assert.equal(row.value.operationEpoch,1);
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.SESSION_ACTIVE);
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.READY_TO_PROVISION);
  f.remote.setMode("APPLIED");
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.COMPLETED);
  assert.equal(row.value.operationEpoch,2);
  assert.equal(row.value.remoteOperationId,"p019:attempt-1:op:2");
  assert.equal(f.remote.mutateCalls,2);
});

test("A019-03: pre-dispatch ambiguity reuses the same durable RemoteOperation identity", async()=>{
  const f=fixture(); let row=await ready(f); f.remote.setMode("THROW_PREPARED");
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.RETRYABLE);
  assert.equal(row.value.remoteOperationId,"p019:attempt-1:op:1");
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  f.remote.setMode("APPLIED");
  row=await f.service.advance("attempt-1",{expectedRevision:row.revision});
  assert.equal(row.value.state,PROVISIONING_STATES.COMPLETED);
  assert.equal(row.value.operationEpoch,1);
  assert.equal(row.value.remoteOperationId,"p019:attempt-1:op:1");
});

test("A019-03: interrupted FINALIZING completes locally without re-dispatching provider mutation", async()=>{
  const f=fixture(); let row=await ready(f);
  const operationEpoch=1, remoteOperationId="p019:attempt-1:op:1";
  const forced={...row.value,state:PROVISIONING_STATES.FINALIZING,operationEpoch,remoteOperationId};
  const revision=f.store.force("attempt-1",forced);
  f.remote.seedForAttempt(forced,"SUCCEEDED","APPLIED");
  const recovered=await f.service.recoverInterrupted();
  assert.deepEqual(recovered,["attempt-1"]);
  row=await f.service.getAttempt("attempt-1");
  assert.equal(row.value.state,PROVISIONING_STATES.COMPLETED);
  assert.ok(row.revision>revision);
  assert.equal(f.remote.mutateCalls,0);
  assert.equal(f.accounts.createCalls,1);
});

test("state fencing rejects duplicate attempt, reserved Persona, and stale revision", async()=>{
  const f=fixture(); let row=await f.service.createAttempt(attemptInput());
  await assert.rejects(()=>f.service.createAttempt(attemptInput()),(e)=>e.code===PROVISIONING_ERROR_CODES.REVISION_CONFLICT);
  f.accounts.seed({accountId:"other",displayName:"Other",personaUid:"22222222-2222-2222-2222-222222222222",providerId:"perchance"});
  await assert.rejects(()=>f.service.createAttempt(attemptInput({attemptId:"attempt-2",accountId:"account-2",personaUid:"22222222-2222-2222-2222-222222222222"})),(e)=>e.code===PROVISIONING_ERROR_CODES.PERSONA_CONFLICT);
  row=await f.service.acquireSession("attempt-1",{expectedRevision:row.revision});
  await assert.rejects(()=>f.service.advance("attempt-1",{expectedRevision:row.revision-1}),(e)=>e.code===PROVISIONING_ERROR_CODES.REVISION_CONFLICT);
});
