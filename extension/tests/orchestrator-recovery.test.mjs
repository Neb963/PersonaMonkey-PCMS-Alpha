import assert from 'node:assert/strict';

const ownerKey='personaAutomationOwner';
const storage={automationJobs:{
  'job-old':{id:'job-old',workflowId:'w',workflowName:'Old',state:'running',createdAt:'2026-09-10T00:00:00Z',startedAt:'2026-09-10T00:00:01Z',finishedAt:null,currentStep:0,error:null,tasks:[{id:'1-1',tabId:7,state:'loading',url:'https://old.test/?token=secret',result:{token:'secret'},error:'secret error'}]},
  'job-done':{id:'job-done',workflowId:'w',workflowName:'Done',state:'completed',createdAt:'2026-09-09T00:00:00Z',startedAt:'2026-09-09T00:00:01Z',finishedAt:'2026-09-09T00:00:02Z',currentStep:0,error:null,tasks:[]}
}};
const tabs=new Map([[7,{id:7,status:'complete',url:'https://old.test/',cookieStoreId:'firefox-container-1'}],[8,{id:8,status:'complete',url:'https://manual.test/',cookieStoreId:'firefox-container-1'}]]);
const session=new Map([[7,new Map([[ownerKey,{jobId:'job-old',taskId:'1-1'}]])],[8,new Map([[ownerKey,{jobId:'some-other-job'}]])]]);
const removed=[];

globalThis.browser={
  storage:{local:{async get(k){return {[k]:storage[k]}},async set(o){Object.assign(storage,o)}}},
  sessions:{async getTabValue(id,key){return session.get(id)?.get(key)},async setTabValue(){},async removeTabValue(id,key){session.get(id)?.delete(key)}},
  tabs:{
    async query(){return [...tabs.values()].map(x=>({...x}))},
    async remove(id){removed.push(id);tabs.delete(id);session.delete(id)},
    onUpdated:{addListener(){},removeListener(){}},onRemoved:{addListener(){},removeListener(){}}
  },
  scripting:{async executeScript(){return[{result:true}]}}
};
const state={global:{automation:{historyLimit:100,maxTabsPerStep:4,maxTabsTotal:4,maxJobRuntimeMinutes:10}},profiles:{},scripts:{},workflows:{}};
const mod=await import(`../lib/orchestrator.js?recovery=${Date.now()}`);
await mod.configureOrchestrator({getState:async()=>state,ensureProfileReady:async()=>({})});
const jobs=await mod.listJobs(10);
const old=jobs.find(j=>j.id==='job-old');
assert.equal(old.state,'interrupted');
assert.equal(old.failed,false,'interruption is a distinct terminal state, not a workflow failure');
assert.equal(old.error,'Workflow interrupted');
assert.equal(old.tasks[0].url,undefined);
assert.equal(old.tasks[0].result,undefined);
assert.equal(old.tasks[0].state,'interrupted');
assert.equal(old.tasks[0].error,'Task interrupted');
assert.deepEqual(removed,[7]);
assert.equal(tabs.has(8),true,'unrelated tagged tab must not be closed');

const trusted=(await mod.listJobsTrusted(10)).find(j=>j.id==='job-old');
assert.equal(trusted.state,'interrupted');
assert.equal(trusted.error,'LibreWolf/extension stopped while this job was running');
assert.equal(trusted.tasks[0].url,'https://old.test/?token=secret','trusted local history retains the task URL for diagnostics');
assert.deepEqual(trusted.tasks[0].result,{token:'secret'},'trusted local history retains script results for diagnostics');
assert.equal(trusted.tasks[0].error,'secret error','trusted local history retains task error detail');

assert.equal(storage.automationJobs['job-old']._cancelled,undefined,'runtime-private fields must not be persisted');
assert.equal(storage.automationJobs['job-old']._deadline,undefined,'runtime deadline must not be persisted');
assert.equal(storage.automationJobs['job-old'].error,'LibreWolf/extension stopped while this job was running','persisted history keeps trusted local recovery detail');
assert.equal(storage.automationJobs['job-old'].tasks[0].state,'interrupted','persisted active tasks must reconcile to the interrupted terminal state');
assert.equal(storage.automationJobs['job-old'].tasks[0].url,'https://old.test/?token=secret','persisted trusted history retains task URLs');
assert.deepEqual(storage.automationJobs['job-old'].tasks[0].result,{token:'secret'},'persisted trusted history retains script results');
console.log('orchestrator recovery cleanup test passed');
