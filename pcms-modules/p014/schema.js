import { ACCOUNTS_ERROR_CODES, accountsError } from "./errors.js";

export const ACCOUNTS_SCHEMA_VERSION = 1;
export const ACCOUNTS_PROVIDER_ID = "perchance";
export const ACCOUNTS_MAX_ACCOUNTS = 1024;
export const ACCOUNTS_STATE_KIND = "accounts-state";
export const ACCOUNT_KIND = "account";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PERSONA_UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function fail(code = ACCOUNTS_ERROR_CODES.INVALID_ARGUMENT) {
  throw accountsError(code);
}

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exact(value, names, code) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== names.length || !names.every((name) => Object.hasOwn(descriptors, name))) fail(code);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
  }
}

function denseArray(value, code) {
  if (!Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
  }
  const allowed = new Set(["length", ...Array.from({ length:value.length }, (_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) fail(code);
}

export function normalizeAccountId(value, code = ACCOUNTS_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(code);
  return value;
}

export function normalizePersonaUid(value, code = ACCOUNTS_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string" || !PERSONA_UID_PATTERN.test(value)) fail(code);
  return value.toLowerCase();
}

export function normalizeDisplayName(value, code = ACCOUNTS_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string"
      || value.length < 1
      || value.length > 160
      || value.trim() !== value
      || CONTROL_PATTERN.test(value)) fail(code);
  return value;
}

export function normalizeTimestamp(value, code = ACCOUNTS_ERROR_CODES.CORRUPT_STATE) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || Number.isNaN(Date.parse(value))) fail(code);
  return value;
}

export function normalizeAccountCreateInput(value) {
  exact(value, ["accountId", "displayName", "personaUid"], ACCOUNTS_ERROR_CODES.INVALID_ARGUMENT);
  return Object.freeze({
    accountId:normalizeAccountId(value.accountId),
    displayName:normalizeDisplayName(value.displayName),
    personaUid:normalizePersonaUid(value.personaUid)
  });
}

export function normalizeAccountRecord(value) {
  exact(value, [
    "schemaVersion", "kind", "accountId", "providerId", "displayName", "personaUid",
    "bindingEpoch", "createdAt", "updatedAt"
  ], ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== ACCOUNTS_SCHEMA_VERSION
      || value.kind !== ACCOUNT_KIND
      || value.providerId !== ACCOUNTS_PROVIDER_ID
      || !Number.isSafeInteger(value.bindingEpoch)
      || value.bindingEpoch < 1) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
  return Object.freeze({
    schemaVersion:ACCOUNTS_SCHEMA_VERSION,
    kind:ACCOUNT_KIND,
    accountId:normalizeAccountId(value.accountId, ACCOUNTS_ERROR_CODES.CORRUPT_STATE),
    providerId:ACCOUNTS_PROVIDER_ID,
    displayName:normalizeDisplayName(value.displayName, ACCOUNTS_ERROR_CODES.CORRUPT_STATE),
    personaUid:normalizePersonaUid(value.personaUid, ACCOUNTS_ERROR_CODES.CORRUPT_STATE),
    bindingEpoch:value.bindingEpoch,
    createdAt:normalizeTimestamp(value.createdAt),
    updatedAt:normalizeTimestamp(value.updatedAt)
  });
}

export function emptyAccountsState() {
  return Object.freeze({
    schemaVersion:ACCOUNTS_SCHEMA_VERSION,
    kind:ACCOUNTS_STATE_KIND,
    accounts:Object.freeze([])
  });
}

export function normalizeAccountsState(value) {
  exact(value, ["schemaVersion", "kind", "accounts"], ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
  if (value.schemaVersion !== ACCOUNTS_SCHEMA_VERSION || value.kind !== ACCOUNTS_STATE_KIND) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
  denseArray(value.accounts, ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
  if (value.accounts.length > ACCOUNTS_MAX_ACCOUNTS) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
  const accounts=[];
  const accountIds=new Set();
  const personaUids=new Set();
  let previous=null;
  for(const raw of value.accounts){
    const account=normalizeAccountRecord(raw);
    if(accountIds.has(account.accountId) || personaUids.has(account.personaUid)) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
    if(previous !== null && previous.localeCompare(account.accountId) >= 0) fail(ACCOUNTS_ERROR_CODES.CORRUPT_STATE);
    accountIds.add(account.accountId);
    personaUids.add(account.personaUid);
    accounts.push(account);
    previous=account.accountId;
  }
  return Object.freeze({
    schemaVersion:ACCOUNTS_SCHEMA_VERSION,
    kind:ACCOUNTS_STATE_KIND,
    accounts:Object.freeze(accounts)
  });
}

export function makeAccountsState(accounts) {
  if (!Array.isArray(accounts)) fail();
  const normalized=accounts.map((account)=>normalizeAccountRecord(account));
  const sorted=normalized.sort((left,right)=>left.accountId.localeCompare(right.accountId));
  return normalizeAccountsState({schemaVersion:ACCOUNTS_SCHEMA_VERSION,kind:ACCOUNTS_STATE_KIND,accounts:sorted});
}
