import assert from 'node:assert/strict';
import { test } from 'node:test';
import {createSupplyFlow} from '../../../../extension/alpha/flows/supply/service.mjs';
import {createReleaseFlow} from '../../../../extension/alpha/flows/release/service.mjs';
import {createRefreshExecution} from '../../../../extension/alpha/flows/refresh/service.mjs';
import {emptyRefreshState,validateRefreshState} from '../../../../extension/alpha/flows/refresh/ledger.mjs';
import { canonicalReleaseId } from '../../../../extension/alpha/features/sources/catalog.mjs';
import { createDeployerService } from '../../../../extension/alpha/features/deployer/service.mjs';
import { createDeployerJournal } from '../../../../extension/alpha/features/deployer/journal.mjs';
import { createPerchanceAdapter } from '../../../../extension/alpha/providers/perchance/adapter.mjs';
import { createPerchanceEmulator } from '../../../../extension/alpha/providers/perchance/emulator.mjs';
import { normalizeRecord, recordKey, assertRecordUpdate } from '../../../../extension/alpha/domain/records.js';

const when = '2026-10-10T00:00:00.000Z';
const key = 'demo';
const context = { accountId: 'account-a', personaUid: 'persona-a', epoch: 1,
  routeRevision: 1, capabilityRevision: 1 };
const copy = value => structuredClone(value);
const snapshotFiles = files => ({
  pjs: files.pjs, html: files.html, thumbnail: [...files.thumbnail]
});
const actualFiles = entry => snapshotFiles(entry.files);

async function release(text, sha = 'c'.repeat(40)) {
  const files = { pjs: text, html: '<main>' + text + '</main>',
    thumbnail: new Uint8Array([17, 22, 99]) };
  const releaseId = await canonicalReleaseId({
    pjs: new TextEncoder().encode(files.pjs),
    html: new TextEncoder().encode(files.html), thumbnail: files.thumbnail
  });
  return { releaseId, source: { repository: 'Neb963/per-gens', ref: 'main',
    root: 'generators/demo', folder: 'demo', slug: key, commitSha: sha,
    blobs: { 'generators/demo/main.pjs': 'b'.repeat(40) },
    status: 'READY', releaseId }, files, createdAt: when };
}

function createStorage(initial) {
  const rows = new Map();
  let version = 15;
  function seed(kind, value) {
    const record = normalizeRecord(kind, copy(value));
    rows.set(kind + '\0' + recordKey(kind, record), {
      revision: kind === 'operation' ? 1 : value.revision || 1, record
    });
  }
  for (const [kind, values] of Object.entries(initial)) for (const value of values) seed(kind, value);
  return Object.freeze({
    async read(kind, keyValue) {
      const item = rows.get(kind + '\0' + keyValue);
      return { revision: version, item: item ? copy(item) : null };
    },
    async list(kind) {
      const items = [...rows.entries()].filter(([k]) => k.startsWith(kind + '\0'))
        .map(([, value]) => copy(value));
      return { revision: version, items };
    },
    async commit({ expectedRevision, writes }) {
      assert.equal(expectedRevision, version, 'Global P102 CAS must not be stale');
      const staged = [];
      for (const w of writes) {
        const normalized = normalizeRecord(w.kind, copy(w.record));
        const k = w.kind + '\0' + recordKey(w.kind, normalized);
        const prior = rows.get(k);
        assert.equal(w.expectedRevision, prior?.revision || 0, 'Per-record CAS');
        assertRecordUpdate(w.kind, prior?.record, normalized);
        if (w.kind === 'generator' || w.kind === 'account') {
          assert.equal(normalized.revision, w.expectedRevision);
          normalized.revision++;
        }
        staged.push([k, { revision: w.expectedRevision + 1, record: normalized }]);
      }
      for (const [k, row] of staged) rows.set(k, row);
      version++;
      return { revision: version, items: staged.map(([, row]) => copy(row)) };
    }
  });
}

async function harness({ existing = false, publicListing = false, state = 'SLEEPING',
  session = 'VERIFIED' } = {}) {
  const old = existing ? await release('last good', 'a'.repeat(40)) : null;
  let candidate = await release('wanted revision');
  const initialFiles = old?.files || { pjs: '', html: '', thumbnail: new Uint8Array() };
  const emulator = createPerchanceEmulator({
    accountId: context.accountId, personaUid: context.personaUid,
    epoch: context.epoch, routeRevision: context.routeRevision,
    capabilityRevision: context.capabilityRevision, session,
    entries: [{ name: key, sourceRevision: 'r1', isPrivate: !publicListing,
      files: initialFiles }] });
  const storage = createStorage({
    account: [{ accountId: context.accountId, personaUid: context.personaUid,
      epoch: context.epoch, name: 'Account A', sessionState: session === 'VERIFIED' ?
        'VERIFIED' : 'WAITING_HUMAN', revision: 1, asOf: when }],
    generator: [{ key, accountId: context.accountId, personaUid: context.personaUid,
      accountBindingEpoch: context.epoch, fleetIntent: 'MANAGED',
      listingObserved: publicListing ? 'PUBLIC' : 'UNLISTED',
      deployState: existing ? 'DEPLOYED' : 'UNDEPLOYED',
      refreshState: state, sourceBinding: old?.source || null,
      releaseId: old?.releaseId || null, revision: 1, asOf: when, attentionRefs: [] }],
    release: old ? [old] : [], operation: []
  });
  const journal = createDeployerJournal({ storage, clock: () => when });
  const provider = createPerchanceAdapter({
    executor: emulator.executor, journal, now: () => when
  });
  const facts = { get: async () => existing ? {
    key, accountId: context.accountId, personaUid: context.personaUid,
    accountBindingEpoch: context.epoch, ownershipObserved: true,
    acceptedSourceRevision: 'r1', providerSourceRevision: 'r1',
    drift: null, ignoredVersion: null
  } : null };
  const core = { assertCurrent: async () => {},
    assertMutationAllowed: async () => {} };
  const sourceCatalog = { resolveRelease: async () => ({
    ok: true, result: copy(candidate), revision: 0
  }) };
  const service = createDeployerService({
    storage, sourceCatalog, provider, journal, core, facts, clock: () => when
  });
  const params = (opId = 'attempt1', options = {}) => ({
    key, accountId: context.accountId, accountBindingEpoch: context.epoch,
    expectedRevision: 1, opId, options: { context: copy(context), ...options }
  });
  return { old, storage, emulator, journal, provider, service, params,
    get candidate() { return candidate; },
    changeCandidate(next) { candidate = next; },
    async gen() { return (await storage.read('generator', key)).item.record; },
    async operation(opId) { return (await storage.read('operation', opId)).item?.record || null; } };
}



/** R4-ISSUE100 connected source-linked deterministic journey.
 * Reuses the P302 source fixture (real P103 Perchance adapter + executor,
 * P102-normalized shared CAS store and P302 deployer/journal). The remaining
 * GitHub/native-AI boundaries are explicit, correlated emulators, not extra
 * execution engines. Every R4 phase consumes the SAME account, generator and
 * durable operation rows. No provider-live inference.
 */
const receipt=result=>({ok:true,result,revision:7});
const good=result=>{assert.equal(result?.ok,true,JSON.stringify(result?.error));return result.result;};
const bad=(result,code)=>{assert.equal(result?.ok,false);assert.equal(result.error.code,code);};
async function connected({casConflict=false,uncertainCommit=false}={}){
  const h=await harness({state:'INELIGIBLE'});
  const initialSha='c'.repeat(40), newSha='d'.repeat(40);
  const initialBlob='b'.repeat(40);
  const paths=['DEPLOYMENT.md','main.pjs','index.html','thumbnail.jpeg']
    .map(name=>'generators/demo/'+name);
  const blobs=Object.fromEntries(paths.map(path=>[path,initialBlob]));
  const candidate={...h.candidate,source:{...h.candidate.source,blobs}};
  h.changeCandidate(candidate);
  const receipt=result=>({ok:true,result,revision:7});
  const catalog={
    async get({key:asked}){return asked===key?receipt(copy(candidate.source)):{ok:false,error:{code:'NOT_APPLIED'}};},
    async resolveRelease({key:asked}){return asked===key?receipt(copy(candidate)):{ok:false,error:{code:'NOT_APPLIED'}};},
    async scan(){return receipt({items:[copy(candidate.source)],cursor:null});}
  };
  const reservation={
    preview:async()=>receipt([]),
    reserve:async()=>({ok:false,error:{code:'UNSUPPORTED_CAPABILITY'}}),
    reconcile:async()=>({ok:false,error:{code:'UNSUPPORTED_CAPABILITY'}})
  };
  const supply=createSupplyFlow({storage:h.storage,reservation,sources:catalog,
    perchance:h.provider,importPerchance:h.provider,
    contextForAccount:async()=>copy(h.emulator.context),now:()=>when});
  let gitHead=initialSha, gitWrites=0, gitByteReads=new Map();
  const gitBlobs={...blobs};
  const github={
    async snapshot({paths:asked}){return receipt({commitSha:gitHead,
      blobs:Object.fromEntries(asked.map(path=>[path,gitBlobs[path]]))});},
    async commit(p){
      gitWrites++;
      if(casConflict || p.expectedHeadSha!==gitHead ||
        Object.entries(p.expectedBlobs).some(([path,sha])=>gitBlobs[path]!==sha))
        return {ok:false,error:{code:'CONFLICT',retryable:false}};
      if(uncertainCommit)return {ok:false,error:{code:'UNCERTAIN',retryable:false}};
      gitHead=newSha;
      let i=0;const updated={};
      for(const [path,bytes] of Object.entries(p.files)){
        const blobSha=(++i).toString(16).repeat(40);
        gitBlobs[path]=blobSha;updated[path]=blobSha;
        gitByteReads.set(blobSha,new Uint8Array(bytes));
      }
      return receipt({commitSha:gitHead,blobs:updated});
    },
    async readBlob({blobSha}){return gitByteReads.has(blobSha)?
      receipt(new Uint8Array(gitByteReads.get(blobSha))):{ok:false,error:{code:'NOT_APPLIED'}};}
  };
  let observedFact=null;
  const facts={
    get:async()=>copy(observedFact),
    async compareAndPut(next,expected){
      assert.equal(observedFact.observationRevision,expected);
      assert.equal(next.observationRevision,expected+1);
      observedFact=copy(next);
    }
  };
  const inventory={
    async observe(p){
      const row=await h.storage.read('generator',key);
      assert.equal(row.item.record.revision,p.expectedRevision);
      const remote=good(await h.provider.read({context:h.emulator.context,targetKey:key}));
      observedFact={key,accountId:context.accountId,personaUid:context.personaUid,
        accountBindingEpoch:1,providerSourceRevision:remote.sourceRevision,
        acceptedSourceRevision:observedFact?.acceptedSourceRevision??null,
        listing:remote.listing,observedAt:when,lastSeenAt:when,ownershipObserved:true,
        discoveryRevision:1,observationRevision:(observedFact?.observationRevision??0)+1,
        ignoredVersion:null,drift:null};
      await h.storage.commit({expectedRevision:row.revision,writes:[{
        kind:'generator',expectedRevision:row.item.revision,
        record:{...row.item.record,listingObserved:remote.listing,asOf:when}}]});
      return receipt((await h.storage.read('generator',key)).item.record);
    }
  };
  const tasks=[];
  const aiStore={read:async()=>({revision:tasks.length,tasks:copy(tasks)})};
  const ai={
    async start(p){
      const remote=good(await h.provider.read({context:h.emulator.context,targetKey:key}));
      const task={id:'native-review-'+tasks.length,key,accountId:context.accountId,
        personaUid:context.personaUid,bindingEpoch:1,revision:1,state:'ACTIVE',
        createdAt:when,updatedAt:when,sourceHash:p.options.expectedSourceHash,
        sourceRevision:remote.sourceRevision,savedSourceHash:null,savedSourceRevision:null,
        sessionId:'native-session',opId:p.opId,dispatchPhase:'APPLIED',
        provenanceRefs:[],approvalRevision:null,approvalOpId:null,
        reviewPending:false,failureCode:null};
      tasks.push(task);return receipt({id:task.id,state:'ACTIVE'});
    },
    async approveIntent(p){
      const t=tasks.find(x=>x.id===p.options.taskId);
      assert(t);assert.equal(t.savedSourceHash,p.options.sourceHash);
      assert.equal(t.savedSourceRevision,p.options.sourceRevision);
      assert.equal(t.revision,p.options.expectedTaskRevision);
      t.revision++;t.approvalRevision=t.revision;t.approvalOpId=p.opId;t.reviewPending=false;
      return receipt({state:'COMPLETED'});
    }
  };
  const core={assertCurrent:async()=>{},assertMutationAllowed:async()=>{}};
  const releaseFlow=createReleaseFlow({storage:h.storage,sourceCatalog:catalog,
    deployer:h.service,ai,aiStore,provider:h.provider,
    github,journal:h.journal,core,inventory,facts,secretRef:'github-ref',clock:()=>when});
  const base=(opId='stage-1',extra={})=>({key,accountId:context.accountId,
    accountBindingEpoch:1,context:copy(h.emulator.context),
    opId,aiOpId:'native-ai-1',...extra});
  async function review(edit){
    const task=tasks.at(-1);assert(task);
    h.emulator.changeRemote(key,{files:copy(edit),sourceRevision:'r-review'});
    task.state='COMPLETED';task.revision++;
    task.savedSourceHash=await canonicalReleaseId({pjs:new TextEncoder().encode(edit.pjs),
      html:new TextEncoder().encode(edit.html),thumbnail:edit.thumbnail});
    task.savedSourceRevision='r-review';task.reviewPending=true;task.updatedAt=when;
    return task;
  }
  const approve=task=>base('approved-1',{stageOpId:'stage-1',taskId:task.id,
    expectedTaskRevision:task.revision,editorUrl:'https://perchance.org/demo#edit'});
  return {h,catalog,supply,releaseFlow,github,tasks,core,base,review,approve,
    inventory,facts,gitState:()=>({head:gitHead,writes:gitWrites,blobs:{...gitBlobs}})};
}
test('R4-ISSUE100 connected GitHub-first supply → P302 unlisted stage → native AI → human approval → conditional GitHub CAS → publication → P403 feedback',async()=>{
  const z=await connected();
  const imported=good(await z.supply.importReady({key,opId:'supply-1'}));
  assert.equal(imported.phase,'APPLIED');
  let generator=(await z.h.storage.read('generator',key)).item.record;
  assert.equal(generator.deployState,'UNDEPLOYED');
  assert.equal(generator.sourceBinding.commitSha,z.h.candidate.source.commitSha);
  const stage=good(await z.releaseFlow.stage(z.base()));
  assert.equal(stage.state,'AI_PENDING');
  assert.equal(z.h.emulator.listRemote()[0].isPrivate,true);
  generator=(await z.h.storage.read('generator',key)).item.record;
  assert.equal(generator.deployState,'STAGED');
  assert.equal(generator.releaseId,null);
  const edit={...copy(z.h.candidate.files),pjs:'edited source for approved release',
    html:'<main>approved revision</main>'};
  const task=await z.review(edit);
  const publish=good(await z.releaseFlow.markReady(z.approve(task)));
  assert.equal(publish.state,'DEPLOYED');
  assert.equal(z.gitState().writes,1);
  assert.equal(z.gitState().head,'d'.repeat(40));
  assert.equal(z.h.emulator.listRemote()[0].isPrivate,false);
  generator=(await z.h.storage.read('generator',key)).item.record;
  assert.equal(generator.fleetIntent,'MANAGED');
  assert.equal(generator.refreshState,'SLEEPING');
  assert.equal(generator.releaseId,task.savedSourceHash);
  // R4 explicitly activates refresh after publication; P402 never auto-enrols.
  let row=await z.h.storage.read('generator',key);
  await z.h.storage.commit({expectedRevision:row.revision,writes:[{
    kind:'generator',expectedRevision:row.item.revision,
    record:{...row.item.record,refreshState:'ACTIVE',asOf:when}}]});
  const t=Date.parse('2026-10-11T08:00:00.000Z');
  let nowMs=t, visible=false;
  const scheduler={
    planPass:async()=>receipt({}),inspect:async()=>({
      config:{margin:.1},health:{state:'HEALTHY'},
      schedules:{[key]:{key,accountId:context.accountId,personaUid:context.personaUid,
        accountBindingEpoch:1,phase:'ACTIVE'}}})
  };
  let ledgerData=emptyRefreshState();
  const ledger={read:async()=>copy(ledgerData),async update(fn){
    const next=copy(ledgerData);fn(next);next.revision++;
    ledgerData=validateRefreshState(next);return copy(ledgerData);
  }};
  const visibility={getPosition:async()=>receipt({key,status:visible?'VISIBLE':'NOT_VISIBLE',
    feedPosition:visible?1:null,renderedPosition:visible?1:null,
    asOf:new Date(nowMs).toISOString(),evidenceRefs:['emulated-feed']})};
  const refresh=createRefreshExecution({scheduler,visibility,storage:z.h.storage,
    provider:z.h.provider,journal:z.h.journal,core:z.core,ledger,
    clock:()=>nowMs,contextFor:async()=>copy(z.h.emulator.context)});
  const pass=good(await refresh.pass());
  assert.equal(pass.items[0].action,'SAVED_WAIT_FOR_OBSERVATION');
  assert(z.h.emulator.listRemote()[0].files.pjs.includes('edited source for approved release'));
  assert.equal((await refresh.inspect()).jobs[key].attempts,1);
  // Fresh independent visibility observation, not a save receipt, establishes target.
  nowMs+=11*60000;visible=true;
  const result=good(await refresh.pass());
  assert.equal(result.items[0].action,'ON_TARGET');
  assert.equal((await refresh.inspect()).jobs[key].attempts,0);
});
test('R4-ISSUE100 GitHub compare-and-swap conflict never publishes or replays a held write',async()=>{
  const z=await connected({casConflict:true});
  good(await z.supply.importReady({key,opId:'supply-cas'}));
  good(await z.releaseFlow.stage(z.base()));
  const files={...copy(z.h.candidate.files),pjs:'edited blocked by CAS'};
  const task=await z.review(files);
  bad(await z.releaseFlow.markReady(z.approve(task)),'CONFLICT');
  assert.equal(z.h.emulator.listRemote()[0].isPrivate,true);
  assert.equal(z.gitState().writes,1);
  bad(await z.releaseFlow.markReady(z.approve(task)),'RECOVERY_HOLD');
  assert.equal(z.gitState().writes,1);
});
test('R4-ISSUE100 lost GitHub write receipt holds unlisted source without speculative retry',async()=>{
  const z=await connected({uncertainCommit:true});
  good(await z.supply.importReady({key,opId:'supply-uncertain'}));
  good(await z.releaseFlow.stage(z.base()));
  const task=await z.review({...copy(z.h.candidate.files),html:'<article>review change</article>'});
  bad(await z.releaseFlow.markReady(z.approve(task)),'UNCERTAIN');
  assert.equal(z.h.emulator.listRemote()[0].isPrivate,true);
  assert.equal(z.gitState().writes,1);
});
test('R4-ISSUE100 stale Persona epoch rejected before supply and deployment mutation',async()=>{
  const z=await connected();
  z.h.emulator.corruptBinding('epoch',2);
  bad(await z.supply.importReady({key,opId:'supply-stale'}),'STALE_BINDING');
  assert.equal(z.h.emulator.calls.filter(c=>['save','create','setListing'].includes(c.kind)).length,0);
});
