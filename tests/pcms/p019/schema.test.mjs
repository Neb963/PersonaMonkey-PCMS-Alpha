import test from "node:test";
import assert from "node:assert/strict";
import { newAttempt, normalizeProvisioningCreateInput, provisioningHumanTaskId, provisioningIntentFingerprint, provisioningOperationId } from "../../../pcms-modules/p019/schema.js";
import { PROVISIONING_ERROR_CODES } from "../../../pcms-modules/p019/errors.js";
import { SECRET_REF, UID_A } from "./harness.mjs";

const base=(attemptId="a")=>({attemptId,accountId:"acct",displayName:"A",personaUid:UID_A,credentialRef:SECRET_REF});

test("derived Core identities stay within accepted 256-character bounds",()=>{
  const id="a".repeat(160);
  assert.equal(provisioningOperationId(id,Number.MAX_SAFE_INTEGER).length<=256,true);
  assert.equal(provisioningHumanTaskId(id,Number.MAX_SAFE_INTEGER).length<=256,true);
  assert.equal(provisioningIntentFingerprint(id,Number.MAX_SAFE_INTEGER).length<=256,true);
  assert.throws(()=>normalizeProvisioningCreateInput(base("a".repeat(161))),(e)=>e.code===PROVISIONING_ERROR_CODES.INVALID_ARGUMENT);
});

test("ordinary durable state accepts only SecretRef, never plaintext credentials",()=>{
  assert.throws(()=>normalizeProvisioningCreateInput({...base(),credentialRef:"plaintext-password"}),(e)=>e.code===PROVISIONING_ERROR_CODES.INVALID_ARGUMENT);
  const attempt=newAttempt(base(),"2026-10-05T12:00:00.000Z");
  assert.equal(attempt.credentialRef,SECRET_REF);
  assert.equal(Object.hasOwn(attempt,"password"),false);
});
