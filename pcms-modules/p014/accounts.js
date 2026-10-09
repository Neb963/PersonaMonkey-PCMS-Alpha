import { ACCOUNTS_ERROR_CODES, accountsError } from "./errors.js";
import {
  ACCOUNTS_MAX_ACCOUNTS,
  ACCOUNTS_PROVIDER_ID,
  ACCOUNTS_SCHEMA_VERSION,
  ACCOUNT_KIND,
  emptyAccountsState,
  makeAccountsState,
  normalizeAccountCreateInput,
  normalizeAccountId,
  normalizeAccountsState,
  normalizePersonaUid
} from "./schema.js";

const PERSONA_STATUS = Object.freeze({
  READY:"READY",
  MISSING:"MISSING",
  IDENTITY_MISMATCH:"IDENTITY_MISMATCH",
  CONTAINER_UNAVAILABLE:"CONTAINER_UNAVAILABLE",
  LOOKUP_FAILED:"LOOKUP_FAILED"
});

function fail(code, options = {}) { throw accountsError(code, options); }

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype || proto===null;
}

function snapshotMethods(value, names, label) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) throw new TypeError(label + " is invalid");
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== names.length
      || !names.every((name)=>Object.hasOwn(descriptors,name)
        && descriptors[name].enumerable
        && Object.hasOwn(descriptors[name],"value")
        && typeof descriptors[name].value === "function")) {
    throw new TypeError(label + " is invalid");
  }
  return Object.freeze(Object.fromEntries(names.map((name)=>[name,descriptors[name].value])));
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(ACCOUNTS_ERROR_CODES.REVISION_CONFLICT);
  return value;
}

function publicState(record) {
  if (record === null) return Object.freeze({revision:0,value:emptyAccountsState()});
  if (!plain(record) || Object.getOwnPropertySymbols(record).length) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
  const descriptors=Object.getOwnPropertyDescriptors(record);
  if (Object.keys(descriptors).length !== 2
      || !Object.hasOwn(descriptors,"revision")
      || !Object.hasOwn(descriptors,"value")
      || !descriptors.revision.enumerable
      || !descriptors.value.enumerable
      || !Object.hasOwn(descriptors.revision,"value")
      || !Object.hasOwn(descriptors.value,"value")
      || !Number.isSafeInteger(descriptors.revision.value)
      || descriptors.revision.value < 1) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({revision:descriptors.revision.value,value:normalizeAccountsState(descriptors.value.value)});
}

function isoNow(clock) {
  let date;
  try { date=new Date(clock()); } catch { fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE); }
  if(Number.isNaN(date.getTime())) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
  return date.toISOString();
}

function normalizePersonaSnapshot(raw, expectedPersonaUid, {requireContainer=false}={}) {
  if (raw === null) return null;
  if (!plain(raw) || Object.getOwnPropertySymbols(raw).length) fail(ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE);
  const descriptors=Object.getOwnPropertyDescriptors(raw);
  for(const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor,"value")) fail(ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE);
  }
  if(!Object.hasOwn(descriptors,"personaUid") || !Object.hasOwn(descriptors,"cookieStoreId")) fail(ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE);
  let personaUid;
  try { personaUid=normalizePersonaUid(descriptors.personaUid.value); }
  catch { fail(ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE); }
  const cookieStoreId=descriptors.cookieStoreId.value;
  if(personaUid !== expectedPersonaUid) fail(ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE);
  if(cookieStoreId !== null && (typeof cookieStoreId !== "string" || cookieStoreId.length < 1 || cookieStoreId.length > 256)) {
    fail(ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE);
  }
  if(requireContainer && cookieStoreId === null) fail(ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE);
  return Object.freeze({personaUid,cookieStoreId});
}

export function createAccountsService({ stateStore, personaResolver, operationInspector = null, clock = () => new Date().toISOString() } = {}) {
  const store=snapshotMethods(stateStore,["read","compareAndSwap"],"Accounts state store");
  const personas=snapshotMethods(personaResolver,["get"],"Accounts Persona resolver");
  const inspector=operationInspector===null?null:snapshotMethods(operationInspector,["assertSafeRebind"],"Accounts operation inspector");
  if(typeof clock !== "function") throw new TypeError("Accounts clock must be a function");

  async function read() {
    let raw;
    try { raw=await store.read(); }
    catch { fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE); }
    return publicState(raw);
  }

  async function commit(expectedRevision, state) {
    let result;
    try { result=await store.compareAndSwap(Object.freeze({expectedRevision,value:state})); }
    catch { fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE); }
    if(!plain(result) || Object.getOwnPropertySymbols(result).length) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
    const descriptors=Object.getOwnPropertyDescriptors(result);
    for(const descriptor of Object.values(descriptors)) {
      if(!descriptor.enumerable || !Object.hasOwn(descriptor,"value")) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
    }
    const ok=descriptors.ok?.value;
    if(ok === false) {
      if(Object.keys(descriptors).length !== 2
          || !Object.hasOwn(descriptors,"currentRevision")
          || !Number.isSafeInteger(descriptors.currentRevision.value)
          || descriptors.currentRevision.value < 0) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
      fail(ACCOUNTS_ERROR_CODES.REVISION_CONFLICT,{currentRevision:descriptors.currentRevision.value});
    }
    if(ok !== true
        || Object.keys(descriptors).length !== 3
        || !Object.hasOwn(descriptors,"revision")
        || !Object.hasOwn(descriptors,"value")) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
    return publicState({revision:descriptors.revision.value,value:descriptors.value.value});
  }

  async function requirePersona(personaUid) {
    let raw;
    try { raw=await personas.get(personaUid); }
    catch { fail(ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE); }
    const snapshot=normalizePersonaSnapshot(raw,personaUid,{requireContainer:true});
    if(!snapshot) fail(ACCOUNTS_ERROR_CODES.PERSONA_UNAVAILABLE);
    return snapshot;
  }

  async function createAccount(input,{expectedRevision}={}) {
    const draft=normalizeAccountCreateInput(input);
    const expected=revision(expectedRevision);
    const current=await read();
    if(current.revision !== expected) fail(ACCOUNTS_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.accounts.length >= ACCOUNTS_MAX_ACCOUNTS) fail(ACCOUNTS_ERROR_CODES.CAPACITY);
    if(current.value.accounts.some((account)=>account.accountId===draft.accountId)) fail(ACCOUNTS_ERROR_CODES.ACCOUNT_CONFLICT);
    if(current.value.accounts.some((account)=>account.personaUid===draft.personaUid)) fail(ACCOUNTS_ERROR_CODES.PERSONA_CONFLICT);
    await requirePersona(draft.personaUid);
    const now=isoNow(clock);
    const account=Object.freeze({
      schemaVersion:ACCOUNTS_SCHEMA_VERSION,
      kind:ACCOUNT_KIND,
      accountId:draft.accountId,
      providerId:ACCOUNTS_PROVIDER_ID,
      displayName:draft.displayName,
      personaUid:draft.personaUid,
      bindingEpoch:1,
      createdAt:now,
      updatedAt:now
    });
    const state=makeAccountsState([...current.value.accounts,account]);
    const saved=await commit(current.revision,state);
    return Object.freeze({revision:saved.revision,account:saved.value.accounts.find((item)=>item.accountId===account.accountId)});
  }

  async function getAccount(rawAccountId) {
    const accountId=normalizeAccountId(rawAccountId);
    const current=await read();
    return current.value.accounts.find((account)=>account.accountId===accountId) || null;
  }

  async function listAccounts() {
    const current=await read();
    return Object.freeze({revision:current.revision,accounts:current.value.accounts});
  }

  async function rebindPersona(rawAccountId,{expectedRevision,expectedPersonaUid,newPersonaUid}={}) {
    const accountId=normalizeAccountId(rawAccountId);
    const expected=revision(expectedRevision);
    const expectedUid=normalizePersonaUid(expectedPersonaUid);
    const targetUid=normalizePersonaUid(newPersonaUid);
    const current=await read();
    if(current.revision !== expected) fail(ACCOUNTS_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    const index=current.value.accounts.findIndex((account)=>account.accountId===accountId);
    if(index < 0) fail(ACCOUNTS_ERROR_CODES.NOT_FOUND);
    const account=current.value.accounts[index];
    if(account.personaUid !== expectedUid) fail(ACCOUNTS_ERROR_CODES.ACCOUNT_CONFLICT);
    if(targetUid === account.personaUid) {
      await requirePersona(targetUid);
      return Object.freeze({revision:current.revision,changed:false,account});
    }
    if(current.value.accounts.some((item,index2)=>index2!==index && item.personaUid===targetUid)) fail(ACCOUNTS_ERROR_CODES.PERSONA_CONFLICT);
    // Reject rebind before and after the asynchronous Persona lookup.
    // OperationInspector reads Core RemoteOps; the UI is never the safety authority.
    if(inspector) await inspector.assertSafeRebind(accountId);
    await requirePersona(targetUid);
    if(inspector) await inspector.assertSafeRebind(accountId);
    const next={
      ...account,
      personaUid:targetUid,
      bindingEpoch:account.bindingEpoch+1,
      updatedAt:isoNow(clock)
    };
    const accounts=[...current.value.accounts];
    accounts[index]=next;
    const saved=await commit(current.revision,makeAccountsState(accounts));
    return Object.freeze({
      revision:saved.revision,
      changed:true,
      account:saved.value.accounts.find((item)=>item.accountId===accountId)
    });
  }

  async function reconcileBindings() {
    const current=await read();
    const bindings=[];
    for(const account of current.value.accounts) {
      let raw;
      try { raw=await personas.get(account.personaUid); }
      catch {
        bindings.push(Object.freeze({
          accountId:account.accountId,personaUid:account.personaUid,cookieStoreId:null,status:PERSONA_STATUS.LOOKUP_FAILED
        }));
        continue;
      }
      if(raw === null) {
        bindings.push(Object.freeze({
          accountId:account.accountId,personaUid:account.personaUid,cookieStoreId:null,status:PERSONA_STATUS.MISSING
        }));
        continue;
      }
      let snapshot;
      try { snapshot=normalizePersonaSnapshot(raw,account.personaUid); }
      catch {
        let actualUid=null;
        if(plain(raw) && !Object.getOwnPropertySymbols(raw).length) {
          const descriptor=Object.getOwnPropertyDescriptor(raw,"personaUid");
          if(descriptor?.enumerable && Object.hasOwn(descriptor,"value") && typeof descriptor.value === "string") actualUid=descriptor.value;
        }
        bindings.push(Object.freeze({
          accountId:account.accountId,personaUid:account.personaUid,cookieStoreId:null,
          status:actualUid && actualUid.toLowerCase()!==account.personaUid ? PERSONA_STATUS.IDENTITY_MISMATCH : PERSONA_STATUS.LOOKUP_FAILED
        }));
        continue;
      }
      bindings.push(Object.freeze({
        accountId:account.accountId,
        personaUid:account.personaUid,
        cookieStoreId:snapshot.cookieStoreId,
        status:snapshot.cookieStoreId===null ? PERSONA_STATUS.CONTAINER_UNAVAILABLE : PERSONA_STATUS.READY
      }));
    }
    return Object.freeze({
      revision:current.revision,
      complete:bindings.every((binding)=>binding.status===PERSONA_STATUS.READY),
      bindings:Object.freeze(bindings)
    });
  }

  return Object.freeze({createAccount,getAccount,listAccounts,rebindPersona,reconcileBindings});
}

export { PERSONA_STATUS };
