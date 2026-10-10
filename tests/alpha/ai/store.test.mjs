import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiTaskStore,validateAiLedger,countAiSlots} from '../../../extension/alpha/features/ai/store.mjs';

function fakeIndexedDB(){
  const data=new Map();
  return {
    corrupt(name,value){data.get(name).rows.set('state',value);},
    open(name,version){
      const req={};
      queueMicrotask(()=>{
        let state=data.get(name),first=!state;
        if(!state){state={rows:new Map()};data.set(name,state);}
        const db={version,objectStoreNames:{length:1,contains:k=>k==='ledger'},close(){},
          createObjectStore(k){assert.equal(k,'ledger');return {add(value,key){state.rows.set(key,structuredClone(value));}};},
          transaction(k,mode){
            assert.equal(k,'ledger');let pending=0,aborted=false;
            const tx={onabort:null,oncomplete:null,onerror:null,
              abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},
              objectStore(key){assert.equal(key,'ledger');return {
                get(id){const q={};pending++;queueMicrotask(()=>{
                  if(aborted)return;
                  q.result=structuredClone(state.rows.get(id));q.onsuccess?.();pending--;
                  queueMicrotask(()=>{if(!pending&&!aborted)tx.oncomplete?.();});
                });return q;},
                put(value,id){assert.equal(mode,'readwrite');pending++;
                  queueMicrotask(()=>{if(aborted)return;state.rows.set(id,structuredClone(value));pending--;
                    queueMicrotask(()=>{if(!pending&&!aborted)tx.oncomplete?.();});});
                }
              };}
            };
            return tx;
          }};
        req.result=db;if(first)req.onupgradeneeded?.();req.onsuccess?.();
      });return req;
    }
  };
}
const now='2026-10-10T12:00:00.000Z';
const item={id:'ai:test',key:'alpha',accountId:'acct-1',personaUid:'uid-001',bindingEpoch:1,
  revision:1,state:'RECOVERING',createdAt:now,updatedAt:now,sourceHash:'a'.repeat(64),sourceRevision:'r1',
  savedSourceHash:null,savedSourceRevision:null,sessionId:null,opId:'run-1',dispatchPhase:'PREPARED',
  provenanceRefs:[],approvalRevision:null,approvalOpId:null,reviewPending:false,failureCode:null};

test('AP303-01 IndexedDB strict ledger survives close/reopen and rejects stale CAS writes',async()=>{
  const indexedDB=fakeIndexedDB(),databaseName='persona-monkey-pcms-alpha-ai-test-persist';
  let store=createAiTaskStore({indexedDB,databaseName});
  assert.deepEqual(await store.read(),{schemaVersion:1,revision:0,tasks:[]});
  await store.change(0,draft=>{draft.tasks.push(structuredClone(item));});
  store.close();store=createAiTaskStore({indexedDB,databaseName});
  const reopened=await store.read();assert.equal(reopened.revision,1);
  assert.equal(reopened.tasks[0].id,'ai:test');
  assert.equal(countAiSlots(reopened.tasks,'acct-1'),1);
  await assert.rejects(store.change(0,draft=>{draft.tasks=[];}),e=>e.code==='STALE_REVISION');
  assert.equal((await store.read()).tasks.length,1);
});

test('AP303-03 corrupt durable record fails closed without resetting session ownership',async()=>{
  const indexedDB=fakeIndexedDB(),databaseName='persona-monkey-pcms-alpha-ai-test-corrupt';
  const store=createAiTaskStore({indexedDB,databaseName});await store.read();
  indexedDB.corrupt(databaseName,{schemaVersion:1,revision:0,tasks:[{id:'ai:stale'}]});
  await assert.rejects(store.read(),e=>e.code==='RECOVERY_HOLD');
  await assert.rejects(store.change(0,draft=>draft.tasks.splice(0)),e=>e.code==='RECOVERY_HOLD');
});

test('AP303-01 updater cannot become asynchronous or persist invalid/open task rows',async()=>{
  const indexedDB=fakeIndexedDB(),databaseName='persona-monkey-pcms-alpha-ai-test-atomic';
  const store=createAiTaskStore({indexedDB,databaseName});
  await assert.rejects(store.change(0,async()=>{}),e=>e.code==='INVALID_REQUEST');
  await assert.rejects(store.change(0,draft=>{draft.tasks.push({...item,unknown:'secret'});}),e=>e.code==='RECOVERY_HOLD');
  assert.equal((await store.read()).revision,0);
  assert.throws(()=>validateAiLedger({schemaVersion:1,revision:1,tasks:[item,item]}),e=>e.code==='RECOVERY_HOLD');
});
