/** P401 Core-only supply composition; P301/P103 retain remote execution authority. */
import { parsePastedSlugs, selectReservationAccount } from '../../features/reservation/service.mjs';
import { collectAccountGenerators } from '../../providers/perchance/adapter.mjs';
import { normalizeGenerator, normalizeGeneratorKey } from '../../domain/records.js';

const MESSAGES = Object.freeze({
  INVALID_REQUEST:'Invalid supply request.', CONFLICT:'Generator or source mapping conflict.',
  STALE_REVISION:'Supply state changed.', STALE_BINDING:'Account Persona binding changed.',
  OWNERSHIP_UNKNOWN:'Generator ownership was not confirmed.',
  UNSUPPORTED_CAPABILITY:'Required provider capability is unavailable.',
  WAITING_HUMAN:'Operator intervention is required.', RECOVERY_HOLD:'Reconciliation is required.',
  NOT_APPLIED:'Remote reservation was not confirmed.',
  UNCERTAIN:'Remote operation is ambiguous; reconcile first.',
  UNAVAILABLE:'Supply dependency is unavailable.', RATE_LIMIT:'Provider request budget exhausted.',
  SOURCE_DRIFT:'Pinned GitHub source has changed.'
});
const HALT = new Set(['UNCERTAIN','RECOVERY_HOLD','STALE_REVISION','STALE_BINDING',
  'UNAVAILABLE','RATE_LIMIT','WAITING_HUMAN','OWNERSHIP_UNKNOWN','SOURCE_DRIFT']);
const IMPORT = 'P401_GITHUB_FIRST';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,89}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
class Fault extends Error { constructor(code) { super(code); this.code = code; } }
const check = (condition, code='INVALID_REQUEST') => { if (!condition) throw new Fault(code); };
const codeOf = e => Object.hasOwn(MESSAGES,e?.code) ? e.code : 'UNAVAILABLE';
const success = (result, revision) => ({ok:true,result,revision});
const failure = (code,revision) => ({ok:false,error:{code,message:MESSAGES[code],
  retryable:code==='UNAVAILABLE'||code==='RATE_LIMIT'},revision});
function trusted(result) {
  check(plain(result) && typeof result.ok === 'boolean','UNSUPPORTED_CAPABILITY');
  if (!result.ok) throw new Fault(Object.hasOwn(MESSAGES,result.error?.code) ?
    result.error.code : 'UNAVAILABLE');
  return result.result;
}
const intention = op => op?.remoteEvidence?.intent;
function validKey(key) {
  check(typeof key === 'string' && (key === 'hub' || key.length >= 4 && key.length <= 80 &&
    /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(key)));
  normalizeGeneratorKey(key); return key;
}
function validOp(opId) { check(typeof opId === 'string' && ID.test(opId)); }

/** P103's import-only journal persists transitions in the shared P102 operation store.
 * Construct the P103 adapter with this journal and the existing Persona-owned executor.
 */
export function createSupplyImportJournal(storage) {
  check(storage && typeof storage.read === 'function' && typeof storage.commit === 'function');
  async function move(opId,allowed,phase,observation) {
    const row = await storage.read('operation',opId), old = row.item?.record;
    check(old?.kind === 'create' && intention(old)?.reservation === IMPORT &&
      allowed.includes(old.phase),'RECOVERY_HOLD');
    const next = {...old,phase,...(observation ? {remoteEvidence:{
      ...old.remoteEvidence,observation}}:{})};
    await storage.commit({expectedRevision:row.revision,writes:[{
      kind:'operation',expectedRevision:row.item.revision,record:next
    }]});
    return {...next,sourceRevision:null};
  }
  return Object.freeze({
    async read(opId) {
      const row = await storage.read('operation',opId),op = row.item?.record;
      return op?.kind === 'create' && intention(op)?.reservation === IMPORT ?
        {...op,sourceRevision:null} : null;
    },
    dispatch:opId=>move(opId,['PREPARED'],'DISPATCHING'),
    complete:(opId,result)=>{
      check(plain(result) && ['APPLIED','UNCERTAIN','HELD','FAILED'].includes(result.phase),
        'RECOVERY_HOLD');
      return move(opId,['DISPATCHING'],result.phase==='FAILED'?'HELD':result.phase,
        result.remoteEvidence ?? null);
    }
  });
}

/** Call from the background Core only. No timers, tabs, raw RPC or generic queues. */
export function createSupplyFlow({storage,reservation,sources,perchance,importPerchance=null,
  contextForAccount,assertMutationAllowed=async()=>{},now=()=>new Date().toISOString()}={}) {
  check(storage && ['read','list','commit'].every(x=>typeof storage[x]==='function') &&
    reservation && ['preview','reserve','reconcile'].every(x=>typeof reservation[x]==='function') &&
    sources && ['get','resolveRelease'].every(x=>typeof sources[x]==='function') &&
    perchance && typeof perchance.listGenerators==='function' &&
    typeof contextForAccount==='function' && typeof assertMutationAllowed==='function' &&
    typeof now==='function' && (!importPerchance ||
      typeof importPerchance.probe==='function' && typeof importPerchance.create==='function'));
  let revision=0;
  async function read(kind,key) { const x=await storage.read(kind,key);revision=x.revision;return x; }
  async function list(kind) { const x=await storage.list(kind);revision=x.revision;return x; }
  async function commit(expectedRevision,writes) {
    const x=await storage.commit({expectedRevision,writes});revision=x.revision;return x;
  }
  async function run(fn) {
    try { return success(await fn(),revision); }
    catch(e) { return failure(codeOf(e),revision); }
  }
  async function context(account) {
    check(account?.sessionState==='VERIFIED','WAITING_HUMAN');
    const ctx=await contextForAccount(Object.freeze({...account}));
    check(plain(ctx) && ctx.accountId===account.accountId &&
      ctx.personaUid===account.personaUid && ctx.epoch===account.epoch &&
      Number.isSafeInteger(ctx.routeRevision) && ctx.routeRevision>=0 &&
      Number.isSafeInteger(ctx.capabilityRevision) && ctx.capabilityRevision>=0,
    'STALE_BINDING');
    return ctx;
  }
  async function ready(key,folder) {
    const binding=trusted(await sources.get({key}));
    check(plain(binding) && binding.slug===key && binding.ref==='main' &&
      binding.status==='READY' && SHA256.test(binding.releaseId||'') &&
      (folder===undefined || binding.folder===folder),'CONFLICT');
    const release=trusted(await sources.resolveRelease({key}));
    check(release?.releaseId===binding.releaseId &&
      release.source?.commitSha===binding.commitSha,'SOURCE_DRIFT');
    return binding;
  }
  async function findOwner(key,accounts) {
    let owner=null;
    for (const account of accounts) {
      if (account.sessionState!=='VERIFIED') continue;
      const ctx=await context(account);
      const inventory=trusted(await collectAccountGenerators(perchance,ctx));
      check(Array.isArray(inventory?.items) && inventory.cursor===null,'UNSUPPORTED_CAPABILITY');
      const found=inventory.items.find(x=>x.key===key);
      if (!found) continue;
      check(!owner,'CONFLICT');
      check(found.readback?.ownership==='CONFIRMED' &&
        ['PUBLIC','UNLISTED'].includes(found.readback.listing) &&
        typeof found.readback.sourceRevision==='string' &&
        found.readback.sourceRevision.length>0,'OWNERSHIP_UNKNOWN');
      owner={account,readback:found.readback};
    }
    return owner;
  }
  async function moveImport(op,phase,observation) {
    const row=await read('operation',op.opId);
    check(row.item?.record.phase===op.phase && row.item.record.kind==='create' &&
      intention(row.item.record)?.reservation===IMPORT,'RECOVERY_HOLD');
    await commit(row.revision,[{kind:'operation',expectedRevision:row.item.revision,
      record:{...row.item.record,phase,...(observation?{
        remoteEvidence:{...row.item.record.remoteEvidence,observation}}:{})}}]);
    return (await read('operation',op.opId)).item.record;
  }
  async function bindLocal(key,binding,owner) {
    const latest=await ready(key,binding.folder);
    check(latest.commitSha===binding.commitSha && latest.releaseId===binding.releaseId,
      'SOURCE_DRIFT');
    const row=await read('generator',key),prior=row.item?.record;
    check(!prior || prior.accountId===owner.account.accountId &&
      prior.personaUid===owner.account.personaUid &&
      prior.accountBindingEpoch===owner.account.epoch,'STALE_BINDING');
    check(!prior?.sourceBinding || prior.sourceBinding.repository===binding.repository &&
      prior.sourceBinding.folder===binding.folder &&
      prior.sourceBinding.slug===key,'CONFLICT');
    if (prior?.sourceBinding?.commitSha===binding.commitSha &&
        prior.sourceBinding?.releaseId===binding.releaseId) return prior;
    const asOf=now();
    check(typeof asOf==='string' && !Number.isNaN(Date.parse(asOf)),'UNAVAILABLE');
    const record=prior?{...prior,sourceBinding:binding,asOf}:normalizeGenerator({
      key,accountId:owner.account.accountId,personaUid:owner.account.personaUid,
      accountBindingEpoch:owner.account.epoch,fleetIntent:'EXCLUDED',
      listingObserved:owner.readback.listing,deployState:'RESERVED',
      refreshState:'INELIGIBLE',sourceBinding:binding,releaseId:null,
      revision:0,asOf,attentionRefs:[]
    });
    await commit(row.revision,[{kind:'generator',expectedRevision:row.item?.revision??0,record}]);
    return (await read('generator',key)).item.record;
  }
  async function importImpl({key,opId,folder}) {
    validKey(key);validOp(opId);
    check(folder===undefined || typeof folder==='string');
    const binding=await ready(key,folder);
    const accountsRow=await list('account'),operationsRow=await list('operation');
    check(accountsRow.revision===operationsRow.revision,'STALE_REVISION');
    const accounts=accountsRow.items.map(x=>x.record);
    const old=(await read('operation',opId)).item?.record;
    check(!old || old.kind==='create' && old.targetKey===key &&
      intention(old)?.reservation===IMPORT && intention(old)?.folder===binding.folder,
    'CONFLICT');
    check(!operationsRow.items.some(({record:op})=>op.opId!==opId &&
      op.kind==='create' && op.targetKey===key &&
      !['NOT_APPLIED','FAILED'].includes(op.phase)),'RECOVERY_HOLD');
    const owner=await findOwner(key,accounts);
    if (old) {
      const expected=intention(old);
      const account=accounts.find(x=>x.accountId===expected.accountId);
      check(account?.personaUid===expected.personaUid &&
        account?.epoch===old.accountBindingEpoch,'STALE_BINDING');
      check(expected.repository===binding.repository &&
        expected.folder===binding.folder &&
        expected.commitSha===binding.commitSha &&
        expected.releaseId===binding.releaseId,'SOURCE_DRIFT');
      if (!owner) {
        if (old.phase==='APPLIED') throw new Fault('RECOVERY_HOLD');
        if (['PREPARED','DISPATCHING','UNCERTAIN','HELD'].includes(old.phase))
          await moveImport(old,'NOT_APPLIED',{absenceConfirmed:true,at:now()});
        throw new Fault('NOT_APPLIED');
      }
      check(owner.account.accountId===expected.accountId &&
        owner.readback.listing==='UNLISTED','RECOVERY_HOLD');
      let next=old;
      if (next.phase==='PREPARED') next=await moveImport(next,'DISPATCHING');
      if (['DISPATCHING','UNCERTAIN','HELD'].includes(next.phase))
        next=await moveImport(next,'APPLIED',{
          ownership:'CONFIRMED',listing:'UNLISTED',
          sourceRevision:owner.readback.sourceRevision
        });
      check(next.phase==='APPLIED','RECOVERY_HOLD');
    } else if (!owner) {
      check(importPerchance,'UNSUPPORTED_CAPABILITY');
      await assertMutationAllowed();
      // Reuse P301's balancing semantics; count P401 remote creates as new reservations.
      const counted=operationsRow.items.map(x=>x.record).map(op=>{
        const i=intention(op);
        return i?.reservation===IMPORT?{...op,remoteEvidence:{
          ...op.remoteEvidence,intent:{...i,reservation:'P301'}}}:op;
      });
      const account=selectReservationAccount(accounts,counted);
      const ctx=await context(account);
      const probe=await importPerchance.probe(ctx);
      const caps=trusted(probe);
      check(Array.isArray(caps) && caps.includes('generator.create') &&
        caps.includes('generator.list') && Number.isSafeInteger(probe.revision),
      'UNSUPPORTED_CAPABILITY');
      const before=await read('operation',opId);
      check(!before.item && before.revision===operationsRow.revision,'STALE_REVISION');
      await commit(before.revision,[{kind:'operation',expectedRevision:0,record:{
        opId,kind:'create',targetKey:key,sourceRevision:'none',
        accountBindingEpoch:account.epoch,phase:'PREPARED',startedAt:now(),
        remoteEvidence:{intent:{reservation:IMPORT,accountId:account.accountId,
          personaUid:account.personaUid,folder:binding.folder,
          repository:binding.repository,commitSha:binding.commitSha,
          releaseId:binding.releaseId}}
      }}]);
      trusted(await importPerchance.create({context:ctx,targetKey:key,opId,
        expectedRevision:probe.revision,accountBindingEpoch:account.epoch,
        expectedSourceRevision:null}));
      check((await read('operation',opId)).item?.record.phase==='APPLIED','RECOVERY_HOLD');
      const confirmed=await findOwner(key,accounts);
      check(confirmed?.account.accountId===account.accountId &&
        confirmed.readback.listing==='UNLISTED','RECOVERY_HOLD');
      const record=await bindLocal(key,binding,confirmed);
      return {key,mode:'GITHUB_FIRST',opId,phase:'APPLIED',source:record.sourceBinding};
    }
    const record=await bindLocal(key,binding,owner);
    return {key,mode:'GITHUB_FIRST',opId:old?opId:null,phase:'APPLIED',
      source:record.sourceBinding};
  }
  async function reserveImpl(key,opId,folder) {
    const prior=(await read('operation',opId)).item?.record;
    if (prior) {
      check(prior.kind==='create' && prior.targetKey===key &&
        intention(prior)?.reservation==='P301' &&
        (folder===undefined || intention(prior).folder===folder),'CONFLICT');
      return {key,mode:'RESERVATION',opId,operation:trusted(await reservation.reconcile({
        key,opId,expectedRevision:revision,accountBindingEpoch:prior.accountBindingEpoch
      }))};
    }
    const accounts=await list('account'),ops=await list('operation');
    check(accounts.revision===ops.revision,'STALE_REVISION');
    const chosen=selectReservationAccount(accounts.items.map(x=>x.record),
      ops.items.map(x=>x.record));
    return {key,mode:'RESERVATION',opId,operation:trusted(await reservation.reserve({
      key,opId,expectedRevision:ops.revision,accountBindingEpoch:chosen.epoch,
      ...(folder===undefined?{}:{options:{folder}})
    }))};
  }
  return Object.freeze({
    preview:({text}={})=>run(()=>reservation.preview({key:text}).then(trusted)),
    importReady:params=>run(()=>importImpl(params||{})),
    /** Stable deterministic operation IDs; one pass does at most 16 serial tasks. */
    processBatch:({text,batchId,offset=0,limit=16,imports=[]}={})=>run(async()=>{
      check(typeof batchId==='string' && /^[A-Za-z0-9_-]{1,32}$/.test(batchId) &&
        Number.isSafeInteger(offset) && offset>=0 &&
        Number.isSafeInteger(limit) && limit>=1 && limit<=16 &&
        Array.isArray(imports) && imports.length<=10000);
      const keys=parsePastedSlugs(text);
      check(offset<keys.length);
      const mappings=new Map();
      const keySet=new Set(keys);
      for (const item of imports) {
        check(plain(item) && Object.keys(item).sort().join(',')==='folder,key' &&
          typeof item.folder==='string' && keySet.has(item.key) &&
          !mappings.has(item.key));
        mappings.set(item.key,item.folder);
      }
      const items=[];let nextOffset=offset,halted=false;
      for (let i=offset;i<Math.min(keys.length,offset+limit);i++) {
        const key=keys[i],opId='sup.'+batchId+'.'+i;
        validOp(opId);
        const item=await run(()=>mappings.has(key)?
          importImpl({key,opId,folder:mappings.get(key)}):reserveImpl(key,opId));
        items.push({key,opId,...item});
        if (!item.ok && HALT.has(item.error.code)) {halted=true;break;}
        nextOffset=i+1;
      }
      return {total:keys.length,items,nextOffset,
        cursor:nextOffset<keys.length?nextOffset:null,
        halted,maxConcurrentMutations:1};
    })
  });
}
