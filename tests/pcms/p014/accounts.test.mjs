import assert from "node:assert/strict";
import test from "node:test";

import { createAccountsService, PERSONA_STATUS } from "../../../pcms-modules/p014/accounts.js";
import { ACCOUNTS_ERROR_CODES } from "../../../pcms-modules/p014/errors.js";
import { ACCOUNTS_PROVIDER_ID } from "../../../pcms-modules/p014/schema.js";
import { PERCHANCE_PROVIDER_ID } from "../../../extension/pcms/providers/perchance/contract.js";
import { UID_A, UID_B, UID_C, makePersonaResolver, makeStateStore, persona } from "./harness.mjs";

function setup(){
  const state=makeStateStore();
  const personas=makePersonaResolver({
    [UID_A]:persona(UID_A,"firefox-container-10"),
    [UID_B]:persona(UID_B,"firefox-container-20"),
    [UID_C]:persona(UID_C,"firefox-container-30")
  });
  let tick=0;
  const service=createAccountsService({
    stateStore:state.store,
    personaResolver:personas.resolver,
    clock:()=>`2026-10-05T04:00:0${tick++}Z`
  });
  return {store:state,personas,service};
}

test("A014-01 account model persists bounded non-secret identity keyed by personaUid",async()=>{
  const h=setup();
  const created=await h.service.createAccount({accountId:"acct-001",displayName:"Primary",personaUid:UID_A.toUpperCase()},{expectedRevision:0});
  assert.equal(created.revision,1);
  assert.deepEqual(created.account,{
    schemaVersion:1,
    kind:"account",
    accountId:"acct-001",
    providerId:ACCOUNTS_PROVIDER_ID,
    displayName:"Primary",
    personaUid:UID_A,
    bindingEpoch:1,
    createdAt:"2026-10-05T04:00:00.000Z",
    updatedAt:"2026-10-05T04:00:00.000Z"
  });
  const serialized=JSON.stringify(h.store.shared.row.value);
  assert.equal(serialized.includes("cookieStoreId"),false);
  assert.equal(serialized.includes("firefox-container-10"),false);
  assert.doesNotMatch(serialized,/password|secret|token|credential/i);
  assert.equal((await h.service.getAccount("acct-001")).personaUid,UID_A);
});


test("A014-01 Accounts provider identity stays aligned with the accepted P013 Perchance contract",()=>{
  assert.equal(ACCOUNTS_PROVIDER_ID,PERCHANCE_PROVIDER_ID);
});

test("A014-01 Persona projection tolerates additive data but never invokes accessors",async()=>{
  const state=makeStateStore();
  let invoked=0;
  const exotic={personaUid:UID_B};
  Object.defineProperty(exotic,"cookieStoreId",{enumerable:true,get(){invoked+=1;return "firefox-container-20";}});
  const service=createAccountsService({
    stateStore:state.store,
    personaResolver:{
      async get(uid){
        if(uid===UID_A) return {personaUid:UID_A,cookieStoreId:"firefox-container-10",name:"Persona A",managed:true};
        if(uid===UID_B) return exotic;
        return null;
      }
    },
    clock:()=>"2026-10-05T04:00:00Z"
  });
  await service.createAccount({accountId:"acct-a",displayName:"A",personaUid:UID_A},{expectedRevision:0});
  await assert.rejects(
    service.createAccount({accountId:"acct-b",displayName:"B",personaUid:UID_B},{expectedRevision:1}),
    error=>error?.code===ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE
  );
  assert.equal(invoked,0);
});

test("A014-01 account identity and Persona binding are unique and revision fenced",async()=>{
  const h=setup();
  await h.service.createAccount({accountId:"acct-a",displayName:"A",personaUid:UID_A},{expectedRevision:0});
  await assert.rejects(
    h.service.createAccount({accountId:"acct-a",displayName:"Duplicate",personaUid:UID_B},{expectedRevision:1}),
    error=>error?.code===ACCOUNTS_ERROR_CODES.ACCOUNT_CONFLICT
  );
  await assert.rejects(
    h.service.createAccount({accountId:"acct-b",displayName:"B",personaUid:UID_A},{expectedRevision:1}),
    error=>error?.code===ACCOUNTS_ERROR_CODES.PERSONA_CONFLICT
  );
  await assert.rejects(
    h.service.createAccount({accountId:"acct-b",displayName:"B",personaUid:UID_B},{expectedRevision:0}),
    error=>error?.code===ACCOUNTS_ERROR_CODES.REVISION_CONFLICT && error.currentRevision===1
  );
});

test("A014-01 binding requires an existing Persona with a current container",async()=>{
  const h=setup();
  h.personas.remove(UID_A);
  await assert.rejects(
    h.service.createAccount({accountId:"acct-a",displayName:"A",personaUid:UID_A},{expectedRevision:0}),
    error=>error?.code===ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE
  );
  h.personas.set(UID_A,persona(UID_A,null));
  await assert.rejects(
    h.service.createAccount({accountId:"acct-a",displayName:"A",personaUid:UID_A},{expectedRevision:0}),
    error=>error?.code===ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE
  );
});

test("A014-02 controlled rebind requires expected old binding and unused replacement Persona",async()=>{
  const h=setup();
  await h.service.createAccount({accountId:"acct-a",displayName:"A",personaUid:UID_A},{expectedRevision:0});
  await h.service.createAccount({accountId:"acct-b",displayName:"B",personaUid:UID_B},{expectedRevision:1});
  await assert.rejects(
    h.service.rebindPersona("acct-a",{expectedRevision:2,expectedPersonaUid:UID_C,newPersonaUid:UID_C}),
    error=>error?.code===ACCOUNTS_ERROR_CODES.ACCOUNT_CONFLICT
  );
  await assert.rejects(
    h.service.rebindPersona("acct-a",{expectedRevision:2,expectedPersonaUid:UID_A,newPersonaUid:UID_B}),
    error=>error?.code===ACCOUNTS_ERROR_CODES.PERSONA_CONFLICT
  );
  const rebound=await h.service.rebindPersona("acct-a",{expectedRevision:2,expectedPersonaUid:UID_A,newPersonaUid:UID_C});
  assert.equal(rebound.changed,true);
  assert.equal(rebound.revision,3);
  assert.equal(rebound.account.personaUid,UID_C);
  assert.equal(rebound.account.bindingEpoch,2);
});

test("A014-02 same personaUid rebind is idempotent and does not rewrite state",async()=>{
  const h=setup();
  await h.service.createAccount({accountId:"acct-a",displayName:"A",personaUid:UID_A},{expectedRevision:0});
  const before=structuredClone(h.store.shared.row);
  h.personas.set(UID_A,persona(UID_A,"firefox-container-99"));
  const result=await h.service.rebindPersona("acct-a",{expectedRevision:1,expectedPersonaUid:UID_A,newPersonaUid:UID_A});
  assert.equal(result.changed,false);
  assert.equal(result.revision,1);
  assert.deepEqual(h.store.shared.row,before);
});

test("A014-03 cookieStoreId rotation changes only the transient reconciliation projection",async()=>{
  const h=setup();
  await h.service.createAccount({accountId:"acct-a",displayName:"A",personaUid:UID_A},{expectedRevision:0});
  const storedBefore=structuredClone(h.store.shared.row);
  let reconciled=await h.service.reconcileBindings();
  assert.deepEqual(reconciled,{
    revision:1,
    complete:true,
    bindings:[{accountId:"acct-a",personaUid:UID_A,cookieStoreId:"firefox-container-10",status:PERSONA_STATUS.READY}]
  });
  h.personas.set(UID_A,persona(UID_A,"firefox-container-77"));
  reconciled=await h.service.reconcileBindings();
  assert.equal(reconciled.complete,true);
  assert.equal(reconciled.bindings[0].cookieStoreId,"firefox-container-77");
  assert.deepEqual(h.store.shared.row,storedBefore);
  assert.equal((await h.service.getAccount("acct-a")).personaUid,UID_A);
});

test("A014-03 reconciliation fails closed for missing, mismatched, unavailable, and failed Persona lookup",async()=>{
  const h=setup();
  await h.service.createAccount({accountId:"acct-a",displayName:"A",personaUid:UID_A},{expectedRevision:0});

  h.personas.remove(UID_A);
  let result=await h.service.reconcileBindings();
  assert.equal(result.complete,false);
  assert.equal(result.bindings[0].status,PERSONA_STATUS.MISSING);

  h.personas.set(UID_A,persona(UID_B,"firefox-container-20"));
  result=await h.service.reconcileBindings();
  assert.equal(result.complete,false);
  assert.equal(result.bindings[0].status,PERSONA_STATUS.IDENTITY_MISMATCH);

  h.personas.set(UID_A,persona(UID_A,null));
  result=await h.service.reconcileBindings();
  assert.equal(result.complete,false);
  assert.equal(result.bindings[0].status,PERSONA_STATUS.CONTAINER_UNAVAILABLE);

  h.personas.fail(UID_A);
  result=await h.service.reconcileBindings();
  assert.equal(result.complete,false);
  assert.equal(result.bindings[0].status,PERSONA_STATUS.LOOKUP_FAILED);
});

test("A014-03 stale concurrent state cannot create duplicate Persona bindings",async()=>{
  const h=setup();
  const first=await h.service.createAccount({accountId:"acct-a",displayName:"A",personaUid:UID_A},{expectedRevision:0});
  assert.equal(first.revision,1);
  const staleRevision=1;
  await h.service.createAccount({accountId:"acct-b",displayName:"B",personaUid:UID_B},{expectedRevision:staleRevision});
  await assert.rejects(
    h.service.rebindPersona("acct-a",{expectedRevision:staleRevision,expectedPersonaUid:UID_A,newPersonaUid:UID_C}),
    error=>error?.code===ACCOUNTS_ERROR_CODES.REVISION_CONFLICT && error.currentRevision===2
  );
  assert.equal((await h.service.getAccount("acct-a")).personaUid,UID_A);
});
