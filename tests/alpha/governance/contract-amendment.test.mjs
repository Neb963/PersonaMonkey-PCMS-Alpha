import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { load, validateSnapshot, validateTransition, AMENDMENT, contractHash } from '../../../tools/alpha/governance.mjs';
const head = load();
const ctx = JSON.parse(readFileSync(AMENDMENT.contextPath,'utf8'));
function before(){const s=structuredClone(head);delete s.lock.contractRevision;s.lock.contracts['alpha.contracts.v1']=AMENDMENT.previousHash;for(const c of s.registry.claims)if(['ACTIVE','PR_OPEN'].includes(c.state))c.contractReads['alpha.contracts.v1']=AMENDMENT.previousHash;return s;}
const files=['extension/alpha/contracts/index.d.ts'];
function check(main=before(),next=head,context=ctx,changed=files){return validateTransition(main,next,context,{mainSha:ctx.baseMainSha,headBranch:context.branch,files:changed});}
test('keyed account-list items, unchanged readback and pagination declarations',()=>{
 const d=readFileSync('extension/alpha/contracts/index.d.ts','utf8');
 assert.match(d,/export interface AccountGeneratorEntry \{ readonly key: GeneratorKey; readonly readback: ProviderReadback \}/);
 assert.match(d,/listGenerators\([^\n]+Promise<Result<Page<AccountGeneratorEntry>>>/);
 for(const method of ['read','observe','create','save','setListing','delete'])assert.match(d,new RegExp(method+'\\([^\\n]+Promise<Result<ProviderReadback>>'));
 assert.match(d,/export interface ProviderReadback \{ readonly sourceRevision: string \| null; readonly files\?: DeployableFiles; readonly listing: ListingObserved; readonly ownership: 'CONFIRMED' \| 'UNKNOWN'; readonly asOf: string \}/);
 assert.match(d,/export interface Page<T> \{ readonly items: readonly T\[\]; readonly cursor: string \| null; readonly asOf: string \}/);
 assert.equal(contractHash(),AMENDMENT.nextHash);assert.equal(validateSnapshot(head,{root:'.'}).activeClaims,4);
});
test('account-discovery conformance fixture rejects bad and duplicate keys across cursor pages',()=>{
 // Test-only reference fixture: not a production Perchance adapter.
 function consume(pages){const seen=new Set(),items=[];for(const page of pages){if(!Array.isArray(page.items)||!(page.cursor===null||typeof page.cursor==='string')||typeof page.asOf!=='string')throw Error('invalid page');for(const e of page.items){if(!e||typeof e.key!=='string'||!/^[a-z0-9][a-z0-9-]*$/.test(e.key))throw Error('invalid identity');if(!e.readback||typeof e.readback.asOf!=='string')throw Error('missing readback');if(seen.has(e.key))throw Error('duplicate identity');seen.add(e.key);items.push(e);}}if(pages.at(-1)?.cursor!==null)throw Error('incomplete pagination');return items;}
 const r={sourceRevision:'s',listing:'UNLISTED',ownership:'CONFIRMED',asOf:'time'};
 const page=(items,cursor)=>({items,cursor,asOf:'time'});
 assert.deepEqual(consume([page([{key:'one',readback:r}],'opaque'),page([{key:'two',readback:r}],null)]).map(x=>x.key),['one','two']);
 assert.throws(()=>consume([page([{key:'one',readback:r}],'opaque')]),/incomplete pagination/);
 for(const key of ['',null,'../bad','UPPER','white space'])assert.throws(()=>consume([page([{key,readback:r}],null)]),/invalid identity/);
 assert.throws(()=>consume([page([{key:'one',readback:r}],'opaque'),page([{key:'one',readback:r}],null)]),/duplicate identity/);
 assert.throws(()=>consume([page([{key:'one'}],null)]),/missing readback/);
});
test('one-time transition revalidates every live read hash without claim takeover',()=>{
 assert.equal(check().kind,'CONTRACT_AMENDMENT');assert.deepEqual(ctx.affectedClaims,['P101','P102','P104','P105']);assert.equal(head.plan.phases.find(p=>p.id==='P103').status,'READY');assert.equal(head.registry.epochs.P103,0);
 const main=before();
 for(const field of ['agentId','claimEpoch','baseMainSha','branch','state','writePaths','contractWrites','exclusiveResources','migrationSlots'])assert.deepEqual(main.registry.claims.map(x=>x[field]),head.registry.claims.map(x=>x[field]));
 for(const mutate of [s=>s.registry.claims[0].claimEpoch++,s=>s.registry.claims[0].agentId='attacker',s=>s.registry.claims[0].writePaths.push('extension/**'),s=>s.registry.epochs.P103=1,s=>s.plan.phases.find(p=>p.id==='P103').status='CLAIMED',s=>s.lock.contracts['alpha.contracts.v1']='0'.repeat(64)]){const x=structuredClone(head);mutate(x);assert.throws(()=>check(main,x));}
});
test('stale main, duplicate amendment, invented claims and unrelated paths reject',()=>{
 const main=before();assert.throws(()=>check(main,head,{...ctx,baseMainSha:'a'.repeat(40)}),/exact current main/);
 assert.throws(()=>check(main,head,{...ctx,amendmentId:'other'}),/Unauthorized/);
 assert.throws(()=>check(main,head,{...ctx,affectedClaims:['P101']}),/affected claims/);
 assert.throws(()=>check(main,head,ctx,['extension/alpha/providers/perchance/live.js']),/outside ownership/);
 assert.throws(()=>check(head,head,ctx),/already applied/);
 const stale=structuredClone(head);stale.registry.claims[0].contractReads['alpha.contracts.v1']=AMENDMENT.previousHash;assert.throws(()=>validateSnapshot(stale),/Stale contract read/);
});
test('normal phase path cannot amend frozen lock',()=>{
 const main=before(),changed=structuredClone(main),c=main.registry.claims[0];changed.lock.contracts['alpha.contracts.v1']=AMENDMENT.nextHash;
 assert.throws(()=>validateTransition(main,changed,{schemaVersion:1,kind:'PHASE',phaseId:c.phaseId,agentId:c.agentId,claimEpoch:c.claimEpoch,baseMainSha:c.baseMainSha,branch:c.branch},{mainSha:ctx.baseMainSha,headBranch:c.branch,files:[]}),/Frozen shared contracts/);
});
