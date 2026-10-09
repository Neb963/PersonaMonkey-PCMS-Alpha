/** P103: Perchance boundary. The injected executor belongs to PersonaMonkey's
 * typed execution broker; this module has no browser, native or network access.
 * A successful transport response is NOT evidence of a completed mutation.
 */
const FAIL = Object.freeze({
  INVALID_REQUEST: ['Invalid Perchance request', false],
  STALE_REVISION: ['Provider or binding revision changed', false],
  STALE_BINDING: ['Account Persona/route binding changed', false],
  UNSUPPORTED_CAPABILITY: ['Required Perchance capability is unverified', false],
  OWNERSHIP_UNKNOWN: ['Account-scoped generator ownership is not confirmed', false],
  SOURCE_DRIFT: ['Provider source does not match the expected revision', false],
  CONFLICT: ['Generator identity or remote state conflicts', false],
  RATE_LIMIT: ['Perchance request budget is exhausted', true],
  WAITING_HUMAN: ['Perchance session or challenge requires the operator', false],
  RECOVERY_HOLD: ['Durable operation requires reconciliation', false],
  NOT_APPLIED: ['Perchance operation did not apply', false],
  UNCERTAIN: ['Remote mutation outcome is ambiguous; reconcile before retry', false],
  UNAVAILABLE: ['Perchance read transport is unavailable', true]
});
const CAP = Object.freeze({probe: null, read: 'generator.get', observe: 'generator.get',
  listGenerators: 'generator.list', create: 'generator.create', save: 'generator.save',
  setListing: 'generator.setPrivacy', delete: 'generator.delete'});
const statusMap = Object.freeze({'stale':'STALE_REVISION','captcha-needed':'WAITING_HUMAN',
  'session-token-error':'WAITING_HUMAN','invalid-edit-key':'OWNERSHIP_UNKNOWN',
  'already-exists':'CONFLICT','too-many-requests':'RATE_LIMIT','too-big':'INVALID_REQUEST',
  'generator-does-not-exist':'NOT_APPLIED','not-applied':'NOT_APPLIED'});
const safe = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const has = (v,k) => Object.prototype.hasOwnProperty.call(v,k);
const err = code => ({ok:false,error:{code,message:FAIL[code][0],retryable:FAIL[code][1]},revision:0});
const success = (result,revision=0) => ({ok:true,result,revision});
class Fault extends Error { constructor(code) { super(code); this.code=code; } }
function reject(code) { throw new Fault(code); }
function check(p,code='INVALID_REQUEST') { if(!p) reject(code); }
const canonicalKey = key => typeof key === 'string' && (key === 'hub' || (key.length >= 4 && key.length <= 80 &&
  /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(key)));
const positive = value => Number.isSafeInteger(value) && value >= 0;
const ctxFields = ['accountId','personaUid','epoch','routeRevision','capabilityRevision'];
function contextOK(c) {
  return safe(c) && typeof c.accountId==='string' && c.accountId.length>0 &&
    typeof c.personaUid==='string' && c.personaUid.length>0 &&
    ctxFields.slice(2).every(k=>positive(c[k]));
}
function sameContext(a,b) { return contextOK(a) && contextOK(b) && ctxFields.every(k=>a[k]===b[k]); }
function dateOK(value) {return typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));}
function filesOK(files) {return safe(files) && typeof files.pjs==='string' && typeof files.html==='string' &&
  files.thumbnail instanceof Uint8Array && files.thumbnail.byteLength<=4*1024*1024 &&
  files.pjs.length<=4*1024*1024 && files.html.length<=4*1024*1024;}
function cloneFiles(files) {return {pjs:files.pjs,html:files.html,thumbnail:new Uint8Array(files.thumbnail)};}
function matchFiles(a,b) {return filesOK(a)&&filesOK(b)&&a.pjs===b.pjs&&a.html===b.html&&
  a.thumbnail.length===b.thumbnail.length&&a.thumbnail.every((v,i)=>v===b.thumbnail[i]);}
function normalizeReadback(data,asOf) {
  check(safe(data),'UNSUPPORTED_CAPABILITY');
  check(data.ownership==='CONFIRMED'||data.ownership==='UNKNOWN','UNSUPPORTED_CAPABILITY');
  check(['PUBLIC','UNLISTED','UNKNOWN'].includes(data.listing),'UNSUPPORTED_CAPABILITY');
  check(data.sourceRevision===null || (typeof data.sourceRevision==='string'&&data.sourceRevision.length>0),
    'UNSUPPORTED_CAPABILITY');
  check(!has(data,'files') || filesOK(data.files),'UNSUPPORTED_CAPABILITY');
  check(dateOK(data.asOf??asOf),'UNSUPPORTED_CAPABILITY');
  return {sourceRevision:data.sourceRevision,listing:data.listing,ownership:data.ownership,
    asOf:data.asOf??asOf,...(has(data,'files')?{files:cloneFiles(data.files)}:{})};
}
function strictAccountRow(item,asOf) {
  check(safe(item)&&canonicalKey(item.name),'UNSUPPORTED_CAPABILITY');
  // The user-authenticated inventory grants account identity; edit keys and
  // the public /api/getGeneratorList feed do not establish ownership.
  check(item.isPrivate===true||item.isPrivate===false||item.isPrivate===null,'UNSUPPORTED_CAPABILITY');
  const r={sourceRevision:item.sourceRevision??null,listing:item.isPrivate===null?'UNKNOWN':item.isPrivate?'UNLISTED':'PUBLIC',
    ownership:'CONFIRMED',asOf};
  return {key:item.name,readback:normalizeReadback(r,asOf)};
}
async function fingerprint(context,entries) {
  const bytes=new TextEncoder().encode(JSON.stringify([ctxFields.map(k=>context[k]),
    entries.map(e=>[e.key,e.readback.listing,e.readback.sourceRevision])]));
  check(typeof globalThis.crypto?.subtle?.digest==='function','UNSUPPORTED_CAPABILITY');
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
/**
 * @param {object} settings
 * @param {object} settings.executor - injected PersonaMonkey-owned execution; inspect/execute only
 * @param {object} settings.journal - durably persisted operation ledger with read/dispatch/complete
 * @param {number} settings.pageSize - bounded local pages of full account inventory
 */
export function createPerchanceAdapter({executor,journal,pageSize=100,now=()=>new Date().toISOString()}={}) {
  if(!executor||typeof executor.inspect!=='function'||typeof executor.execute!=='function'||
    !journal||typeof journal.read!=='function'||typeof journal.dispatch!=='function'||
    typeof journal.complete!=='function'||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>250||
    typeof now!=='function') throw new TypeError('Perchance requires scoped executor, durable ledger and bounded page size');
  async function run(fn) {try {return await fn();} catch(e){return err(e instanceof Fault?e.code:'UNAVAILABLE');}}
  async function inspect(context,required) {
    check(contextOK(context));
    let state;try{state=await executor.inspect({context});}catch{reject('UNAVAILABLE');}
    check(safe(state)&&sameContext(state.context,context),'STALE_BINDING');
    check(state.origin==='ACCOUNT_PERSONA' && typeof state.session==='string', 'UNSUPPORTED_CAPABILITY');
    check(state.session==='VERIFIED','WAITING_HUMAN');
    check(positive(state.revision)&&Array.isArray(state.capabilities)&&
      new Set(state.capabilities).size===state.capabilities.length&&
      state.capabilities.every(x=>typeof x==='string'&&x.length>0),'UNSUPPORTED_CAPABILITY');
    if(required)check(state.capabilities.includes(required),'UNSUPPORTED_CAPABILITY');
    return state;
  }
  async function transport(action,context,targetKey,extra={}) {
    let result;
    try{result=await executor.execute({action,context,...(targetKey?{targetKey}:{}),...extra});}
    catch{reject(action==='inventory'||action==='read'?'UNAVAILABLE':'UNCERTAIN');}
    check(safe(result)&&sameContext(result.context,context),action==='inventory'||action==='read'?'STALE_BINDING':'UNCERTAIN');
    check(typeof result.status==='string','UNSUPPORTED_CAPABILITY');
    return result;
  }
  function assertInventory(response) {
    check(response.status==='success','UNSUPPORTED_CAPABILITY');
    // The second form is the documented discovery-v3 getGeneratorsByUser
    // payload, tagged by the Persona-bound executor rather than fetched here.
    const items=response.source==='DISCOVERY_V3_GET_GENERATORS_BY_USER'?response.generators:
      response.source==='ACCOUNT_INVENTORY'?response.items:null;
    check(Array.isArray(items)&&items.length<=100000,'UNSUPPORTED_CAPABILITY');
    check(dateOK(response.asOf),'UNSUPPORTED_CAPABILITY');
    const found=new Set(), entries=items.map(item=>{
      const e=strictAccountRow(item,response.asOf);
      check(!found.has(e.key),'CONFLICT');found.add(e.key);return e;
    });
    return entries;
  }
  async function inventory(context) {
    await inspect(context,CAP.listGenerators);
    return assertInventory(await transport('inventory',context));
  }
  async function generator(context,targetKey,alreadyOwned=false) {
    check(canonicalKey(targetKey));
    await inspect(context,CAP.read);
    if(!alreadyOwned){const rows=await inventory(context);check(rows.some(e=>e.key===targetKey),'OWNERSHIP_UNKNOWN');}
    const data=await transport('read',context,targetKey);
    check(data.status==='success','OWNERSHIP_UNKNOWN');
    const observed=normalizeReadback(data.readback,data.asOf??now());
    check(observed.ownership==='CONFIRMED','OWNERSHIP_UNKNOWN');
    return observed;
  }
  async function probe(context) {return run(async()=>{const s=await inspect(context);return success(Object.freeze([...s.capabilities]),s.revision);});}
  async function read({context,targetKey}={}) {return run(async()=>success(await generator(context,targetKey)));}
  async function observe(input) {return read(input);}
  async function listGenerators({context,cursor}={}) {return run(async()=>{
    check(cursor===undefined||(typeof cursor==='string'&&cursor.length>0&&cursor.length<128));
    const entries=await inventory(context),hash=await fingerprint(context,entries);
    let offset=0;
    if(cursor!==undefined){const parsed=/^v1\.(0|[1-9]\d*)\.([a-f0-9]{64})$/.exec(cursor);
      check(parsed,'INVALID_REQUEST');offset=Number(parsed[1]);
      check(positive(offset)&&offset>0&&offset<entries.length&&parsed[2]===hash,'STALE_REVISION');}
    const next=offset+pageSize;
    return success({items:entries.slice(offset,next),cursor:next<entries.length?`v1.${next}.${hash}`:null,
      asOf:entries[0]?.readback.asOf??now()});
  });}
  async function mutation(action,input) {return run(async()=>{
    check(safe(input)&&contextOK(input.context)&&canonicalKey(input.targetKey)&&
      positive(input.expectedRevision)&&positive(input.accountBindingEpoch)&&
      input.accountBindingEpoch===input.context.epoch&&
      typeof input.opId==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/.test(input.opId)&&
      (input.expectedSourceRevision===null||
        (typeof input.expectedSourceRevision==='string'&&input.expectedSourceRevision.length>0)));
    if(action==='save')check(filesOK(input.files));
    if(action==='setListing')check(['PUBLIC','UNLISTED'].includes(input.listing));
    const state=await inspect(input.context,CAP[action]);
    check(state.revision===input.expectedRevision,'STALE_REVISION');
    let operation; try{operation=await journal.read(input.opId);}catch{reject('RECOVERY_HOLD');}
    check(safe(operation)&&operation.phase==='PREPARED'&&operation.targetKey===input.targetKey&&
      operation.kind===action&&operation.accountBindingEpoch===input.context.epoch&&
      operation.sourceRevision===input.expectedSourceRevision,'RECOVERY_HOLD');
    const owned=await inventory(input.context),item=owned.find(e=>e.key===input.targetKey);
    if(action==='create'){
      check(input.expectedSourceRevision===null);
      check(!item,'CONFLICT');
    } else {
      check(item,'OWNERSHIP_UNKNOWN');
      const pre=await generator(input.context,input.targetKey,true);
      check(pre.sourceRevision!==null&&pre.sourceRevision===input.expectedSourceRevision,'SOURCE_DRIFT');
    }
    // This await must complete durably before the first external write.
    let begun;try{begun=await journal.dispatch(input.opId);}catch{reject('RECOVERY_HOLD');}
    check(begun?.phase==='DISPATCHING','RECOVERY_HOLD');
    let outcome,code=null,observed=null;
    try {
      const receipt=await transport(action,input.context,input.targetKey,
        action==='save'?{files:cloneFiles(input.files)}:action==='setListing'?{listing:input.listing}:{});
      const acceptable={create:'created',save:'saved',setListing:'privacy-set',delete:'deleted'}[action];
      if(receipt.status!==acceptable)code=statusMap[receipt.status]??'UNCERTAIN';
      if(!code){
        if(action==='delete'){
          const after=await inventory(input.context);
          check(!after.some(e=>e.key===input.targetKey),'UNCERTAIN');
          const probe=await transport('read',input.context,input.targetKey);
          check(probe.status==='generator-does-not-exist','UNCERTAIN');
          observed={sourceRevision:null,listing:'UNKNOWN',ownership:'UNKNOWN',asOf:now()};
        } else {
          const after=await inventory(input.context);
          check(after.some(e=>e.key===input.targetKey),'UNCERTAIN');
          observed=await generator(input.context,input.targetKey,true);
          check(observed.sourceRevision!==null,'UNCERTAIN');
          if(action==='create'||action==='setListing')check(observed.listing===(action==='create'?'UNLISTED':input.listing),'UNCERTAIN');
          if(action==='save')check(matchFiles(observed.files,input.files),'UNCERTAIN');
        }
      }
    }catch(e){code=e instanceof Fault?e.code:'UNCERTAIN';
      // A write may have applied before any error in readback. Never classify
      // ambiguous post-dispatch failures as safely retryable.
      if(['UNAVAILABLE','STALE_BINDING','UNSUPPORTED_CAPABILITY','OWNERSHIP_UNKNOWN',
           'SOURCE_DRIFT','CONFLICT'].includes(code))code='UNCERTAIN';
    }
    const disposition=code?(code==='UNCERTAIN'?'UNCERTAIN':code==='WAITING_HUMAN'?'HELD':'FAILED'):'APPLIED';
    try {const completed=await journal.complete(input.opId,{phase:disposition,
      code:code??null,remoteEvidence:code?null:{sourceRevision:observed.sourceRevision,
        listing:observed.listing,ownership:observed.ownership}});
      check(completed?.phase===disposition,'RECOVERY_HOLD');
    }catch{return err('RECOVERY_HOLD');}
    if(code)return err(code);
    return success(observed,state.revision);
  });}
  return Object.freeze({probe,read,observe,listGenerators,
    create:input=>mutation('create',input), save:input=>mutation('save',input),
    setListing:input=>mutation('setListing',input),delete:input=>mutation('delete',input)});
}

/** Consume *all* pages or fail closed. A failed/interrupted page never means empty. */
export async function collectAccountGenerators(adapter,context,{maxPages=1000}={}) {
  if(!adapter||typeof adapter.listGenerators!=='function'||!Number.isSafeInteger(maxPages)||maxPages<1) return err('INVALID_REQUEST');
  const seen=new Set(),cursors=new Set(),items=[];let cursor;
  for(let n=0;n<maxPages;n++){
    const page=await adapter.listGenerators({context,...(cursor?{cursor}:{})});
    if(!page?.ok)return page?.error?err(FAIL[page.error.code] ? page.error.code:'UNSUPPORTED_CAPABILITY'):err('UNSUPPORTED_CAPABILITY');
    if(!safe(page.result)||!Array.isArray(page.result.items)||!dateOK(page.result.asOf))return err('UNSUPPORTED_CAPABILITY');
    for(const entry of page.result.items){if(!safe(entry)||!canonicalKey(entry.key)||seen.has(entry.key)||
      !safe(entry.readback)||entry.readback.ownership!=='CONFIRMED')return err('CONFLICT');
      seen.add(entry.key);items.push(entry);}
    if(page.result.cursor===null)return success({items,cursor:null,asOf:page.result.asOf});
    if(typeof page.result.cursor!=='string'||!page.result.cursor||cursors.has(page.result.cursor))return err('CONFLICT');
    cursors.add(page.result.cursor);cursor=page.result.cursor;
  }
  return err('RECOVERY_HOLD');
}