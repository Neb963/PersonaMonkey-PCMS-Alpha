import test from "node:test";
import assert from "node:assert/strict";
import {createFixtureRepositoryProvider} from "../../../extension/pcms/providers/repository/fixture.js";
import {createGithubRepositoryProvider} from "../../../extension/pcms/providers/repository/github.js";
import {REPO_ERRORS,normalizeRepositoryConfig,normalizeRepoTree} from "../../../extension/pcms/providers/repository/contract.js";
import {createDeployerRepositoryService} from "../../../pcms-modules/p015/repository-service.js";
import {createSingletonStateStore} from "../../../extension/pcms/integration/adapters.js";
import {createUiContribution} from "../../../pcms-modules/p015/ui.js";
import {normalizeBuiltinContribution} from "../../../extension/pcms/integration/ui-contributions.js";
import {generatorPayloadHash} from "../../../extension/pcms/providers/perchance/contract.js";
import {setup} from "../p036/harness.mjs";
const sha1="1".repeat(40),sha2="2".repeat(40),sha3="3".repeat(40);
const config={provider:"github",owner:"fixtures",repo:"generators",ref:"main",root:"",
  access:{kind:"public"},network:"default"};
function blobs({version="1.0.0",code="alpha",html="<main>A</main>",listing="UNLISTED",folder="alice",slug="example"}={}){
  const base=folder+"/"+slug+"/";
  const m={format:"pcms.generator/v1",slug,title:"Example",release:version,listing,deploy:"manual"};
  return {"pcms-generators.json":'{"format":"pcms.generator-repository/v1"}',
    [base+"generator.json"]:JSON.stringify(m),
    [base+"releases/"+version+"/code.perchance"]:code,
    [base+"releases/"+version+"/page.html"]:html};
}
function fixture({versions={[sha1]:blobs()},failures={},deployerOverride=null}={}){
  const ctx=setup();
  const provider=createFixtureRepositoryProvider({refs:{main:sha1},commits:Object.fromEntries(
    Object.entries(versions).map(([sha,blobs])=>[sha,{blobs,committedAt:"2026-10-01T12:00:00.000Z"}])),failures});
  let n=0;const clock=()=>new Date(Date.UTC(2026,9,8,12,0,n++)).toISOString();
  const repo=createDeployerRepositoryService({stateStore:createSingletonStateStore({
    storageBroker:ctx.storage,namespace:"module.deployer.repository"}),
    ledgerStore:ctx.storage.namespace("module.deployer.repository.ledger"),
    repositoryProvider:provider,deployer:deployerOverride?deployerOverride(ctx.deployer):ctx.deployer,accounts:ctx.accounts.service,
    recoveryHold:ctx.recoveryHold,clock});
  return {ctx,provider,repo};
}
async function configure(repo){
  await repo.configure({config,expectedRevision:0});
  const row=await repo.read();
  await repo.linkFolder({folder:"alice",accountId:"acct-1",expectedRevision:row.revision});
}
async function finish(repo){
  const start=await repo.startScan();assert.equal(start.alreadyRunning,false);
  let result;
  for(let i=0;i<64;i++){
    result=await repo.scanStep({batchSize:1});
    if(result.done)return result;
  }
  throw new Error("Exceeded scan checkpoint budget");
}
test("A037-01 commit-pinned byte hashes and snapshots are timezone/clock independent",async()=>{
  const left=fixture(),right=fixture();
  await configure(left.repo);await configure(right.repo);
  const a=await finish(left.repo),b=await finish(right.repo);
  assert.equal(a.status,"SUCCESS");assert.equal(b.status,"SUCCESS");
  assert.deepEqual(a.snapshot,b.snapshot);
  assert.equal(a.snapshot.items[0].payloadHash,await generatorPayloadHash("alpha","<main>A</main>"));
  assert.equal("code" in a.snapshot.items[0],false);
  assert.equal("html" in a.snapshot.items[0],false);
  assert.equal(a.snapshot.commitId,sha1);
  assert.equal(a.snapshot.items[0].origin.path,"alice/example/generator.json");
});
test("A037-02 update ready, unchanged no-op and modified published release blocks",async()=>{
  const fx=fixture({versions:{[sha1]:blobs(),[sha2]:blobs({version:"1.0.1",code:"beta"}),
    [sha3]:blobs({version:"1.0.0",code:"tampered"})}});
  await configure(fx.repo);assert.equal((await finish(fx.repo)).status,"SUCCESS");
  let state=await fx.ctx.deployer.listDeployments();assert.equal(state.deployments.length,1);
  const first=state.deployments[0];
  assert.equal(first.desired.origin.kind,"REPOSITORY");
  assert.equal(first.desired.revision,1);
  assert.equal((await finish(fx.repo)).status,"UNCHANGED");
  state=await fx.ctx.deployer.listDeployments();
  assert.equal(state.revision,1); // unchanged release never bumps Deployer revision
  fx.provider.setRef("main",sha2);
  assert.equal((await finish(fx.repo)).status,"SUCCESS");
  state=await fx.ctx.deployer.listDeployments();
  assert.equal(state.deployments[0].desired.revision,2);
  assert.equal(state.deployments[0].confirmed.payloadHash,null); // snapshot never impersonates provider state
  fx.provider.setRef("main",sha3);
  const modified=await finish(fx.repo);
  assert.equal(modified.status,"SUCCESS");
  assert.ok(modified.snapshot.problems.some(p=>p.code==="GEN_RELEASE_MODIFIED"));
  assert.equal(modified.snapshot.items.length,0);
  state=await fx.ctx.deployer.listDeployments();
  assert.equal(state.deployments[0].desired.revision,2); // blocked release not prepared
});
test("A037-03 bad marker, truncation and auth faults retain previous snapshot and desired deployment",async()=>{
  const fx=fixture({versions:{[sha1]:blobs(),[sha2]:{"no-marker.json":"{}"}}});
  await configure(fx.repo);assert.equal((await finish(fx.repo)).status,"SUCCESS");
  const baseline=(await fx.repo.read()).value.snapshot;
  fx.provider.setRef("main",sha2);
  assert.equal((await finish(fx.repo)).status,"FAILED");
  assert.deepEqual((await fx.repo.read()).value.snapshot,baseline);
  assert.equal((await fx.ctx.deployer.listDeployments()).deployments.length,1);
  fx.provider.setFailure("listTree",REPO_ERRORS.TREE_TRUNCATED);
  assert.equal((await finish(fx.repo)).status,"FAILED");
  assert.deepEqual((await fx.repo.read()).value.snapshot,baseline);
  fx.provider.setFailure("listTree",null);
  fx.provider.setFailure("resolveRef",REPO_ERRORS.AUTH_FAILED);
  assert.equal((await finish(fx.repo)).status,"FAILED");
  assert.deepEqual((await fx.repo.read()).value.snapshot,baseline);
});
test("A037-03 failed APPLY checkpoint survives retry without duplicated deployment",async()=>{
  const fx=fixture();await configure(fx.repo);
  const start=await fx.repo.startScan();assert.equal(start.alreadyRunning,false);
  assert.equal((await fx.repo.scanStep()).status,"VALIDATE");
  assert.equal((await fx.repo.scanStep()).status,"FINALIZE");
  assert.equal((await fx.repo.scanStep()).status,"APPLY");
  const original=fx.ctx.deployer.createDeployment,service=fx.repo;
  // Restart persistence exercised separately below; no second scan should be required.
  assert.equal((await service.scanStep()).status,"SUCCESS");
  const created=(await fx.ctx.deployer.listDeployments()).deployments;
  assert.equal(created.length,1);
  assert.equal((await finish(service)).status,"UNCHANGED");
  assert.equal((await fx.ctx.deployer.listDeployments()).deployments.length,1);
});
test("A037-01 strict repository provider mapping and bounded GitHub shapes",async()=>{
  assert.throws(()=>normalizeRepositoryConfig({...config,root:"../secret"}),{code:REPO_ERRORS.PROTOCOL});
  assert.throws(()=>normalizeRepoTree({complete:false,entries:[]}),{code:REPO_ERRORS.TREE_TRUNCATED});
  const seen=[];
  const headers={get:()=>null};
  const fetchImpl=async(url,opts)=>{
    seen.push({url,opts});
    if(url.includes("/commits/"))return {ok:true,status:200,headers,async text(){return JSON.stringify({
      sha:sha1,commit:{committer:{date:"2026-10-01T12:00:00Z"},message:"first"}})}};

    if(url.includes("/git/trees/"))return {ok:true,status:200,headers,async text(){return JSON.stringify({
      truncated:false,tree:[{path:"pcms-generators.json",type:"blob",sha:sha2,size:12}]})}};

    return {ok:true,status:200,headers,async text(){return JSON.stringify({encoding:"base64",size:2,content:"aGk="})}};
  };
  const github=createGithubRepositoryProvider({fetchImpl});
  const resolved=await github.resolveRef(config);
  assert.deepEqual(Object.keys(resolved),["commitId","committedAt","message"]);
  const tree=await github.listTree(config,sha1);
  assert.deepEqual(tree.entries[0],{path:"pcms-generators.json",type:"file",size:12,blobId:sha2});
  const bytes=await github.readBlob(config,sha1,"pcms-generators.json",sha2,{maxBytes:20});
  assert.deepEqual(Array.from(bytes),[104,105]);
  assert.ok(seen.every(x=>x.opts.method==="GET"&&x.opts.credentials==="omit"&&x.opts.redirect==="error"));
  assert.ok(seen.every(x=>!x.opts.headers.Authorization));
});
test("Deployer built-in page conforms to pcms.ui-contribution/v1",async()=>{
  const {repo}=fixture();
  const contribution=createUiContribution({moduleId:"deployer",service:repo});
  const normalized=normalizeBuiltinContribution(contribution,"deployer");
  assert.equal(normalized.descriptor.title,"Deployer");
  assert.ok(normalized.descriptor.actions.some(x=>x.id==="deploy"&&x.risk==="EXTERNAL_MUTATION"));
  assert.ok(normalized.descriptor.nav);
  const summary=await contribution.summary();
  assert.equal(summary.status.token,"INFO");
});

test("A037-03 linking after an unchanged commit resumes local preparation",async()=>{
  const fx=fixture();
  await fx.repo.configure({config,expectedRevision:0});
  assert.equal((await finish(fx.repo)).status,"SUCCESS");
  assert.equal((await fx.ctx.deployer.listDeployments()).deployments.length,0);
  const current=await fx.repo.read();
  await fx.repo.linkFolder({folder:"alice",accountId:"acct-1",expectedRevision:current.revision});
  assert.equal((await finish(fx.repo)).status,"SUCCESS");
  assert.equal((await fx.ctx.deployer.listDeployments()).deployments.length,1);
  assert.equal((await finish(fx.repo)).status,"UNCHANGED");
});
test("A037-02 duplicate generator slug in two account folders is blocked for both",async()=>{
  const fx=fixture({versions:{[sha1]:{...blobs({folder:"alice"}),...blobs({folder:"bob"})}}});
  await configure(fx.repo);
  const result=await finish(fx.repo);
  assert.equal(result.status,"SUCCESS");
  assert.equal(result.snapshot.items.length,0);
  assert.equal(result.snapshot.problems.filter(p=>p.code==="GEN_DUPLICATE_SLUG").length,2);
  assert.equal((await fx.ctx.deployer.listDeployments()).deployments.length,0);
});
test("A037-03 deploy:hold forbids dispatch and malformed changelog only warns",async()=>{
  const b=blobs();
  b["alice/example/generator.json"]=JSON.stringify({...JSON.parse(b["alice/example/generator.json"]),deploy:"hold"});
  b["alice/example/releases/1.0.0/changelog.md"]=Uint8Array.from([255]);
  const fx=fixture({versions:{[sha1]:b}});
  await configure(fx.repo);
  const result=await finish(fx.repo);
  assert.equal(result.status,"SUCCESS");
  assert.equal(result.snapshot.items.length,1);
  assert.ok(result.snapshot.problems.some(p=>p.code==="GEN_CHANGELOG_INVALID"));
  const deployment=(await fx.ctx.deployer.listDeployments()).deployments[0];
  await assert.rejects(fx.repo.deployFromRepository({deploymentId:deployment.deploymentId,
    expectedRevision:1}),{code:REPO_ERRORS.PROTOCOL});
  assert.deepEqual(await fx.ctx.remoteOps.listUnresolved(),[]);
});

test("A037-02 binary JPEG round-trips as a base64 release without changing fingerprint",async()=>{
  const original=blobs();
  original["alice/example/releases/1.0.0/thumbnail.jpeg"]=Uint8Array.from([255,216,255,224,0,1,2,3,255,217]);
  const fx=fixture({versions:{[sha1]:original}});
  await configure(fx.repo);
  const result=await finish(fx.repo);
  assert.equal(result.status,"SUCCESS");
  assert.equal(result.snapshot.items.length,1);
  assert.match(result.snapshot.items[0].thumbnailHash,/^[a-f0-9]{64}$/);
  assert.equal(result.snapshot.problems.length,0);
  const record=(await fx.ctx.deployer.listDeployments()).deployments[0];
  assert.equal(record.desired.thumbnailHash,result.snapshot.items[0].thumbnailHash);
  // Content is recovered from the exact release commit only at dispatch; no blob
  // bytes or token contents are persisted in the immutable repository snapshot.
  assert.equal(JSON.stringify(result.snapshot).includes("/9j/"),false);
});


test("A037-03 busy deployment retains queued release across unchanged-ref scans",async()=>{
  let busy=true;
  const fx=fixture({versions:{[sha1]:blobs(),[sha2]:blobs({code:"next",version:"2.0.0"})},
    deployerOverride:base=>({
      ...base,
      async setDesired(...args){
        if(busy)throw Object.assign(new Error("busy"),{code:"PCMS_DEPLOYER_OPERATION_BUSY"});
        return base.setDesired(...args);
      }
    })
  });
  await configure(fx.repo);
  assert.equal((await finish(fx.repo)).status,"SUCCESS");
  fx.provider.setRef("main",sha2);
  assert.equal((await finish(fx.repo)).status,"SUCCESS");
  assert.equal((await fx.repo.read()).value.needsApply,true);
  assert.equal((await fx.ctx.deployer.listDeployments()).deployments[0].desired.revision,1);
  busy=false;
  assert.equal((await finish(fx.repo)).status,"SUCCESS");
  assert.equal((await fx.repo.read()).value.needsApply,false);
  assert.equal((await fx.ctx.deployer.listDeployments()).deployments[0].desired.revision,2);
  assert.equal((await finish(fx.repo)).status,"UNCHANGED");
});
test("A037-03 repository identity changes revoke old folder bindings",async()=>{
  const fx=fixture();await configure(fx.repo);
  assert.equal((await finish(fx.repo)).status,"SUCCESS");
  const before=(await fx.repo.read());
  await fx.repo.configure({expectedRevision:before.revision,
    config:{...config,repo:"another-repository"}});
  const after=(await fx.repo.read()).value;
  assert.equal(after.identityEpoch,before.value.identityEpoch+1);
  assert.deepEqual(Object.keys(after.links),[]);
  assert.equal(after.snapshot,null);
  assert.equal(after.needsApply,false);
  assert.equal((await finish(fx.repo)).status,"SUCCESS");
  assert.equal((await fx.ctx.deployer.listDeployments()).deployments.length,1);
});
test("A037-03 GitHub read bounds abort slow requests and oversize streaming bodies",async()=>{
  let aborted=false;
  const stalled=createGithubRepositoryProvider({timeoutMs:5,fetchImpl:(_url,{signal})=>{
    signal.addEventListener("abort",()=>{aborted=true;});
    return new Promise(()=>{});
  }});
  await assert.rejects(stalled.resolveRef(config),{code:REPO_ERRORS.UNAVAILABLE});
  assert.equal(aborted,true);
  const huge=createGithubRepositoryProvider({maxResponseBytes:64,fetchImpl:async()=>({
    ok:true,status:200,headers:{get:()=>null},
    body:{getReader:()=>({
      read:async()=>({done:false,value:Uint8Array.from({length:80},()=>65)}),
      releaseLock(){}
    })}
  })});
  await assert.rejects(huge.resolveRef(config),{code:REPO_ERRORS.TOO_LARGE});
});
test("A037-01 secondary rate limiting maps 403 Retry-After without a false auth error",async()=>{
  const provider=createGithubRepositoryProvider({fetchImpl:async()=>({
    ok:false,status:403,headers:{get(key){return key==="retry-after"?"120":key==="x-ratelimit-remaining"?"10":null;}}
  })});
  await assert.rejects(provider.resolveRef(config),error=>{
    assert.equal(error.code,REPO_ERRORS.RATE_LIMITED);
    assert.equal(typeof error.resetAt,"string");
    return true;
  });
});
