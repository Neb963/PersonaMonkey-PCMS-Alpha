import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGitHubAdapter} from '../../../../extension/alpha/providers/github/adapter.mjs';
import {createGitHubPathTemplates, assertGitHubPath} from '../../../../extension/alpha/providers/github/paths.mjs';

const SHA = Object.fromEntries('abcdef'.split('').map(x => [x, x.repeat(40)]));
const token = 'FAKE_SECRET_SENTINEL_NEVER_REAL';
const repository = 'Neb963/per-gens';
const path = 'generators/folder-one/main.pjs';
const htmlPath = 'generators/folder-one/index.html';
const source = new TextEncoder().encode('seed');
const replacement = new TextEncoder().encode('updated source');
function reply(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {status, headers: {'content-type':'application/json',...headers}});
}
function scenario({head = SHA.a, contentSha = SHA.b, patchStatus = 200, dropPatch = false, changingHead = null, authStatus = null, rateLimited = false} = {}) {
  const calls = [];
  let branchHead = head, headReads = 0;
  const fetchImpl = async (url, options) => {
    const u = new URL(url), suffix = u.pathname.split('/repos/Neb963/per-gens')[1];
    calls.push({suffix, method:options.method, body:options.body ? JSON.parse(options.body) : null,
      bearer:options.headers.Authorization, credentials:options.credentials, redirect:options.redirect, ref:u.searchParams.get('ref')});
    if (authStatus !== null) return reply({message:'private authorization denied'}, authStatus);
    if (rateLimited) return reply({message:'rate-limited'}, 403, {'retry-after':'15','x-ratelimit-remaining':'0'});
    if (suffix === '/git/ref/heads/main' && options.method === 'GET') {
      headReads++;
      if (changingHead && headReads >= changingHead) branchHead = SHA.f;
      return reply({object:{type:'commit',sha:branchHead}});
    }
    if (suffix.startsWith('/contents/generators/folder-one/') && options.method === 'GET') {
      const filePath=suffix.slice('/contents/'.length);
      return contentSha === null ? reply({},404) : reply({type:'file',path:filePath,sha:contentSha});
    }
    if (suffix === `/git/commits/${SHA.a}`) return reply({tree:{sha:SHA.c}});
    if (suffix === `/git/blobs/${SHA.b}` && options.method === 'GET') return reply({sha:SHA.b,encoding:'base64',size:source.length,content:btoa(String.fromCharCode(...source))});
    if (suffix === '/git/blobs' && options.method === 'POST') return reply({sha:SHA.d},201);
    if (suffix === '/git/trees' && options.method === 'POST') return reply({sha:SHA.e},201);
    if (suffix === '/git/commits' && options.method === 'POST') return reply({sha:SHA.f},201);
    if (suffix === '/git/refs/heads/main' && options.method === 'PATCH') {
      if (dropPatch) throw new Error(`unknown write outcome with ${token}`);
      if (patchStatus !== 200) return reply({message:'head advanced'},patchStatus);
      branchHead = options.body && JSON.parse(options.body).sha;
      return reply({object:{sha:branchHead}});
    }
    throw new Error(`Unanticipated fixture request: ${options.method} ${suffix}`);
  };
  const adapter = createGitHubAdapter({secretRef:'github-ref',bindings:[{folder:'folder-one',slug:'slug-one'}],resolveSecret:async()=>token,fetchImpl});
  return {adapter,calls,head:()=>branchHead};
}
const snap = () => ({repository,ref:'main',paths:[path]});
const commit = (more = {}) => ({repository,ref:'main',expectedHeadSha:SHA.a,
  expectedBlobs:{[path]:SHA.b},files:{[path]:replacement},secretRef:'github-ref',opId:'op-123',...more});

test('AP104-01 strict literal templates reject traversal, URI aliasing and ambiguous names', () => {
  const templates = createGitHubPathTemplates();
  assert.deepEqual(templates.resolve({folder:'different-folder',slug:'different-slug'}),{
    status:'generators/different-folder/DEPLOYMENT.md',pjs:'generators/different-folder/main.pjs',
    html:'generators/different-folder/index.html',thumbnail:'generators/different-folder/thumbnail.jpeg'});
  const derived = createGitHubPathTemplates({root:'sources/{folder}',pjs:'src-{slug}.pjs'});
  assert.equal(derived.resolve({folder:'fold-1',slug:'slug-2'}).pjs,'sources/fold-1/src-slug-2.pjs');
  for(const bad of ['../evil','/absolute','a/../b','generators//main.pjs','generators/a/%2e%2e/z','a\\b','a/./c','a/b/CON','a/.git/config','a/b/abc..pjs','a/b/trailing.','a/b/na?me','a/b/fóó']) {
    assert.throws(()=>assertGitHubPath(bad),TypeError,bad);
  }
  for(const bad of ['{other}','../generators/{folder}','generators/{folder}/../oops','generators/{folder}//oops','generators/*'])
    assert.throws(()=>createGitHubPathTemplates({root:bad}),TypeError,bad);
  assert.throws(()=>createGitHubPathTemplates({pjs:'Index.html',html:'index.html'}).resolve({folder:'x',slug:'y'}),/Ambiguous/);
  assert.throws(()=>templates.resolve({folder:'../../steal',slug:'fine'}));
  assert.throws(()=>templates.resolve({folder:'x',slug:'a/b'}));
});

test('AP104-01 snapshot pins Contents reads to immutable commit and readBlob by identity', async () => {
  const s = scenario();
  const value = await s.adapter.snapshot(snap());
  assert.deepEqual({...value.result.blobs},{[path]:SHA.b});
  assert.equal(value.result.commitSha,SHA.a);
  assert.ok(s.calls.some(x=>x.suffix===`/contents/${path}` && x.ref===SHA.a));
  assert.equal((await s.adapter.readBlob({repository,blobSha:SHA.b})).result.join(','),source.join(','));
  assert.ok(s.calls.every(x=>x.bearer===`Bearer ${token}` && x.credentials==='omit' && x.redirect==='error'));
});

test('AP104-01 conditional atomic tree commit updates main in one non-forced ref move', async () => {
  const s = scenario();
  const result = await s.adapter.commit(commit());
  assert.equal(result.ok,true,JSON.stringify(result.error));
  assert.equal(result.result.commitSha,SHA.f);
  assert.equal(result.result.blobs[path],SHA.d);
  assert.equal(s.head(),SHA.f);
  assert.deepEqual(s.calls.filter(x=>x.method==='POST').map(x=>x.suffix),['/git/blobs','/git/trees','/git/commits']);
  const tree=s.calls.find(x=>x.suffix==='/git/trees').body;
  assert.deepEqual(tree,{base_tree:SHA.c,tree:[{path,mode:'100644',type:'blob',sha:SHA.d}]});
  const created=s.calls.find(x=>x.suffix==='/git/commits').body;
  assert.deepEqual(created.parents,[SHA.a]);
  const patch=s.calls.filter(x=>x.method==='PATCH');
  assert.equal(patch.length,1);
  assert.deepEqual(patch[0].body,{sha:SHA.f,force:false});
});

test('AP104-02 unexpected branch-head prevents writes even if expected blobs match', async () => {
  const s = scenario({head:SHA.f});
  const result=await s.adapter.commit(commit());
  assert.equal(result.error.code,'CONFLICT');
  assert.ok(!s.calls.some(x=>x.method==='POST'||x.method==='PATCH'));
});

test('AP104-02 mismatch of expected blob prevents source overwrite', async () => {
  const s = scenario({contentSha:SHA.d});
  const result=await s.adapter.commit(commit());
  assert.equal(result.error.code,'CONFLICT');
  assert.ok(!s.calls.some(x=>x.method==='POST'||x.method==='PATCH'));
});

test('AP104-02 a competing merge before ref update stops the mutation', async () => {
  const s = scenario({changingHead:2});
  const result=await s.adapter.commit(commit());
  assert.equal(result.error.code,'CONFLICT');
  assert.equal(s.calls.filter(x=>x.method==='PATCH').length,0);
});

test('AP104-02 non-fast-forward 422 does not overwrite an intervening developer commit',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../../../fixtures/alpha/github/branch-conflict.json',import.meta.url)));
  const s=scenario({patchStatus:fixture.status});
  const result=await s.adapter.commit(commit());
  assert.equal(result.error.code,fixture.expectedFailure);
  assert.equal(s.head(),SHA.a);
  assert.equal(s.calls.filter(x=>x.method==='PATCH').length,1);
  assert.equal(s.calls.find(x=>x.method==='PATCH').body.force,false);
});

test('AP104-02 ambiguous ref update response requires readback/reconciliation, never blind retry',async()=>{
  const s=scenario({dropPatch:true});
  const result=await s.adapter.commit(commit());
  assert.equal(result.error.code,'UNCERTAIN');
  assert.equal(result.error.retryable,false);
  assert.equal(s.calls.filter(x=>x.method==='PATCH').length,1);
});

test('AP104-03 token never appears in success or failure values and is resolved outside normal state', async () => {
  const s=scenario({rateLimited:true});
  const fixture=JSON.parse(readFileSync(new URL('../../../../fixtures/alpha/github/rate-limit.json',import.meta.url)));
  const read=await s.adapter.snapshot(snap());
  const write=await s.adapter.commit(commit());
  assert.equal(read.error.code,fixture.expectedFailure);
  assert.equal(write.error.code,'RATE_LIMIT');
  assert.ok(!JSON.stringify([read,write]).includes(token));
  assert.ok(!JSON.stringify([read,write]).includes('Bearer'));
  const denied=scenario({authStatus:401});
  const forbidden=await denied.adapter.commit(commit());
  assert.equal(forbidden.error.code,'WAITING_HUMAN');
  assert.ok(!JSON.stringify(forbidden).includes(token));
  const crash=scenario({dropPatch:true});
  assert.ok(!JSON.stringify(await crash.adapter.commit(commit())).includes(token));
});

test('AP104-03 fail closed on invalid target, ref, opId, secretRef or unsafe paths before network', async () => {
  const s=scenario();
  for(const bad of [
    {...snap(),ref:'feature'}, {...snap(),repository:'Neb963/other'},
    {...snap(),paths:['generators/../steal/main.pjs']},
    {...snap(),paths:['generators/folder-one/main.pjs','generators/folder-one/MAIN.pjs']},
    {...snap(),paths:['generators/other/main.pjs']},
    {...snap(),paths:['generators/folder-one/README.md']},
    commit({opId:'x\r\nAuthorization: evil'}), commit({secretRef:'untrusted-ref'}),
    commit({files:{'generators/a/%2e%2e/main.pjs':new Uint8Array()},expectedBlobs:{'generators/a/%2e%2e/main.pjs':null}}),
    commit({files:{'generators/folder-one/private.txt':new Uint8Array()},expectedBlobs:{'generators/folder-one/private.txt':null}}),
    commit({files:{[path]:new Uint8Array(4*1024*1024+1)}})
  ]) {
    const value = 'paths' in bad ? await s.adapter.snapshot(bad) : await s.adapter.commit(bad);
    assert.equal(value.error?.code,'INVALID_REQUEST',JSON.stringify(bad));
  }
  assert.equal(s.calls.length,0);
});

test('AP104-03 missing file read is explicit and malformed blobs cannot be trusted',async()=>{
  const s=scenario({contentSha:null});
  const snapResult=await s.adapter.snapshot(snap());
  assert.equal(snapResult.ok,true);
  assert.deepEqual({...snapResult.result.blobs},{});
  const badBlob=await s.adapter.readBlob({repository,blobSha:'../../etc'});
  assert.equal(badBlob.error.code,'INVALID_REQUEST');
});

test('AP104-01 configured remapped bindings are exact; unknown or duplicate binding fails closed',async()=>{
  assert.throws(()=>createGitHubAdapter({secretRef:'x',resolveSecret:async()=>token,fetchImpl:async()=>{},bindings:[]}),/bindings/);
  assert.throws(()=>createGitHubAdapter({secretRef:'x',resolveSecret:async()=>token,fetchImpl:async()=>{},bindings:[{folder:'same',slug:'one'},{folder:'same',slug:'two'}]}),/Ambiguous/);
  const remapped = createGitHubPathTemplates({root:'library/{folder}',pjs:'source-{slug}.pjs'});
  assert.equal(remapped.resolve({folder:'different',slug:'target'}).pjs,'library/different/source-target.pjs');
});

test('AP104-01 source and HTML edits become one commit, not two main updates',async()=>{
  const s=scenario();
  const value=await s.adapter.commit(commit({expectedBlobs:{[path]:SHA.b,[htmlPath]:SHA.b},files:{[path]:replacement,[htmlPath]:new TextEncoder().encode('<main>ready</main>')}}));
  assert.equal(value.ok,true);
  assert.equal(s.calls.filter(x=>x.suffix==='/git/trees').length,1);
  assert.equal(s.calls.find(x=>x.suffix==='/git/trees').body.tree.length,2);
  assert.equal(s.calls.filter(x=>x.suffix==='/git/commits' && x.method==='POST').length,1);
  assert.equal(s.calls.filter(x=>x.method==='PATCH').length,1);
});

test('AP104-01 reject repository alias and unconfigured source paths',async()=>{
  assert.throws(()=>createGitHubAdapter({repository:'../escape',secretRef:'x',resolveSecret:async()=>token,fetchImpl:async()=>{},bindings:[{folder:'folder-one',slug:'ok'}]}));
  const s=scenario();
  assert.equal((await s.adapter.snapshot({...snap(),paths:['generators/folder-one/untracked.md']})).error.code,'INVALID_REQUEST');
});
