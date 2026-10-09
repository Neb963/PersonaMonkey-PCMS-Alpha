/** P202 — Persona-bound accounts. No browser, network, native, or credential authority. */
import { id, text, revision } from '../../domain/validation.js';
import { normalizeAccount, normalizeGenerator, normalizeGeneratorKey } from '../../domain/records.js';
import { collectAccountGenerators } from '../../providers/perchance/adapter.mjs';

const ERR=Object.freeze({
  INVALID_REQUEST:'Invalid account request.',
  STALE_REVISION:'Account storage revision changed.',
  STALE_BINDING:'Account Persona binding changed.',
  UNSUPPORTED_CAPABILITY:'Account-scoped provider capability is unverified.',
  OWNERSHIP_UNKNOWN:'Authenticated ownership was not confirmed.',
  SOURCE_DRIFT:'Observed provider source changed.',
  CONFLICT:'Account or Persona already bound.',
  RATE_LIMIT:'Provider request budget exhausted.',
  WAITING_HUMAN:'Manual login or challenge handling is required.',
  RECOVERY_HOLD:'Uncertain operation requires reconciliation.',
  NOT_APPLIED:'Account does not exist.',
  UNCERTAIN:'External mutation is ambiguous; do not retry.',
  UNAVAILABLE:'Account service is unavailable.'
});
class Fault extends Error {constructor(code){super(ERR[code]||ERR.UNAVAILABLE);this.code=Object.hasOwn(ERR,code)?code:'UNAVAILABLE';}}
function check(test,code='INVALID_REQUEST'){if(!test)throw new Fault(code);}
const success=(result,revision)=>({ok:true,result,revision});
const fail=(code,revision=0)=>({ok:false,error:{code,message:ERR[code],retryable:code==='UNAVAILABLE'||code==='RATE_LIMIT'},revision});
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&(Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
const validOp=x=>{id(x);check(x.length<=180);return x;};
const ONGOING=new Set(['PREPARED','DISPATCHING','UNCERTAIN','HELD']);
const LOGIN_URL='https://perchance.org/';
// PersonaMonkey integration v1 accepts only canonical, durable UUID identities.
const UID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mutation(input){
  check(plain(input)&&plain(input.options||{}));
  revision(input.expectedRevision);revision(input.accountBindingEpoch,1);validOp(input.opId);
  if(input.accountId!==undefined)id(input.accountId);
  return input.options||{};
}
function bindingMatches(context,account){
  return plain(context)&&context.accountId===account.accountId&&context.personaUid===account.personaUid&&
    context.epoch===account.epoch&&nonnegative(context.routeRevision)&&nonnegative(context.capabilityRevision);
}

/** The trusted Core supplies P102 storage, a typed Persona Broker, P103 adapter,
 * and an account-bound provider-context factory; user UI never supplies context.
 * No live Perchance session or real-route acceptance is inferred by this module. */
export function createAccountsService({storage,broker,perchance,contextForAccount,
  now=()=>new Date().toISOString(),randomId=()=>globalThis.crypto.randomUUID()}={}){
  check(storage&&['read','list','commit'].every(k=>typeof storage[k]==='function'));
  check(broker&&typeof broker.request==='function');
  check(perchance&&typeof perchance.probe==='function'&&typeof perchance.listGenerators==='function');
  check(typeof contextForAccount==='function'&&typeof now==='function'&&typeof randomId==='function');
  let lastRevision=0;
  async function run(task){
    try{return await task();}
    catch(e){const code=e?.code&&Object.hasOwn(ERR,e.code)?e.code:'UNAVAILABLE';return fail(code,lastRevision);}
  }
  async function read(kind,key){
    const value=await storage.read(kind,key);lastRevision=value.revision;return value;
  }
  async function listKind(kind){
    const value=await storage.list(kind);lastRevision=value.revision;return value;
  }
  async function save(expectedRevision,writes){
    const value=await storage.commit({expectedRevision,writes});lastRevision=value.revision;return value;
  }
  async function accountById(accountId){
    const item=(await read('account',id(accountId))).item;
    check(item?.record,'NOT_APPLIED');return item.record;
  }
  async function assertNoAccountHold(accountId){
    const operations=await listKind('operation');
    check(!operations.items.some(item=>item.record.targetKey===accountId&&
      ONGOING.has(item.record.phase)),'RECOVERY_HOLD');
  }
  function guard(params,account,globalRevision){
    check(params.expectedRevision===globalRevision,'STALE_REVISION');
    check(params.accountBindingEpoch===account.epoch,'STALE_BINDING');
  }
  async function requestRead(command,params){
    const requestId=id('p202-read-'+randomId());
    const reply=await broker.request({version:1,requestId,command,params});
    check(plain(reply)&&reply.version===1&&reply.requestId===requestId&&
      nonnegative(reply.revision)&&typeof reply.bootId==='string'&&reply.ok===true,'UNAVAILABLE');
    return reply;
  }
  async function requestAction(command,params,opId){
    const pre=await requestRead('system.describe',{});
    const requestId=id('p202-write-'+randomId());
    const reply=await broker.request({version:1,requestId,command,params,operationId:opId,
      precondition:{bootId:pre.bootId,revision:pre.revision}});
    check(plain(reply)&&reply.version===1&&reply.requestId===requestId&&
      reply.operationId===opId&&reply.ok===true&&typeof reply.bootId==='string'&&
      nonnegative(reply.revision),'UNCERTAIN');
    return reply.result;
  }
  async function move(opId,phase,remoteEvidence){
    const current=await read('operation',opId);
    check(current.item,'RECOVERY_HOLD');
    await save(current.revision,[{kind:'operation',expectedRevision:current.item.revision,
      record:{...current.item.record,phase,...(remoteEvidence?{remoteEvidence}:{})}}]);
  }
  async function prepared(opId,kind,targetKey,epoch,expectedRevision){
    await assertNoAccountHold(targetKey);
    check((await read('operation',opId)).item===null,'RECOVERY_HOLD');
    check(expectedRevision===lastRevision,'STALE_REVISION');
    const record={opId,kind,targetKey,sourceRevision:'none',accountBindingEpoch:epoch,
      phase:'PREPARED',startedAt:now()};
    await save(expectedRevision,[{kind:'operation',expectedRevision:0,record}]);
    await move(opId,'DISPATCHING'); // durable before the first external side effect
  }
  async function uncertain(opId){
    try{await move(opId,'UNCERTAIN');}catch{} // DISPATCHING itself is a durable replay fence
  }
  async function external(opId,kind,targetKey,epoch,command,params,confirm,expectedRevision){
    await prepared(opId,kind,targetKey,epoch,expectedRevision);
    let evidence;
    try{
      const result=await requestAction(command,params,opId);
      evidence=await confirm(result);
      check(plain(evidence)&&Object.keys(evidence).length>0,'UNCERTAIN');
    }catch{
      await uncertain(opId);
      throw new Fault('UNCERTAIN');
    }
    try{await move(opId,'APPLIED',evidence);}
    catch{throw new Fault('RECOVERY_HOLD');}
    return evidence;
  }
  async function openAttempt(accountId,opId){
    const account=await accountById(accountId),expected=lastRevision;
    await external(opId,'persona.open',accountId,account.epoch,'persona.open',
      {personaUid:account.personaUid,url:LOGIN_URL,active:true,allowDirect:false},
      async result=>{
        check(plain(result)&&result.personaUid===account.personaUid&&
          Number.isSafeInteger(result.tabId)&&result.tabId>0,'UNCERTAIN');
        const observed=(await requestRead('persona.get',{personaUid:account.personaUid})).result;
        check(plain(observed)&&observed.personaUid===account.personaUid,'UNCERTAIN');
        // TabId is recorded so the owner can retire ONLY its own attempt later.
        return {personaUid:account.personaUid,tabId:result.tabId,ownedAttempt:true};
      },expected);
  }
  async function createAccount(params,options){
    check(params.accountBindingEpoch===1);
    check(Object.keys(options).every(k=>['action','name','routeId'].includes(k)));
    const name=text(options.name||'Perchance account',256);
    const accountId=id(params.accountId||('account-'+params.opId));
    const generatedUid=randomId();
    check(typeof generatedUid==='string'&&UID.test(generatedUid));
    const personaUid=id(generatedUid.toLowerCase());
    if(options.routeId!==undefined)id(options.routeId);
    const current=await read('account',accountId);
    check(!current.item,'CONFLICT');
    check(current.revision===params.expectedRevision,'STALE_REVISION');
    await prepared(params.opId,'persona.create',accountId,1,params.expectedRevision);
    try{
      const response=await requestAction('persona.create',{
        personaUid,name,...(options.routeId?{routeId:options.routeId}:{}),allowDirect:false
      },params.opId);
      check(plain(response)&&plain(response.persona)&&response.persona.personaUid===personaUid,'UNCERTAIN');
      const observed=(await requestRead('persona.get',{personaUid})).result;
      check(plain(observed)&&observed.personaUid===personaUid,'UNCERTAIN');
    }catch{
      await uncertain(params.opId);
      throw new Fault('UNCERTAIN');
    }
    const preparedRecord=await read('operation',params.opId);
    const account=normalizeAccount({accountId,personaUid,epoch:1,name,sessionState:'WAITING_HUMAN',
      revision:0,asOf:now()});
    try{
      await save(preparedRecord.revision,[
        {kind:'account',expectedRevision:0,record:account},
        {kind:'operation',expectedRevision:preparedRecord.item.revision,record:{
          ...preparedRecord.item.record,phase:'APPLIED',remoteEvidence:{personaUid,confirmed:true}
        }}
      ]);
    }catch{throw new Fault('RECOVERY_HOLD');}
    await openAttempt(accountId,params.opId+'-open');
    return accountById(accountId);
  }
  async function retryRoute(accountId,routeId,opId){
    const account=await accountById(accountId);
    id(routeId);
    const observed=(await requestRead('persona.get',{personaUid:account.personaUid})).result;
    check(plain(observed)&&observed.personaUid===account.personaUid,'STALE_BINDING');
    await external(opId+'-route','route.assign',accountId,account.epoch,'route.assign',
      {personaUid:account.personaUid,routeId,allowDirect:false},
      async result=>{
        check(plain(result)&&plain(result.route)&&result.route.id===routeId&&plain(result.persona)&&
          result.persona.personaUid===account.personaUid,'UNCERTAIN');
        return {personaUid:account.personaUid,routeId,confirmed:true};
      },lastRevision);
    const latest=await read('account',accountId);
    const test=await external(opId+'-test','route.test',accountId,account.epoch,'route.test',
      {personaUid:account.personaUid,allowDirect:false},
      async result=>{
        check(plain(result)&&typeof result.ok==='boolean','UNCERTAIN');
        return {routeTested:true,healthy:result.ok};
      },latest.revision);
    if(test.healthy!==true)throw new Fault('WAITING_HUMAN');
    await openAttempt(accountId,opId+'-open');
  }
  async function enroll(params){
    return run(async()=>{
      const options=mutation(params),action=options.action||'BEGIN';
      check(['BEGIN','OPEN','RETRY_ROUTE'].includes(action));
      if(action==='BEGIN')return success(await createAccount(params,options),lastRevision);
      check(Object.keys(options).every(k=>action==='OPEN'?k==='action':['action','routeId'].includes(k)));
      const account=await accountById(params.accountId);
      guard(params,account,lastRevision);
      if(action==='OPEN')await openAttempt(account.accountId,params.opId);
      else{
        check(typeof options.routeId==='string');
        await retryRoute(account.accountId,options.routeId,params.opId);
      }
      return success(await accountById(account.accountId),lastRevision);
    });
  }
  async function verifySession(params){
    return run(async()=>{
      const options=mutation(params);
      check(Object.keys(options).every(k=>k==='manualDone')&&options.manualDone===true,'WAITING_HUMAN');
      const account=await accountById(params.accountId);
      guard(params,account,lastRevision);
      await assertNoAccountHold(account.accountId);
      const context=await contextForAccount(Object.freeze({...account}));
      check(bindingMatches(context,account),'STALE_BINDING');
      const probe=await perchance.probe(context);
      if(!probe?.ok)throw new Fault(probe?.error?.code||'WAITING_HUMAN');
      // Never use public recent-generator feed, and never infer an empty inventory
      // from partial, looping or stale pagination.
      const listing=await collectAccountGenerators(perchance,context);
      if(!listing?.ok)throw new Fault(listing?.error?.code||'UNSUPPORTED_CAPABILITY');
      check(listing.result?.cursor===null&&Array.isArray(listing.result.items),'UNSUPPORTED_CAPABILITY');
      const existing=await listKind('generator');
      check(existing.revision===params.expectedRevision,'STALE_REVISION');
      const byKey=new Map(existing.items.map(x=>[x.record.key,x.record]));
      const missing=[];
      for(const entry of listing.result.items){
        const key=normalizeGeneratorKey(entry.key);
        check(entry.readback?.ownership==='CONFIRMED','OWNERSHIP_UNKNOWN');
        const old=byKey.get(key);
        if(old){
          check(old.accountId===account.accountId&&old.personaUid===account.personaUid&&
            old.accountBindingEpoch===account.epoch,'CONFLICT');
          continue; // Never change a previously opted-in generator's intent.
        }
        missing.push(normalizeGenerator({
          key,accountId:account.accountId,personaUid:account.personaUid,
          accountBindingEpoch:account.epoch,fleetIntent:'EXCLUDED',
          listingObserved:entry.readback.listing,deployState:'IMPORTED',refreshState:'SLEEPING',
          sourceBinding:null,releaseId:null,revision:0,asOf:now(),attentionRefs:[]
        }));
      }
      // P102 caps a commit at 64 writes. On interrupted import the account
      // remains WAITING_HUMAN; a subsequent explicit verification resumes.
      for(let i=0;i<missing.length;i+=64){
        const global=(await read('account',account.accountId)).revision;
        await save(global,missing.slice(i,i+64).map(record=>({kind:'generator',expectedRevision:0,record})));
      }
      const latest=await read('account',account.accountId);
      check(latest.item?.record.personaUid===account.personaUid&&latest.item.record.epoch===account.epoch,
        'STALE_BINDING');
      await save(latest.revision,[{kind:'account',expectedRevision:latest.item.revision,record:{
        ...latest.item.record,sessionState:'VERIFIED',revision:latest.item.revision,asOf:now()
      }}]);
      return success(await accountById(account.accountId),lastRevision);
    });
  }
  async function impact(accountId){
    const account=await accountById(accountId);
    const [generators,operations]=await Promise.all([listKind('generator'),listKind('operation')]);
    const owned=generators.items.map(x=>x.record).filter(g=>g.accountId===accountId);
    const keys=new Set([accountId,...owned.map(g=>g.key)]);
    const held=operations.items.map(x=>x.record).filter(op=>keys.has(op.targetKey)&&ONGOING.has(op.phase));
    return {account,owned,held,revision:Math.max(generators.revision,operations.revision)};
  }
  async function previewRebind(params){
    return run(async()=>{
      check(plain(params)&&typeof params.accountId==='string');
      const state=await impact(id(params.accountId));
      return success(['Persona '+state.account.personaUid+' bound at epoch '+state.account.epoch,
        'Affected generators: '+state.owned.length,
        ...state.owned.map(g=>'Generator '+g.key+' ('+g.fleetIntent+')'),
        ...state.held.map(op=>'Blocked operation '+op.opId+' in '+op.phase)],lastRevision);
    });
  }
  async function rebind(params){
    return run(async()=>{
      const options=mutation(params);
      check(Object.keys(options).every(k=>['personaUid','confirm'].includes(k))&&
        options.confirm===true&&typeof options.personaUid==='string');
      const nextUid=id(options.personaUid);
      check(UID.test(nextUid));
      const state=await impact(params.accountId);
      guard(params,state.account,state.revision);
      check(nextUid!==state.account.personaUid,'CONFLICT');
      check(state.held.length===0,'RECOVERY_HOLD');
      check(state.owned.length<=63,'RECOVERY_HOLD'); // account+generators atomically
      const accounts=await listKind('account');
      check(accounts.items.every(x=>x.record.accountId===state.account.accountId||
        x.record.personaUid!==nextUid),'CONFLICT');
      const observed=(await requestRead('persona.get',{personaUid:nextUid})).result;
      check(plain(observed)&&observed.personaUid===nextUid,'STALE_BINDING');
      const latest=await read('account',state.account.accountId);
      check(latest.revision===params.expectedRevision,'STALE_REVISION');
      const updated=normalizeAccount({...state.account,personaUid:nextUid,
        epoch:state.account.epoch+1,sessionState:'WAITING_HUMAN',
        revision:latest.item.revision,asOf:now()});
      const writes=[
        {kind:'account',expectedRevision:latest.item.revision,record:updated},
        ...state.owned.map(g=>({kind:'generator',expectedRevision:g.revision,
          record:{...g,personaUid:nextUid,accountBindingEpoch:updated.epoch,asOf:now()}}))
      ];
      await save(params.expectedRevision,writes);
      return success(await accountById(state.account.accountId),lastRevision);
    });
  }
  async function get(params){
    return run(async()=>{
      check(plain(params)&&typeof params.accountId==='string');
      const result=await read('account',id(params.accountId));
      check(result.item,'NOT_APPLIED');
      return success(result.item.record,result.revision);
    });
  }
  async function list(params={}){
    return run(async()=>{
      check(plain(params));
      const limit=params.limit===undefined?100:params.limit;
      check(Number.isSafeInteger(limit)&&limit>=1&&limit<=200);
      const data=await listKind('account');
      let offset=0;
      if(params.cursor!==undefined){
        check(typeof params.cursor==='string');
        const parsed=/^v1\.(\d+)\.(\d+)$/.exec(params.cursor);
        check(parsed&&Number(parsed[1])===data.revision,'STALE_REVISION');
        offset=Number(parsed[2]);check(Number.isSafeInteger(offset)&&offset>=0);
      }
      const rows=data.items.map(x=>x.record).sort((a,b)=>a.accountId.localeCompare(b.accountId));
      check(offset<=rows.length);
      const next=offset+limit;
      return success({items:rows.slice(offset,next),
        cursor:next<rows.length?'v1.'+data.revision+'.'+next:null,asOf:now()},data.revision);
    });
  }
  return Object.freeze({list,get,enroll,verifySession,previewRebind,rebind});
}
