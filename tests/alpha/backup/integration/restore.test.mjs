import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackupRestore, RESTORE_CONFIRMATION } from '../../../../extension/alpha/backup/integration/restore.mjs';
const file=new Uint8Array([1,2,3]);
const bundle={manifest:{encrypted:false,createdAt:'2026-10-11T01:00:00.000Z',absentItems:['alpha.inventoryFacts','personaMonkey.personas','personaMonkey.routes','personaMonkey.userscripts','personaMonkey.workflows'].map(item=>({item,reason:'UNAVAILABLE'}))},inventoryFacts:new Uint8Array(),authorizedSensitiveEntries:{}};
const preview={verified:true,integrityVerified:true,applied:false,missing:[],encrypted:false,proposedRecoveryState:'RECOVERY_HOLD'};
function fixture(overrides={}) {
  let held=false,replacements=0,released=false,canRelease=true;
  const authority={
    async supported(){return ['alpha.records','alpha.journal'];},
    async begin(){held=true;return {state:'RECOVERY_HOLD',holdId:'test_hold_001',durable:true};},
    async replace(){replacements++;return {state:'APPLIED',holdId:'test_hold_001'};},
    async status(){return {state:'RECOVERY_HOLD',holdId:'test_hold_001'};},
    async reconcile(){return {core:true,bindings:canRelease,sessions:true,providers:true,operations:true,inventory:true};},
    async release(){released=true;return {state:'RUNNING',holdId:'test_hold_001'};},
    ...overrides
  };
  const service=createBackupRestore({exporter:{async stageRestore(){return preview;}},decodeFile:async()=>bundle,authority,randomId:()=> 'preview_0001'});
  return {service,authority,held:()=>held,replacements:()=>replacements,released:()=>released,block:()=>{canRelease=false;},allow:()=>{canRelease=true;}};
}
test('requires genuine restore authority; preview alone is not an application',async()=>{
  const service=createBackupRestore({exporter:{async stageRestore(){return preview;}},decodeFile:async()=>bundle,randomId:()=> 'preview_0001'});
  const p=await service.stage(file); assert.equal(p.supported,false);
  await assert.rejects(service.apply({id:p.id,digest:p.digest,confirmation:RESTORE_CONFIRMATION}),e=>e.code==='UNSUPPORTED_CAPABILITY');
});
test('staged integrity digest and explicit confirmation guard against stale, swapped or unapproved bytes',async()=>{
  const {service,held}=fixture();const p=await service.stage(file);
  await assert.rejects(service.apply({id:p.id,digest:'wrong',confirmation:RESTORE_CONFIRMATION}),e=>e.code==='PREVIEW_MISMATCH');
  await assert.rejects(service.apply({id:p.id,digest:p.digest,confirmation:'RESTORE'}),e=>e.code==='PREVIEW_MISMATCH');
  assert.equal(held(),false);
});
test('authorized restore enters durable hold then verifies reconciliation before release',async()=>{
  const h=fixture();const p=await h.service.stage(file);
  const done=await h.service.apply({id:p.id,digest:p.digest,confirmation:RESTORE_CONFIRMATION});
  assert.equal(done.state,'RUNNING');assert.equal(h.replacements(),1);assert.equal(h.released(),true);
});
test('unreconciled binding holds until read-only resume; no second replacement',async()=>{
  const h=fixture();h.block();const p=await h.service.stage(file);
  const held=await h.service.apply({id:p.id,digest:p.digest,confirmation:RESTORE_CONFIRMATION});
  assert.equal(held.state,'RECOVERY_HOLD');assert.deepEqual(held.unresolved,['bindings']);assert.equal(h.released(),false);
  h.allow();const done=await h.service.resumeReconciliation({holdId:held.holdId});
  assert.equal(done.state,'RUNNING');assert.equal(h.replacements(),1);
});
test('uncertain apply never blindly replays and excludes absent necessary restoration coverage',async()=>{
  const h=fixture({async replace(){throw Error('private remote contents');}});const p=await h.service.stage(file);
  await assert.rejects(h.service.apply({id:p.id,digest:p.digest,confirmation:RESTORE_CONFIRMATION}),e=>e.code==='RECOVERY_HOLD'&&!e.message.includes('private'));
  await assert.rejects(h.service.apply({id:p.id,digest:p.digest,confirmation:RESTORE_CONFIRMATION}),e=>e.code==='PREVIEW_MISMATCH');
  const z=fixture({async supported(){return ['alpha.records'];}}),v=await z.service.stage(file);
  await assert.rejects(z.service.apply({id:v.id,digest:v.digest,confirmation:RESTORE_CONFIRMATION}),e=>e.code==='UNSUPPORTED_CAPABILITY');
});