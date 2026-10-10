import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecord, recordKey, assertRecordUpdate } from '../../../extension/alpha/domain/records.js';
import { createReservationJournal, createReservationService, parsePastedSlugs,
  selectReservationAccount } from '../../../extension/alpha/features/reservation/service.mjs';

const NOW = '2026-10-10T12:00:00.000Z', hex = n => n.toString(16).padStart(1,'0').repeat(40);
const clone = v => structuredClone(v);
function storageFixture() {
  const data = new Map(['account','generator','operation','release'].map(kind => [kind,new Map()]));
  let revision = 0;
  return {
    async read(kind,key) {
      const row = data.get(kind).get(key);
      return { revision, item: row ? clone(row) : null };
    },
    async list(kind) {
      return { revision, items: [...data.get(kind).values()].map(clone) };
    },
    async commit({ expectedRevision, writes }) {
      assert.equal(expectedRevision, revision, 'global CAS must be exact');
      assert.ok(Array.isArray(writes) && writes.length && writes.length <= 64);
      const pending = new Map([...data].map(([kind, rows]) => [kind, new Map(rows)]));
      const keys = new Set();
      for (const write of writes) {
        const raw = normalizeRecord(write.kind, write.record), key = recordKey(write.kind, raw);
        const identifier = write.kind+'/'+key;
        assert.ok(!keys.has(identifier)); keys.add(identifier);
        const previous = pending.get(write.kind).get(key);
        assert.equal(previous?.revision || 0, write.expectedRevision, 'record CAS must be exact');
        assertRecordUpdate(write.kind, previous?.record, raw);
        const record = ['account','generator'].includes(write.kind) ?
          { ...raw, revision: write.expectedRevision + 1 } : raw;
        pending.get(write.kind).set(key, { revision: write.expectedRevision + 1, record });
      }
      for (const row of pending.get('generator').values()) {
        const g = row.record, account = pending.get('account').get(g.accountId)?.record;
        assert.ok(account && account.epoch === g.accountBindingEpoch &&
          account.personaUid === g.personaUid, 'generator must retain account binding');
      }
      revision++;
      for (const [kind, rows] of pending) data.set(kind, rows);
      return { revision, items: writes.map(w => clone(data.get(w.kind).get(recordKey(w.kind,w.record)))) };
    }
  };
}

async function harness(accountCount = 2) {
  const storage = storageFixture(), remote = new Map(), log = [];
  const journal = createReservationJournal(storage);
  const githubFiles = new Map(), blobs = new Map();
  let head = hex(10), githubCommits = 0, creates = 0, failNext = false, lostNext = false;
  for (let i = 1; i <= accountCount; i++) {
    const accountId = 'account-'+i;
    remote.set(accountId, new Map());
    const s = await storage.list('account');
    await storage.commit({ expectedRevision: s.revision, writes: [{
      kind: 'account', expectedRevision: 0,
      record: { accountId, personaUid:'persona-'+i, epoch:1, name:'Account '+i,
        sessionState:'VERIFIED', revision:0, asOf:NOW }
    }] });
  }
  const perchance = {
    async probe(context) {
      log.push(['probe',context.accountId]);
      return { ok:true, result:['generator.create','generator.list'], revision:5 };
    },
    async listGenerators({context,cursor}) {
      assert.equal(cursor,undefined);
      log.push(['list', context.accountId]);
      return { ok:true,revision:5,result:{
        items:[...remote.get(context.accountId)].map(([key,readback]) => ({key,readback:clone(readback)})),
        cursor:null, asOf:NOW
      }};
    },
    async create(input) {
      creates++;
      log.push(['create',input.context.accountId,input.targetKey]);
      assert.equal(input.expectedRevision,5);
      assert.equal(input.expectedSourceRevision,null);
      const current = await journal.read(input.opId);
      assert.equal(current.phase,'PREPARED', 'operation must be durable before dispatch');
      assert.equal(current.sourceRevision,null);
      assert.equal(current.targetKey,input.targetKey);
      await journal.dispatch(input.opId);
      assert.equal((await journal.read(input.opId)).phase,'DISPATCHING');
      const readback = {ownership:'CONFIRMED',listing:'UNLISTED',
        sourceRevision:'source-rev-1',asOf:NOW};
      if (remote.get(input.context.accountId).has(input.targetKey)) {
        await journal.complete(input.opId,{phase:'UNCERTAIN',code:'CONFLICT'});
        return {ok:false,error:{code:'UNCERTAIN'}};
      }
      remote.get(input.context.accountId).set(input.targetKey,readback);
      await journal.complete(input.opId,{phase:'APPLIED',code:null,remoteEvidence:{
        sourceRevision:readback.sourceRevision,listing:'UNLISTED',ownership:'CONFIRMED'
      }});
      return { ok:true,result:clone(readback),revision:5 };
    }
  };
  const github = {
    async snapshot({repository,ref,paths}) {
      assert.equal(repository,'Neb963/per-gens'); assert.equal(ref,'main');
      log.push(['github.snapshot',...paths]);
      const matched = {};
      for (const path of paths) if (githubFiles.has(path)) matched[path] = githubFiles.get(path);
      return {ok:true,revision:0,result:{commitSha:head,blobs:matched}};
    },
    async readBlob({blobSha}) {
      assert.ok(blobs.has(blobSha));
      return {ok:true,revision:0,result:clone(blobs.get(blobSha))};
    },
    async commit(input) {
      githubCommits++;
      log.push(['github.commit',input.opId]);
      assert.equal(input.ref,'main');
      assert.equal(input.expectedHeadSha,head);
      assert.equal(input.secretRef,'test-reference');
      const [path] = Object.keys(input.files);
      assert.equal(input.expectedBlobs[path],null);
      assert.ok(!githubFiles.has(path));
      const prepared = (await storage.read('operation',input.opId)).item?.record;
      assert.equal(prepared?.phase,'DISPATCHING','GitHub mutation dispatched only after P102 op');
      if (failNext) {
        failNext = false;
        return {ok:false,error:{code:'UNAVAILABLE',message:'synthetic'},revision:0};
      }
      const blobSha = hex(10+githubCommits);
      blobs.set(blobSha,clone(input.files[path]));
      githubFiles.set(path,blobSha);
      head = hex(15+githubCommits);
      if (lostNext) {
        lostNext = false;
        return {ok:false,error:{code:'UNCERTAIN',message:'synthetic'},revision:0};
      }
      return {ok:true,result:{commitSha:head,blobs:{[path]:blobSha}},revision:0};
    }
  };
  const service = createReservationService({
    storage,perchance,github,secretRef:'test-reference',now:()=>NOW,
    contextForAccount:account=>({accountId:account.accountId,personaUid:account.personaUid,
      epoch:account.epoch,routeRevision:2,capabilityRevision:3})
  });
  async function reserve(key, opId = 'reserve-'+key, options = undefined) {
    const current = await storage.list('operation');
    return service.reserve({key,opId,expectedRevision:current.revision,
      accountBindingEpoch:1,...(options?{options}:{})});
  }
  async function reconcile(key,opId='reserve-'+key) {
    const current = await storage.list('operation');
    return service.reconcile({key,opId,expectedRevision:current.revision,accountBindingEpoch:1});
  }
  return { storage, service, remote, log, githubFiles, blobs, reserve, reconcile,
    failGithub:()=>{failNext=true;},loseGithubReceipt:()=>{lostNext=true;},
    get creates(){return creates;},get githubCommits(){return githubCommits;}
  };
}
function good(result) {
  assert.equal(result.ok,true,JSON.stringify(result));return result.result;
}
function bad(result, code) {
  assert.equal(result.ok,false,JSON.stringify(result));
  assert.equal(result.error.code,code);
}

test('AP301-01: valid pasted list is canonical and supports 200 or more independent slugs',async()=>{
  assert.deepEqual(parsePastedSlugs('alpha_one, beta-two\nhub;gamma3'),
    ['alpha_one','beta-two','hub','gamma3']);
  for (const input of ['','ABC','abc','a','a_', '_abcd','abcd!','alpha alpha','ab bC',
    'a'.repeat(81)]) assert.throws(()=>parsePastedSlugs(input),/INVALID_REQUEST|CONFLICT/);
  const h=await harness(1), list=Array.from({length:240},(_,i)=>'item'+String(i).padStart(4,'0')).join('\n');
  assert.equal(good(await h.service.preview({key:list})).length,240);
});

test('AP301-01/AP301-02: even new-slot balancing ignores imported generators',async()=>{
  const h=await harness(3);
  h.remote.get('account-1').set('old_imported', {
    ownership:'CONFIRMED',listing:'PUBLIC',sourceRevision:'old',asOf:NOW
  });
  for (let i=0;i<6;i++) {
    const op=good(await h.reserve('new_item_'+i));
    assert.equal(op.kind,'reservation.github');
    assert.equal(op.phase,'APPLIED');
  }
  assert.deepEqual([...h.remote].map(([accountId,map])=>[accountId,
    [...map.keys()].filter(key=>key.startsWith('new_item_')).length]),
  [['account-1',2],['account-2',2],['account-3',2]]);
  assert.equal(h.creates,6);
  const gens=(await h.storage.list('generator')).items;
  assert.equal(gens.length,6);
  assert.ok(gens.every(({record:g})=>g.fleetIntent==='EXCLUDED' &&
    g.listingObserved==='UNLISTED' && g.deployState==='RESERVED' &&
    g.refreshState==='INELIGIBLE' && g.sourceBinding.status==='BLOCKED' &&
    g.sourceBinding.ref==='main' && g.releaseId===null));
});

test('AP301-02: existing remote slug, GitHub folder and locally claimed slug collide without writes',async()=>{
  const h=await harness();
  h.remote.get('account-2').set('used_slug',{ownership:'CONFIRMED',listing:'UNLISTED',
    sourceRevision:'existing',asOf:NOW});
  bad(await h.reserve('used_slug'),'CONFLICT');
  assert.equal(h.creates,0);
  good(await h.reserve('unique_slug'));
  bad(await h.reserve('unique_slug','second-op'),'CONFLICT');
  bad(await h.reserve('another_slug','different-op',{folder:'unique_slug'}),'CONFLICT');
  assert.equal(h.creates,1);
  assert.equal(h.githubFiles.size,1);
});

test('AP301-03: GitHub failure after Perchance create repairs without duplicate create',async()=>{
  const h=await harness();
  h.failGithub();
  bad(await h.reserve('partial_slug'),'UNCERTAIN');
  assert.equal(h.creates,1);
  const createOp=(await h.storage.read('operation','reserve-partial_slug')).item.record;
  assert.equal(createOp.phase,'APPLIED');
  assert.equal(h.githubFiles.size,0);
  const recovered=good(await h.reconcile('partial_slug'));
  assert.equal(recovered.phase,'APPLIED');
  assert.equal(h.creates,1,'no repeated provider create');
  assert.equal(h.githubCommits,2);
  const op=(await h.storage.list('operation')).items.map(x=>x.record);
  assert.deepEqual(op.filter(x=>x.kind==='reservation.github').map(x=>x.phase),
    ['NOT_APPLIED','APPLIED']);
  assert.equal(h.githubFiles.size,1);
  assert.ok([...h.blobs.values()].some(x=>new TextDecoder().decode(x).includes('Status: BLOCKED')));
  good(await h.reconcile('partial_slug'));
  assert.equal(h.creates,1);
  assert.equal(h.githubCommits,2);
});

test('AP301-03: lost GitHub response reconciles marker and does not write again',async()=>{
  const h=await harness();
  h.loseGithubReceipt();
  bad(await h.reserve('lost_reply'),'UNCERTAIN');
  assert.equal(h.creates,1); assert.equal(h.githubCommits,1);
  assert.equal(h.githubFiles.size,1);
  const done=good(await h.reconcile('lost_reply'));
  assert.equal(done.phase,'APPLIED');
  assert.equal(h.creates,1); assert.equal(h.githubCommits,1);
  good(await h.reconcile('lost_reply'));
  assert.equal(h.githubCommits,1);
});

test('AP301-03: retry with wrong epoch fails closed and does not create',async()=>{
  const h=await harness();
  h.failGithub();
  bad(await h.reserve('epoch_slug'),'UNCERTAIN');
  const current=(await h.storage.list('operation')).revision;
  bad(await h.service.reconcile({key:'epoch_slug',opId:'reserve-epoch_slug',
    expectedRevision:current,accountBindingEpoch:2}),'INVALID_REQUEST');
  assert.equal(h.creates,1);
  assert.equal(h.githubCommits,1);
});

test('AP301-02: balancing includes pending new reservations but never existing inventory',()=>{
  const a=[{accountId:'a',sessionState:'VERIFIED'},{accountId:'b',sessionState:'VERIFIED'}];
  const op={kind:'create',phase:'UNCERTAIN',remoteEvidence:{intent:{reservation:'P301',accountId:'a'}}};
  assert.equal(selectReservationAccount(a,[op]).accountId,'b');
  assert.equal(selectReservationAccount(a,[{...op,phase:'NOT_APPLIED'}]).accountId,'a');
});
