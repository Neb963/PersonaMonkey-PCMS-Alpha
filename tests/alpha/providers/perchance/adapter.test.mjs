import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPerchanceAdapter,collectAccountGenerators} from '../../../../extension/alpha/providers/perchance/adapter.mjs';
import {createPerchanceEmulator,PERCHANCE_CAPABILITIES} from '../../../../extension/alpha/providers/perchance/emulator.mjs';
import {classifyAiSource,classifyListingObservation} from '../../../../extension/alpha/providers/perchance/observations.mjs';
const fixture=JSON.parse(readFileSync(new URL('../../../../fixtures/alpha/perchance/discovery-v3.json',import.meta.url)));
const now=()=> '2026-09-10T00:00:00.000Z';
const files=(pjs='a',html='b')=>({pjs,html,thumbnail:new Uint8Array([1,2,3])});
const fake=options=>{
  const e=createPerchanceEmulator({entries:[{name:'alpha-one',isPrivate:true,sourceRevision:'r1',files:files()}],...options});
  const a=createPerchanceAdapter({executor:e.executor,journal:e.journal,pageSize:2,now});
  return {e,a,context:e.context};
};
const expectCode=(r,code)=>{assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.error.code,code);};
const req=(context,kind,targetKey,expectedSourceRevision,opId='op-1',extra={})=>
  ({context,targetKey,expectedRevision:7,accountBindingEpoch:context.epoch,expectedSourceRevision,opId,...extra});
function prepared(e,action,key,revision,opId='op-1'){e.prepare(opId,action,key,revision);}

test('discovery-v3 fingerprint and honest Brave-only provenance',()=>{
  assert.equal(fixture.source.sha256,'65c52533702bc210556acadd2f39f9d848e302644f6c17652e5bc9066e7a9080');
  assert.equal(fixture.source.firefoxLiveVerified,false);
  assert.equal(fixture.accountInventory.observedPagination,false);
  assert.equal(fixture.save.pendingFileEditsAreSaved,false);
});
test('probe requires Persona binding, verified session and explicit capability list',async()=>{
  const {e,a,context}=fake();
  assert.deepEqual((await a.probe(context)).result,PERCHANCE_CAPABILITIES);
  e.setSession('CHALLENGE');expectCode(await a.probe(context),'WAITING_HUMAN');
  e.setSession('VERIFIED');e.corruptBinding('routeRevision',2);
  expectCode(await a.probe({...context,routeRevision:1}),'STALE_BINDING');
});
test('listGenerators produces keyed account-scope entries and opaque checked cursor',async()=>{
  const {e,a,context}=fake({entries:fixture.accountInventory.items});
  const p=await a.listGenerators({context});assert.equal(p.ok,true);
  assert.deepEqual(p.result.items.map(x=>x.key),['alpha-one','beta_two']);
  assert.equal(p.result.items[0].readback.listing,'UNLISTED');
  assert.equal(p.result.items[1].readback.listing,'PUBLIC');
  assert.equal(p.result.items[0].readback.ownership,'CONFIRMED');
  assert.equal(p.result.cursor,null);
  assert(!e.calls.some(c=>c.kind==='public-feed'));
});
test('local account paging covers 1k items, not just public generator feed',async()=>{
  const {e,a,context}=fake({entries:Array.from({length:1001},(_,i)=>({name:`generator-${i.toString().padStart(4,'0')}`,isPrivate:i%2===0}))});
  const adapter=createPerchanceAdapter({executor:e.executor,journal:e.journal,pageSize:125,now});
  const r=await collectAccountGenerators(adapter,context);assert.equal(r.ok,true);
  assert.equal(r.result.items.length,1001);
  assert.equal(new Set(r.result.items.map(x=>x.key)).size,1001);
  assert.equal(r.result.items[0].readback.listing,'UNLISTED');
  assert.equal(r.result.items[1].readback.listing,'PUBLIC');
});
test('cursor fails closed when account inventory or order changes',async()=>{
  const {e,a,context}=fake({entries:['a111','a222','a333'].map(name=>({name,isPrivate:true}))});
  const p=await a.listGenerators({context});assert(p.result.cursor);
  e.changeRemote('a333',{isPrivate:false});
  expectCode(await a.listGenerators({context,cursor:p.result.cursor}),'STALE_REVISION');
  expectCode(await a.listGenerators({context,cursor:'v1.5.'+'a'.repeat(64)}),'STALE_REVISION');
  expectCode(await a.listGenerators({context,cursor:'bad'}),'INVALID_REQUEST');
});
test('reject malformed, duplicate and missing account-scope identities',async()=>{
  for(const bad of ['XUpper','foo/evil','foo.',' leading','aa']){
    const {a,context}=fake({entries:[{name:bad,isPrivate:true}]});
    expectCode(await a.listGenerators({context}),'UNSUPPORTED_CAPABILITY');
  }
  const {e,a,context}=fake();
  const original=e.executor.execute;
  e.executor.execute=async x=>x.action==='inventory'?
    {context,status:'success',source:'ACCOUNT_INVENTORY',asOf:now(),items:[{name:'alpha-one',isPrivate:true},{name:'alpha-one',isPrivate:false}]}:original(x);
  expectCode(await a.listGenerators({context}),'CONFLICT');
});
test('cross-page duplicate and repeated cursor never silently overwrite',async()=>{
  const context=fake().context;
  let n=0;
  const stub={listGenerators:async()=>({ok:true,result:{asOf:now(),items:[{key:'alpha-one',readback:{ownership:'CONFIRMED'}}],cursor:++n<3?String(n):null}})};
  expectCode(await collectAccountGenerators(stub,context),'CONFLICT');
  const loop={listGenerators:async()=>({ok:true,result:{asOf:now(),items:[],cursor:'loop'}})};
  expectCode(await collectAccountGenerators(loop,context),'CONFLICT');
  const outage={listGenerators:async()=>({ok:false,error:{code:'UNAVAILABLE',message:'x',retryable:true}})};
  expectCode(await collectAccountGenerators(outage,context),'UNAVAILABLE');
});
test('read and observe refuse unowned, invalid or unauthenticated targets',async()=>{
  const {e,a,context}=fake();
  assert.equal((await a.read({context,targetKey:'alpha-one'})).result.sourceRevision,'r1');
  assert.equal((await a.observe({context,targetKey:'alpha-one'})).result.ownership,'CONFIRMED');
  expectCode(await a.read({context,targetKey:'not-owned'}),'OWNERSHIP_UNKNOWN');
  expectCode(await a.read({context,targetKey:'../bad'}),'INVALID_REQUEST');
  e.setCapability(['generator.list']);expectCode(await a.read({context,targetKey:'alpha-one'}),'UNSUPPORTED_CAPABILITY');
});
test('mutations require journal PREPARED, capability and exact expected revisions',async()=>{
  const {e,a,context}=fake();
  const input=req(context,'save','alpha-one','r1','op-1',{files:files('edited')});
  expectCode(await a.save(input),'RECOVERY_HOLD');
  assert(!e.calls.some(x=>x.kind==='save'));
  prepared(e,'save','alpha-one','r1');
  expectCode(await a.save({...input,expectedRevision:8}),'STALE_REVISION');
  assert.equal(e.inspectJournal('op-1').phase,'PREPARED');
  e.setCapability(['generator.get','generator.list']);
  expectCode(await a.save(input),'UNSUPPORTED_CAPABILITY');
  assert.equal(e.inspectJournal('op-1').phase,'PREPARED');
  e.setCapability(PERCHANCE_CAPABILITIES);
  expectCode(await a.save({...input,expectedSourceRevision:'r9'}),'RECOVERY_HOLD');
  assert(!e.calls.some(x=>x.kind==='save'));
});
test('save succeeds only on exact authoritative byte readback; no duplicate execution',async()=>{
  const {e,a,context}=fake();
  prepared(e,'save','alpha-one','r1');
  const s=await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('edited','<b>ok</b>')}));
  assert.equal(s.ok,true,JSON.stringify(s));assert.equal(s.result.files.pjs,'edited');
  assert.deepEqual([...s.result.files.thumbnail],[1,2,3]);
  assert.equal(e.inspectJournal('op-1').phase,'APPLIED');
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('edited')})),'RECOVERY_HOLD');
  assert.equal(e.calls.filter(x=>x.kind==='save').length,1);
});
test('stale save is FAILED, requires source reconsideration, never replayed',async()=>{
  const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');
  e.failNext('save',{status:'stale'});
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'STALE_REVISION');
  assert.equal(e.inspectJournal('op-1').phase,'FAILED');
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'RECOVERY_HOLD');
  assert.equal(e.calls.filter(x=>x.kind==='save').length,1);
});
test('manual challenge holds operation and never bypasses it',async()=>{
  const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');
  e.failNext('save',{status:'captcha-needed'});
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'WAITING_HUMAN');
  assert.equal(e.inspectJournal('op-1').phase,'HELD');
  assert.equal(e.calls.filter(x=>x.kind==='save').length,1);
});
test('ambiguous timeout after apply remains UNCERTAIN; no blind replay',async()=>{
  const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');
  e.failNext('save',{apply:true,throwError:true});
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'UNCERTAIN');
  assert.equal(e.listRemote()[0].files.pjs,'x');
  assert.equal(e.inspectJournal('op-1').phase,'UNCERTAIN');
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'RECOVERY_HOLD');
  assert.equal(e.calls.filter(x=>x.kind==='save').length,1);
});
test('unknown provider response after dispatch is uncertain, not fabricated success',async()=>{
  const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');
  e.failNext('save',{status:'unexpected-response'});
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'UNCERTAIN');
  assert.equal(e.inspectJournal('op-1').phase,'UNCERTAIN');
});
test('create requires absent account entry, verifies unlisted and tolerates external collision as conflict',async()=>{
  const {e,a,context}=fake();
  prepared(e,'create','new-slug',null);
  const created=await a.create(req(context,'create','new-slug',null));
  assert.equal(created.ok,true,JSON.stringify(created));
  assert.equal(created.result.ownership,'CONFIRMED');
  assert.equal(created.result.listing,'UNLISTED');
  const elsewhere=fake();elsewhere.e.reserveElsewhere('other-slug');
  prepared(elsewhere.e,'create','other-slug',null);
  expectCode(await elsewhere.a.create(req(elsewhere.context,'create','other-slug',null)),'CONFLICT');
});
test('listing switch requires confirmation, never treats unlisted as confidential',async()=>{
  const {e,a,context}=fake();prepared(e,'setListing','alpha-one','r1');
  const r=await a.setListing(req(context,'setListing','alpha-one','r1','op-1',{listing:'PUBLIC'}));
  assert.equal(r.ok,true);assert.equal(r.result.listing,'PUBLIC');
  assert.equal(e.listRemote()[0].isPrivate,false);
});
test('delete requires both account inventory absence and missing exact target',async()=>{
  const {e,a,context}=fake();prepared(e,'delete','alpha-one','r1');
  const r=await a.delete(req(context,'delete','alpha-one','r1'));
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.result.ownership,'UNKNOWN');
  assert.equal(e.listRemote().length,0);
});
test('source drift and wrong persona block before dispatch',async()=>{
  const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');
  e.changeRemote('alpha-one',{sourceRevision:'r2'});
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'SOURCE_DRIFT');
  assert.equal(e.inspectJournal('op-1').phase,'PREPARED');
  expectCode(await a.save(req({...context,personaUid:'wrong'},'save','alpha-one','r1','op-1',{files:files('x')})),'STALE_BINDING');
  assert.equal(e.calls.filter(x=>x.kind==='save').length,0);
});
test('recent-feed and rendered observations cannot establish ownership',()=>{
  const observed=classifyListingObservation({targetKey:'beta_two',feedKeys:['pinned','beta_two'],renderedKeys:['pinned'],asOf:now()});
  assert.equal(observed.status,'LIKELY_FILTERED');assert.equal(observed.feedPosition,2);
  assert.equal(observed.renderedPosition,null);
  assert.equal(classifyListingObservation({targetKey:'alpha-one',feedKeys:[],renderedKeys:[],asOf:now()}).status,'NOT_VISIBLE');
  assert.equal(classifyListingObservation({targetKey:'alpha-one',feedKeys:['alpha-one','alpha-one'],renderedKeys:[],asOf:now()}).status,'UNKNOWN');
});
test('AI history or unsaved local editor cannot masquerade as persisted source',()=>{
  assert.deepEqual(classifyAiSource({saved:{pjs:'a',html:'b'},workspace:{pjs:'a',html:'new'},history:{state:'ACTIVE'}}),
    {source:'LOCAL_UNSAVED',approved:false});
  assert.equal(classifyAiSource({saved:{pjs:'a',html:'b'},workspace:{pjs:'a',html:'b'},history:{state:'IDLE'}}).source,'SAVED_MATCH');
  assert.equal(classifyAiSource({history:{state:'ACTIVE'}}).source,'UNKNOWN');
});
test('executor is injected; module and emulator contain no forbidden independent network/browser authority',()=>{
  const paths=['adapter.mjs','emulator.mjs','observations.mjs'];
  for(const file of paths){const source=readFileSync(new URL(`../../../../extension/alpha/providers/perchance/${file}`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\b(?:fetch|XMLHttpRequest|WebSocket|browser\.tabs|chrome\.tabs|nativeMessaging|sendNativeMessage)\s*\(/);
  }
});
test('mutation guard refuses stale binding epoch and cannot mutate with missing read capability',async()=>{
  const {e,a,context}=fake();prepared(e,'delete','alpha-one','r1');
  expectCode(await a.delete({...req(context,'delete','alpha-one','r1'),accountBindingEpoch:2}),'INVALID_REQUEST');
  e.setCapability(['generator.list','generator.delete']);
  expectCode(await a.delete(req(context,'delete','alpha-one','r1')),'UNSUPPORTED_CAPABILITY');
  assert.equal(e.inspectJournal('op-1').phase,'PREPARED');
});
test('readback differing in a single thumbnail byte is an UNCERTAIN save',async()=>{
  const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');
  const execute=e.executor.execute;
  e.executor.execute=async input=>{
    const r=await execute(input);
    if(input.action==='save')e.changeRemote('alpha-one',{files:files('edited','b')});
    if(input.action==='read' && r.status==='success' && r.readback.files.pjs==='edited'){
      r.readback.files.thumbnail[2]=9;
    }
    return r;
  };
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('edited','b')})),'UNCERTAIN');
  assert.equal(e.inspectJournal('op-1').phase,'UNCERTAIN');
});
test('challenge before mutation does not dispatch or bypass CAPTCHA',async()=>{
  const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');e.setSession('WAITING_HUMAN');
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'WAITING_HUMAN');
  assert.equal(e.inspectJournal('op-1').phase,'PREPARED');
  assert.equal(e.calls.filter(x=>x.kind==='save').length,0);
});
test('invalid or unknown provider status never creates a success receipt',async()=>{
  for(const status of ['server-error','src-unmapped','created','unknown']){
    const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');
    e.failNext('save',{status});
    expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'UNCERTAIN');
    assert.equal(e.inspectJournal('op-1').phase,'UNCERTAIN');
  }
});
test('rate limit is typed and journal prevents blind retry',async()=>{
  const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');
  e.failNext('save',{status:'too-many-requests'});
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'RATE_LIMIT');
  assert.equal(e.inspectJournal('op-1').phase,'FAILED');
  assert.equal((await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')}))).error.retryable,false);
});
test('failed journal completion blocks ambiguous operation recovery',async()=>{
  const {e,a,context}=fake();prepared(e,'save','alpha-one','r1');
  e.journal.complete=async()=>{throw Error('disk I/O');};
  expectCode(await a.save(req(context,'save','alpha-one','r1','op-1',{files:files('x')})),'RECOVERY_HOLD');
  assert.equal(e.inspectJournal('op-1').phase,'DISPATCHING');
  assert.equal(e.listRemote()[0].files.pjs,'x');
});
test('one name missing or ambiguous privacy invalidates entire account page',async()=>{
  const {e,a,context}=fake();const orig=e.executor.execute;
  e.executor.execute=async input=>input.action==='inventory'?
    {context,status:'success',source:'ACCOUNT_INVENTORY',items:[{isPrivate:true}],asOf:now()}:orig(input);
  expectCode(await a.listGenerators({context}),'UNSUPPORTED_CAPABILITY');
  e.executor.execute=async input=>input.action==='inventory'?
    {context,status:'success',source:'ACCOUNT_INVENTORY',items:[{name:'correct-slug',isPrivate:'maybe'}],asOf:now()}:orig(input);
  expectCode(await a.listGenerators({context}),'UNSUPPORTED_CAPABILITY');
});
