import { PCMS_UI_ERROR_CODES, pcmsUiError } from "./errors.js";
import { normalizePcmsSearchQuery, pcmsRouteHref } from "./deep-links.js";

export const PCMS_UI_MAX_ATTENTION = 100;
export const PCMS_UI_MAX_SEARCH_RESULTS = 50;

const PRIORITY_ORDER = Object.freeze({ CRITICAL:0, HIGH:1, NORMAL:2, LOW:3 });
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const PERSONA_UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code = PCMS_UI_ERROR_CODES.PROJECTION_PROTOCOL) {
  throw pcmsUiError(code);
}

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype || proto===null;
}

function data(value,key) {
  if(!plain(value) || Object.getOwnPropertySymbols(value).length) fail();
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor,"value")) fail();
  return descriptor.value;
}

function snapshotMethods(value,names,label) {
  if(!plain(value)||Object.getOwnPropertySymbols(value).length) throw new TypeError(label+" is invalid");
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(!names.every((name)=>Object.hasOwn(descriptors,name)
      && descriptors[name].enumerable
      && Object.hasOwn(descriptors[name],"value")
      && typeof descriptors[name].value==="function")) throw new TypeError(label+" is invalid");
  return Object.freeze(Object.fromEntries(names.map((name)=>[name,descriptors[name].value])));
}

function id(value) {
  if(typeof value!=="string"||!ID_PATTERN.test(value)) fail();
  return value;
}

function text(value,max,{empty=false}={}) {
  if(typeof value!=="string"||value.length>max||(!empty&&value.length<1)||/[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}

function timestamp(value) {
  if(typeof value!=="string"||value.length<1||value.length>64||Number.isNaN(Date.parse(value))) fail();
  return value;
}

function subject(raw) {
  if(raw===null) return null;
  const kind=text(data(raw,"kind"),64);
  const subjectId=text(data(raw,"id"),256);
  return Object.freeze({kind,id:subjectId});
}

function normalizeAttention(rows) {
  if(!Array.isArray(rows)||rows.length>500) fail();
  const out=[];
  const seen=new Set();
  for(const row of rows) {
    const revision=data(row,"revision");
    const value=data(row,"value");
    if(!Number.isSafeInteger(revision)||revision<1) fail();
    const taskId=id(data(value,"taskId"));
    if(seen.has(taskId)) fail();
    seen.add(taskId);
    if(data(value,"state")!=="OPEN") fail();
    const priority=data(value,"priority");
    if(!Object.hasOwn(PRIORITY_ORDER,priority)) fail();
    const taskKind=text(data(value,"taskKind"),96);
    const title=text(data(value,"title"),160);
    const createdAt=timestamp(data(value,"createdAt"));
    const subjectRef=subject(data(value,"subjectRef"));
    let subjectHref=null;
    if(subjectRef?.kind==="account" && ID_PATTERN.test(subjectRef.id)) {
      subjectHref=pcmsRouteHref("accounts",{id:subjectRef.id});
    }
    out.push(Object.freeze({
      taskId,
      taskKind,
      title,
      priority,
      createdAt,
      subjectRef,
      subjectHref,
      href:pcmsRouteHref("attention",{id:taskId})
    }));
  }
  out.sort((a,b)=>PRIORITY_ORDER[a.priority]-PRIORITY_ORDER[b.priority]
    || a.createdAt.localeCompare(b.createdAt)
    || a.taskId.localeCompare(b.taskId));
  return Object.freeze(out);
}

function normalizeAccounts(listed) {
  const revision=data(listed,"revision");
  const raw=data(listed,"accounts");
  if(!Number.isSafeInteger(revision)||revision<0||!Array.isArray(raw)||raw.length>1024) fail();
  const accounts=[];
  const ids=new Set();
  for(const account of raw) {
    const accountId=id(data(account,"accountId"));
    if(ids.has(accountId)) fail();
    ids.add(accountId);
    const displayName=text(data(account,"displayName"),160);
    const providerId=text(data(account,"providerId"),64);
    const personaUid=data(account,"personaUid");
    const bindingEpoch=data(account,"bindingEpoch");
    if(!PERSONA_UID_PATTERN.test(personaUid)||!Number.isSafeInteger(bindingEpoch)||bindingEpoch<1) fail();
    accounts.push(Object.freeze({
      accountId,
      displayName,
      providerId,
      personaUid:personaUid.toLowerCase(),
      bindingEpoch,
      href:pcmsRouteHref("accounts",{id:accountId})
    }));
  }
  accounts.sort((a,b)=>a.accountId.localeCompare(b.accountId));
  return Object.freeze({revision,accounts:Object.freeze(accounts)});
}

function fieldScore(field,query) {
  const normalized=field.normalize("NFKC").toLocaleLowerCase("en-US");
  if(normalized===query) return 0;
  if(normalized.startsWith(query)) return 10;
  const boundary=normalized.split(/[^a-z0-9]+/).some((token)=>token.startsWith(query));
  if(boundary) return 20;
  if(normalized.includes(query)) return 30;
  return null;
}

function searchProjection(query,accounts,attention,limit) {
  const safe=normalizePcmsSearchQuery(query);
  if(!safe) return Object.freeze([]);
  const needle=safe.toLocaleLowerCase("en-US");
  const results=[];

  for(const account of accounts) {
    const fields=[account.displayName,account.accountId,account.personaUid,account.providerId];
    const scores=fields.map((field)=>fieldScore(field,needle)).filter((score)=>score!==null);
    if(!scores.length) continue;
    results.push(Object.freeze({
      kind:"account",
      id:account.accountId,
      title:account.displayName,
      subtitle:account.accountId+" · "+account.personaUid,
      href:account.href,
      score:Math.min(...scores)
    }));
  }

  for(const task of attention) {
    const fields=[task.title,task.taskId,task.taskKind,task.priority];
    if(task.subjectRef) fields.push(task.subjectRef.kind,task.subjectRef.id);
    const scores=fields.map((field)=>fieldScore(field,needle)).filter((score)=>score!==null);
    if(!scores.length) continue;
    results.push(Object.freeze({
      kind:"attention",
      id:task.taskId,
      title:task.title,
      subtitle:task.priority+" · "+task.taskKind,
      href:task.href,
      score:Math.min(...scores)
    }));
  }

  results.sort((a,b)=>a.score-b.score
    || a.kind.localeCompare(b.kind)
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id));
  return Object.freeze(results.slice(0,limit));
}

function navigation(attentionCount,accountCount) {
  return Object.freeze([
    Object.freeze({id:"overview",label:"Overview",href:pcmsRouteHref("overview"),badge:null}),
    Object.freeze({id:"attention",label:"Attention",href:pcmsRouteHref("attention"),badge:attentionCount}),
    Object.freeze({id:"accounts",label:"Accounts",href:pcmsRouteHref("accounts"),badge:accountCount}),
    Object.freeze({id:"search",label:"Search",href:pcmsRouteHref("search"),badge:null})
  ]);
}

export function createPcmsUiProjectionService({
  humanTasks,
  accounts,
  maxAttention=PCMS_UI_MAX_ATTENTION,
  maxSearchResults=PCMS_UI_MAX_SEARCH_RESULTS
}={}) {
  const tasks=snapshotMethods(humanTasks,["listAttention"],"PCMS UI HumanTask source");
  const accountSource=snapshotMethods(accounts,["listAccounts"],"PCMS UI Accounts source");
  if(!Number.isSafeInteger(maxAttention)||maxAttention<1||maxAttention>500
      || !Number.isSafeInteger(maxSearchResults)||maxSearchResults<1||maxSearchResults>100) {
    throw new RangeError("PCMS UI projection limits are invalid");
  }

  async function snapshot({query=""}={}) {
    const safeQuery=normalizePcmsSearchQuery(query);
    let rawAttention,rawAccounts;
    try {
      [rawAttention,rawAccounts]=await Promise.all([
        tasks.listAttention({limit:maxAttention}),
        accountSource.listAccounts()
      ]);
    } catch {
      fail();
    }
    const attention=normalizeAttention(rawAttention);
    const accountProjection=normalizeAccounts(rawAccounts);
    const notifications=Object.freeze({
      count:attention.length,
      criticalCount:attention.filter((item)=>item.priority==="CRITICAL").length,
      items:attention
    });
    const search=Object.freeze({
      query:safeQuery,
      results:searchProjection(safeQuery,accountProjection.accounts,attention,maxSearchResults)
    });
    return Object.freeze({
      navigation:navigation(attention.length,accountProjection.accounts.length),
      notifications,
      accounts:accountProjection,
      search
    });
  }

  return Object.freeze({snapshot});
}
