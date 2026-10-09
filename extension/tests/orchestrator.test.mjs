import assert from 'node:assert/strict';
import { MAX_WORKFLOW_STEP_TIMEOUT_MS } from '../lib/constants.js';

let nextTab = 10;
const tabs = new Map();
const removed = [];
const storage = {};
const updatedListeners = new Set();
let updateHook = null;
let emitComplete = true;
let failOwnershipTag = false;
let failStorageWrite = false;
let holdNextWrite = false;
let releaseHeldWrite = null;
let notifyHeldWrite = null;
let historyWrites = 0;
const sessionValues = new Map();
const navigations = [];

globalThis.browser = {
  storage: { local: {
    async get(key) { if (key == null) return { ...storage }; return typeof key === 'string' ? { [key]: storage[key] } : {}; },
    async set(obj) {
      historyWrites++;
      if (holdNextWrite) {
        holdNextWrite = false;
        notifyHeldWrite();
        await new Promise((resolve) => { releaseHeldWrite = resolve; });
      }
      if (failStorageWrite) throw new Error('storage write unavailable');
      Object.assign(storage, obj);
    },
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage[k]; }
  }},
  sessions: {
    async setTabValue(id, key, value) {
      if (failOwnershipTag) throw new Error('session storage unavailable');
      sessionValues.set(`${id}:${key}`, structuredClone(value));
    },
    async getTabValue(id, key) { return sessionValues.get(`${id}:${key}`); },
    async removeTabValue(id, key) { sessionValues.delete(`${id}:${key}`); }
  },
  tabs: {
    onUpdated: { addListener(fn){updatedListeners.add(fn)}, removeListener(fn){updatedListeners.delete(fn)} },
    async create(opts) { const tab = { id: nextTab++, status:'complete', url:opts.url, cookieStoreId:opts.cookieStoreId }; tabs.set(tab.id, tab); return { ...tab }; },
    async get(id) { if (!tabs.has(id)) throw new Error('missing tab'); return { ...tabs.get(id) }; },
    async update(id, changes) {
      navigations.push({ id, url: changes.url });
      const t=tabs.get(id);
      Object.assign(t, changes, {status: emitComplete ? 'complete' : 'loading'});
      if (updateHook) await updateHook(id, {...t});
      if (emitComplete) for (const fn of [...updatedListeners]) fn(id,{status:'complete'},{...t});
      return {...t};
    },
    async remove(id) { removed.push(id); tabs.delete(id); }
  },
  scripting: { async executeScript(){ return [{result:true}]; } }
};

const mod = await import(`../lib/orchestrator.js?test=${Date.now()}`);
const state = {
  global:{automation:{historyLimit:100,maxTabsPerStep:4,maxTabsTotal:3,maxJobRuntimeMinutes:2}},
  profiles:{'firefox-container-1':{containerId:'firefox-container-1',managed:true,name:'P1'}},
  scripts:{sig:{id:'sig',name:'Signal',enabled:true,profileIds:['firefox-container-1'],grants:['GM_info','Persona.signal']},sig2:{id:'sig2',name:'Signal two',enabled:true,profileIds:['firefox-container-1'],grants:['GM_info','Persona.signal']}},
  workflows:{
    w1:{id:'w1',name:'Smoke',enabled:true,steps:[{id:'s1',profileId:'firefox-container-1',urls:['https://example.com/a','https://example.com/b'],concurrency:2,scriptIds:[],completion:{mode:'load',timeoutMs:5000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]},
    wSignal:{id:'wSignal',name:'Early signal',enabled:true,steps:[{id:'ss',profileId:'firefox-container-1',urls:['https://example.com/signal?token=local-detail'],concurrency:1,scriptIds:['sig'],completion:{mode:'signal',timeoutMs:5000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]},
    wHold:{id:'wHold',name:'Concurrent signal',enabled:true,steps:[{id:'sh',profileId:'firefox-container-1',urls:['https://example.com/hold'],concurrency:1,scriptIds:['sig'],completion:{mode:'signal',timeoutMs:1000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]},
    wTag:{id:'wTag',name:'Tag failure',enabled:true,steps:[{id:'st',profileId:'firefox-container-1',urls:['https://example.com/tag-failure'],concurrency:1,scriptIds:[],completion:{mode:'load',timeoutMs:5000},retries:0,retryDelayMs:1000,closeTabs:false,stopOnError:true}]},
    wOversizeSignal:{id:'wOversizeSignal',name:'Oversize signal',enabled:true,steps:[{id:'so',profileId:'firefox-container-1',urls:['https://example.com/oversize-signal'],concurrency:1,scriptIds:['sig'],completion:{mode:'signal',timeoutMs:5000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]},
    wCombinedSignal:{id:'wCombinedSignal',name:'Combined signal',enabled:true,steps:[{id:'sc',profileId:'firefox-container-1',urls:['https://example.com/combined-signal'],concurrency:1,scriptIds:['sig','sig2'],completion:{mode:'signal',timeoutMs:5000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]},
    wJobBudget:{id:'wJobBudget',name:'Job result budget',enabled:true,steps:[{id:'sb',profileId:'firefox-container-1',urls:Array.from({length:18},(_,i)=>`https://example.com/job-budget/${i}`),concurrency:1,scriptIds:['sig'],completion:{mode:'signal',timeoutMs:5000},retries:0,retryDelayMs:1000,closeTabs:true,stopOnError:true}]},
    wMaxTimeout:{id:'wMaxTimeout',name:'Maximum step timeout',enabled:true,steps:[{id:'st',profileId:'firefox-container-1',urls:['https://example.com/max-timeout'],concurrency:1,scriptIds:[],completion:{mode:'load',timeoutMs:MAX_WORKFLOW_STEP_TIMEOUT_MS},retries:0,retryDelayMs:0,closeTabs:true,stopOnError:true}]}
  }
};
let prepared=0;
const jobEvents=[];
await mod.configureOrchestrator({getState:async()=>state,ensureProfileReady:async(id)=>{assert.equal(id,'firefox-container-1');prepared++;return {profile:state.profiles[id],route:null,mode:'direct'};},onJobEvent:(event)=>jobEvents.push(event)});
const started=await mod.runWorkflow('w1');
assert.equal(started.workflowId,'w1');
for(let i=0;i<100;i++){
  const [job]=await mod.listJobs(1);
  if(['completed','failed'].includes(job.state)) break;
  await new Promise(r=>setTimeout(r,5));
}
const [job]=await mod.listJobs(1);
assert.equal(job.state,'completed');
assert.equal(job.tasks.length,2);
assert.equal(job.tasks.filter(t=>t.state==='completed').length,2);
assert.equal(job.stepProgress[0].completed,2);
assert.equal(job.stepProgress[0].state,'completed');
assert.equal(job.stepProgress[0].stepId,undefined,'ordinary job projection does not expose an additive step ID');
assert.equal('id' in job.stepProgress[0],false,'ordinary job projection strips the internal step ID');
assert.equal(removed.length,2);
assert.equal(prepared,1);
assert.equal((await mod.getJob(started.id)).id,started.id);
assert.ok(jobEvents.some((event)=>event.type==='workflow.job.changed'));
assert.ok(jobEvents.some((event)=>event.type==='workflow.job.finished'));
assert.equal(jobEvents.every((event)=>event.data.tasks===undefined),true,'event payloads must remain bounded and not expose task results');
assert.equal(jobEvents.every((event)=>event.data.stepProgress.every((progress)=>!('id' in progress)&&!('stepId' in progress))),true,'ordinary job events do not expose internal or owner-scoped step IDs');
console.log('orchestrator tests passed');

// Verify the runtime passes the accepted 60-minute maximum into its actual
// page-load timer. Accelerate only that timer so the regression test stays fast.
emitComplete = false;
const nativeSetTimeout = globalThis.setTimeout;
const originalJobRuntimeMinutes = state.global.automation.maxJobRuntimeMinutes;
// A workflow's remaining overall budget bounds the page timer, so give this
// job the full minute to observe the configured 60-minute per-step limit.
state.global.automation.maxJobRuntimeMinutes = 60;
let runtimeTimeoutDelay = null;
let runtimePageTimerStack = "";
globalThis.setTimeout = (callback, delay, ...args) => {
  const stack = new Error().stack || "";
  if (stack.includes("waitForTabComplete") && delay >= MAX_WORKFLOW_STEP_TIMEOUT_MS - 5000) {
    runtimeTimeoutDelay = delay;
    runtimePageTimerStack = stack;
    return nativeSetTimeout(callback, 5, ...args);
  }
  return nativeSetTimeout(callback, delay, ...args);
};
let maxTimeoutStart;
try {
  maxTimeoutStart = await mod.runWorkflow('wMaxTimeout');
  const timedOut = await finishedJob('wMaxTimeout');
  assert.ok(runtimeTimeoutDelay > MAX_WORKFLOW_STEP_TIMEOUT_MS - 5000 && runtimeTimeoutDelay <= MAX_WORKFLOW_STEP_TIMEOUT_MS, 'runtime timer must honor the full 60-minute per-step timeout, subject only to elapsed setup time');
  assert.match(runtimePageTimerStack, /waitForTabComplete/, 'captured timer must come from the page completion waiter');
  assert.equal(timedOut.id, maxTimeoutStart.id);
  assert.equal(timedOut.tasks[0].completion.timeoutMs, MAX_WORKFLOW_STEP_TIMEOUT_MS);
  assert.equal(timedOut.state, 'failed', 'accelerated max timer should still enforce the timeout');
} finally {
  globalThis.setTimeout = nativeSetTimeout;
  state.global.automation.maxJobRuntimeMinutes = originalJobRuntimeMinutes;
  emitComplete = true;
}

const holding = await Promise.all(Array.from({length:3},()=>mod.runWorkflow('wHold')));
const navigationsBeforeRejectedStart=navigations.length;
await assert.rejects(mod.runWorkflow('wHold'),/At most 3 automation jobs may run concurrently/);
assert.equal(navigations.length,navigationsBeforeRejectedStart,'admission rejection must happen before opening a tab');
assert.equal((await mod.listJobsTrusted(100)).filter((entry)=>['queued','preparing','running','stopping'].includes(entry.state)).length,3,'rejected fourth job must not remain queued');
for(const item of holding) await mod.stopJob(item.id);
for(let i=0;i<400;i++){
  const retained=await Promise.all(holding.map(({id})=>mod.getJob(id)));
  if(retained.every((entry)=>['stopped','failed'].includes(entry.state))) break;
  await new Promise(r=>setTimeout(r,5));
}
const stillActive=(await mod.listJobsTrusted(100)).filter((entry)=>['queued','preparing','running','stopping'].includes(entry.state));
assert.equal(stillActive.length,0,`stopped jobs release active capacity: ${JSON.stringify(stillActive.map((entry)=>({id:entry.id,state:entry.state,error:entry.error})))}`);
failStorageWrite=true;
await assert.rejects(mod.runWorkflow('w1'),/storage write unavailable/);
failStorageWrite=false;
assert.equal((await mod.listJobsTrusted(100)).filter((entry)=>['queued','preparing','running','stopping'].includes(entry.state)).length,0,'failed initial persistence must roll back queued job');

// A document-start userscript may signal during navigation. Signal mode must
// complete from that signal even if the page never emits a later load-complete
// event (streaming pages and long-lived apps can behave this way).
emitComplete = false;
updateHook = async (tabId) => {
  const policy = mod.getAutomationTabPolicy(tabId);
  const url = tabs.get(tabId)?.url || '';
  if (url.includes('/oversize-signal')) {
    assert.equal(mod.handleAutomationSignal({tabId,scriptId:'sig',status:'complete',result:'x'.repeat(64 * 1024)}), true);
  } else if (url.includes('/combined-signal')) {
    assert.equal(mod.handleAutomationSignal({tabId,scriptId:'sig',status:'complete',result:'a'.repeat(40 * 1024)}), true);
    assert.equal(mod.handleAutomationSignal({tabId,scriptId:'sig2',status:'complete',result:'b'.repeat(40 * 1024)}), true);
  } else if (url.includes('/job-budget/')) {
    assert.equal(mod.handleAutomationSignal({tabId,scriptId:'sig',status:'complete',result:'r'.repeat(58 * 1024)}), true);
  } else if (policy?.allowedScriptIds?.includes('sig')) {
    assert.equal(mod.handlePageAutomationSignal({tab:{id:tabId}}, {token:policy.automationToken,scriptId:'sig',status:'complete',result:{forged:true}}), false, 'page-world messages cannot complete isolated automation');
    assert.equal(mod.handleAutomationSignal({tabId,scriptId:'sig',status:'complete',result:{early:true,credential:'trusted-local-only'}}), true);
  }
};
await mod.runWorkflow('wSignal');
for(let i=0;i<100;i++){
  const jobs=await mod.listJobs(5);
  const j=jobs.find(x=>x.workflowId==='wSignal');
  if(j && ['completed','failed'].includes(j.state)) break;
  await new Promise(r=>setTimeout(r,5));
}
const signalJob=(await mod.listJobs(5)).find(x=>x.workflowId==='wSignal');
assert.equal(signalJob.state,'completed');
assert.equal(signalJob.tasks[0].result,undefined,"public job data must not expose userscript return values");
assert.equal(signalJob.tasks[0].url,undefined,"public job data must not expose workflow URLs");
assert.equal(signalJob.tasks[0].error,null,"public job data must not expose arbitrary error strings");
assert.equal(signalJob.tasks[0].state,'completed');
assert.equal(signalJob.tasks[0].attemptHistory[0].state,'completed',"safe attempt progress remains observable");
assert.equal(signalJob.tasks[0].attemptHistory[0].error,null,"raw attempt errors are not exposed");
assert.deepEqual(signalJob.tasks[0].completion,{mode:'signal'},"safe completion mode remains observable");

const trustedSignalJob=(await mod.listJobsTrusted(5)).find(x=>x.workflowId==='wSignal');
assert.equal(trustedSignalJob.tasks[0].url,'https://example.com/signal?token=local-detail','trusted diagnostics retain the task URL');
assert.deepEqual(trustedSignalJob.tasks[0].result,{sig:{early:true,credential:'trusted-local-only'}},'trusted diagnostics retain userscript result detail');
assert.equal(trustedSignalJob.tasks[0].completion.timeoutMs,5000,'trusted diagnostics retain completion detail');
assert.equal('_cancelled' in trustedSignalJob,false,'trusted projections omit runtime coordination flags');
assert.equal(storage.automationJobs[trustedSignalJob.id].tasks[0].url,'https://example.com/signal?token=local-detail','restart history retains trusted local diagnostic detail');
assert.equal('_cancelled' in storage.automationJobs[trustedSignalJob.id],false,'persisted history omits runtime coordination flags');

failOwnershipTag = true;
const navigationCountBeforeTagFailure = navigations.length;
const failedTagStart = await mod.runWorkflow('wTag');
for(let i=0;i<100;i++){
  const [candidate] = await mod.listJobs(5);
  if(candidate?.id === failedTagStart.id && ['completed','failed'].includes(candidate.state)) break;
  await new Promise(r=>setTimeout(r,5));
}
const failedTagJob = (await mod.listJobs(5)).find((candidate)=>candidate.id === failedTagStart.id);
assert.equal(failedTagJob.state,'failed','tab ownership tagging failure must fail closed');
assert.equal(navigations.length,navigationCountBeforeTagFailure,'automation must not navigate before ownership is tagged');
assert.equal(tabs.size,0,'an untagged blank tab must be closed even when closeTabs=false');
failOwnershipTag = false;

async function finishedJob(workflowId) {
  for (let i=0;i<300;i++) {
    const candidate = (await mod.listJobsTrusted(100)).find((entry)=>entry.workflowId===workflowId);
    if(candidate && ['completed','failed'].includes(candidate.state)) return candidate;
    await new Promise(r=>setTimeout(r,5));
  }
  throw new Error(`workflow ${workflowId} did not finish`);
}
await mod.runWorkflow('wOversizeSignal');
const oversizeJob = await finishedJob('wOversizeSignal');
assert.equal(oversizeJob.state,'failed','an individual signal beyond the bound must fail the task');
assert.match(oversizeJob.error,/65536-byte limit/);
await mod.runWorkflow('wCombinedSignal');
const combinedJob = await finishedJob('wCombinedSignal');
assert.equal(combinedJob.state,'failed','combined signals beyond the bound must fail the task');
assert.match(combinedJob.error,/Combined userscript completion result exceeds/);
await mod.runWorkflow('wJobBudget');
const budgetJob = await finishedJob('wJobBudget');
assert.equal(budgetJob.state,'failed','a workflow that exceeds the per-job persisted results ceiling must stop');
assert.match(budgetJob.error,/Automation results exceed the 1048576-byte job storage limit/);

const importedHistory={
  imported:{id:'imported',workflowId:'historical',workflowName:'Imported history',state:'completed',createdAt:new Date().toISOString(),startedAt:null,finishedAt:new Date().toISOString(),currentStep:0,totalSteps:0,error:null,stepProgress:[],tasks:[]},
  oversized:{id:'oversized',workflowId:'historical',workflowName:'Oversized imported history',state:'completed',createdAt:new Date().toISOString(),startedAt:null,finishedAt:new Date().toISOString(),currentStep:0,totalSteps:0,error:null,stepProgress:[],tasks:[{id:'large',state:'completed',result:'x'.repeat(1100000)}]}
};
const replacedHistory=await mod.replaceJobsTrusted(importedHistory);
assert.deepEqual(replacedHistory.map((entry)=>entry.id).sort(),['imported','oversized'],'history import must replace the orchestrator cache without a runtime reload');
assert.deepEqual(Object.keys(storage.automationJobs).sort(),['imported','oversized'],'history import must persist the same replacement set');
const compactedLegacy = await mod.getJobTrusted('oversized');
assert.equal(compactedLegacy.tasks[0].result,undefined,'oversized historical results must be removed to preserve the storage budget');
assert.equal(compactedLegacy.tasks[0].resultOmitted,true);
assert.match(compactedLegacy.storageNote,/omitted/,'legacy history compaction must be explicit');
assert.ok(Buffer.byteLength(JSON.stringify(storage.automationJobs.oversized)) <= 1024 * 1024);

// Hold the first full-history write after it starts. A second job must wait
// for that write before taking its own snapshot, so completion order cannot
// overwrite its persisted record with an older one.
emitComplete=true;
updateHook=null;
const heldWriteStarted=new Promise((resolve)=>{notifyHeldWrite=resolve;});
holdNextWrite=true;
const firstStart=mod.runWorkflow('w1');
await heldWriteStarted;
const secondStart=mod.runWorkflow('w1');
let queuedStarts=[];
for(let i=0;i<100;i++){
  queuedStarts=(await mod.listJobsTrusted(100)).filter((entry)=>entry.workflowId==='w1' && entry.state==='queued');
  if(queuedStarts.length===2)break;
  await new Promise(r=>setTimeout(r,1));
}
assert.equal(queuedStarts.length,2,'both starts must be queued before testing write ordering');
const writesWhileHeld=historyWrites;
await new Promise(r=>setTimeout(r,20));
assert.equal(historyWrites,writesWhileHeld,'newer full-history write must wait for the held older write');
releaseHeldWrite();
const [firstConcurrent,secondConcurrent]=await Promise.all([firstStart,secondStart]);
for(let i=0;i<200;i++){
  const states=await Promise.all([firstConcurrent.id,secondConcurrent.id].map((id)=>mod.getJob(id)));
  if(states.every((entry)=>entry?.state==='completed'))break;
  await new Promise(r=>setTimeout(r,5));
}
assert.equal(storage.automationJobs[firstConcurrent.id]?.state,'completed');
assert.equal(storage.automationJobs[secondConcurrent.id]?.state,'completed','newer job must survive a delayed older write');

// The count limit includes active jobs but must never evict one while its
// runner is still alive, even after newer jobs have finished.
state.global.automation.historyLimit=10;
state.workflows.wHold.steps[0].completion.timeoutMs=10000;
const oldestActive=await mod.runWorkflow('wHold');
for(let i=0;i<100;i++){
  const current=await mod.getJobTrusted(oldestActive.id);
  if(current?.state==='running' && current.tasks?.[0]?.state==='waiting')break;
  await new Promise(r=>setTimeout(r,5));
}
for(let index=0;index<10;index++){
  const newer=await mod.runWorkflow('w1');
  for(let i=0;i<100;i++){
    if((await mod.getJob(newer.id))?.state==='completed')break;
    await new Promise(r=>setTimeout(r,5));
  }
  assert.equal((await mod.getJob(newer.id))?.state,'completed');
}
assert.equal((await mod.getJob(oldestActive.id))?.state,'running','oldest active job remains visible after ten newer completions');
assert.equal(storage.automationJobs[oldestActive.id]?.state,'running','oldest active job remains durable for restart recovery');
await mod.stopJob(oldestActive.id);
for(let i=0;i<200;i++){
  if((await mod.getJob(oldestActive.id))?.state==='stopped')break;
  await new Promise(r=>setTimeout(r,5));
}
assert.equal((await mod.getJob(oldestActive.id))?.state,'stopped','surviving active job is still stoppable');
console.log('signal-without-page-load, trusted diagnostics, and history replacement tests passed');
