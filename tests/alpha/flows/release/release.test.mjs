import test from 'node:test';
import assert from 'node:assert/strict';
import {createReleaseFlow} from '../../../../extension/alpha/flows/release/service.mjs';
import {canonicalReleaseId} from '../../../../extension/alpha/features/sources/catalog.mjs';
import {normalizeRecord,recordKey,assertRecordUpdate} from '../../../../extension/alpha/domain/records.js';

const when='2026-10-10T10:00:00.000Z', key='demo', SHA='c'.repeat(40),
  UPDATED='d'.repeat(40), BLOB='b'.repeat(40), EDIT_BLOB='e'.repeat(40);
const context={accountId:'acct',personaUid:'persona',epoch:1,
  routeRevision:1,capabilityRevision:1};
const copy=x=>structuredClone(x), okay=result=>({ok:true,result,revision:7});
const path={status:'generators/demo/DEPLOYMENT.md',pjs:'generators/demo/main.pjs',
  html:'generators/demo/index.html',thumbnail:'generators/demo/thumbnail.jpeg'};
async function release(pjs,sha=SHA) {
  const files={pjs,html:'<main>'+pjs+'</main>',thumbnail:new Uint8Array([17,18,19])};
  const releaseId=await canonicalReleaseId({pjs:new TextEncoder().encode(files.pjs),
    html:new TextEncoder().encode(files.html),thumbnail:files.thumbnail});
  return {releaseId,source:{repository:'Neb963/per-gens',ref:'main',
    root:'generators/demo',folder:'demo',slug:key,commitSha:sha,
    blobs:Object.fromEntries(Object.values(path).map(x=>[x,BLOB])),
    status:'READY',releaseId},files,createdAt:when};
}
function storageFactory(initial) {
  const rows=new Map();let revision=10;
  for(const [kind,items] of Object.entries(initial)) for(const record of items) {
    const value=normalizeRecord(kind,copy(record));
    rows.set(kind+'\0'+recordKey(kind,value),{
      record:value,revision:kind==='generator'||kind==='account'?record.revision:1});
  }
  return Object.freeze({
    async read(kind,id) {const item=rows.get(kind+'\0'+id);return {revision,item:item?copy(item):null};},
    async list(kind) {return {revision,items:[...rows.entries()].filter(([k])=>k.startsWith(kind+'\0'))
      .map(([,v])=>copy(v))};},
    async commit({expectedRevision,writes}) {
      assert.equal(expectedRevision,revision,'global P102 revision fence');
      const changes=[];
      for(const w of writes) {
        const value=normalizeRecord(w.kind,copy(w.record)),name=w.kind+'\0'+recordKey(w.kind,value),
          before=rows.get(name);
        assert.equal(w.expectedRevision,before?.revision??0,'per-record P102 fence');
        assertRecordUpdate(w.kind,before?.record,value);
        if(w.kind==='generator'||w.kind==='account') {
          assert.equal(value.revision,w.expectedRevision);
          value.revision++;
        }
        changes.push([name,{revision:w.expectedRevision+1,record:value}]);
      }
      for(const [k,v] of changes)rows.set(k,v);
      revision++;
      return {revision,items:changes.map(x=>copy(x[1]))};
    }
  });
}
async function fixture({existing=false,active=false,publicListing=false,repoConflict=false,
  githubUncertain=false}={}) {
  const prior=existing?await release('known-good','a'.repeat(40)):null;
  const desired=await release('ready-source');
  let githubHead=SHA,generatorListing=publicListing?'PUBLIC':'UNLISTED',
    providerRevision='r1',providerFiles=copy(prior?.files||{pjs:'',html:'',thumbnail:new Uint8Array()});
  const actions=[],tasks=[],gitWrites=[];
  const storage=storageFactory({
    account:[{accountId:context.accountId,personaUid:context.personaUid,
      epoch:1,name:'Account',sessionState:'VERIFIED',revision:1,asOf:when}],
    generator:[{key,accountId:context.accountId,personaUid:context.personaUid,
      accountBindingEpoch:1,fleetIntent:existing?'MANAGED':'EXCLUDED',
      listingObserved:generatorListing,deployState:existing?'DEPLOYED':'UNDEPLOYED',
      refreshState:active?'ACTIVE':existing?'SLEEPING':'INELIGIBLE',
      sourceBinding:prior?.source||null,releaseId:prior?.releaseId||null,
      revision:1,asOf:when,attentionRefs:[]}],
    release:prior?[prior]:[],operation:[]});
  const change=async(kind,id,fn)=>{
    const row=await storage.read(kind,id);assert.ok(row.item);
    await storage.commit({expectedRevision:row.revision,writes:[{
      kind,expectedRevision:row.item.revision,record:fn(row.item.record)}]});
  };
  const createOperation=async(o)=>{
    const row=await storage.read('operation',o.opId);
    assert.equal(row.item,null);
    await storage.commit({expectedRevision:row.revision,writes:[{
      kind:'operation',expectedRevision:0,record:o}]});
  };
  const settle=async(id,phase,remoteEvidence={disposition:'VERIFIED'})=>change('operation',id,
    x=>({...x,phase,remoteEvidence}));
  const deployer={
    async prepare(p) {
      actions.push('prepare');
      await createOperation({opId:p.opId,kind:'deployer.apply',targetKey:key,
        sourceRevision:1,accountBindingEpoch:1,phase:'PREPARED',startedAt:when,
        remoteEvidence:{intent:{releaseId:desired.releaseId,commitSha:desired.source.commitSha,
          previousReleaseId:prior?.releaseId||null,expectedProviderRevision:providerRevision}}});
      return okay({phase:'PREPARED'});
    },
    async apply(p) {
      actions.push('apply');
      if(generatorListing==='PUBLIC') {
        actions.push('UNLIST');
        generatorListing='UNLISTED';
      }
      actions.push('SAVE');
      providerFiles=copy(desired.files);providerRevision='r2';
      await settle(p.opId,'DISPATCHING',{intent:(await storage.read('operation',p.opId)).item.record.remoteEvidence.intent});
      await settle(p.opId,'APPLIED',{intent:{releaseId:desired.releaseId,commitSha:desired.source.commitSha,
        previousReleaseId:prior?.releaseId||null},observation:{releaseId:desired.releaseId,
          sourceRevision:'r2',listing:'UNLISTED'}});
      const r=await storage.read('release',desired.releaseId);
      assert.equal(r.item,null);
      await storage.commit({expectedRevision:r.revision,writes:[{
        kind:'release',expectedRevision:0,record:desired}]});
      await change('generator',key,g=>({...g,deployState:'STAGED',listingObserved:'UNLISTED',
        refreshState:prior?'SLEEPING':'INELIGIBLE',asOf:when}));
      return okay({phase:'APPLIED'});
    },
    async rollback(p) {
      actions.push('ROLLBACK');
      generatorListing='UNLISTED';providerFiles=copy(prior?.files||desired.files);
      await change('generator',key,g=>({...g,deployState:'QUARANTINED',listingObserved:'UNLISTED',
        refreshState:prior?'SLEEPING':'INELIGIBLE',
        attentionRefs:[...g.attentionRefs,'deployer.failed.'+desired.releaseId],asOf:when}));
      return okay({opId:p.opId,phase:'APPLIED'});
    }
  };
  const aiStore={read:async()=>({revision:tasks.length,tasks:copy(tasks)})};
  const ai={
    async start(p) {
      actions.push('AI_START');
      assert.equal(p.options.expectedSourceHash,desired.releaseId);
      tasks.push({id:'ai:'+p.opId,key,accountId:context.accountId,
        personaUid:context.personaUid,bindingEpoch:1,revision:1,state:'ACTIVE',
        createdAt:when,updatedAt:when,sourceHash:desired.releaseId,
        sourceRevision:providerRevision,savedSourceHash:null,savedSourceRevision:null,
        sessionId:'native',opId:p.opId,dispatchPhase:'APPLIED',
        provenanceRefs:[],approvalRevision:null,approvalOpId:null,
        reviewPending:false,failureCode:null});
      return okay({id:tasks.at(-1).id,state:'ACTIVE'});
    },
    async approveIntent(p) {
      actions.push('AI_APPROVE');
      const t=tasks.find(x=>x.id===p.options.taskId);
      assert.equal(t.revision,p.options.expectedTaskRevision);
      assert.equal(p.options.sourceHash,t.savedSourceHash);
      assert.equal(p.options.sourceRevision,t.savedSourceRevision);
      assert.equal(p.editorUrl,undefined);
      t.revision++;t.approvalRevision=t.revision;t.approvalOpId=p.opId;t.reviewPending=false;
      return okay({state:'COMPLETED'});
    }
  };
  const provider={
    async read() {return okay({ownership:'CONFIRMED',listing:generatorListing,
      sourceRevision:providerRevision,files:copy(providerFiles)});},
    async probe() {return {ok:true,result:['generator.setPrivacy'],revision:1};},
    async setListing(x) {
      actions.push('PUBLIC');
      const child=(await storage.read('operation',x.opId)).item.record;
      assert.equal(child.phase,'PREPARED');
      await settle(x.opId,'DISPATCHING');
      generatorListing='PUBLIC';providerRevision='r4';
      await settle(x.opId,'APPLIED',{disposition:'APPLIED',listing:'PUBLIC'});
      return okay({listing:'PUBLIC'});
    }
  };
  const journal={
    read:async id=>(await storage.read('operation',id)).item?.record??null,
    prepare:async({opId,kind,targetKey,sourceRevision,accountBindingEpoch})=>{
      actions.push('PUBLISH_PREPARE');
      await createOperation({opId,kind,targetKey,sourceRevision,accountBindingEpoch,
        phase:'PREPARED',startedAt:when});
    }
  };
  const github={
    async snapshot({paths}) {
      return okay({commitSha:githubHead,blobs:Object.fromEntries(paths.map(x=>[x,
        gitWrites.some(w=>w.changed.has(x))?EDIT_BLOB:BLOB]))});
    },
    async commit(p) {
      actions.push('GIT_COMMIT');gitWrites.push({input:p,changed:new Set(Object.keys(p.files))});
      if(repoConflict) return {ok:false,error:{code:'CONFLICT'}};
      if(githubUncertain) return {ok:false,error:{code:'UNCERTAIN'}};
      assert.equal(p.expectedHeadSha,SHA);
      assert.equal(p.secretRef,'github-ref');
      assert.deepEqual(Object.keys(p.files).sort(),[path.html,path.pjs].sort());
      githubHead=UPDATED;
      return okay({commitSha:UPDATED,blobs:Object.fromEntries(
        Object.keys(p.files).map(x=>[x,EDIT_BLOB]))});
    },
    async readBlob({blobSha}) {
      assert.equal(blobSha,EDIT_BLOB);
      const w=gitWrites.at(-1),name=Object.keys(w.input.files).find(x=>
        w.input.files[x] instanceof Uint8Array && w.changed.has(x));
      // Both changed blobs may share the same mocked SHA. Return bytes on each
      // request in the adapter's order.
      const n=gitWrites.at(-1).readCounter||0;
      const selected=Object.keys(w.input.files)[n];
      gitWrites.at(-1).readCounter=n+1;
      return okay(w.input.files[selected]);
    }
  };
  const sourceCatalog={
    resolveRelease:async()=>okay(copy(desired)),
    scan:async()=>okay({items:[copy(desired.source)],cursor:null})
  };
  const core={assertCurrent:async()=>{},assertMutationAllowed:async()=>{}};
  const flow=createReleaseFlow({storage,sourceCatalog,deployer,ai,aiStore,provider,
    github,journal,core,secretRef:'github-ref',clock:()=>when});
  const base=(opId='stage-1',extras={})=>({key,accountId:context.accountId,
    accountBindingEpoch:1,context:copy(context),opId,aiOpId:'ai-1',...extras});
  const stage=async()=>flow.stage(base());
  const review=async(files=copy(desired.files))=>{
    assert.ok(tasks.length);
    providerFiles=copy(files);providerRevision='r3';
    const t=tasks.at(-1);
    t.state='COMPLETED';t.revision++;t.savedSourceHash=await canonicalReleaseId({
      pjs:new TextEncoder().encode(files.pjs),html:new TextEncoder().encode(files.html),
      thumbnail:files.thumbnail});
    t.savedSourceRevision='r3';t.reviewPending=true;
    return t;
  };
  const approval=(t,extras={})=>base('ready-1',{stageOpId:'stage-1',
    taskId:t.id,expectedTaskRevision:t.revision,
    editorUrl:'https://perchance.org/demo#edit',...extras});
  return {flow,storage,actions,tasks,gitWrites,base,stage,review,approval,desired,prior,
    get listing(){return generatorListing;},get remoteFiles(){return copy(providerFiles);},
    setHead(x){githubHead=x;},get head(){return githubHead;},
    async generator(){return (await storage.read('generator',key)).item.record;},
    async operation(id){return (await storage.read('operation',id)).item?.record??null;}};
}

test('AP402-01 new READY release stages unlisted and enters native AI without premature adoption',async()=>{
  const f=await fixture();
  const result=await f.stage();
  assert.equal(result.ok,true,JSON.stringify(result.error));
  assert.equal(result.result.state,'AI_PENDING');
  assert.deepEqual(f.actions.slice(0,3),['prepare','apply','SAVE']);
  const staged=await f.generator();
  assert.equal(staged.releaseId,null);
  assert.equal(staged.deployState,'STAGED');
  assert.equal(f.listing,'UNLISTED');
  assert.equal(f.tasks.length,1);
});

test('AP402-02 active READY update is deferred before first remote change',async()=>{
  const f=await fixture({existing:true,active:true,publicListing:true});
  const result=await f.stage();
  assert.equal(result.error.code,'CONFLICT');
  assert.deepEqual(f.actions,[]);
  assert.equal(f.listing,'PUBLIC');
  assert.equal(await f.operation('stage-1'),null);
});

test('AP402-03 deployed update is unlisted before save, then republished only after review',async()=>{
  const f=await fixture({existing:true,publicListing:true});
  assert.equal((await f.stage()).ok,true);
  assert.deepEqual(f.actions.slice(0,4),['prepare','apply','UNLIST','SAVE']);
  assert.equal(f.listing,'UNLISTED');
  const t=await f.review();
  const ready=await f.flow.markReady(f.approval(t));
  assert.equal(ready.ok,true,JSON.stringify(ready.error));
  assert.equal(ready.result.listing,'PUBLIC');
  assert.equal(f.listing,'PUBLIC');
  assert.ok(f.actions.indexOf('AI_APPROVE')<f.actions.indexOf('PUBLIC'));
  assert.ok(f.actions.indexOf('PUBLISH_PREPARE')<f.actions.indexOf('PUBLIC'));
  const g=await f.generator();
  assert.equal(g.releaseId,f.desired.releaseId);
  assert.equal(g.deployState,'DEPLOYED');
  assert.equal(g.refreshState,'SLEEPING');
  assert.equal(g.fleetIntent,'MANAGED');
  assert.equal(f.gitWrites.length,0);
});

test('AP402-01 new release approval enrols managed but does not start an active slot',async()=>{
  const f=await fixture();
  assert.equal((await f.stage()).ok,true);
  const t=await f.review();
  const x=await f.flow.markReady(f.approval(t));
  assert.equal(x.ok,true,JSON.stringify(x.error));
  assert.equal((await f.generator()).fleetIntent,'MANAGED');
  assert.equal((await f.generator()).refreshState,'SLEEPING');
  assert.equal(f.listing,'PUBLIC');
});

test('AP402-02 edited PJS and HTML use one atomic expected-head GitHub commit and immutable new release',async()=>{
  const f=await fixture();
  assert.equal((await f.stage()).ok,true);
  const edited={...f.desired.files,pjs:'edited pjs',html:'<main>edited html</main>'};
  const t=await f.review(edited);
  const result=await f.flow.markReady(f.approval(t));
  assert.equal(result.ok,true,JSON.stringify(result.error));
  assert.equal(f.gitWrites.length,1);
  assert.equal(f.gitWrites[0].input.expectedHeadSha,SHA);
  assert.equal(f.gitWrites[0].input.expectedBlobs[path.pjs],BLOB);
  assert.equal(f.gitWrites[0].input.expectedBlobs[path.html],BLOB);
  assert.equal(f.head,UPDATED);
  assert.equal(f.listing,'PUBLIC');
  assert.equal((await f.generator()).releaseId,t.savedSourceHash);
  assert.notEqual(t.savedSourceHash,f.desired.releaseId);
  const adopted=(await f.storage.read('release',t.savedSourceHash)).item.record;
  assert.equal(adopted.source.commitSha,UPDATED);
  assert.equal(adopted.source.blobs[path.pjs],EDIT_BLOB);
  assert.equal(adopted.files.pjs,'edited pjs');
});

test('AP402-02 changed GitHub branch head blocks writeback and public mutation',async()=>{
  const f=await fixture({repoConflict:true});
  assert.equal((await f.stage()).ok,true);
  const t=await f.review({...f.desired.files,pjs:'edited pjs',html:'changed html'});
  const result=await f.flow.markReady(f.approval(t));
  assert.equal(result.error.code,'CONFLICT');
  assert.equal(f.listing,'UNLISTED');
  assert.equal((await f.operation('ready-1.git')).phase,'HELD');
  assert.ok(!f.actions.includes('PUBLIC'));
});

test('AP402-03 uncertain GitHub write never retries and keeps unlisted recovery hold',async()=>{
  const f=await fixture({githubUncertain:true});
  assert.equal((await f.stage()).ok,true);
  const t=await f.review({...f.desired.files,pjs:'edited',html:'changed'});
  assert.equal((await f.flow.markReady(f.approval(t))).error.code,'UNCERTAIN');
  assert.equal(f.gitWrites.length,1);
  assert.equal((await f.operation('ready-1.git')).phase,'UNCERTAIN');
  assert.equal((await f.flow.markReady(f.approval(t))).error.code,'RECOVERY_HOLD');
  assert.equal(f.gitWrites.length,1);
  assert.equal(f.listing,'UNLISTED');
});

test('AP402-03 failed update safely delegates last-good restore and quarantines',async()=>{
  const f=await fixture({existing:true,publicListing:true});
  assert.equal((await f.stage()).ok,true);
  const r=await f.flow.failUpdate(f.base('rollback-1',{stageOpId:'stage-1'}));
  assert.equal(r.ok,true,JSON.stringify(r.error));
  assert.equal(f.listing,'UNLISTED');
  assert.equal((await f.generator()).deployState,'QUARANTINED');
  assert.equal((await f.generator()).releaseId,f.prior.releaseId);
  assert.ok((await f.generator()).attentionRefs.includes('deployer.failed.'+f.desired.releaseId));
});

test('AP402-03 non-current Persona binding is rejected before staging mutations',async()=>{
  const f=await fixture();
  const r=await f.flow.stage(f.base('bad',{accountBindingEpoch:2}));
  assert.equal(r.error.code,'INVALID_REQUEST');
  assert.deepEqual(f.actions,[]);
});
