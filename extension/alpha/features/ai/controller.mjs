/** P303. Background-only native Perchance AI coordinator. All browser execution
 * is delegated to a verified PersonaMonkey-owned native-session boundary. */
import { countAiSlots, validateAiTask } from './store.mjs';

const CODES = Object.freeze({
  INVALID_REQUEST:'Invalid AI review request.', STALE_REVISION:'AI review state changed.',
  STALE_BINDING:'Account Persona binding changed.', UNSUPPORTED_CAPABILITY:'Native Perchance AI capability is not verified.',
  OWNERSHIP_UNKNOWN:'Generator ownership is not confirmed.', SOURCE_DRIFT:'Saved editor source needs reconciliation.',
  CONFLICT:'An AI session or approval already owns this target.', RATE_LIMIT:'AI session capacity has been reached.',
  WAITING_HUMAN:'Manual session or challenge resolution is required.',
  RECOVERY_HOLD:'An uncertain AI session must be reconciled, never restarted blindly.',
  NOT_APPLIED:'AI review task does not exist.', UNCERTAIN:'Native session dispatch outcome is uncertain.',
  UNAVAILABLE:'AI review service is unavailable.'
});
const CODE_SET = new Set(Object.keys(CODES));
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const check = (x, code = 'INVALID_REQUEST') => { if (!x) { const e = new Error(CODES[code]); e.code = code; throw e; } };
const codeOf = e => CODE_SET.has(e?.code) ? e.code : 'UNAVAILABLE';
const result = (data, revision) => ({ok:true,result:data,revision});
const failure = (code, revision) => ({ok:false,error:{code,message:CODES[code],retryable:code==='UNAVAILABLE'||code==='RATE_LIMIT'},revision});
const validId = x => typeof x === 'string' && ID.test(x);
const validHash = x => typeof x === 'string' && HASH.test(x);
const nonnegative = x => Number.isSafeInteger(x) && x >= 0;
const project = t => ({id:t.id,key:t.key,accountId:t.accountId,state:t.state,sourceHash:t.savedSourceHash,
  provenanceRefs:[...t.provenanceRefs],approvalRevision:t.approvalRevision});
function safeInput(p) {
  check(plain(p) && validId(p.opId) && validId(p.accountId) && SLUG.test(p.key) &&
    nonnegative(p.expectedRevision) && nonnegative(p.accountBindingEpoch) && p.accountBindingEpoch > 0 &&
    (p.options === undefined || plain(p.options)));
  return p.options ?? {};
}
function validateBinding(observed, p) {
  check(plain(observed) && observed.accountId === p.accountId && observed.key === p.key &&
    validId(observed.personaUid) && observed.epoch === p.accountBindingEpoch &&
    validHash(observed.sourceHash) && typeof observed.sourceRevision === 'string' && observed.sourceRevision.length > 0 &&
    observed.listing === 'UNLISTED' && nonnegative(observed.revision), 'STALE_BINDING');
}
function editorAddress(key, url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'perchance.org' && !u.port &&
    !u.username && !u.password && !u.search && u.pathname === `/${key}` && u.hash === '#edit'; }
  catch { return false; }
}
function assertTaskBinding(task, observed) {
  check(observed.personaUid === task.personaUid && observed.epoch === task.bindingEpoch &&
    observed.accountId === task.accountId && observed.key === task.key, 'STALE_BINDING');
}
function reviewId(params) {
  const id = params?.options?.taskId;
  check(validId(id)); return id;
}
function validateStatus(value, task, completedAllowed = true) {
  check(plain(value) && validId(value.sessionId) && value.sessionId === task.sessionId && value.operationId===task.opId && value.key === task.key &&
    value.accountId === task.accountId && value.personaUid === task.personaUid &&
    value.bindingEpoch === task.bindingEpoch &&
    ['ACTIVE','WAITING_HUMAN',...(completedAllowed?['COMPLETED','FAILED']:[])].includes(value.state), 'RECOVERY_HOLD');
}
export const AI_TEST_PROMPT = 'Test the existing generator with short functional checks. Correct only observed problems. Add concise human-readable code comments explaining each modification. Keep the user in control of saving and approval.';

/** identity.verify({accountId,key,accountBindingEpoch}) must read P102 state
 * and independently confirm provider ownership with P103. Native `start` and
 * `inspect` must be backed by PersonaMonkey's control lease/browser execution,
 * never direct tabs, network, or a second AI engine. */
export function createAiSessionController({store,identity,native,verifySaved,
  now=()=>new Date().toISOString(),maxRunningPerAccount=1}={}) {
  check(store && typeof store.read==='function' && typeof store.change==='function' &&
    identity && typeof identity.verify==='function' &&
    typeof now==='function' && Number.isSafeInteger(maxRunningPerAccount) &&
    maxRunningPerAccount >= 1 && maxRunningPerAccount <= 4);
  let lastRevision = 0;
  async function run(fn) { try{return await fn();}catch(e){return failure(codeOf(e),lastRevision);} }
  async function bound(p) {
    const binding = await identity.verify({accountId:p.accountId,key:p.key,accountBindingEpoch:p.accountBindingEpoch});
    validateBinding(binding,p); lastRevision=binding.revision; return binding;
  }
  async function authorizeNative(binding) {
    check(native && typeof native.probe==='function' && typeof native.start==='function' &&
      typeof native.inspect==='function', 'UNSUPPORTED_CAPABILITY');
    const p = await native.probe({binding});
    check(plain(p) && p.authority==='PERSONA_MONKEY' && p.capability==='PERCHANCE_NATIVE_AI' &&
      p.available===true && p.origin==='https://perchance.org', 'UNSUPPORTED_CAPABILITY');
  }
  async function lookup(taskId) {
    check(validId(taskId));const ledger=await store.read();
    const task=ledger.tasks.find(t=>t.id===taskId);
    check(task,'NOT_APPLIED');return {ledger,task};
  }
  async function change(expected,mutate){return store.change(expected,mutate);}
  async function start(p) {return run(async()=>{
    const opts=safeInput(p); check(Object.keys(opts).every(k=>k==='taskId'||k==='expectedSourceHash'));
    const binding=await bound(p); check(p.expectedRevision===binding.revision,'STALE_REVISION');
    if(opts.expectedSourceHash!==undefined)check(opts.expectedSourceHash===binding.sourceHash,'SOURCE_DRIFT');
    await authorizeNative(binding);
    const taskId=opts.taskId??('ai:'+p.opId);check(validId(taskId));
    const snapshot=await store.read();
    // No duplicate provider start on replay, including after a dispatch crash.
    check(!snapshot.tasks.some(t=>t.id===taskId || t.opId===p.opId ||
      (t.accountId===p.accountId && t.key===p.key && t.state!=='FAILED')), 'CONFLICT');
    check(countAiSlots(snapshot.tasks,p.accountId)<maxRunningPerAccount,'RATE_LIMIT');
    const task=validateAiTask({id:taskId,key:p.key,accountId:p.accountId,personaUid:binding.personaUid,
      bindingEpoch:binding.epoch,revision:1,state:'RECOVERING',createdAt:now(),updatedAt:now(),
      sourceHash:binding.sourceHash,sourceRevision:binding.sourceRevision,
      savedSourceHash:null,savedSourceRevision:null,sessionId:null,opId:p.opId,dispatchPhase:'PREPARED',
      provenanceRefs:[],approvalRevision:null,approvalOpId:null,reviewPending:false,failureCode:null});
    await change(snapshot.revision,draft=>{
      check(!draft.tasks.some(t=>t.id===taskId||t.opId===p.opId||
        (t.accountId===p.accountId&&t.key===p.key&&t.state!=='FAILED')),'CONFLICT');
      check(countAiSlots(draft.tasks,p.accountId)<maxRunningPerAccount,'RATE_LIMIT');
      draft.tasks.push(task);
    });
    // DISPATCHING is persisted before native execution, even if no reply arrives.
    const beforeDispatch=await bound(p);
    check(beforeDispatch.sourceRevision===binding.sourceRevision &&
      beforeDispatch.sourceHash===binding.sourceHash && beforeDispatch.personaUid===binding.personaUid, 'SOURCE_DRIFT');
    let row=await lookup(taskId);
    await change(row.ledger.revision,draft=>{
      const t=draft.tasks.find(t=>t.id===taskId);
      check(t.dispatchPhase==='PREPARED','RECOVERY_HOLD');
      t.dispatchPhase='DISPATCHING';t.revision++;t.updatedAt=now();
    });
    let started;
    try {
      started=await native.start({binding,task:structuredClone(task),prompt:AI_TEST_PROMPT,operationId:p.opId});
      check(plain(started) && validId(started.sessionId) && started.operationId===task.opId && started.key===task.key &&
        started.accountId===task.accountId && started.personaUid===task.personaUid &&
        started.bindingEpoch===task.bindingEpoch && ['ACTIVE','WAITING_HUMAN'].includes(started.state), 'UNCERTAIN');
    }catch(e){
      // A dispatched mutation may have applied. No restart, cancel or retry here.
      try {
        row=await lookup(taskId);
        await change(row.ledger.revision,draft=>{
          const t=draft.tasks.find(t=>t.id===taskId);
          t.dispatchPhase='UNCERTAIN';t.state='RECOVERING';t.revision++;t.updatedAt=now();t.failureCode='UNCERTAIN';
        });
      }catch{check(false,'RECOVERY_HOLD');}
      check(false,'UNCERTAIN');
    }
    row=await lookup(taskId);
    await change(row.ledger.revision,draft=>{
      const t=draft.tasks.find(t=>t.id===taskId);
      check(t.dispatchPhase==='DISPATCHING' && t.sessionId===null,'RECOVERY_HOLD');
      t.state=started.state;t.sessionId=started.sessionId;t.dispatchPhase='APPLIED';
      t.revision++;t.updatedAt=now();
    });
    return result(project((await lookup(taskId)).task),binding.revision);
  });}
  async function reconnect({taskId}={}) {return run(async()=>{
    let {task,ledger}=await lookup(taskId);
    const binding=await bound({accountId:task.accountId,key:task.key,accountBindingEpoch:task.bindingEpoch});
    assertTaskBinding(task,binding);
    if(['COMPLETED','FAILED','READY'].includes(task.state)) return result(project(task),binding.revision);
    await authorizeNative(binding);
    // This is OBSERVATION ONLY. Never replay start, even for PREPARED tasks.
    let observation;
    try { observation=await native.inspect({task:structuredClone(task),binding}); }
    catch {check(false,'RECOVERY_HOLD');}
    check(plain(observation) && validId(observation.sessionId) && observation.operationId===task.opId && observation.key===task.key &&
      observation.accountId===task.accountId && observation.personaUid===task.personaUid &&
      observation.bindingEpoch===task.bindingEpoch &&
      ['ACTIVE','WAITING_HUMAN','COMPLETED','FAILED'].includes(observation.state),'RECOVERY_HOLD');
    check(task.sessionId===null || task.sessionId===observation.sessionId,'RECOVERY_HOLD');
    // Native COMPLETED alone cannot prove a saved source. Retain slot pending review verification.
    const next=observation.state==='COMPLETED'?'WAITING_HUMAN':observation.state;
    await change(ledger.revision,draft=>{
      const t=draft.tasks.find(x=>x.id===task.id);
      check(t.revision===task.revision,'STALE_REVISION');
      t.state=next;t.sessionId=observation.sessionId;t.dispatchPhase='APPLIED';
      t.failureCode=next==='WAITING_HUMAN'?'WAITING_HUMAN':null;
      t.revision++;t.updatedAt=now();
    });
    return result(project((await lookup(taskId)).task),binding.revision);
  });}
  async function recordReview(p) {return run(async()=>{
    const opts=safeInput(p);check(Object.keys(opts).every(k=>k==='taskId'||k==='expectedTaskRevision'));
    const taskId=reviewId(p),{task,ledger}=await lookup(taskId);
    check(task.accountId===p.accountId && task.key===p.key && task.bindingEpoch===p.accountBindingEpoch,'STALE_BINDING');
    check(nonnegative(opts.expectedTaskRevision)&&opts.expectedTaskRevision===task.revision,'STALE_REVISION');
    check(['ACTIVE','WAITING_HUMAN','RECOVERING'].includes(task.state),'CONFLICT');
    const binding=await bound(p);assertTaskBinding(task,binding);check(p.expectedRevision===binding.revision,'STALE_REVISION');
    await authorizeNative(binding);
    check(typeof verifySaved==='function','UNSUPPORTED_CAPABILITY');
    const observed=await native.inspect({task:structuredClone(task),binding});
    // Only native completion PLUS authoritative Perchance saved-source readback
    // may release the session slot; AI transcript never constitutes save proof.
    validateStatus(observed,{...task,sessionId:task.sessionId??observed?.sessionId});
    check(observed.state==='COMPLETED','WAITING_HUMAN');
    const saved=await verifySaved({binding,task:structuredClone(task),observed});
    check(plain(saved)&&saved.confirmed===true && validHash(saved.sourceHash) &&
      typeof saved.sourceRevision==='string' && saved.sourceRevision.length>0 &&
      Array.isArray(saved.provenanceRefs)&&saved.provenanceRefs.length<=128 &&
      saved.provenanceRefs.every(validId) && new Set(saved.provenanceRefs).size===saved.provenanceRefs.length &&
      saved.sourceRevision===binding.sourceRevision,
      'SOURCE_DRIFT');
    const current=(await lookup(taskId));
    check(current.task.revision===task.revision,'STALE_REVISION');
    await change(current.ledger.revision,draft=>{
      const t=draft.tasks.find(x=>x.id===taskId);
      check(t.revision===task.revision,'STALE_REVISION');
      t.state='COMPLETED';t.savedSourceHash=saved.sourceHash;t.savedSourceRevision=saved.sourceRevision;
      t.provenanceRefs=[...saved.provenanceRefs];t.reviewPending=true;t.dispatchPhase='APPLIED';
      t.sessionId=observed.sessionId;t.failureCode=null;t.revision++;t.updatedAt=now();
    });
    return result(project((await lookup(taskId)).task),binding.revision);
  });}
  async function approveIntent(p) {return run(async()=>{
    const opts=safeInput(p);check(Object.keys(opts).every(k=>
      ['taskId','expectedTaskRevision','sourceHash','sourceRevision','editorUrl'].includes(k)));
    const taskId=reviewId(p),{task,ledger}=await lookup(taskId);
    check(task.accountId===p.accountId&&task.key===p.key&&task.bindingEpoch===p.accountBindingEpoch,'STALE_BINDING');
    check(task.state==='COMPLETED'&&task.reviewPending&&task.approvalRevision===null,'CONFLICT');
    check(opts.expectedTaskRevision===task.revision,'STALE_REVISION');
    check(opts.sourceHash===task.savedSourceHash && opts.sourceRevision===task.savedSourceRevision &&
      editorAddress(task.key,opts.editorUrl),'SOURCE_DRIFT');
    const binding=await bound(p);assertTaskBinding(task,binding);
    check(binding.revision===p.expectedRevision,'STALE_REVISION');
    // A newer source observation invalidates an old #edit overlay, even if a
    // pending review still exists. Approval is only a durable INTENT for P402.
    check(binding.sourceRevision===task.savedSourceRevision,'SOURCE_DRIFT');
    if(typeof verifySaved!=='function') check(false,'UNSUPPORTED_CAPABILITY');
    const saved=await verifySaved({binding,task:structuredClone(task),purpose:'APPROVAL'});
    check(saved?.confirmed===true&&saved.sourceHash===task.savedSourceHash&&
      saved.sourceRevision===task.savedSourceRevision,'SOURCE_DRIFT');
    await change(ledger.revision,draft=>{
      const t=draft.tasks.find(x=>x.id===taskId);
      check(t.revision===task.revision&&t.approvalRevision===null,'STALE_REVISION');
      t.revision++;t.approvalRevision=t.revision;t.approvalOpId=p.opId;
      t.reviewPending=false;t.updatedAt=now();
    });
    return result(project((await lookup(taskId)).task),binding.revision);
  });}
  async function get(p={}) {return run(async()=>{
    check(plain(p)&&validId(p.key));const {task}=await lookup(p.key);
    if(p.accountId!==undefined)check(p.accountId===task.accountId,'OWNERSHIP_UNKNOWN');
    return result(project(task),lastRevision);
  });}
  async function queue(p={}) {return run(async()=>{
    check(plain(p) && (p.accountId===undefined||validId(p.accountId)) &&
      (p.limit===undefined||(Number.isSafeInteger(p.limit)&&p.limit>0&&p.limit<=200)));
    const ledger=await store.read(), all=ledger.tasks.filter(t=>p.accountId===undefined||t.accountId===p.accountId)
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    let offset=0;
    if(p.cursor!==undefined) {const match=/^v1\.(\d+)\.(\d+)$/.exec(p.cursor);
      check(match&&Number(match[1])===ledger.revision,'STALE_REVISION');offset=Number(match[2]);
      check(nonnegative(offset)&&offset>0&&offset<all.length,'INVALID_REQUEST');}
    const next=offset+(p.limit??100);
    return result({items:all.slice(offset,next).map(project),cursor:next<all.length?`v1.${ledger.revision}.${next}`:null,
      asOf:now()},lastRevision);
  });}
  return Object.freeze({start,reconnect,recordReview,approveIntent,get,queue});
}

/** Trusted provider identity composition, no raw Perchance HTTP or browser APIs. */
export function createAiIdentity({storage,perchance,contextForAccount}={}) {
  check(storage && typeof storage.read==='function' && perchance && typeof perchance.read==='function' &&
    typeof contextForAccount==='function');
  return Object.freeze({ async verify({accountId,key,accountBindingEpoch}) {
    check(validId(accountId)&&SLUG.test(key)&&nonnegative(accountBindingEpoch)&&accountBindingEpoch>0);
    const a=await storage.read('account',accountId),g=await storage.read('generator',key);
    const account=a.item?.record,generator=g.item?.record;
    check(account&&generator&&generator.accountId===accountId,'OWNERSHIP_UNKNOWN');
    check(account.epoch===accountBindingEpoch&&generator.accountBindingEpoch===accountBindingEpoch&&
      account.personaUid===generator.personaUid,'STALE_BINDING');
    check(account.sessionState==='VERIFIED','WAITING_HUMAN');
    const context=await contextForAccount(account);
    check(context?.accountId===accountId&&context.personaUid===account.personaUid&&
      context.epoch===accountBindingEpoch,'STALE_BINDING');
    const provider=await perchance.read({context,targetKey:key});
    if(!provider?.ok)check(false,CODE_SET.has(provider?.error?.code)?provider.error.code:'UNAVAILABLE');
    check(provider.result?.ownership==='CONFIRMED','OWNERSHIP_UNKNOWN');
    check(provider.result?.listing==='UNLISTED'&&typeof provider.result?.sourceRevision==='string'&&
      provider.result.sourceRevision.length>0,'SOURCE_DRIFT');
    check(validHash(generator.releaseId),'SOURCE_DRIFT');
    return Object.freeze({accountId,key,personaUid:account.personaUid,epoch:accountBindingEpoch,
      sourceHash:generator.releaseId,sourceRevision:provider.result.sourceRevision,
      listing:provider.result.listing,revision:g.revision});
  } });
}
