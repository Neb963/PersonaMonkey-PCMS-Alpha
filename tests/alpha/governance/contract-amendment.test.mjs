import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { load, validateSnapshot, validateTransition, AMENDMENT, contractHash, acquire } from '../../../tools/alpha/governance.mjs';
import { normalizeGeneratorKey } from '../../../extension/alpha/domain/records.js';

// Commit-addressed fixture: the exact accepted pre-amendment main, not the
// mutable checkout. CI checks out full history; later claims cannot rewrite it.
const PRE_AMENDMENT_MAIN_SHA = '2c075175e366e970e3bfe4e17662df23fed97c19';
const POST_AMENDMENT_MAIN_SHA = 'a1c9a5676921420e75e296771e95a951064c270e';
const historicalMain = load('.', PRE_AMENDMENT_MAIN_SHA);
const historicalHead = structuredClone(historicalMain);
historicalHead.lock.contractRevision = AMENDMENT.revision;
historicalHead.lock.contracts['alpha.contracts.v1'] = AMENDMENT.nextHash;
for (const claim of historicalHead.registry.claims) {
  if (['ACTIVE', 'PR_OPEN'].includes(claim.state))
    claim.contractReads['alpha.contracts.v1'] = AMENDMENT.nextHash;
}
const ctx = JSON.parse(readFileSync(AMENDMENT.contextPath, 'utf8'));
const files = ['extension/alpha/contracts/index.d.ts'];
function check(main = historicalMain, next = historicalHead, context = ctx, changed = files) {
  return validateTransition(main, next, context, { mainSha: ctx.baseMainSha, headBranch: context.branch, files: changed });
}
test('keyed account-list items, unchanged readback and pagination declarations',()=>{
 const d=readFileSync('extension/alpha/contracts/index.d.ts','utf8');
 assert.match(d,/export interface AccountGeneratorEntry \{ readonly key: GeneratorKey; readonly readback: ProviderReadback \}/);
 assert.match(d,/listGenerators\([^\n]+Promise<Result<Page<AccountGeneratorEntry>>>/);
 for(const method of ['read','observe','create','save','setListing','delete'])assert.match(d,new RegExp(method+'\\([^\\n]+Promise<Result<ProviderReadback>>'));
 assert.match(d,/export interface ProviderReadback \{ readonly sourceRevision: string \| null; readonly files\?: DeployableFiles; readonly listing: ListingObserved; readonly ownership: 'CONFIRMED' \| 'UNKNOWN'; readonly asOf: string \}/);
 assert.match(d,/export interface Page<T> \{ readonly items: readonly T\[\]; readonly cursor: string \| null; readonly asOf: string \}/);
 assert.equal(contractHash(),AMENDMENT.nextHash);assert.equal(validateSnapshot(historicalHead).activeClaims,4);assert.equal(validateSnapshot(load(),{root:'.'}).phases,30);
});
test('account-discovery conformance fixture rejects bad and duplicate keys across cursor pages',()=>{
 // Test-only pagination fixture; use P102's canonical key authority, not a second regex.
 function validKey(key){try{return normalizeGeneratorKey(key)===key;}catch{return false;}}
 function consume(pages){const seen=new Set(),items=[];for(const page of pages){if(!Array.isArray(page.items)||!(page.cursor===null||typeof page.cursor==='string')||typeof page.asOf!=='string')throw Error('invalid page');for(const e of page.items){if(!e||!validKey(e.key))throw Error('invalid identity');if(!e.readback||typeof e.readback.asOf!=='string')throw Error('missing readback');if(seen.has(e.key))throw Error('duplicate identity');seen.add(e.key);items.push(e);}}if(pages.at(-1)?.cursor!==null)throw Error('incomplete pagination');return items;}
 const r={sourceRevision:'s',listing:'UNLISTED',ownership:'CONFIRMED',asOf:'time'};
 const page=(items,cursor)=>({items,cursor,asOf:'time'});
 assert.deepEqual(consume([page([{key:'one',readback:r}],'opaque'),page([{key:'two',readback:r}],null)]).map(x=>x.key),['one','two']);
 assert.deepEqual(consume([page([{key:'generator_1-test',readback:r}],'opaque'),page([{key:'a'.repeat(100),readback:r}],null)]).map(x=>x.key),['generator_1-test','a'.repeat(100)]);
 assert.throws(()=>consume([page([{key:'one',readback:r}],'opaque')]),/incomplete pagination/);
 for(const key of ['',null,'../bad','UPPER','white space','_leading','-leading','a'.repeat(101),'a'.repeat(100)+'_'])assert.throws(()=>consume([page([{key,readback:r}],null)]),/invalid identity/);
 assert.throws(()=>consume([page([{key:'one',readback:r}],'opaque'),page([{key:'one',readback:r}],null)]),/duplicate identity/);
 assert.throws(()=>consume([page([{key:'one'}],null)]),/missing readback/);
});
test('one-time transition revalidates every live read hash without claim takeover',()=>{
 assert.equal(ctx.baseMainSha,PRE_AMENDMENT_MAIN_SHA);
 assert.equal(historicalMain.lock.contracts['alpha.contracts.v1'],AMENDMENT.previousHash);
 assert.equal(historicalHead.lock.contracts['alpha.contracts.v1'],AMENDMENT.nextHash);
 assert.equal(validateSnapshot(historicalMain).activeClaims,4);
 assert.equal(check().kind,'CONTRACT_AMENDMENT');assert.deepEqual(ctx.affectedClaims,['P101','P102','P104','P105']);assert.equal(historicalHead.plan.phases.find(p=>p.id==='P103').status,'READY');assert.equal(historicalHead.registry.epochs.P103,0);
 const main=structuredClone(historicalMain);
 for(const field of ['agentId','claimEpoch','baseMainSha','branch','state','writePaths','contractWrites','exclusiveResources','migrationSlots'])assert.deepEqual(main.registry.claims.map(x=>x[field]),historicalHead.registry.claims.map(x=>x[field]));
 for(const mutate of [s=>s.registry.claims[0].claimEpoch++,s=>s.registry.claims[0].agentId='attacker',s=>s.registry.claims[0].writePaths.push('extension/**'),s=>s.registry.epochs.P103=1,s=>s.plan.phases.find(p=>p.id==='P103').status='CLAIMED',s=>s.lock.contracts['alpha.contracts.v1']='0'.repeat(64)]){const x=structuredClone(historicalHead);mutate(x);assert.throws(()=>check(main,x));}
});
test('stale main, duplicate amendment, invented claims and unrelated paths reject',()=>{
 const main=structuredClone(historicalMain);assert.throws(()=>check(main,historicalHead,{...ctx,baseMainSha:'a'.repeat(40)}),/exact current main/);
 assert.throws(()=>check(main,historicalHead,{...ctx,amendmentId:'other'}),/Unauthorized/);
 assert.throws(()=>check(main,historicalHead,{...ctx,affectedClaims:['P101']}),/affected claims/);
 assert.throws(()=>check(main,historicalHead,ctx,['extension/alpha/providers/perchance/live.js']),/outside ownership/);
 assert.throws(()=>check(historicalHead,historicalHead,ctx),/already applied/);
 const stale=structuredClone(historicalHead);stale.registry.claims[0].contractReads['alpha.contracts.v1']=AMENDMENT.previousHash;assert.throws(()=>validateSnapshot(stale),/Stale contract read/);
});
test('normal phase path cannot amend frozen lock',()=>{
 const main=structuredClone(historicalMain),changed=structuredClone(main),c=main.registry.claims[0];changed.lock.contracts['alpha.contracts.v1']=AMENDMENT.nextHash;
 for(const record of changed.registry.claims)if(['ACTIVE','PR_OPEN'].includes(record.state))record.contractReads['alpha.contracts.v1']=AMENDMENT.nextHash;
 assert.throws(()=>validateTransition(main,changed,{schemaVersion:1,kind:'PHASE',phaseId:c.phaseId,agentId:c.agentId,claimEpoch:c.claimEpoch,baseMainSha:c.baseMainSha,branch:c.branch},{mainSha:ctx.baseMainSha,headBranch:c.branch,files:[]}),/Frozen shared contracts/);
});

test('fifth R1 acquisition succeeds without mutating the historical amendment or bypassing fences',()=>{
 const context={schemaVersion:1,kind:'CLAIM',action:'acquire',phaseId:'P103',agentId:'slot-three-p103',
  claimEpoch:1,expectedEpoch:0,baseMainSha:POST_AMENDMENT_MAIN_SHA,branch:'agent/slot-three-p103/p103'};
 const claimed=acquire(historicalHead,context);
 assert.equal(validateSnapshot(claimed).activeClaims,5);
 assert.equal(claimed.registry.epochs.P103,1);
 assert.deepEqual(claimed.registry.claims.slice(0,4),historicalHead.registry.claims);
 assert.equal(validateTransition(historicalHead,claimed,context,{
  mainSha:POST_AMENDMENT_MAIN_SHA,headBranch:context.branch,files:['docs/implementation/alpha/claims.json']
 }).kind,'CLAIM');
 assert.equal(check().kind,'CONTRACT_AMENDMENT');
 assert.throws(()=>acquire(historicalHead,{...context,expectedEpoch:1}),/Stale acquisition epoch/);
 assert.throws(()=>acquire(historicalHead,{...context,agentId:'slot-one'}),/already has an active claim/);
 assert.throws(()=>validateTransition(historicalHead,claimed,{...context,claimEpoch:0},{
  mainSha:POST_AMENDMENT_MAIN_SHA,headBranch:context.branch,files:[]
 }),/Claim context epoch/);
 assert.throws(()=>validateTransition(historicalHead,claimed,context,{
  mainSha:'f'.repeat(40),headBranch:context.branch,files:[]
 }),/exact current main/);
 const overlapping=structuredClone(claimed);
 overlapping.plan.phases.find(p=>p.id==='P103').ownership.writePaths[0]='tests/alpha/browser-baseline/**';
 overlapping.registry.claims.at(-1).writePaths[0]='tests/alpha/browser-baseline/**';
 assert.throws(()=>validateSnapshot(overlapping),/Write-path overlap/);
});
