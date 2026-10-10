import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackupIntegration } from '../../../../extension/alpha/backup/integration/index.mjs';
const f=new Uint8Array([1,2]);
test('export uses P205 consent-gated exporter, passes unencrypted bytes only to download port',async()=>{
  let input, received;
  const exporter={async exportBackup(x){input=x;return {file:f,inventory:[{item:'alpha.records',availability:'EXPORTED'},{item:'perchance.passwords',availability:'UNAVAILABLE',reason:'UNAVAILABLE'}]};},async stageRestore(){return {verified:true,integrityVerified:true,applied:false};}};
  const downloads={async downloadFile(bytes){received=bytes;return {id:42,status:'PENDING',filename:'PersonaMonkey-PCMS-Alpha-backups/test.json'};},async status(){return {};},async maintain(){return {};}};
  const i=createBackupIntegration({exporter,decodeFile:async()=>({manifest:{encrypted:false,absentItems:[]},authorizedSensitiveEntries:{}}),downloads});
  const receipt=await i.exportToDownloads({consent:'EXPORT UNENCRYPTED BACKUP'});
  assert.deepEqual(input,{consent:'EXPORT UNENCRYPTED BACKUP'});assert.equal(received,f);
  assert.equal(receipt.status,'PENDING');assert.equal(receipt.downloadId,42);
  assert.deepEqual(receipt.unavailable,[{item:'perchance.passwords',reason:'UNAVAILABLE'}]);
  assert.equal(Object.hasOwn(receipt,'file'),false);assert.equal(i.restoreAvailable,false);
});