import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, META, operation, confirm } from './helpers.mjs';
import { createAlphaCore, NEXT_ALARM, HEARTBEAT_ALARM } from '../../../extension/alpha/core/core.mjs';
import { installAlphaBackground } from '../../../extension/alpha/bootstrap/entry.mjs';
import { authorizeSender, validateUiRequest, createUiDispatcher } from '../../../extension/alpha/core/ui.mjs';
import { AlphaDataError } from '../../../extension/alpha/domain/validation.js';

const rejected = code => error => error?.code === code;
test('AP201-01 duplicate entry evaluations install one host and one listener set', async () => {
  const listeners = [], event = { addListener(fn) { listeners.push(fn); } }, scope = {};
  let constructed = 0, wakes = 0;
  const browserRef = { runtime: { onMessage: event, onStartup: event, onInstalled: event }, alarms: { onAlarm: event } };
  const createHost = () => { constructed++; return { async wake() { wakes++; } }; };
  const a = installAlphaBackground({ browserRef, scope, createHost }), b = installAlphaBackground({ browserRef, scope, createHost });
  assert.equal(a, b); assert.equal(constructed, 1); assert.equal(listeners.length, 4);
  assert.equal(a.setPersonaMonkeyBootstrap(async () => {}), true); assert.equal(b.setPersonaMonkeyBootstrap(async () => {}), false);
  await Promise.resolve(); assert.equal(wakes, 1);
});
test('AP201-01 sender identity, origin, document and frame fail closed', () => {
  const runtime = { id: 'product', getURL: () => 'moz-extension://correct/' };
  const sender = { id: 'product', url: 'moz-extension://correct/alpha/ui/shell/index.html', frameId: 0 };
  assert.equal(authorizeSender(sender, runtime), true);
  for (const patch of [{ id: 'other' }, { url: 'https://example.test/alpha/ui/shell/index.html' }, { url: 'moz-extension://other/alpha/ui/shell/index.html' },
    { url: 'moz-extension://correct/pcms/app/index.html' }, { url: 'moz-extension://correct/alpha/core/probe.html' }, { frameId: 1 }, { origin: 'null' }])
    assert.equal(authorizeSender({ ...sender, ...patch }, runtime), false);
});
test('AP201-01 exact request fields, fixed commands, bounded data and mutations', () => {
  const base = { v: 1, requestId: 'query-1', command: 'accounts.list', params: {} };
  assert.equal(validateUiRequest(base).write, false);
  for (const patch of [{ v: 2 }, { command: 'module.execute' }, { command: '__proto__.list' }, { extra: true }, { params: { context: {} } }, { params: { limit: 201 } }, { requestId: 'x'.repeat(129) }])
    assert.throws(() => validateUiRequest({ ...base, ...patch }));
  let touched = false; const params = {}; Object.defineProperty(params, 'limit', { enumerable: true, get() { touched = true; return 10; } });
  assert.throws(() => validateUiRequest({ ...base, params })); assert.equal(touched, false);
  assert.throws(() => validateUiRequest({ ...base, command: 'inventory.setIntent', params: { expectedRevision: 0, accountBindingEpoch: 1, opId: 'op' } }));
});
test('AP201-02 warm rehydration increments generation; stale workers cannot dispatch', async () => {
  const f = await fixture(), before = await f.core.readStatus();
  const replacement = createAlphaCore(f.options); await replacement.initialize();
  const status = await replacement.readStatus(); assert.equal(status.wake, 'WARM'); assert.equal(status.generation, before.generation + 1);
  await assert.rejects(f.core.assertCurrent(), rejected('CONFLICT'));
  await assert.rejects(f.core.operations.execute({ operation: operation('stale'), binding: META, expectedRevision: 1, dispatch: async () => {}, readback: confirm }), rejected('CONFLICT'));
  assert.equal(f.sent.length, 0);
});
test('AP201-03 DISPATCHING is durable before broker side effect, with boot/revision preconditions', async () => {
  const f = await fixture();
  const done = await f.core.operations.execute({ operation: operation('durable'), binding: META, expectedRevision: 1,
    dispatch: async authority => {
      assert.equal((await f.storage.read('operation', 'durable')).item.record.phase, 'DISPATCHING');
      return authority.mutate('persona.updateIdentity', { personaUid: META.personaUid, changes: { name: 'Updated' } });
    }, readback: confirm });
  assert.equal(done.phase, 'APPLIED'); const wire = f.sent.find(x => x.operationId === 'durable');
  assert.deepEqual(wire.precondition, { bootId: 'broker-boot', revision: 1 }); assert.equal((await f.core.readStatus()).budgets.operations, 0);
});
test('AP201-03 lost readback becomes UNCERTAIN; retry blocked until genuine reconciliation', async () => {
  const f = await fixture();
  await assert.rejects(f.core.operations.execute({ operation: operation('lost'), binding: META, expectedRevision: 1,
    dispatch: authority => authority.mutate('persona.updateIdentity', { personaUid: META.personaUid, changes: { name: 'Updated' } }),
    readback: async () => { throw new Error('transport lost'); } }), rejected('UNCERTAIN'));
  assert.equal((await f.storage.read('operation', 'lost')).item.record.phase, 'UNCERTAIN'); assert.equal((await f.core.readStatus()).state, 'RECOVERY_HOLD');
  await assert.rejects(f.core.operations.execute({ operation: operation('retry'), binding: META, expectedRevision: 3, dispatch: async () => {}, readback: confirm }), rejected('RECOVERY_HOLD'));
  await assert.rejects(f.core.operations.reconcile({ opId: 'lost', binding: { ...META, owner: 'deployer' }, readback: confirm }), rejected('CONFLICT'));
  await f.core.operations.reconcile({ opId: 'lost', binding: META, readback: confirm }); assert.equal((await f.core.readStatus()).state, 'RUNNING');
  assert.equal(f.sent.filter(x => x.operationId).length, 1);
});
test('AP201-03 restart recovers interrupted dispatch without replay', async () => {
  const f = await fixture();
  const op = operation('interrupted');
  await f.storage.commit({ expectedRevision: 1, writes: [{ kind: 'operation', expectedRevision: 0, record: op }] });
  await f.storage.commit({ expectedRevision: 2, writes: [{ kind: 'operation', expectedRevision: 1, record: { ...op, phase: 'DISPATCHING' } }] });
  const replacement = createAlphaCore(f.options); await replacement.initialize();
  assert.equal((await f.storage.read('operation', op.opId)).item.record.phase, 'UNCERTAIN');
  assert.equal((await replacement.readStatus()).state, 'RECOVERY_HOLD'); assert.equal(f.sent.length, 0);
});
test('AP201-03 binding changes during dispatch reject completion and hold the operation', async () => {
  const f = await fixture();
  await assert.rejects(f.core.operations.execute({ operation: operation('binding-race'), binding: META, expectedRevision: 1,
    dispatch: async () => {
      const a = await f.storage.read('account', META.accountId);
      await f.storage.commit({ expectedRevision: a.revision, writes: [{ kind: 'account', expectedRevision: a.item.revision, record: { ...a.item.record, epoch: 2 } }] });
    }, readback: confirm }), rejected('STALE_BINDING'));
  assert.equal((await f.storage.read('operation', 'binding-race')).item.record.phase, 'UNCERTAIN');
});
test('AP201-03 dispatch timeout invalidates late authority and never replays', async () => {
  const f = await fixture({ limits: { handlerMs: 10 } }); let authority;
  await assert.rejects(f.core.operations.execute({ operation: operation('timeout'), binding: META, expectedRevision: 1,
    dispatch: context => { authority = context; return new Promise(() => {}); }, readback: confirm }), rejected('UNCERTAIN'));
  await assert.rejects(authority.mutate('persona.updateIdentity', { personaUid: META.personaUid, changes: { name: 'Late' } }), rejected('CONFLICT'));
  assert.equal(f.sent.length, 0);
});
test('AP201-03 coalesced periodic timers, bounded passes and fixed alarm names', async () => {
  const f = await fixture();
  for (let i = 0; i < 20; i++) await f.core.timers.schedule({ id: 'due-' + i, owner: 'core', generation: 1, dueAt: new Date(f.options.now()).toISOString(), intervalMs: 1000, mutating: false });
  f.advance(86400000); const pass = await f.core.timers.pass(); assert.equal(pass.processed, 16); assert.equal(pass.remaining, 5);
  assert.deepEqual([...f.alarmRows.keys()].sort(), [HEARTBEAT_ALARM, NEXT_ALARM].sort());
  const delivered = (await f.core.timers.list()).filter(t => t.id !== 'core.checkpoint' && t.attempt === 1);
  assert.ok(delivered.every(t => Date.parse(t.dueAt) > f.options.now()));
  await assert.rejects(f.core.timers.schedule({ id: 'foreign', owner: 'installable-module', generation: 1, dueAt: new Date(f.options.now()).toISOString(), intervalMs: null, mutating: false }), rejected('CONFLICT'));
});
test('AP201-03 failed mutation timer holds; heartbeat does not hot-loop held timers', async () => {
  const f = await fixture({ limits: { handlerMs: 10 }, timerHandlers: { deployer: { generation: 1, run: () => new Promise(() => {}) } } });
  await f.core.timers.schedule({ id: 'held-timer', owner: 'deployer', generation: 1, dueAt: new Date(f.options.now()).toISOString(), intervalMs: 1000, mutating: true });
  await f.core.timers.pass(); assert.equal((await f.core.readStatus()).state, 'RECOVERY_HOLD');
  const count = (await f.core.timers.list()).find(t => t.id === 'held-timer').attempt;
  await f.core.timers.pass(); assert.equal((await f.core.timers.list()).find(t => t.id === 'held-timer').attempt, count);
  assert.ok(f.alarmRows.get(NEXT_ALARM).when > f.options.now() + 1000);
  await f.core.timers.reconcile({ id: 'held-timer', owner: 'deployer', generation: 1, readback: confirm });
  assert.equal((await f.core.readStatus()).state, 'RUNNING');
});
test('AP201-03 global tab ceiling and owner fencing never close operator tabs', async () => {
  const f = await fixture(), permits = [];
  for (let i = 0; i < 4; i++) permits.push(await f.core.tabs.reserve({ binding: META, opId: 'tab-' + i, targetKey: META.accountId }));
  await assert.rejects(f.core.tabs.reserve({ binding: META, opId: 'excess', targetKey: META.accountId }), rejected('RATE_LIMIT'));
  await assert.rejects(f.core.tabs.release({ permit: { ...permits[0], owner: 'deployer' } }), rejected('CONFLICT'));
  await f.core.tabs.release({ permit: permits[0] }); assert.equal((await f.core.readStatus()).budgets.tabs, 3);
});
test('AP201-01 two UI clients share optimistic revision and sanitized failures', async () => {
  const f = await fixture(), runtime = { id: 'product', getURL: () => 'moz-extension://correct/' };
  const sender = { id: 'product', url: 'moz-extension://correct/alpha/ui/shell/index.html', frameId: 0 };
  let calls = 0;
  const ui = createUiDispatcher({ runtime, ensureCore: async () => f.core, services: { inventory: { async setIntent() {
    calls++; const r = await f.storage.read('account', META.accountId);
    await f.storage.commit({ expectedRevision: r.revision, writes: [{ kind: 'account', expectedRevision: r.item.revision, record: { ...r.item.record, name: 'Changed' } }] });
    return { ok: true, result: { changed: true }, revision: r.revision + 1 };
  } } } });
  const message = { type: 'PCMS_UI_REQUEST', request: { v: 1, requestId: 'client', command: 'inventory.setIntent', expectedRevision: 1, params: { expectedRevision: 1, accountBindingEpoch: 1, opId: 'ui-op' } } };
  const results = await Promise.all([ui.handle(message, sender), ui.handle(message, sender)]);
  assert.equal(results[0].ok, true); assert.equal(results[1].error.code, 'STALE_REVISION'); assert.equal(calls, 1);
});
test('AP201-03 storage failure before PREPARED prevents dispatch and releases reservations', async () => {
  const f = await fixture(); let invoked = false;
  await assert.rejects(f.core.operations.execute({ operation: operation('stale-cas'), binding: META, expectedRevision: 0,
    dispatch: async () => { invoked = true; }, readback: confirm }), rejected('STALE_REVISION'));
  assert.equal(invoked, false); assert.equal((await f.core.readStatus()).budgets.operations, 0);
  assert.equal((await f.storage.read('operation', 'stale-cas')).item, null);
});
test('AP201-03 unknown or differently owned provider targets cannot consume authority', async () => {
  const f = await fixture();
  await assert.rejects(f.core.operations.execute({ operation: operation('unknown-target', 'not-owned'), binding: META, expectedRevision: 1,
    dispatch: async () => {}, readback: confirm }), rejected('OWNERSHIP_UNKNOWN'));
  assert.equal(f.sent.length, 0);
});
test('AP201-03 failed DISPATCHING commit retains PREPARED identity and immediate recovery hold', async () => {
  const f = await fixture(), original = f.storage.commit; let failed = false;
  f.storage.commit = async input => {
    if (!failed && input.writes.some(w => w.record.phase === 'DISPATCHING')) { failed = true; throw new AlphaDataError('UNAVAILABLE'); }
    return original(input);
  };
  await assert.rejects(f.core.operations.execute({ operation: operation('prepare-failure'), binding: META, expectedRevision: 1,
    dispatch: async () => assert.fail('No dispatch after failed preparation'), readback: confirm }), rejected('UNAVAILABLE'));
  assert.equal((await f.storage.read('operation', 'prepare-failure')).item.record.phase, 'HELD');
  assert.equal((await f.core.readStatus()).state, 'RECOVERY_HOLD'); assert.equal(f.sent.length, 0);
  await f.core.operations.reconcile({ opId: 'prepare-failure', binding: META, readback: async () => ({ phase: 'NOT_APPLIED', evidence: { neverDispatched: true } }) });
  assert.equal((await f.core.readStatus()).state, 'RUNNING');
});
test('AP201-03 concurrent mutation callbacks consume one dispatch authority', async () => {
  const f = await fixture();
  await f.core.operations.execute({ operation: operation('single-dispatch'), binding: META, expectedRevision: 1,
    dispatch: async authority => {
      const results = await Promise.allSettled([1, 2].map(() => authority.mutate('persona.updateIdentity', { personaUid: META.personaUid, changes: { name: 'Once' } })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    }, readback: confirm });
  assert.equal(f.sent.filter(x => x.operationId).length, 1);
});
test('AP201-03 repeated tab reservation is idempotent; open cannot bypass the tab permit', async () => {
  const f = await fixture(), input = { binding: META, opId: 'one-permit', targetKey: META.accountId };
  const a = await f.core.tabs.reserve(input), b = await f.core.tabs.reserve(input);
  assert.equal(a.id, b.id); assert.equal((await f.core.readStatus()).budgets.tabs, 1);
  await assert.rejects(f.core.operations.execute({ operation: { ...operation('no-permit'), kind: 'persona.open' }, binding: META, expectedRevision: 1,
    dispatch: authority => authority.mutate('persona.open', { personaUid: META.personaUid }), readback: confirm }), rejected('UNCERTAIN'));
  assert.equal(f.sent.length, 0);
});
test('AP201-03 occupied tab permits survive wake; numeric tab reuse never transfers ownership', async () => {
  const live = new Map([[7, { id: 7, cookieStoreId: 'fixture-container', tag: undefined }], [8, { id: 8, cookieStoreId: 'operator-container', tag: undefined }]]);
  const tabs = { async tag(tabId, value) { live.get(tabId).tag = value; }, async inspect(tabId) { return live.get(tabId); },
    async findOwned(value) { return [...live.values()].filter(tab => tab.tag === value); },
    async isGone(_tabId, value) { return ![...live.values()].some(tab => tab.tag === value); } };
  const f = await fixture({ tabs }), request = f.options.broker.request;
  f.options.broker.request = async wire => ({ ...(await request(wire)), result: { cookieStoreId: 'fixture-container' } });
  const permit = await f.core.tabs.reserve({ binding: META, opId: 'owned-open', targetKey: META.accountId });
  await f.core.operations.execute({ operation: { ...operation('owned-open'), kind: 'persona.open' }, binding: META, expectedRevision: 1,
    dispatch: authority => authority.mutate('persona.open', { personaUid: META.personaUid }), readback: async () => ({ phase: 'APPLIED', evidence: { tabId: 7 } }) });
  await assert.rejects(f.core.tabs.attach({ permit, tabId: 8 }), rejected('CONFLICT'));
  await f.core.tabs.attach({ permit, tabId: 7 });
  await assert.rejects(f.core.tabs.release({ permit }), rejected('RECOVERY_HOLD'));
  const replacement = createAlphaCore(f.options); await replacement.initialize();
  const reconciled = await replacement.tabs.reconcile({ permit, binding: META });
  assert.equal(reconciled.phase, 'ACTIVE'); assert.equal(reconciled.permit.coreGeneration, (await replacement.readStatus()).generation);
  live.set(7, { id: 7, cookieStoreId: 'operator-container', tag: undefined });
  assert.equal((await replacement.tabs.reconcile({ permit: reconciled.permit, binding: META })).phase, 'RELEASED');
  assert.equal(live.size, 2); assert.equal((await replacement.readStatus()).budgets.tabs, 0);
});
