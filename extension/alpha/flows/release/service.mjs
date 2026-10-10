/** P402: durable release composition. P302/P303/P103/P104 remain the sole
 * deployer, AI, Perchance and GitHub mutation authorities. No browser APIs. */
import { canonicalReleaseId } from '../../features/sources/catalog.mjs';
import { createGitHubPathTemplates } from '../../providers/github/paths.mjs';
import { validateAiTask } from '../../features/ai/store.mjs';

const CODES = new Set(['INVALID_REQUEST','STALE_REVISION','STALE_BINDING',
  'UNSUPPORTED_CAPABILITY','OWNERSHIP_UNKNOWN','SOURCE_DRIFT','CONFLICT','RATE_LIMIT',
  'WAITING_HUMAN','RECOVERY_HOLD','NOT_APPLIED','UNCERTAIN','UNAVAILABLE']);
const HASH = /^[a-f0-9]{64}$/, SHA = /^[a-f0-9]{40}$/, IDENT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const OPEN = new Set(['PREPARED','DISPATCHING','UNCERTAIN','HELD']);
const check = (condition, code = 'INVALID_REQUEST') => {
  if (!condition) throw Object.assign(new Error(code), {code});
};
const failCode = e => CODES.has(e?.code) ? e.code : 'UNAVAILABLE';
const okay = (result, revision = 0) => ({ok:true,result,revision});
const errorResult = (e, revision = 0) => {
  const code = failCode(e);
  return {ok:false,error:{code,message:code,retryable:code==='RATE_LIMIT'||code==='UNAVAILABLE'},revision};
};
function unwrap(reply) {
  check(reply && typeof reply.ok === 'boolean', 'UNSUPPORTED_CAPABILITY');
  if (!reply.ok) check(false,CODES.has(reply.error?.code)?reply.error.code:'UNAVAILABLE');
  return reply.result;
}
const exactBytes = (a,b) => a instanceof Uint8Array && b instanceof Uint8Array &&
  a.length === b.length && a.every((byte,i) => byte === b[i]);
const sameFiles = (a,b) => a && b && a.pjs===b.pjs && a.html===b.html &&
  exactBytes(a.thumbnail,b.thumbnail);
const sleeping = g => g && g.deployState!=='ACTIVE' &&
  (g.refreshState==='SLEEPING' ||
   (g.releaseId===null && g.deployState==='UNDEPLOYED' && g.refreshState==='INELIGIBLE'));
function input(p) {
  check(p && typeof p==='object' && !Array.isArray(p) &&
    /^[a-z0-9][a-z0-9_-]{0,99}$/.test(p.key) &&
    IDENT.test(p.accountId||'') &&
    Number.isSafeInteger(p.accountBindingEpoch) && p.accountBindingEpoch>0 &&
    p.context?.accountId===p.accountId &&
    p.context?.epoch===p.accountBindingEpoch &&
    IDENT.test(p.context?.personaUid||'') && IDENT.test(p.opId||''));
  return p;
}
async function hashFiles(files) {
  check(files && typeof files.pjs==='string' && typeof files.html==='string' &&
    files.thumbnail instanceof Uint8Array,'SOURCE_DRIFT');
  try {
    return await canonicalReleaseId({pjs:new TextEncoder().encode(files.pjs),
      html:new TextEncoder().encode(files.html),thumbnail:files.thumbnail});
  } catch {check(false,'SOURCE_DRIFT');}
}
/**
 * All storage writes use P102 global + record CAS. Approval operations and GitHub
 * child operations are durable before remote calls. A DISPATCHING/UNCERTAIN
 * writeback lacking verified commit evidence is never automatically replayed.
 */
export function createReleaseFlow({storage,sourceCatalog,deployer,ai,aiStore,
  provider,github,journal,core,repository='Neb963/per-gens',secretRef,
  pathTemplates={},clock=()=>new Date().toISOString()}={}) {
  check(storage && ['read','list','commit'].every(k=>typeof storage[k]==='function') &&
    sourceCatalog && ['scan','resolveRelease'].every(k=>typeof sourceCatalog[k]==='function') &&
    deployer && ['prepare','apply','rollback'].every(k=>typeof deployer[k]==='function') &&
    ai && ['start','approveIntent'].every(k=>typeof ai[k]==='function') &&
    aiStore && typeof aiStore.read==='function' &&
    provider && ['probe','read','setListing'].every(k=>typeof provider[k]==='function') &&
    github && ['snapshot','commit','readBlob'].every(k=>typeof github[k]==='function') &&
    journal && ['prepare','read'].every(k=>typeof journal[k]==='function') &&
    core && ['assertCurrent','assertMutationAllowed'].every(k=>typeof core[k]==='function') &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
    /^[A-Za-z0-9_-]{1,80}$/.test(secretRef||'') && typeof clock==='function');
  const templates=createGitHubPathTemplates(pathTemplates), encode=new TextEncoder();
  const now=()=>clock();
  let lastRevision=0;
  const run=async fn=>{try{return await fn();}catch(e){return errorResult(e,lastRevision);}};
  async function read(kind,key) {
    const row=await storage.read(kind,key);
    check(row && Number.isSafeInteger(row.revision),'RECOVERY_HOLD');
    lastRevision=row.revision;
    return row;
  }
  async function op(opId) {const row=await read('operation',opId);return row.item?.record||null;}
  async function confirmed(p, staged=false) {
    await core.assertCurrent();
    const a=await read('account',p.accountId),g=await read('generator',p.key);
    check(a.revision===g.revision,'STALE_REVISION');
    const account=a.item?.record,gen=g.item?.record;
    check(account && gen && account.sessionState==='VERIFIED','WAITING_HUMAN');
    check(gen.accountId===p.accountId && gen.personaUid===p.context.personaUid &&
      account.personaUid===p.context.personaUid &&
      account.epoch===p.accountBindingEpoch &&
      gen.accountBindingEpoch===p.accountBindingEpoch,'STALE_BINDING');
    check(sleeping(gen) || staged && gen.deployState==='STAGED' &&
      (gen.refreshState==='SLEEPING'||gen.refreshState==='INELIGIBLE'),'CONFLICT');
    check(!gen.attentionRefs?.some(ref=>ref.startsWith('deployer.failed.')),'CONFLICT');
    return {gen,row:g};
  }
  async function remote(p,listing) {
    const r=unwrap(await provider.read({context:p.context,targetKey:p.key}));
    check(r && r.ownership==='CONFIRMED' &&
      ['PUBLIC','UNLISTED'].includes(r.listing) &&
      typeof r.sourceRevision==='string' && r.sourceRevision.length>0 &&
      r.files?.thumbnail instanceof Uint8Array,'OWNERSHIP_UNKNOWN');
    if(listing)check(r.listing===listing,'SOURCE_DRIFT');
    return r;
  }
  async function state(opId,allowed,phase,details,patch=null,release=null) {
    const o=await read('operation',opId);
    check(o.item && allowed.includes(o.item.record.phase),'RECOVERY_HOLD');
    const writes=[{kind:'operation',expectedRevision:o.item.revision,
      record:{...o.item.record,phase,remoteEvidence:details}}];
    if(patch) {
      const g=await read('generator',o.item.record.targetKey);
      check(g.revision===o.revision && g.item &&
        g.item.record.accountBindingEpoch===o.item.record.accountBindingEpoch,
      'STALE_BINDING');
      writes.push({kind:'generator',expectedRevision:g.item.revision,
        record:{...g.item.record,...patch,asOf:now()}});
    }
    if(release) {
      const known=await read('release',release.releaseId);
      check(known.revision===o.revision,'STALE_REVISION');
      if(known.item)check(sameFiles(known.item.record.files,release.files) &&
        known.item.record.source.commitSha===release.source.commitSha,'CONFLICT');
      else writes.push({kind:'release',expectedRevision:0,record:release});
    }
    await storage.commit({expectedRevision:o.revision,writes});return op(opId);
  }
  async function stageOp(p,idValue) {
    check(IDENT.test(idValue||''),'INVALID_REQUEST');
    const x=await op(idValue);
    check(x && x.kind==='deployer.apply' && x.phase==='APPLIED' &&
      x.targetKey===p.key && x.accountBindingEpoch===p.accountBindingEpoch &&
      HASH.test(x.remoteEvidence?.intent?.releaseId||'') &&
      x.remoteEvidence?.observation?.listing==='UNLISTED','RECOVERY_HOLD');
    return x;
  }
  async function stagedRelease(p,stage) {
    const id=stage.remoteEvidence.intent.releaseId;
    const row=await read('release',id),r=row.item?.record;
    check(r && r.releaseId===id && r.source?.status==='READY' &&
      r.source.ref==='main' && r.source.slug===p.key &&
      r.source.repository===repository && SHA.test(r.source.commitSha),'SOURCE_DRIFT');
    check(await hashFiles(r.files)===id,'SOURCE_DRIFT');
    return r;
  }
  async function headProof(release) {
    const paths=templates.resolve({folder:release.source.folder,slug:release.source.slug});
    const expected=Object.values(paths);
    check(expected.every(path=>SHA.test(release.source.blobs[path]||'')),'SOURCE_DRIFT');
    const head=unwrap(await github.snapshot({repository,ref:'main',paths:expected}));
    check(head && head.commitSha===release.source.commitSha &&
      expected.every(path=>head.blobs[path]===release.source.blobs[path]),'CONFLICT');
    return paths;
  }
  async function taskFor(p,taskId,stage) {
    check(IDENT.test(taskId||''),'INVALID_REQUEST');
    const ledger=await aiStore.read();
    const matches=ledger.tasks.filter(t=>t.id===taskId);
    check(matches.length===1,'NOT_APPLIED');
    const t=validateAiTask(matches[0]);
    check(t.key===p.key && t.accountId===p.accountId &&
      t.personaUid===p.context.personaUid && t.bindingEpoch===p.accountBindingEpoch &&
      t.sourceHash===stage.remoteEvidence.intent.releaseId &&
      t.state==='COMPLETED' && HASH.test(t.savedSourceHash||'') &&
      t.savedSourceRevision && t.dispatchPhase==='APPLIED','WAITING_HUMAN');
    return t;
  }
  async function launchAi(p,stageId,aiOpId) {
    const st=await stageOp(p,stageId);
    await confirmed(p,true);
    const release=await stagedRelease(p,st),r=await remote(p,'UNLISTED');
    check(sameFiles(r.files,release.files),'SOURCE_DRIFT');
    const binding=await read('generator',p.key);
    return unwrap(await ai.start({opId:aiOpId,key:p.key,accountId:p.accountId,
      accountBindingEpoch:p.accountBindingEpoch,expectedRevision:binding.revision,
      options:{expectedSourceHash:release.releaseId}}));
  }
  async function prepareStage(p) {
    input(p);check(IDENT.test(p.aiOpId||''),'INVALID_REQUEST');
    await core.assertMutationAllowed();
    const {gen}=await confirmed(p);
    const next=unwrap(await sourceCatalog.resolveRelease({key:p.key}));
    check(next.source?.status==='READY' && next.source.ref==='main' &&
      next.source.repository===repository && next.releaseId!==gen.releaseId,'NOT_APPLIED');
    const old=await op(p.opId);
    check(!old,'CONFLICT');
    const d={opId:p.opId,key:p.key,accountId:p.accountId,
      accountBindingEpoch:p.accountBindingEpoch,expectedRevision:gen.revision,
      options:{context:p.context}};
    unwrap(await deployer.prepare(d));
    const applied=unwrap(await deployer.apply(d));
    check(applied.phase==='APPLIED','RECOVERY_HOLD');
    const aiResult=await ai.start({opId:p.aiOpId,key:p.key,accountId:p.accountId,
      accountBindingEpoch:p.accountBindingEpoch,
      expectedRevision:(await read('generator',p.key)).revision,
      options:{expectedSourceHash:next.releaseId}});
    // A missing native capability leaves a verified unlisted stage, not a
    // false approval or speculative browser automation.
    if(!aiResult?.ok) return errorResult(
      Object.assign(new Error(aiResult?.error?.code||'UNAVAILABLE'),{
        code:aiResult?.error?.code||'UNAVAILABLE'}),lastRevision);
    return okay({state:'AI_PENDING',stageOpId:p.opId,taskId:aiResult.result.id},lastRevision);
  }
  async function writeback(p,parent,stage,release,approved,paths) {
    if(sameFiles(approved,release.files))return release;
    check(exactBytes(approved.thumbnail,release.files.thumbnail),'SOURCE_DRIFT');
    const files={},expectedBlobs={};
    for(const [field,path] of [['pjs',paths.pjs],['html',paths.html]]) {
      if(approved[field]!==release.files[field]) {
        files[path]=encode.encode(approved[field]);
        expectedBlobs[path]=release.source.blobs[path];
      }
    }
    check(Object.keys(files).length>0,'SOURCE_DRIFT');
    const childId=p.opId+'.git';
    let child=await op(childId);
    if(child) {
      check(child.kind==='release.writeback' && child.targetKey===p.key &&
        child.accountBindingEpoch===p.accountBindingEpoch,'RECOVERY_HOLD');
      check(child.phase==='APPLIED','RECOVERY_HOLD');
      const adopted=await read('release',child.remoteEvidence?.releaseId);
      check(adopted.item && adopted.item.record.releaseId===await hashFiles(approved),
        'RECOVERY_HOLD');
      return adopted.item.record;
    }
    const g=await read('generator',p.key);
    const prepared={opId:childId,kind:'release.writeback',targetKey:p.key,
      sourceRevision:g.item.record.revision,accountBindingEpoch:p.accountBindingEpoch,
      phase:'PREPARED',startedAt:now(),
      remoteEvidence:{stageReleaseId:release.releaseId,expectedHeadSha:release.source.commitSha}};
    await storage.commit({expectedRevision:g.revision,writes:[
      {kind:'operation',expectedRevision:0,record:prepared}]});
    await state(childId,['PREPARED'],'DISPATCHING',prepared.remoteEvidence);
    let receipt;
    try {
      receipt=unwrap(await github.commit({repository,ref:'main',
        expectedHeadSha:release.source.commitSha,expectedBlobs,files,secretRef,
        opId:childId}));
    } catch(e) {
      const code=failCode(e);
      await state(childId,['DISPATCHING'],
        code==='UNCERTAIN'||code==='UNAVAILABLE'?'UNCERTAIN':'HELD',
        {disposition:code,stageReleaseId:release.releaseId});
      throw e;
    }
    try {
      check(SHA.test(receipt?.commitSha),'UNCERTAIN');
      const expected={...release.source.blobs,...receipt.blobs};
      const snapshot=unwrap(await github.snapshot({repository,ref:'main',
        paths:Object.values(paths)}));
      check(snapshot.commitSha===receipt.commitSha &&
        Object.keys(expected).every(path=>snapshot.blobs[path]===expected[path]),
      'UNCERTAIN');
      for(const [path,bytes] of Object.entries(files)) {
        const observed=unwrap(await github.readBlob({repository,blobSha:expected[path]}));
        check(exactBytes(observed,bytes),'UNCERTAIN');
      }
      const releaseId=await hashFiles(approved);
      const result={releaseId,source:{...release.source,commitSha:receipt.commitSha,
        blobs:expected,releaseId},files:approved,createdAt:now()};
      await state(childId,['DISPATCHING'],'APPLIED',
        {commitSha:receipt.commitSha,releaseId,stageReleaseId:release.releaseId},
        null,result);
      return result;
    } catch(e) {
      // GitHub may already be mutated. Preserve UNCERTAIN, never replay commit.
      try {await state(childId,['DISPATCHING'],'UNCERTAIN',
        {disposition:'READBACK_REQUIRED',stageReleaseId:release.releaseId});}
      catch {check(false,'RECOVERY_HOLD');}
      throw e;
    }
  }
  async function finalize(p,parent,release) {
    const observed=await remote(p,'PUBLIC');
    check(sameFiles(observed.files,release.files) &&
      await hashFiles(observed.files)===release.releaseId,'RECOVERY_HOLD');
    const {gen}=await confirmed(p,true);
    check(gen.deployState==='STAGED' && gen.releaseId===parent.remoteEvidence.intent.previousReleaseId,
      'CONFLICT');
    const opRow=await read('operation',p.opId);
    check(opRow.item?.record.phase==='DISPATCHING','RECOVERY_HOLD');
    const genRow=await read('generator',p.key);
    check(genRow.revision===opRow.revision,'STALE_REVISION');
    const patch={...genRow.item.record,releaseId:release.releaseId,
      sourceBinding:release.source,deployState:'DEPLOYED',fleetIntent:'MANAGED',
      listingObserved:'PUBLIC',refreshState:'SLEEPING',
      asOf:now()};
    await storage.commit({expectedRevision:opRow.revision,writes:[
      {kind:'operation',expectedRevision:opRow.item.revision,
        record:{...opRow.item.record,phase:'APPLIED',remoteEvidence:{
          ...opRow.item.record.remoteEvidence,commitSha:release.source.commitSha,
          releaseId:release.releaseId,listing:'PUBLIC',
          providerRevision:observed.sourceRevision}}},
      {kind:'generator',expectedRevision:genRow.item.revision,record:patch}]});
    // Do not call Refresher.planPass: approval must not allocate an active slot.
    return {state:'DEPLOYED',releaseId:release.releaseId,
      commitSha:release.source.commitSha,listing:'PUBLIC',refreshState:'SLEEPING'};
  }
  async function publish(p,parent,release) {
    await confirmed(p,true);
    const before=await remote(p,'UNLISTED');
    check(sameFiles(before.files,release.files) &&
      await hashFiles(before.files)===release.releaseId,'SOURCE_DRIFT');
    const proof=await github.snapshot({repository,ref:'main',
      paths:Object.values(templates.resolve({folder:release.source.folder,slug:p.key}))});
    const latest=unwrap(proof);
    check(latest.commitSha===release.source.commitSha &&
      Object.keys(release.source.blobs).every(path=>
        latest.blobs[path]===release.source.blobs[path]),'CONFLICT');
    if(parent.phase==='PREPARED') parent=await state(p.opId,['PREPARED'],'DISPATCHING',
      parent.remoteEvidence);
    check(parent.phase==='DISPATCHING','RECOVERY_HOLD');
    const childId=p.opId+'.public';
    const previous=await journal.read(childId);
    // Even after a crash, a possibly dispatched listing operation is NEVER
    // repeated. Only authoritative public readback may finish the parent.
    check(!previous,'RECOVERY_HOLD');
    const probe=await provider.probe(p.context);
    const capabilities=unwrap(probe);
    check(Array.isArray(capabilities) &&
      capabilities.includes('generator.setPrivacy') &&
      Number.isSafeInteger(probe.revision),'UNSUPPORTED_CAPABILITY');
    await journal.prepare({opId:childId,kind:'setListing',targetKey:p.key,
      sourceRevision:before.sourceRevision,
      accountBindingEpoch:p.accountBindingEpoch});
    unwrap(await provider.setListing({context:p.context,targetKey:p.key,
      opId:childId,expectedRevision:probe.revision,
      accountBindingEpoch:p.accountBindingEpoch,
      expectedSourceRevision:before.sourceRevision,listing:'PUBLIC'}));
    return finalize(p,parent,release);
  }
  async function markReady(p) {
    input(p);check(IDENT.test(p.stageOpId||'') && IDENT.test(p.taskId||'') &&
      Number.isSafeInteger(p.expectedTaskRevision) &&
      typeof p.editorUrl==='string','INVALID_REQUEST');
    await core.assertMutationAllowed();
    const {gen}=await confirmed(p,true);
    check(gen.deployState==='STAGED','CONFLICT');
    const stage=await stageOp(p,p.stageOpId),release=await stagedRelease(p,stage);
    const t=await taskFor(p,p.taskId,stage);
    check(t.revision===p.expectedTaskRevision ||
      t.approvalOpId===p.opId,'STALE_REVISION');
    check(t.approvalRevision===null || t.approvalOpId===p.opId,'CONFLICT');
    const approved=await remote(p,'UNLISTED');
    check(t.savedSourceRevision===approved.sourceRevision &&
      await hashFiles(approved.files)===t.savedSourceHash,'SOURCE_DRIFT');
    const path=await headProof(release);
    const existing=await op(p.opId);
    const intent={stageOpId:p.stageOpId,taskId:t.id,
      stageReleaseId:release.releaseId,approvedHash:t.savedSourceHash,
      expectedHeadSha:release.source.commitSha,
      providerRevision:approved.sourceRevision,previousReleaseId:gen.releaseId};
    if(existing) {
      check(existing.kind==='release.approval' && existing.targetKey===p.key &&
        existing.accountBindingEpoch===p.accountBindingEpoch &&
        existing.remoteEvidence.intent.stageReleaseId===intent.stageReleaseId &&
        existing.remoteEvidence.intent.approvedHash===intent.approvedHash,'RECOVERY_HOLD');
      check(existing.phase==='PREPARED'||existing.phase==='DISPATCHING','RECOVERY_HOLD');
    } else {
      const row=await read('generator',p.key);
      await storage.commit({expectedRevision:row.revision,writes:[{
        kind:'operation',expectedRevision:0,record:{
          opId:p.opId,kind:'release.approval',targetKey:p.key,
          sourceRevision:gen.revision,accountBindingEpoch:p.accountBindingEpoch,
          phase:'PREPARED',startedAt:now(),remoteEvidence:{intent}}}]});
    }
    if(t.approvalRevision===null) {
      const g=await read('generator',p.key);
      unwrap(await ai.approveIntent({opId:p.opId,key:p.key,accountId:p.accountId,
        accountBindingEpoch:p.accountBindingEpoch,expectedRevision:g.revision,
        options:{taskId:t.id,expectedTaskRevision:t.revision,
          sourceHash:t.savedSourceHash,sourceRevision:t.savedSourceRevision,
          editorUrl:p.editorUrl}}));
    }
    const parent=await op(p.opId);
    const adopted=await writeback(p,parent,stage,release,approved.files,path);
    return okay(await publish(p,parent,adopted),lastRevision);
  }
  async function reconcile(p) {
    input(p);await core.assertMutationAllowed();
    const parent=await op(p.opId);
    check(parent && parent.kind==='release.approval' && parent.phase==='DISPATCHING' &&
      parent.targetKey===p.key && parent.accountBindingEpoch===p.accountBindingEpoch,
      'RECOVERY_HOLD');
    const stage=await stageOp(p,parent.remoteEvidence.intent.stageOpId);
    const baseline=await stagedRelease(p,stage);
    const child=await op(p.opId+'.git');
    check(!child || child.phase==='APPLIED','RECOVERY_HOLD');
    const adopted=child ? (await read('release',child.remoteEvidence.releaseId)).item?.record : baseline;
    check(adopted,'RECOVERY_HOLD');
    const latest=unwrap(await github.snapshot({repository,ref:'main',
      paths:Object.values(templates.resolve({folder:adopted.source.folder,slug:p.key}))}));
    check(latest.commitSha===adopted.source.commitSha &&
      Object.keys(adopted.source.blobs).every(path=>latest.blobs[path]===adopted.source.blobs[path]),
      'RECOVERY_HOLD');
    const current=await remote(p);
    check(current.listing==='PUBLIC' && sameFiles(current.files,adopted.files),
      'RECOVERY_HOLD');
    return okay(await finalize(p,parent,adopted),lastRevision);
  }
  return Object.freeze({
    scanReady({cursor,limit=32}={}) {return run(async()=>{
      const page=unwrap(await sourceCatalog.scan({cursor,limit}));
      const inv=await storage.list('generator');
      const byKey=new Map(inv.items.map(x=>[x.record.key,x.record]));
      return okay({items:page.items.filter(x=>x.status==='READY' &&
        x.releaseId!==byKey.get(x.slug)?.releaseId)
        .map(x=>({key:x.slug,releaseId:x.releaseId,commitSha:x.commitSha,
          eligible:sleeping(byKey.get(x.slug))})),
        cursor:page.cursor},inv.revision);
    });},
    stage(p={}) {return run(()=>prepareStage(p));},
    startAi(p={}) {return run(async()=>{
      input(p);check(IDENT.test(p.stageOpId||'')&&IDENT.test(p.aiOpId||''));
      await core.assertMutationAllowed();
      return okay(await launchAi(p,p.stageOpId,p.aiOpId),lastRevision);
    });},
    markReady(p={}) {return run(()=>markReady(p));},
    reconcile(p={}) {return run(()=>reconcile(p));},
    failUpdate(p={}) {return run(async()=>{
      input(p);check(IDENT.test(p.stageOpId||''));
      await core.assertMutationAllowed();
      const stage=await stageOp(p,p.stageOpId);
      const {gen}=await confirmed(p,true);
      check(gen.deployState==='STAGED','CONFLICT');
      const response=unwrap(await deployer.rollback({
        key:p.key,accountId:p.accountId,accountBindingEpoch:p.accountBindingEpoch,
        expectedRevision:gen.revision,opId:p.opId,
        options:{context:p.context,originalOpId:stage.opId}}));
      return okay({state:'QUARANTINED',operation:response.opId},lastRevision);
    });}
  });
}
