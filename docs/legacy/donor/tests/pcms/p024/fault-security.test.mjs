import test from "node:test";
import assert from "node:assert/strict";

import { createProviderGate } from "../../../extension/pcms/remoteops/provider-gate.js";
import { createRecoveryHoldController } from "../../../extension/pcms/remoteops/recovery-hold.js";
import { createRemoteOps } from "../../../extension/pcms/remoteops/remote-ops.js";
import { REMOTE_OP_ERROR_CODES } from "../../../extension/pcms/remoteops/errors.js";
import { createSecretStore } from "../../../extension/pcms/secrets/secret-store.js";
import { SECRET_ERROR_CODES } from "../../../extension/pcms/secrets/errors.js";
import { makeStorage, op } from "../p010-harness.mjs";

function providerRegistry({ dispatch, reconcile }) {
  return {
    perchance: {
      operations: {
        "generator.update": { dispatch, reconcile }
      }
    }
  };
}

function fixture(shared, behavior) {
  const storage = makeStorage(shared);
  const remoteOps = createRemoteOps({
    storageBroker:storage,
    clock:() => "2026-10-05T18:30:00.000Z"
  });
  const recoveryHold = createRecoveryHoldController({
    storageBroker:storage,
    remoteOps,
    clock:() => "2026-10-05T18:30:01.000Z"
  });
  const gate = createProviderGate({
    remoteOps,
    recoveryHold,
    providers:providerRegistry(behavior)
  });
  return { storage, remoteOps, recoveryHold, gate };
}

test("A024-01 ambiguous provider dispatch stays UNCERTAIN across restart and cannot be blindly replayed", async () => {
  const shared={rows:new Map()};
  let dispatches=0;
  const first=fixture(shared,{
    async dispatch() {
      dispatches += 1;
      throw new Error("disconnect after provider may have applied");
    },
    async reconcile() { return {status:"UNKNOWN"}; }
  });

  await assert.rejects(
    first.gate.mutate({operation:op(),dispatchInput:{transient:"value"}}),
    (error) => error?.code===REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL
  );
  assert.equal(dispatches,1);
  assert.equal((await first.remoteOps.get("op-1")).value.state,"UNCERTAIN");

  const restarted=fixture(shared,{
    async dispatch() {
      dispatches += 1;
      return {status:"APPLIED"};
    },
    async reconcile() { return {status:"UNKNOWN"}; }
  });

  await assert.rejects(
    restarted.gate.mutate({operation:op(),dispatchInput:{transient:"retry"}}),
    (error) => error?.code===REMOTE_OP_ERROR_CODES.RECONCILE_REQUIRED
  );
  assert.equal(dispatches,1,"restart must not replay an ambiguous mutation");

  const reconciled=await restarted.gate.reconcile("op-1");
  assert.equal(reconciled.value.state,"UNCERTAIN");
  assert.equal(reconciled.value.resolution,"RECONCILED_UNKNOWN");
  assert.equal(dispatches,1);
});

test("A024-01 interrupted dispatch is fenced by RECOVERY_HOLD until explicit reconciliation completes", async () => {
  const shared={rows:new Map()};
  let dispatches=0;
  const first=fixture(shared,{
    async dispatch() { dispatches += 1; return {status:"APPLIED"}; },
    async reconcile() { return {status:"NOT_APPLIED"}; }
  });
  const prepared=await first.remoteOps.prepare(op({operationId:"op-restart"}));
  await first.remoteOps.beginDispatch("op-restart",{expectedRevision:prepared.revision});

  const restarted=fixture(shared,{
    async dispatch() { dispatches += 1; return {status:"APPLIED"}; },
    async reconcile() { return {status:"NOT_APPLIED"}; }
  });
  const entered=await restarted.recoveryHold.enterRecoveryHold({reason:"restart"});
  assert.deepEqual(entered.recoveredOperationIds,["op-restart"]);
  assert.equal((await restarted.remoteOps.get("op-restart")).value.state,"UNCERTAIN");

  await assert.rejects(
    restarted.gate.mutate({operation:op({operationId:"op-other"}),dispatchInput:{}}),
    (error) => error?.code===REMOTE_OP_ERROR_CODES.RECOVERY_HOLD
  );
  assert.equal(dispatches,0);

  await assert.rejects(
    restarted.recoveryHold.releaseRecoveryHold({
      expectedRevision:entered.hold.revision,
      checks:{moduleGenerations:true,personaBindings:true,providerCapabilities:true}
    }),
    (error) => error?.code===REMOTE_OP_ERROR_CODES.RECOVERY_INCOMPLETE
  );

  const reconciled=await restarted.gate.reconcile("op-restart");
  assert.equal(reconciled.value.state,"RETRYABLE");
  const cancelled=await restarted.remoteOps.cancel("op-restart",{expectedRevision:reconciled.revision});
  assert.equal(cancelled.value.state,"CANCELLED");

  const current=await restarted.recoveryHold.getStatus();
  const released=await restarted.recoveryHold.releaseRecoveryHold({
    expectedRevision:current.revision,
    checks:{moduleGenerations:true,personaBindings:true,providerCapabilities:true}
  });
  assert.equal(released.value.state,"NORMAL");
  assert.equal(dispatches,0,"recovery reconciles/cancels but never dispatches");
});

test("A024-01 ambiguous protected-value mutation returns an opaque reference without echoing the value", async () => {
  const protectedValue="P024-NONPUBLIC-VALUE";
  const uuid="11111111-1111-4111-8111-111111111111";
  const backend={
    async probe(){ return {ready:true}; },
    async put(){ throw new Error("transport lost after write"); },
    async get(){ return protectedValue; },
    async delete(){ return {deleted:true}; }
  };
  const store=createSecretStore({backend,randomUUID:()=>uuid});

  await assert.rejects(
    store.create(protectedValue),
    (error) => {
      assert.equal(error?.code,SECRET_ERROR_CODES.UNCERTAIN);
      assert.equal(error?.operation,"create");
      assert.equal(error.message.includes(protectedValue),false);
      assert.equal(JSON.stringify(error).includes(protectedValue),false);
      return true;
    }
  );
});
