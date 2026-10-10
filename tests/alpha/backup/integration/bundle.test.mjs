import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackupExporter,decodeBackupFile,UNENCRYPTED_CONSENT} from '../../../../extension/alpha/backup/bundle.js';
import {createBackupIntegration} from '../../../../extension/alpha/backup/integration/index.mjs';

test('P205 real codec integrates one consented unencrypted local download, safe stage and explicit gaps',async()=>{
  const storage={async snapshot(){return {schemaVersion:1,revision:0,records:[],journal:[]};}};
  const exporter=createBackupExporter({alphaStorage:storage,clock:()=> '2026-10-11T00:00:00.000Z',sensitiveExports:{'alpha.githubCredential':async()=>new Uint8Array([13,0,255])}});
  let file;
  const downloads={
    async downloadFile(bytes){file=new Uint8Array(bytes);return {id:17,status:'PENDING',filename:'PersonaMonkey-PCMS-Alpha-backups/fixture.json'};},
    async maintain(){return {retained:1,warnings:[]};},async status(){return {entries:[]};}
  };
  const integration=createBackupIntegration({exporter,decodeFile:decodeBackupFile,downloads});
  await assert.rejects(integration.exportToDownloads({}),e=>e.code==='UNENCRYPTED_CONSENT_REQUIRED');
  const receipt=await integration.exportToDownloads({consent:UNENCRYPTED_CONSENT,includeSensitive:['alpha.githubCredential']});
  assert.equal(receipt.encrypted,false);assert.equal(receipt.downloadId,17);
  assert.equal(receipt.unavailable.some(x=>x.item==='personaMonkey.activeSessions'),true);
  assert.equal(Object.hasOwn(receipt,'file'),false);
  const stage=await integration.stageRestore(file);
  assert.equal(stage.verified,true);assert.equal(stage.supported,false);
  assert.equal(stage.requiredSections.includes('alpha.githubCredential'),true);
  await assert.rejects(integration.applyRestore({id:stage.id,digest:stage.digest,confirmation:stage.requiresConfirmation}),e=>e.code==='UNSUPPORTED_CAPABILITY');
});