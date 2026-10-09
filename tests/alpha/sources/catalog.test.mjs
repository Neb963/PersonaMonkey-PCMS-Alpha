import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { createSourceCatalog, canonicalReleaseId, parseDeploymentStatus, hasNewDeployableRelease } from '../../../extension/alpha/features/sources/catalog.mjs';
import { createGitHubPathTemplates } from '../../../extension/alpha/providers/github/paths.mjs';

const crypto = globalThis.crypto || webcrypto;
const sha = char => char.repeat(40);
const bytes = v => typeof v === 'string' ? new TextEncoder().encode(v) : v;
const files = { pjs: bytes('hello\r\n'), html: bytes('<main>ok</main>'), thumbnail: Uint8Array.from([255,216,1,2,255,217]) };
function githubFixture({ mappings=[{folder:'folder-one',slug:'live_slug'}], paths={}, status='Status: READY\r\n\nNotes',
  omit=[], source=files, badStatus=false, head=sha('a'), fail=null } = {}) {
  const templates=createGitHubPathTemplates(paths);
  const blobs={}, data=new Map(), log=[];
  const all=[];
  for(const m of mappings){
    const names=templates.resolve(m); all.push(names);
    for(const [key,path] of Object.entries(names)) {
      if(omit.includes(key)||omit.includes(path))continue;
      const contents=key==='status'?bytes(status):source[key];
      if(contents===undefined)continue;
      const id=createHash('sha1').update(Buffer.from(contents)).digest('hex');
      blobs[path]=id;data.set(id,contents);
    }
  }
  const github={
    async snapshot(input){log.push(['snapshot',input]);if(fail)return {ok:false,error:{code:fail,message:'MALICIOUS_PRIVATE_TOKEN'},revision:0};return {ok:true,result:{commitSha:head,blobs:Object.fromEntries(input.paths.filter(p=>blobs[p]).map(p=>[p,blobs[p]]))},revision:0};},
    async readBlob({blobSha}){log.push(['readBlob',blobSha]);return data.has(blobSha)?{ok:true,result:data.get(blobSha),revision:0}:{ok:false,error:{code:'UNAVAILABLE',message:'MALICIOUS_PRIVATE_TOKEN'},revision:0};}
  };
  return {github,mappings,paths,log,data,blobs,all};
}
const make = (f, other={})=>createSourceCatalog({github:f.github,mappings:f.mappings,paths:f.paths,digest:crypto.subtle,clock:()=>new Date('2026-10-09T12:00:00Z').toISOString(),...other});

test('AP203-01 status recognizes only one exact standalone directive',()=>{
  for (const [value,result] of [['Status: READY','READY'],['# Notes\nStatus: IN_DEVELOPMENT\n','IN_DEVELOPMENT'],['Status: BLOCKED\r\n','BLOCKED'],['Status: READY\nStatus: BLOCKED','BLOCKED'],['Status: READY\n Status: READY','BLOCKED'],['Status: READY \n','BLOCKED'],['status: READY','BLOCKED'],['Status: DEPLOYED','BLOCKED'],['Some Status: READY','BLOCKED'],['Just docs','BLOCKED'],['Status: READY\nStatus: broken','BLOCKED']])assert.equal(parseDeploymentStatus(value),result,value);
});

test('AP203-01 READY resolves pinned PJS/HTML/JPEG bytes and canonical release',async()=>{
  const f=githubFixture();const catalog=make(f);
  const got=await catalog.get({key:'live_slug'});assert.equal(got.ok,true);assert.equal(got.result.status,'READY');
  assert.equal(got.result.ref,'main');assert.equal(got.result.commitSha,sha('a'));assert.equal(got.result.folder,'folder-one');assert.equal(got.result.slug,'live_slug');
  const record=await catalog.resolveRelease({key:'live_slug'});
  assert.equal(record.ok,true);assert.equal(record.result.releaseId,got.result.releaseId);assert.deepEqual(record.result.files, {pjs:'hello\r\n',html:'<main>ok</main>',thumbnail:files.thumbnail});
  assert.equal(record.result.createdAt,'2026-10-09T12:00:00.000Z');
  assert.ok(f.log.every(([method,input])=>method!=='snapshot'||input.ref==='main'));
  assert.ok(f.log.every(([method])=>method!=='commit'));
});

test('AP203-01 each non-READY or missing status makes release unavailable',async()=>{
  for(const value of ['Status: BLOCKED','Status: IN_DEVELOPMENT','status: READY','Status: READY\nStatus: READY','Status: READY\nStatus: MAYBE','some text']) {
    const f=githubFixture({status:value});const c=make(f);const r=await c.get({key:'live_slug'});
    assert.equal(r.ok,true,value);assert.equal(r.result.status,parseDeploymentStatus(value),value);assert.equal(r.result.releaseId,null,value);
    assert.equal((await c.resolveRelease({key:'live_slug'})).error.code,'NOT_APPLIED',value);
    assert.equal(f.log.filter(([x])=>x==='readBlob').length,2,'only status read on get/resolve');
  }
  const absent=githubFixture({omit:['status']});assert.equal((await make(absent).get({key:'live_slug'})).result.status,'BLOCKED');
  assert.equal(absent.log.filter(([x])=>x==='readBlob').length,0);
});

test('AP203-01 READY without each required deployable file cannot release',async()=>{
  for(const omitted of ['pjs','html','thumbnail']) {
    const c=make(githubFixture({omit:[omitted]}));const result=await c.get({key:'live_slug'});
    assert.equal(result.ok,true);assert.equal(result.result.status,'READY');assert.equal(result.result.releaseId,null);
    assert.equal((await c.resolveRelease({key:'live_slug'})).error.code,'NOT_APPLIED');
  }
});

test('AP203-02 pure canonical byte framing distinguishes ambiguous inputs and docs-only commits',async()=>{
  const a=await canonicalReleaseId(files,crypto.subtle);
  const b=await canonicalReleaseId({pjs:bytes('hello\n'),html:files.html,thumbnail:files.thumbnail},crypto.subtle);
  const c=await canonicalReleaseId({pjs:bytes('a'),html:bytes('bc'),thumbnail:files.thumbnail},crypto.subtle);
  const d=await canonicalReleaseId({pjs:bytes('ab'),html:bytes('c'),thumbnail:files.thumbnail},crypto.subtle);
  assert.match(a,/^[a-f0-9]{64}$/);assert.notEqual(a,b);assert.notEqual(c,d);
  assert.equal(await canonicalReleaseId(files,crypto.subtle),a);
  const f=githubFixture();const first=await make(f).get({key:'live_slug'});
  const changed=githubFixture({status:'Status: READY\nChanged docs only',head:sha('b')});const next=await make(changed).get({key:'live_slug'});
  assert.notEqual(next.result.commitSha,first.result.commitSha);assert.equal(next.result.releaseId,first.result.releaseId);
  assert.equal(hasNewDeployableRelease(next.result,first.result.releaseId),false);
  assert.equal(hasNewDeployableRelease(next.result,null),true);
  assert.equal(hasNewDeployableRelease({status:'BLOCKED',releaseId:a},null),false);
  assert.equal(hasNewDeployableRelease({status:'READY',releaseId:null},null),false);
  assert.equal(hasNewDeployableRelease(next.result,undefined),false);
});

test('AP203-03 explicit distinct folder and slug templates do not infer identity',async()=>{
  const mappings=[{folder:'source-folder-a',slug:'generator_one'},{folder:'different-folder',slug:'generator_two'}];
  const paths={root:'code/{folder}/deploy',pjs:'src/{slug}.pjs',html:'web/{slug}.html',thumbnail:'assets/{folder}.jpeg',status:'state/DEPLOYMENT.md'};
  const f=githubFixture({mappings,paths});const c=make(f);const page=await c.scan({limit:2});
  assert.equal(page.ok,true);assert.equal(page.result.items.length,2);
  assert.equal(page.result.items[0].slug,'generator_one');assert.equal(page.result.items[0].root,'code/source-folder-a/deploy');
  assert.equal(page.result.items[1].folder,'different-folder');assert.equal(page.result.items[1].releaseId,page.result.items[0].releaseId);
  assert.ok(Object.keys(page.result.items[0].blobs).some(p=>p==='code/source-folder-a/deploy/src/generator_one.pjs'));
  assert.throws(()=>make(githubFixture({mappings:[mappings[0],mappings[0]]})),/Duplicate/);
  assert.throws(()=>make(githubFixture({mappings:[{folder:'x',slug:'InvalidName'}]})));
  assert.throws(()=>make(githubFixture({mappings:[{folder:'../x',slug:'safe'}]})));
});

test('AP203-03 cursor fences commit changes between 32-file snapshots',async()=>{
  const maps=Array.from({length:35},(_,i)=>({folder:`dir-${i}`,slug:`slug_${i}`}));
  const f=githubFixture({mappings:maps});const c=make(f);
  const page=await c.scan({limit:7});assert.equal(page.ok,true);assert.equal(page.result.items.length,7);assert.match(page.result.cursor,/^s1:7:[a-f0-9]{40}$/);
  const next=await c.scan({cursor:page.result.cursor,limit:7});assert.equal(next.ok,true);assert.equal(next.result.items.length,7);
  const altered=make(githubFixture({mappings:maps,head:sha('c')}));assert.equal((await altered.scan({cursor:page.result.cursor,limit:7})).error.code,'CONFLICT');
  const invalid=await c.scan({cursor:'s1:01:'+sha('a')});assert.equal(invalid.error.code,'INVALID_REQUEST');
  assert.equal((await c.scan({limit:33})).error.code,'INVALID_REQUEST');
  assert.equal((await c.scan({cursor:'s1:999:'+sha('a')})).error.code,'INVALID_REQUEST');
});

test('AP203-01 malformed blob encoding blocks release, never coerces bytes',async()=>{
  const bad=githubFixture({source:{...files,pjs:Uint8Array.from([0xff,0xfe])}});
  const result=await make(bad).get({key:'live_slug'});assert.equal(result.ok,true);assert.equal(result.result.status,'READY');assert.equal(result.result.releaseId,null);
  const invalidStatus=githubFixture({status:'Status: READY'});const id=invalidStatus.blobs[invalidStatus.all[0].status];invalidStatus.data.set(id,Uint8Array.from([0xff,0xfe]));
  const invalid=await make(invalidStatus).get({key:'live_slug'});assert.equal(invalid.result.status,'BLOCKED');
});

test('AP203-02 GitHub typed errors are propagated with no raw provider text',async()=>{
  for(const code of ['RATE_LIMIT','WAITING_HUMAN','UNAVAILABLE','CONFLICT']){
    const c=make(githubFixture({fail:code}));const r=await c.get({key:'live_slug'});
    assert.equal(r.error.code,code);assert.ok(!JSON.stringify(r).includes('MALICIOUS_PRIVATE_TOKEN'));
  }
});

test('AP203-03 local bind enforces global CAS, account binding epoch and safe mapping',async()=>{
  const f=githubFixture();
  let calls=0;
  const original={key:'live_slug',accountBindingEpoch:4,sourceBinding:null,revision:2};
  const storage={async read(){return {revision:8,item:{revision:2,record:original}};},async commit(input){calls++;assert.equal(input.expectedRevision,8);assert.equal(input.writes[0].expectedRevision,2);assert.equal(input.writes[0].record.releaseId,undefined);return {revision:9,items:[{record:{...original,sourceBinding:input.writes[0].record.sourceBinding}}]};}};
  const c=make(f,{storage});const valid={key:'live_slug',expectedRevision:8,accountBindingEpoch:4,opId:'op-123'};
  assert.equal((await c.bind(valid)).ok,true);assert.equal(calls,1);
  assert.equal((await c.bind({...valid,expectedRevision:7})).error.code,'STALE_REVISION');
  assert.equal((await c.bind({...valid,accountBindingEpoch:3})).error.code,'STALE_BINDING');
  assert.equal((await c.bind({...valid,key:'unknown'})).error.code,'INVALID_REQUEST');
  assert.equal(calls,1);
});
