import test from "node:test";
import assert from "node:assert/strict";

import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";

function backend(initial=[]){
  let records=structuredClone(initial);let replacement=null;
  return {
    async open(){},
    close(){},
    async get(){return null;},
    async compareAndSwap(){throw new Error("not used");},
    async deleteCompareAndSwap(){throw new Error("not used");},
    async listNamespace(){return [];},
    async listAllRecords(){return structuredClone(records);},
    async replaceAllRecords(next){replacement=structuredClone(next);records=structuredClone(next);return {replaced:next.length};},
    get replacement(){return structuredClone(replacement);}
  };
}

test("A020-01 privileged storage admin snapshots canonical records and preserves revisions",async()=>{
  const raw=[
    {id:"z\0b",namespace:"z",key:"b",revision:4,updatedAt:"2026-10-05T00:00:00Z",value:{n:2}},
    {id:"a\0a",namespace:"a",key:"a",revision:2,updatedAt:"2026-10-04T00:00:00Z",value:{n:1}}
  ];
  const be=backend(raw);const broker=createPcmsStorageBroker({backend:be});
  const snapshot=await broker.admin.snapshotRecords();
  assert.deepEqual(snapshot.map(r=>[r.namespace,r.key,r.revision]),[["a","a",2],["z","b",4]]);
  assert.equal(Object.hasOwn(snapshot[0],"id"),false);
  await broker.admin.replaceAllRecords(snapshot);
  assert.deepEqual(be.replacement.map(r=>r.revision),[2,4]);
});

test("storage admin rejects duplicate identity and unsafe metadata before replacement",async()=>{
  const be=backend();const broker=createPcmsStorageBroker({backend:be});
  const row={namespace:"a",key:"x",revision:1,updatedAt:"2026-10-05T00:00:00Z",value:{ok:true}};
  assert.throws(()=>broker.admin.validateRecords([row,row]));
  assert.throws(()=>broker.admin.validateRecords([{...row,revision:0}]));
  assert.equal(be.replacement,null);
});
