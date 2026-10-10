import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { IsolatedFirefox } from '../../../tools/alpha/firefox/harness.mjs';
import { waitFor } from '../../../tools/firefox/packaged-harness.mjs';
import { execFileText, sha256File } from '../../../tools/firefox/lib.mjs';
import { verifyInstallation, REPO_ROOT } from '../../../tools/alpha/firefox/pin.mjs';

const PRODUCT = 'persona-route-manager@local', PAGE = 'alpha/ui/shell/index.html';
let h, root, probe, sequence = 0;
const report = { phaseId: 'P201', providerLive: false, checks: {}, passed: false,
  contentSandboxDisabled: process.env.MOZ_DISABLE_CONTENT_SANDBOX === '1' };
const next = prefix => prefix + '-' + ++sequence;
async function page(code, input = {}, { core: requireCore = true } = {}) {
  // Privileged Marionette inspection exports compiled callbacks into the real
  // background realm. UI requests below still enter its production listener.
  await h.client.command('Marionette:SetContext', { value: 'content' });
  const executed = await h.client.command('WebDriver:ExecuteAsyncScript', {
    newSandbox: true, sandbox: 'system', scriptTimeout: h.client.timeout - 1000,
    args: [input], script: `const done=arguments[arguments.length-1];
    (async()=>{
      const api=window.wrappedJSObject.browser;
      const bg=await api.runtime.getBackgroundPage(), w=bg.wrappedJSObject||bg;
      const entry=w[w.Symbol.for('persona-monkey.alpha.background.v1')];
      if(!entry) throw new Error('Production Alpha entry is absent');
      const returned=${requireCore ? 'await entry.host.ensureCore()' : 'null'}, core=returned?.wrappedJSObject||returned,
        clone=value=>{const copied=w.JSON.parse(JSON.stringify(value));return copied?.wrappedJSObject||copied;}, data=clone(arguments[0]);
      const compiled=value=>{const copied=clone({});for(const key of Object.keys(value))copied[key]=typeof value[key]==='function'?value[key]:clone(value[key]);return copied;};
      const callable=fn=>Components.utils.exportFunction((...args)=>new w.Promise(
        Components.utils.exportFunction((resolve,reject)=>{
          Promise.resolve().then(()=>fn(...args.map(value=>value?.wrappedJSObject||value)))
            .then(value=>resolve(value),error=>reject(clone({code:(error.wrappedJSObject||error).code||'HARNESS_FAILURE'})));
        },w,{allowCrossOriginArguments:true})),w,{allowCrossOriginArguments:true});
      ${code}
    })().then(value=>done({ok:true,value:JSON.parse(JSON.stringify(value??null))}),
      error=>{const e=error?.wrappedJSObject||error;done({ok:false,code:e?.code||'HARNESS_FAILURE',message:String(e?.message||'Browser case failed'),
        stack:typeof e?.stack==='string'?e.stack.split('\\n').slice(0,8).join('\\n'):null});});`
  });
  const result = executed.value;
  if (!result.ok) { const e = new Error(result.message + (result.stack ? '\n' + result.stack : '')); e.code = result.code; throw e; }
  return result.value;
}
const status = () => page('return core.readStatus();');
async function request(command, params = {}, expectedRevision) {
  return page('return api.runtime.sendMessage(clone(data));', { type: 'PCMS_UI_REQUEST', request: {
    v: 1, requestId: next('browser-client'), command, params, ...(expectedRevision === undefined ? {} : { expectedRevision })
  } }, { core: false });
}
async function openProbe() { probe = await h.openPage(PRODUCT, PAGE); return probe; }
async function wakeOnAlarm(label) {
  await waitFor(async () => (await h.extension(PRODUCT)).state === 'running', label, 30000);
  await openProbe(); return status();
}
function meta(index = 1) { return { owner: 'accounts', generation: 1, accountId: 'p201-account-' + index,
  personaUid: '20100000-0000-4000-8000-' + String(index).padStart(12, '0'), epoch: 1 }; }
function op(opId, binding, kind = 'persona.updateIdentity') { return { opId, kind, targetKey: binding.accountId, sourceRevision: 'persona-v1',
  accountBindingEpoch: binding.epoch, phase: 'PREPARED', startedAt: new Date().toISOString() }; }
async function seedPersona(index) {
  const binding = meta(index), operation = op(next('create'), binding, 'persona.create');
  return page(`
    const current=await core.storage.read('account',data.binding.accountId);
    if(!current.item) await core.storage.commit(clone({expectedRevision:current.revision,writes:[{kind:'account',expectedRevision:0,record:{
      accountId:data.binding.accountId,personaUid:data.binding.personaUid,epoch:1,name:'P201 synthetic account',sessionState:'UNKNOWN',revision:0,asOf:new Date().toISOString()
    }}]}));
    const revision=(await core.storage.list('operation')).revision;
    const applied=await core.operations.execute(compiled({operation:clone(data.operation),binding:clone(data.binding),expectedRevision:revision,
      dispatch:callable(authority=>authority.mutate('persona.create',clone({personaUid:data.binding.personaUid,name:'P201 disposable Persona'}))),
      readback:callable(async({read})=>{
        const observed=await read('persona.get',clone({personaUid:data.binding.personaUid}));
        if(observed.result.personaUid!==data.binding.personaUid||observed.result.health.routeId!=='__block__') throw new Error('Persona readback failed');
        return clone({phase:'APPLIED',evidence:{personaUid:observed.result.personaUid,routeId:observed.result.health.routeId}});
      })}));
    return {phase:applied.phase,personaUid:data.binding.personaUid};`, { binding, operation });
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'alpha-p201-packaged-'));
  if (!process.env.FIREFOX_BIN || !process.env.FIREFOX_INSTALL_MANIFEST) {
    // The ordinary governance job also discovers this mandatory file. Use the
    // same attested installer there, never skip the packaged scenarios.
    if (process.env.GITHUB_ACTIONS === 'true') {
      // The full governance suite runs P102 and P201 in parallel. P102 is the
      // sole host-package provisioner there; a second apt transaction races
      // its lock. Wait for P102's successful real-browser report rather than
      // checking dpkg aliases (Ubuntu t64 virtual names can differ). The
      // dedicated P201 packaged workflow already supplies the pinned runtime.
      await waitFor(async () => {
        try {
          const proof = JSON.parse(await readFile(resolve('.agent-runs/alpha-p102-firefox.json'), 'utf8'));
          return proof.passed === true && proof.providerLive === false && proof.workflowRun === process.env.GITHUB_RUN_ID;
        } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
      }, 'P102 real Firefox prerequisites completed without duplicate apt', 150000);
    }
    const installed = await execFileText(process.execPath, ['tools/alpha/firefox/install-pinned.mjs'],
      { cwd: REPO_ROOT, env: { ...process.env, FIREFOX_INSTALL_ROOT: join(root, 'runtime') }, timeout: 240000 });
    const info = JSON.parse(installed.stdout.trim().split('\n').at(-1));
    process.env.FIREFOX_BIN = info.firefoxBin; process.env.FIREFOX_INSTALL_MANIFEST = info.manifestPath;
  }
  report.browser = await verifyInstallation();
  report.commitSha = (await execFileText('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim();
  report.workflowRun = process.env.GITHUB_RUN_ID || null;
  await execFileText(process.execPath, ['scripts/build-extension.mjs'], { cwd: REPO_ROOT });
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'extension/manifest.json'), 'utf8'));
  const xpi = join(REPO_ROOT, `dist/persona-route-manager-v${manifest.version}.xpi`);
  report.productXpiSha256 = await sha256File(xpi);
  // The installed archive contains the exact production implementation and no
  // fixture/test hook. Parent-process inspection below stays in this harness.
  for (const path of ['alpha/core/core.mjs', 'alpha/core/control-store.mjs', 'alpha/core/ui.mjs', 'alpha/bootstrap/entry.mjs', 'alpha/bootstrap/host.mjs', 'lib/recovery-bootstrap.js']) {
    const archived = await execFileText('unzip', ['-p', xpi, path]);
    assert.equal(archived.stdout, await readFile(join(REPO_ROOT, 'extension', path), 'utf8'));
  }
  h = await IsolatedFirefox.create({ root: join(root, 'profiles'), allowedOrigins: [] });
  await h.start(); assert.equal(await h.install(xpi), PRODUCT); await openProbe();
  await waitFor(async () => { try { return (await status()).state === 'RUNNING'; } catch (error) {
    report.startupError = { code: error.code, message: error.message };
    if (error.code === 'HARNESS_FAILURE' && !error.message.includes('entry is absent')) throw error;
    return false;
  } }, 'production Alpha Core startup');
}, { timeout: 300000 });
after(async () => {
  if (!report.passed && h?.client) {
    try { report.failureDocument = await h.pageScript('return {url:location.href,title:document.title,text:document.body?.textContent?.slice(0,300)};'); } catch {}
    try { report.failureExtension = await h.extension(PRODUCT); } catch {}
    report.browserStderr = h.stderr?.slice(-2500);
  }
  await h?.dispose();
  await writeFile(resolve('.agent-runs/alpha-p201-packaged.json'), JSON.stringify(report, null, 2) + '\n');
  if (root) await rm(root, { recursive: true, force: true });
});

test('AP201-01 startup and sender/request authorization', async () => {
  const initial = await status(); assert.equal(initial.wake, 'COLD');
  assert.deepEqual(await page('return entry.host.diagnostics();'), { constructedCores: 1, activeCores: 1 });
  assert.equal((await request('accounts.list')).ok, true);
  const broker = await page(`const reply=await core.broker.read('system.describe');return {ok:reply.ok,bootId:reply.bootId,revision:reply.revision};`);
  assert.equal(broker.ok, true); assert.ok(broker.bootId);
  const bad = await request('module.execute'); assert.equal(bad.error.code, 'INVALID_REQUEST');
  const unknown = await request('deployer.apply', { opId: 'unimplemented', expectedRevision: initial.revision, accountBindingEpoch: 1 }, initial.revision);
  assert.equal(unknown.error.code, 'UNSUPPORTED_CAPABILITY');
  const original = probe, unauthorized = await h.openPage(PRODUCT, 'options/options.html');
  const denied = await h.pageScript(`const done=arguments[arguments.length-1];window.wrappedJSObject.browser.runtime.sendMessage(arguments[0]).then(done);`,
    [{ type: 'PCMS_UI_REQUEST', request: { v: 1, requestId: 'wrong-document', command: 'accounts.list', params: {} } }], { async: true });
  assert.equal(denied.error.code, 'INVALID_REQUEST'); await h.closePage(unauthorized);
  await h.client.command('WebDriver:SwitchToWindow', { handle: original }); probe = original;
  report.checks.startupAuthorizationAndPersonaMonkeyAuthority = true;
});
test('AP201-02 two clients one core', async () => {
  const first = probe, before = await status(), second = await h.openPage(PRODUCT, PAGE);
  assert.equal((await request('accounts.list')).ok, true); const other = await status();
  assert.equal(other.coreId, before.coreId); assert.equal(other.generation, before.generation);
  await h.client.command('WebDriver:SwitchToWindow', { handle: first });
  assert.equal((await request('inventory.list', { limit: 20 })).ok, true);
  const local = await page(`
    const rev=(await core.storage.list('account')).revision, at=new Date().toISOString();
    await core.storage.commit(clone({expectedRevision:rev,writes:[
      {kind:'account',expectedRevision:0,record:{accountId:data.accountId,personaUid:data.personaUid,epoch:1,name:'P201 synthetic account',sessionState:'UNKNOWN',revision:0,asOf:at}},
      {kind:'generator',expectedRevision:0,record:{key:'p201-local-intent',accountId:data.accountId,personaUid:data.personaUid,accountBindingEpoch:1,
        fleetIntent:'EXCLUDED',listingObserved:'UNKNOWN',deployState:'UNDEPLOYED',refreshState:'INELIGIBLE',sourceBinding:null,releaseId:null,revision:0,asOf:at,attentionRefs:[]}}
    ]}));
    return (await core.storage.read('generator','p201-local-intent'));`, meta(1));
  const intent = { key: 'p201-local-intent', accountId: meta(1).accountId, accountBindingEpoch: 1,
    expectedRevision: local.item.revision, opId: next('intent'), options: { fleetIntent: 'MANAGED' } };
  const changed = await request('inventory.setIntent', intent, local.revision); assert.equal(changed.ok, true);
  await h.client.command('WebDriver:SwitchToWindow', { handle: second });
  const stale = await request('inventory.setIntent', intent, local.revision); assert.equal(stale.error.code, 'STALE_REVISION');
  assert.equal((await status()).coreId, before.coreId); await h.closePage(second); probe = first;
  await h.client.command('WebDriver:SwitchToWindow', { handle: first });
  report.checks.twoClientsOneProductionCore = true;
});
test('AP201-02 idle unload and warm alarm wake', async () => {
  const before = await status();
  await page(`await core.timers.schedule(clone({id:'p201.warm',owner:'core',generation:1,dueAt:new Date(Date.now()+10000).toISOString(),intervalMs:null,mutating:false}));return true;`);
  await h.closePage(probe); probe = null;
  assert.equal(await h.client.script(`return [...gBrowser.tabs].filter(tab=>tab.linkedBrowser.currentURI.spec.includes('/alpha/ui/')).length;`), 0);
  report.unload = await h.forceIdleUnload(PRODUCT); assert.equal(report.unload.state, 'stopped');
  const warm = await wakeOnAlarm('durable Alpha alarm wakes an unloaded event page');
  assert.equal(warm.wake, 'WARM'); assert.ok(warm.generation > before.generation); assert.notEqual(warm.coreId, before.coreId);
  const timer = await page(`return (await core.timers.list()).find(t=>t.id==='p201.warm');`);
  assert.equal(timer.phase, 'COMPLETED'); assert.equal(timer.attempt, 1);
  report.checks.zeroClientTabsWarmAlarmWake = true;
});
test('AP201-02 cold browser restart', async () => {
  const before = await status();
  await page(`await core.timers.schedule(clone({id:'p201.cold',owner:'core',generation:1,dueAt:new Date(Date.now()+1000).toISOString(),intervalMs:null,mutating:false}));return true;`);
  await h.restart(); await openProbe(); const cold = await status();
  assert.equal(cold.wake, 'COLD'); assert.ok(cold.generation > before.generation);
  const timer = await waitFor(async () => { const row = await page(`return (await core.timers.list()).find(t=>t.id==='p201.cold');`); return row.phase === 'COMPLETED' && row; }, 'cold restart rehydrates durable timer');
  assert.equal(timer.attempt, 1); report.checks.packagedProfileColdRestart = true;
});
test('AP201-03 UNCERTAIN and RECOVERY_HOLD', async () => {
  assert.equal((await seedPersona(1)).phase, 'APPLIED');
  const binding = meta(1), operation = op(next('lost-readback'), binding);
  const lost = await page(`
    try {
      await core.operations.execute(compiled({operation:clone(data.operation),binding:clone(data.binding),expectedRevision:(await core.storage.list('operation')).revision,
        dispatch:callable(authority=>authority.mutate('persona.updateIdentity',clone({personaUid:data.binding.personaUid,changes:{name:'P201 remotely applied'}}))),
        readback:callable(async()=>{throw new Error('Injected lost readback');})}));
    } catch(error) { return {code:(error.wrappedJSObject||error).code,phase:(await core.storage.read('operation',data.operation.opId)).item.record.phase,status:await core.readStatus()}; }
    throw new Error('Expected uncertainty');`, { operation, binding });
  assert.equal(lost.code, 'UNCERTAIN'); assert.equal(lost.phase, 'UNCERTAIN'); assert.equal(lost.status.state, 'RECOVERY_HOLD');
  const blocked = await request('inventory.setIntent', { opId: 'blocked', expectedRevision: lost.status.revision, accountBindingEpoch: 1, accountId: binding.accountId, key: 'not-owned', options: { fleetIntent: 'MANAGED' } }, lost.status.revision);
  assert.equal(blocked.error.code, 'RECOVERY_HOLD');
  await h.restart(); await openProbe(); assert.equal((await status()).state, 'RECOVERY_HOLD');
  const reconciled = await page(`
    const observed=await core.broker.read('persona.get',clone({personaUid:data.binding.personaUid}));
    if(observed.result.name!=='P201 remotely applied') throw new Error('Actual PersonaMonkey mutation did not apply');
    const done=await core.operations.reconcile(compiled({opId:data.operation.opId,binding:data.binding,
      readback:callable(async({read})=>{const reply=await read('persona.get',clone({personaUid:data.binding.personaUid}));
        if(reply.result.name!=='P201 remotely applied') throw new Error('Authoritative readback changed');
        return clone({phase:'APPLIED',evidence:{personaUid:reply.result.personaUid,name:reply.result.name}});})}));
    return {phase:done.phase,state:(await core.readStatus()).state};`, { operation, binding });
  assert.equal(reconciled.phase, 'APPLIED'); assert.equal(reconciled.state, 'RUNNING');
  report.checks.realBrokerMutationLostReadbackRestartAndReconciliation = true;
});
test('AP201-03 bounded alarms and operation/tab budgets', async () => {
  const bounded = await page(`
    const dueAt=new Date().toISOString();
    for(let i=0;i<20;i++) await core.timers.schedule(clone({id:'p201.bounded.'+i,owner:'core',generation:1,dueAt,intervalMs:1000,mutating:false}));
    const pass=await core.timers.pass(), timers=await core.timers.list(), alarms=await api.alarms.getAll();
    return {pass,attempts:timers.filter(t=>t.id.startsWith('p201.bounded.')).map(t=>t.attempt),alarms:alarms.filter(a=>a.name.startsWith('alpha.')).map(a=>a.name)};`);
  assert.equal(bounded.pass.processed, 16); assert.equal(bounded.pass.remaining, 4);
  assert.equal(bounded.attempts.filter(n => n === 1).length, 16); assert.ok(bounded.attempts.every(n => n <= 1));
  assert.equal(bounded.alarms.length, 2);
  await page(`for(const timer of await core.timers.list()) if(timer.id.startsWith('p201.bounded.')) await core.timers.cancel(clone({id:timer.id,owner:'core',generation:1}));return true;`);
  await seedPersona(2); await seedPersona(3);
  const capacityOperations = [op(next('pending'), meta(1)), op(next('pending'), meta(2)), op(next('excess'), meta(3))];
  const capacity = await page(`
    const spawn=async(index)=>{
      const binding=clone(data.bindings[index]), operation=clone(data.operations[index]);
      const promise=core.operations.execute(compiled({operation,binding,expectedRevision:(await core.storage.list('operation')).revision,
        dispatch:callable(()=>new Promise(()=>{})),readback:callable(async()=>{throw new Error('not reached');})}));
      promise.catch(()=>{});
      for(let tries=0;tries<100;tries++) {const row=await core.storage.read('operation',operation.opId);if(row.item?.record.phase==='DISPATCHING')return;await new Promise(resolve=>setTimeout(resolve,5));}
      throw new Error('Dispatch was not durably prepared');
    };
    await spawn(0);await spawn(1);const before=await core.readStatus();let failure;
    try {await core.operations.execute(compiled({operation:clone(data.operations[2]),binding:clone(data.bindings[2]),expectedRevision:before.revision,dispatch:callable(async()=>{}),readback:callable(async()=>{})}));} catch(error){failure=(error.wrappedJSObject||error).code;}
    return {before,failure};`, { bindings: [meta(1), meta(2), meta(3)], operations: capacityOperations });
  assert.equal(capacity.before.budgets.operations, 2); assert.equal(capacity.failure, 'RATE_LIMIT');
  await waitFor(async () => (await status()).state === 'RECOVERY_HOLD', 'operation timeout enters recovery hold');
  // Recovery hold can begin on the first timeout; the second dispatch may still
  // be active. Wait for both exact identities to become durably UNCERTAIN
  // before doing read-only reconciliation, or a late timeout re-enters hold.
  await waitFor(async () => {
    const phases = await page(`return (await core.storage.list('operation')).items
      .filter(row => data.ids.includes(row.record.opId)).map(row => row.record.phase);`,
      { ids: capacityOperations.slice(0, 2).map(item => item.opId) });
    return phases.length === 2 && phases.every(phase => phase === 'UNCERTAIN');
  }, 'both timed-out operations reach durable uncertainty');
  await page(`
    for(const row of (await core.storage.list('operation')).items) if(row.record.phase==='UNCERTAIN'){
      const binding=clone(row.record.remoteEvidence.intent);
      // These dispatches never called mutate. Verify the actual Persona identity
      // through the broker before recording a negative disposition.
      const observed=await core.broker.read('persona.get',clone({personaUid:binding.personaUid}));
      await core.operations.reconcile(compiled({opId:row.record.opId,binding,
        readback:callable(async()=>clone({phase:'NOT_APPLIED',evidence:{personaUid:observed.result.personaUid,noDispatch:true}}))}));
    }return true;`);
  assert.equal((await status()).state, 'RUNNING', 'Read-only reconciliation must clear both durable holds');
  const tabs = await page(`
    const before=(await api.tabs.query(clone({}))).map(t=>t.id), permits=[];
    for(let i=0;i<4;i++){const permit=await core.tabs.reserve(clone({binding:data.binding,opId:'p201.tab.'+i,targetKey:data.binding.accountId}));permits.push(permit.wrappedJSObject||permit);}
    let failure;try{await core.tabs.reserve(clone({binding:data.binding,opId:'p201.tab.excess',targetKey:data.binding.accountId}));}catch(error){failure=(error.wrappedJSObject||error).code;}
    const permit=permits[0];
    const operation=clone({opId:permit.opId,kind:'persona.open',targetKey:data.binding.accountId,sourceRevision:'persona-v1',accountBindingEpoch:1,phase:'PREPARED',startedAt:new Date().toISOString()});
    const opened=await core.operations.execute(compiled({operation,binding:data.binding,expectedRevision:(await core.storage.list('operation')).revision,
      dispatch:callable(authority=>authority.mutate('persona.open',clone({personaUid:data.binding.personaUid,active:false}))),
      readback:callable(async({result,read})=>{const persona=await read('persona.get',clone({personaUid:data.binding.personaUid})),tab=await api.tabs.get(result.result.tabId);
        if(tab.cookieStoreId!==persona.result.cookieStoreId)throw new Error('Tab Persona readback failed');
        return clone({phase:'APPLIED',evidence:{personaUid:data.binding.personaUid,tabId:tab.id}});})}));
    const tabId=opened.remoteEvidence.observation.tabId;
    await core.tabs.attach(clone({permit,tabId}));let occupied;
    try{await core.tabs.release(clone({permit}));}catch(error){occupied=(error.wrappedJSObject||error).code;}
    for(const spare of permits.slice(1))await core.tabs.release(clone({permit:spare}));
    return {failure,occupied,allocated:permits.length,before,after:(await api.tabs.query(clone({}))).map(t=>t.id),permit,tabId,status:await core.readStatus()};`, { binding: meta(1) });
  assert.equal(tabs.failure, 'RATE_LIMIT'); assert.equal(tabs.occupied, 'RECOVERY_HOLD'); assert.equal(tabs.allocated, 4);
  assert.deepEqual(tabs.after.filter(id => id !== tabs.tabId), tabs.before); assert.equal(tabs.status.budgets.tabs, 1);
  assert.equal((await h.forceIdleUnload(PRODUCT)).state, 'stopped');
  const retained = await page(`const recovered=await core.tabs.reconcile(clone({permit:data.permit,binding:data.binding}));
    if(recovered.phase!=='ACTIVE')throw new Error('Owned tab did not survive warm wake');
    const permit=recovered.permit.wrappedJSObject||recovered.permit;
    if(await api.sessions.getTabValue(permit.tabId,'alphaOwnedPermit')!==permit.id)throw new Error('Owned tab tag changed');
    // Only this disposable, positively tagged test tab is closed by the harness.
    // Core itself never invokes tabs.remove.
    await api.tabs.remove(permit.tabId);await core.tabs.release(clone({permit}));
    return {after:(await api.tabs.query(clone({}))).map(t=>t.id),status:await core.readStatus()};`, { binding: meta(1), permit: tabs.permit });
  assert.ok(retained.status.generation > tabs.status.generation); assert.deepEqual(retained.after, tabs.before);
  assert.equal(retained.status.budgets.tabs, 0); assert.equal(retained.status.state, 'RUNNING');
  // Corrupt the actual control envelope in this disposable packaged profile;
  // startup must fail closed. No fault hook is shipped in the product.
  const journal = await page(`const db=await new Promise((resolve,reject)=>{const r=w.indexedDB.open('persona-monkey-pcms-alpha-core',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('Journal unavailable'));});
    let saved;await new Promise((resolve,reject)=>{const tx=db.transaction('control','readwrite',clone({durability:'strict'})),store=tx.objectStore('control'),r=store.get('state');
      r.onsuccess=()=>{saved=r.result;store.put(clone({state:saved.state,checksum:'0'.repeat(64)}),'state');};tx.oncomplete=resolve;tx.onabort=()=>reject(new Error('Fault injection aborted'));});
    db.close();return saved;`);
  assert.equal((await h.forceIdleUnload(PRODUCT)).state, 'stopped');
  assert.equal((await request('accounts.list')).error.code, 'RECOVERY_HOLD');
  await page(`const db=await new Promise((resolve,reject)=>{const r=w.indexedDB.open('persona-monkey-pcms-alpha-core',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('Journal unavailable'));});
    await new Promise((resolve,reject)=>{const tx=db.transaction('control','readwrite',clone({durability:'strict'}));tx.objectStore('control').put(clone(data),'state');tx.oncomplete=resolve;tx.onabort=()=>reject(new Error('Repair aborted'));});
    db.close();return true;`, journal, { core: false });
  assert.equal((await request('accounts.list')).ok, true); assert.equal((await status()).state, 'RUNNING');
  report.checks.boundedTimersOperationsAndTabPermitsNoOperatorTabClosure = true;
  report.passed = Object.values(report.checks).length === 6 && Object.values(report.checks).every(Boolean);
  assert.equal(report.passed, true);
});
