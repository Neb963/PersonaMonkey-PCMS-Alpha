import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createAccountsService} from "../../../pcms-modules/p014/accounts.js";
import {ACCOUNTS_ERROR_CODES} from "../../../pcms-modules/p014/errors.js";
import {UID_A,UID_B,makePersonaResolver,makeStateStore,persona} from "../p014/harness.mjs";
const blocked=()=>Object.assign(new Error("Unresolved mutation"),{code:ACCOUNTS_ERROR_CODES.UNRESOLVED_OPERATION});
function harness(assertSafeRebind){
 const {store}=makeStateStore();
 const accounts=createAccountsService({
  stateStore:store,
  personaResolver:makePersonaResolver({
   [UID_A]:persona(UID_A,"firefox-container-10"),
   [UID_B]:persona(UID_B,"firefox-container-20")
  }).resolver,
  operationInspector:{assertSafeRebind},
  clock:()=>"2026-10-08T00:00:00Z"
 });
 return accounts;
}
test("A034-02 pending operation blocks rebind before persistence",async()=>{
 let count=0;
 const accounts=harness(async()=>{count++;throw blocked();});
 const added=await accounts.createAccount({accountId:"account",displayName:"Account",personaUid:UID_A},{expectedRevision:0});
 await assert.rejects(accounts.rebindPersona("account",{expectedRevision:1,expectedPersonaUid:UID_A,newPersonaUid:UID_B}),
   error=>error?.code===ACCOUNTS_ERROR_CODES.UNRESOLVED_OPERATION);
 assert.equal(count,1);
 assert.equal((await accounts.getAccount("account")).personaUid,UID_A);
 assert.equal((await accounts.listAccounts()).revision,added.revision);
});
test("A034-02 racing operation arising during Persona lookup blocks second check",async()=>{
 let calls=0;
 const accounts=harness(async()=>{if(++calls===2)throw blocked();});
 await accounts.createAccount({accountId:"account",displayName:"Account",personaUid:UID_A},{expectedRevision:0});
 await assert.rejects(accounts.rebindPersona("account",{expectedRevision:1,expectedPersonaUid:UID_A,newPersonaUid:UID_B}),
  error=>error?.code===ACCOUNTS_ERROR_CODES.UNRESOLVED_OPERATION);
 assert.equal(calls,2);
 assert.equal((await accounts.getAccount("account")).personaUid,UID_A);
});
test("A034-02 resolved operation allows a safe rebind; revision and persona fencing remain",async()=>{
 const accounts=harness(async()=>{});
 await accounts.createAccount({accountId:"account",displayName:"Account",personaUid:UID_A},{expectedRevision:0});
 const result=await accounts.rebindPersona("account",{expectedRevision:1,expectedPersonaUid:UID_A,newPersonaUid:UID_B});
 assert.equal(result.changed,true);assert.equal(result.revision,2);
 assert.equal(result.account.bindingEpoch,2);
 await assert.rejects(accounts.rebindPersona("account",{expectedRevision:1,expectedPersonaUid:UID_A,newPersonaUid:UID_B}),
  error=>error?.code===ACCOUNTS_ERROR_CODES.REVISION_CONFLICT);
});
test("A034-02 production composition injects durable RemoteOps with unknown-correlation fail-closed",async()=>{
 const source=await readFile("extension/pcms/integration/composition.js","utf8");
 assert.match(source,/remoteOps\.listUnresolved\(\)/);
 assert.match(source,/operationContext\.get\(op\.operationId\)/);
 assert.match(source,/operationInspector,/);
 assert.match(source,/PCMS_ACCOUNTS_UNRESOLVED_OPERATION/);
});
