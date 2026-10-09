import assert from 'node:assert/strict';

let nextTab = 100;
const tabs = new Map();
const storage = {};
const updatedListeners = new Set();
const removedListeners = new Set();
let maxOpen = 0;
const sessionValues = new Map();

function tabValueMap(id) {
  let m = sessionValues.get(id);
  if (!m) sessionValues.set(id, m = new Map());
  return m;
}

globalThis.browser = {
  storage: { local: {
    async get(key) { if (key == null) return { ...storage }; return typeof key === 'string' ? { [key]: storage[key] } : {}; },
    async set(obj) { Object.assign(storage, obj); },
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage[k]; }
  }},
  sessions: {
    async setTabValue(id, key, value) { tabValueMap(id).set(key, structuredClone(value)); },
    async getTabValue(id, key) { return sessionValues.get(id)?.get(key); },
    async removeTabValue(id, key) { sessionValues.get(id)?.delete(key); }
  },
  tabs: {
    onUpdated: { addListener(fn){updatedListeners.add(fn)}, removeListener(fn){updatedListeners.delete(fn)} },
    onRemoved: { addListener(fn){removedListeners.add(fn)}, removeListener(fn){removedListeners.delete(fn)} },
    async query() { return [...tabs.values()].map(t => ({...t})); },
    async create(opts) {
      const tab = { id: nextTab++, status:'complete', url:opts.url, cookieStoreId:opts.cookieStoreId };
      tabs.set(tab.id, tab);
      maxOpen = Math.max(maxOpen, tabs.size);
      return { ...tab };
    },
    async get(id) { if (!tabs.has(id)) throw new Error('missing tab'); return { ...tabs.get(id) }; },
    async update(id, changes) {
      const t = tabs.get(id); Object.assign(t, changes, {status:'complete'});
      for (const fn of [...updatedListeners]) fn(id,{status:'complete'},{...t});
      return {...t};
    },
    async remove(id) {
      tabs.delete(id); sessionValues.delete(id);
      for (const fn of [...removedListeners]) fn(id, {isWindowClosing:false});
    }
  },
  scripting: { async executeScript(){ return [{result:true}]; } }
};

const mod = await import(`../lib/orchestrator.js?limits=${Date.now()}`);
const profile = 'firefox-container-1';
const mkStep = (urls, closeTabs=true) => ({
  id:'s', profileId:profile, urls, concurrency:5, scriptIds:[],
  completion:{mode:'delay',value:'75',timeoutMs:5000}, retries:0, closeTabs, stopOnError:true
});
const state = {
  global:{automation:{historyLimit:100,maxTabsPerStep:5,maxTabsTotal:3,maxJobRuntimeMinutes:2}},
  profiles:{[profile]:{managed:true,name:'P1'}}, scripts:{},
  workflows:{
    a:{id:'a',name:'A',enabled:true,steps:[mkStep(['https://a.test/1','https://a.test/2','https://a.test/3','https://a.test/4'])]},
    b:{id:'b',name:'B',enabled:true,steps:[mkStep(['https://b.test/1','https://b.test/2','https://b.test/3','https://b.test/4'])]},
    keep:{id:'keep',name:'Keep',enabled:true,steps:[mkStep(['https://keep.test/1'],false)]}
  }
};
await mod.configureOrchestrator({getState:async()=>state,ensureProfileReady:async()=>({})});

await Promise.all([mod.runWorkflow('a'), mod.runWorkflow('b')]);
for (let i=0;i<300;i++) {
  const j = await mod.listJobs(10);
  const ab = j.filter(x => x.workflowId === 'a' || x.workflowId === 'b');
  if (ab.length === 2 && ab.every(x => ['completed','failed'].includes(x.state))) break;
  await new Promise(r=>setTimeout(r,10));
}
const ab = (await mod.listJobs(10)).filter(x => x.workflowId === 'a' || x.workflowId === 'b');
assert.equal(ab.length, 2);
assert.ok(ab.every(x=>x.state==='completed'));
assert.ok(maxOpen <= 3, `global tab cap exceeded: observed ${maxOpen}`);
assert.equal(tabs.size, 0);

maxOpen = 0;
await mod.runWorkflow('keep');
for (let i=0;i<200;i++) {
  const j=(await mod.listJobs(10)).find(x=>x.workflowId==='keep');
  if (j && ['completed','failed'].includes(j.state)) break;
  await new Promise(r=>setTimeout(r,10));
}
const kept=(await mod.listJobs(10)).find(x=>x.workflowId==='keep');
assert.equal(kept.state,'completed');
assert.equal(tabs.size,1,'closeTabs=false should retain the completed tab');
const [keptTab]=tabs.values();
assert.equal(mod.getAutomationTabPolicy(keptTab.id),null,'retained tab must no longer be automation-restricted');
assert.equal(await browser.sessions.getTabValue(keptTab.id,'personaAutomationOwner'),undefined,'retained tab ownership tag must be removed');
console.log('orchestrator global-limit and retained-tab tests passed');
