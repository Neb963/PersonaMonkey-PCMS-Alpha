import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackupDownloads, BACKUP_FOLDER } from '../../../../extension/alpha/backup/integration/downloads.mjs';
const now = () => '2026-10-11T00:45:00.000Z';
function harness(maxComplete=1) {
  const rows = [], removed=[], revoked=[];
  let manifest = null, nextId=1;
  const downloads = {
    async download({filename}) { const id=nextId++; rows.push({id, filename:'/home/test/Downloads/'+filename,state:'in_progress'}); return id; },
    async search(q) { if('id' in q) return rows.filter(x=>x.id===q.id); return [...rows]; },
    async removeFile(id) { const row=rows.find(x=>x.id===id); if(row.failDelete) throw Error('no access'); row.state='removed'; removed.push(id); }
  };
  const manifestStore={async read(){return manifest ? structuredClone(manifest):null;},async write(x){manifest=structuredClone(x);}};
  const service=createBackupDownloads({downloads,manifestStore,maxComplete,clock:now,random:()=>String(nextId).padStart(12,'0'),makeBlobUrl:()=>`blob:test-${nextId}`,revokeBlobUrl:u=>revoked.push(u)});
  return {service,downloads,rows,removed,revoked,manifestStore};
}
test('only successful known downloads count toward retention, never pending or unknown', async()=>{
  const h=harness(); const a=await h.service.downloadFile(new Uint8Array([1]));
  assert.equal(a.status,'PENDING'); assert.equal(a.filename.startsWith(BACKUP_FOLDER+'/'),true);
  const b=await h.service.downloadFile(new Uint8Array([2]));
  h.rows[0].state='complete'; h.rows[1].state='complete';
  const s=await h.service.maintain();assert.equal(s.retained,1);assert.deepEqual(h.removed,[1]);
  assert.equal(h.rows[1].state,'complete');
});
test('unknown files and deletion failure are warnings; no unknown ID is deleted', async()=>{
  const h=harness();await h.service.downloadFile(new Uint8Array([5]));h.rows[0].state='complete';
  h.rows.push({id:100,filename:`/home/test/Downloads/${BACKUP_FOLDER}/untracked.json`,state:'complete'});
  await h.service.downloadFile(new Uint8Array([7])); h.rows[2].state='complete';h.rows[0].failDelete=true;
  const s=await h.service.maintain();assert.equal(s.retained,2);assert.deepEqual(h.removed,[]);assert.equal(s.unknownCount,1);
  assert.ok(s.warnings.includes('KNOWN_FILE_DELETE_FAILED'));
  assert.ok(s.warnings.includes('UNKNOWN_DOWNLOADS_LEFT_UNTOUCHED'));
});
test('interrupted downloads never replace last successful backup', async()=>{
  const h=harness();await h.service.downloadFile(new Uint8Array([1]));h.rows[0].state='complete';
  await h.service.downloadFile(new Uint8Array([2]));h.rows[1].state='interrupted';
  const result=await h.service.maintain();assert.equal(result.retained,1);assert.deepEqual(h.removed,[]);
});
test('invalid archive, durable manifest failure and untracked history fail closed', async()=>{
  const h=harness();await assert.rejects(h.service.downloadFile(new Uint8Array()),e=>e.code==='INVALID_BACKUP');
  const a=await h.service.downloadFile(new Uint8Array([1]));const b=await h.service.status();assert.equal(b.entries[0].id,a.id);
  h.rows[0].filename='/home/test/Downloads/unrelated.json';const view=await h.service.maintain();assert.ok(view.warnings.includes('KNOWN_DOWNLOAD_UNVERIFIABLE'));
  const m=h.manifestStore; m.write=async()=>{throw Error('storage fail');};
  // Factory captures manifestStore methods by reference: failed writes must block.
  await assert.rejects(h.service.downloadFile(new Uint8Array([2])),/RECOVERY_HOLD/);
});