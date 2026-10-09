import { AlphaDataError, exact, id, revision, instant, safeDetails, requireData } from '../domain/validation.js';
import { normalizeOperation } from '../domain/records.js';
import { getPersonaBrokerCommand } from '../../pcms/core/persona-broker-contract.js';
import { LIMITS, OWNERS } from './control-store.mjs';

export const NEXT_ALARM = 'alpha.core.next';
export const HEARTBEAT_ALARM = 'alpha.core.heartbeat';
const OPEN = new Set(['PREPARED', 'DISPATCHING', 'UNCERTAIN', 'HELD']);
const check = (condition, code = 'INVALID_REQUEST') => requireData(condition, code);
const stamp = value => new Date(value).toISOString();
function owner(input) { check(OWNERS.includes(input.owner) && input.generation === 1, 'CONFLICT'); }
function evidence(input) {
  const r = exact(input, ['phase', 'evidence']);
  check(['APPLIED', 'NOT_APPLIED'].includes(r.phase), 'UNCERTAIN');
  const details = safeDetails(r.evidence); check(Object.keys(details).length > 0, 'UNCERTAIN');
  return { phase: r.phase, remoteEvidence: details };
}
async function bounded(task, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AlphaDataError('UNCERTAIN')), ms);
  })]); } finally { clearTimeout(timer); }
}

/** Background authority. Callbacks are compiled feature services, never UI
 * supplied code. Domain operations use P102; the control DB stores only leases,
 * timers and resource reservations. No browser execution engine lives here. */
export function createAlphaCore({ storage, control, broker, alarms, session, tabs = null,
  timerHandlers = {}, now = () => Date.now(), randomId = () => crypto.randomUUID(), limits = LIMITS } = {}) {
  check(storage && control && broker && alarms && session, 'UNAVAILABLE');
  const bounds = { ...LIMITS, ...limits };
  for (const k of Object.keys(LIMITS)) check(Number.isSafeInteger(bounds[k]) && bounds[k] > 0 && bounds[k] <= LIMITS[k]);
  let token = null, starting = null, closed = false, wake = null, serial = Promise.resolve(), passes = Promise.resolve();
  const locked = task => { const next = serial.then(task, task); serial = next.catch(() => {}); return next; };
  const when = () => stamp(now());
  async function fence() {
    check(!closed && token, 'UNAVAILABLE');
    const s = await control.read(); check(s.generation === token.generation && s.ownerId === token.ownerId, 'CONFLICT');
    return s;
  }
  const change = fn => { check(!closed && token, 'UNAVAILABLE'); return control.change(token, fn); };
  async function operations() { return (await storage.list('operation')).items; }
  async function hold() {
    const s = await fence(), rows = await operations();
    const unresolved = rows.filter(({ record: op }) => op.phase === 'PREPARED' || op.phase === 'UNCERTAIN' || op.phase === 'HELD' ||
      (op.phase === 'DISPATCHING' && !s.slots.some(t => t.kind === 'operation' && t.opId === op.opId && t.phase === 'ACTIVE' && t.coreGeneration === token.generation)));
    return { state: s.recoveryReason || unresolved.length ? 'RECOVERY_HOLD' : 'RUNNING', unresolved: unresolved.map(x => x.record.opId) };
  }
  async function mutable() { check((await hold()).state === 'RUNNING', 'RECOVERY_HOLD'); }
  async function binding(meta) {
    owner(meta); id(meta.accountId); id(meta.personaUid); revision(meta.epoch, 1);
    const a = (await storage.read('account', meta.accountId)).item?.record;
    check(a && a.personaUid === meta.personaUid && a.epoch === meta.epoch, 'STALE_BINDING');
    return a;
  }
  async function move(opId, phase, remoteEvidence) {
    await fence(); const row = await storage.read('operation', opId); check(row.item, 'RECOVERY_HOLD');
    const result = await storage.commit({ expectedRevision: row.revision, writes: [{ kind: 'operation', expectedRevision: row.item.revision,
      record: { ...row.item.record, phase, ...(remoteEvidence ? { remoteEvidence: {
        ...(row.item.record.remoteEvidence?.intent ? { intent: row.item.record.remoteEvidence.intent } : {}), observation: remoteEvidence
      } } : {}) } }] });
    await fence(); return result.items[0].record;
  }
  async function arm() {
    const s = await fence(), recovery = await hold(), pending = s.timers.filter(t => t.phase === 'SCHEDULED' &&
      !(t.mutating && recovery.state === 'RECOVERY_HOLD'));
    await Promise.resolve(alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 5 }));
    if (pending.length) {
      const earliest = Math.min(...pending.map(t => Date.parse(t.dueAt)));
      await Promise.resolve(alarms.create(NEXT_ALARM, { when: Math.max(now() + bounds.continuationMs, earliest) }));
    } else await alarms.clear(NEXT_ALARM);
  }
  async function publish() {
    const status = await readStatus(); await session.set({ alphaCoreStatus: status }); return status;
  }
  async function initialize() {
    if (starting) return starting;
    starting = locked(async () => {
      await storage.open(); await storage.snapshot();
      const marker = (await session.get('alphaCoreSession')).alphaCoreSession;
      wake = marker?.version === 1 && typeof marker.browserRun === 'string' ? 'WARM' : 'COLD';
      const state = await control.change(null, s => {
        s.generation++; s.ownerId = randomId();
        for (const slot of s.slots) slot.phase = 'HELD';
        for (const t of s.timers) if (t.phase === 'RUNNING') {
          t.phase = t.mutating ? 'HELD' : 'MISSED';
          if (t.mutating) s.recoveryReason = 'INTERRUPTED_TIMER';
          else if (t.intervalMs !== null) { t.phase = 'SCHEDULED'; t.dueAt = stamp(now() + t.intervalMs); }
        }
      });
      token = { generation: state.generation, ownerId: state.ownerId };
      // No side effects are replayed. PREPARED has not crossed dispatch, but a
      // suspended feature must explicitly reconcile/cancel it before reuse.
      for (const row of await operations()) {
        if (row.record.phase === 'DISPATCHING') await move(row.record.opId, 'UNCERTAIN');
        else if (row.record.phase === 'PREPARED') await move(row.record.opId, 'HELD');
      }
      await change(s => { s.slots = s.slots.filter(t => t.kind !== 'operation'); });
      await session.set({ alphaCoreSession: { version: 1, browserRun: wake === 'WARM' ? marker.browserRun : randomId() } });
      const existing = (await fence()).timers.find(t => t.id === 'core.checkpoint');
      if (!existing) await putTimer({ id: 'core.checkpoint', owner: 'core', generation: 1, dueAt: stamp(now() + 300000), intervalMs: 300000, mutating: false });
      await arm();
    }).then(async () => { await pass(); await publish(); return api; }).catch(error => { starting = null; throw error; });
    return starting;
  }
  async function putTimer(input) {
    const t = exact(input, ['id', 'owner', 'generation', 'dueAt', 'intervalMs', 'mutating']);
    owner(t); id(t.id); instant(t.dueAt);
    check(typeof t.mutating === 'boolean' && (t.intervalMs === null || (Number.isSafeInteger(t.intervalMs) && t.intervalMs >= 1000)));
    check(t.owner !== 'core' || t.mutating === false);
    check(t.owner === 'core' || (timerHandlers[t.owner]?.generation === t.generation && typeof timerHandlers[t.owner]?.run === 'function'), 'UNSUPPORTED_CAPABILITY');
    await change(s => {
      const old = s.timers.find(x => x.id === t.id);
      check(!old || (old.owner === t.owner && old.generation === t.generation && old.phase !== 'RUNNING' && old.phase !== 'HELD'), 'CONFLICT');
      check(old || s.timers.length < bounds.timers, 'RATE_LIMIT');
      s.timers = s.timers.filter(x => x.id !== t.id);
      s.timers.push({ ...t, phase: 'SCHEDULED', attempt: old?.attempt || 0, completedAt: null, receipt: null });
    });
  }
  function pass() {
    const run = async () => {
      await fence(); const started = Date.now(); let processed = 0;
      const due = (await fence()).timers.filter(t => t.phase === 'SCHEDULED' && Date.parse(t.dueAt) <= now())
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
      for (const t of due) {
        if (processed >= bounds.pass || Date.now() - started >= bounds.passMs) break;
        if (t.mutating && (await hold()).state === 'RECOVERY_HOLD') continue;
        await locked(() => change(s => { const row = s.timers.find(x => x.id === t.id); check(row?.phase === 'SCHEDULED', 'CONFLICT'); row.phase = 'RUNNING'; row.attempt++; }));
        const timerFence = async () => {
          const row = (await fence()).timers.find(x => x.id === t.id);
          check(row?.phase === 'RUNNING' && row.attempt === t.attempt + 1, 'CONFLICT');
        };
        let completed = false;
        try {
          if (t.owner !== 'core') await bounded(() => timerHandlers[t.owner].run({ timer: structuredClone(t), assertCurrent: timerFence }), bounds.handlerMs);
          await timerFence(); completed = true;
        } catch { /* a bounded failure becomes a durable hold/missed receipt */ }
        await locked(() => change(s => {
          const row = s.timers.find(x => x.id === t.id); row.completedAt = when();
          row.phase = completed ? 'COMPLETED' : t.mutating ? 'HELD' : 'MISSED';
          if (!completed && t.mutating) s.recoveryReason = 'INTERRUPTED_TIMER';
          if (completed && t.intervalMs !== null) {
            // Coalesce every missed interval into one pass, never replay a backlog.
            row.dueAt = stamp(Date.parse(t.dueAt) + (Math.floor(Math.max(0, now() - Date.parse(t.dueAt)) / t.intervalMs) + 1) * t.intervalMs);
            row.phase = 'SCHEDULED';
          }
        }));
        processed++;
      }
      await locked(() => change(s => { s.lastPassAt = when(); s.passCount++; }));
      await arm(); await publish(); return { processed, remaining: (await fence()).timers.filter(t => t.phase === 'SCHEDULED' && Date.parse(t.dueAt) <= now()).length };
    };
    const next = passes.then(run, run); passes = next.catch(() => {}); return next;
  }
  async function reserve(meta, kind, opId, targetKey) {
    await binding(meta); await mutable(); id(opId); id(targetKey);
    const previous = (await fence()).slots.find(t => t.kind === kind && t.opId === opId);
    if (previous) {
      check(['owner', 'generation', 'accountId', 'personaUid', 'epoch'].every(k => previous[k] === meta[k]) && previous.targetKey === targetKey, 'CONFLICT');
      await assertSlot(previous); return previous;
    }
    const slot = { id: randomId(), owner: meta.owner, generation: meta.generation, accountId: meta.accountId, personaUid: meta.personaUid, epoch: meta.epoch,
      coreGeneration: token.generation, kind, opId, targetKey, tabId: null, phase: 'RESERVED' };
    await change(s => {
      check(s.slots.length < bounds.pending && s.slots.filter(t => t.kind === kind).length < bounds[kind === 'tab' ? 'tabs' : 'operations'], 'RATE_LIMIT');
      s.slots.push(slot);
    }); return slot;
  }
  async function assertSlot(slot, allowHold = false) {
    const state = await fence(), current = state.slots.find(x => x.id === slot.id);
    check(current && current.coreGeneration === token.generation && current.owner === slot.owner && current.generation === slot.generation &&
      current.phase !== 'HELD', 'CONFLICT');
    await binding(current); if (!allowHold) await mutable(); return current;
  }
  async function execute({ operation, binding: meta, expectedRevision, dispatch, readback }) {
    const op = normalizeOperation(operation); check(op.phase === 'PREPARED' && !Object.hasOwn(op, 'remoteEvidence') && !Object.hasOwn(op, 'result') && typeof dispatch === 'function' && typeof readback === 'function');
    check(op.accountBindingEpoch === meta.epoch, 'STALE_BINDING'); revision(expectedRevision);
    let slot;
    await locked(async () => {
      await fence(); await mutable(); await binding(meta);
      if (op.targetKey !== meta.accountId) {
        const target = (await storage.read('generator', op.targetKey)).item?.record;
        check(target && target.accountId === meta.accountId && target.personaUid === meta.personaUid && target.accountBindingEpoch === meta.epoch, 'OWNERSHIP_UNKNOWN');
        if (typeof op.sourceRevision === 'number') check(target.revision === op.sourceRevision, 'STALE_REVISION');
      }
      const rows = await operations(); check(rows.length < bounds.ledger, 'RATE_LIMIT');
      check(!rows.some(x => x.record.opId === op.opId || (x.record.targetKey === op.targetKey && OPEN.has(x.record.phase))), 'CONFLICT');
      slot = await reserve(meta, 'operation', op.opId, op.targetKey);
      try {
        await storage.commit({ expectedRevision, writes: [{ kind: 'operation', expectedRevision: 0,
          record: { ...op, remoteEvidence: { intent: { ...meta, coreGeneration: token.generation } } } }] });
        await move(op.opId, 'DISPATCHING');
        await change(s => { s.slots.find(x => x.id === slot.id).phase = 'ACTIVE'; });
      } catch (error) {
        const persisted = (await storage.read('operation', op.opId)).item?.record;
        if (persisted) {
          // A failed dispatch transition must retain its identity and fence all
          // new mutations immediately, even if the journal is still PREPARED.
          if (persisted.phase === 'PREPARED') { try { await move(op.opId, 'HELD'); } catch {} }
          await change(s => { const held = s.slots.find(x => x.id === slot.id); if (held) held.phase = 'HELD'; });
        } else await change(s => { s.slots = s.slots.filter(x => x.id !== slot.id); });
        await publish(); throw error;
      }
    });
    let sent = false;
    const authority = Object.freeze({
      assertCurrent: () => assertSlot(slot),
      read: readBroker,
      async mutate(command, params) {
        check(!sent && getPersonaBrokerCommand(command) && (getPersonaBrokerCommand(command).mutating || getPersonaBrokerCommand(command).sideEffecting));
        check(!getPersonaBrokerCommand(op.kind) || op.kind === command);
        check(params?.personaUid === meta.personaUid, 'STALE_BINDING');
        if (command === 'persona.open') {
          const allocated = (await fence()).slots.find(t => t.kind === 'tab' && t.opId === op.opId && t.targetKey === op.targetKey &&
            t.owner === meta.owner && t.generation === meta.generation && t.personaUid === meta.personaUid && t.phase === 'RESERVED');
          check(allocated && allocated.coreGeneration === token.generation, 'RATE_LIMIT');
        }
        await assertSlot(slot); const described = await readBroker('system.describe', {});
        await locked(async () => { await assertSlot(slot); check(!sent, 'CONFLICT'); sent = true; });
        return broker.request({ version: 1, requestId: randomId(), command, params, operationId: op.opId,
          precondition: { bootId: described.bootId, revision: described.revision } });
      }
    });
    try {
      const result = await bounded(() => dispatch(authority), bounds.handlerMs);
      const observed = evidence(await bounded(() => readback({ read: readBroker, result, operation: op }), bounds.handlerMs));
      return await locked(async () => {
        await assertSlot(slot); const done = await move(op.opId, observed.phase, observed.remoteEvidence);
        await change(s => { s.slots = s.slots.filter(x => x.id !== slot.id); }); await publish(); return done;
      });
    } catch (error) {
      await locked(async () => {
        try {
          await fence(); const current = (await storage.read('operation', op.opId)).item?.record;
          if (current?.phase === 'DISPATCHING') await move(op.opId, 'UNCERTAIN');
          await change(s => { const current = s.slots.find(x => x.id === slot.id); if (current) current.phase = 'HELD'; }); await publish();
        } catch { /* DISPATCHING and its durable slot already forbid replay */ }
      });
      throw new AlphaDataError(error?.code === 'STALE_BINDING' ? 'STALE_BINDING' : 'UNCERTAIN');
    }
  }
  async function reconcile({ opId, binding: meta, readback }) {
    id(opId); check(typeof readback === 'function'); await fence(); await binding(meta);
    const row = await storage.read('operation', opId); check(row.item && ['UNCERTAIN', 'HELD'].includes(row.item.record.phase), 'CONFLICT');
    check(row.item.record.accountBindingEpoch === meta.epoch, 'STALE_BINDING');
    const intent = row.item.record.remoteEvidence?.intent;
    check(intent && ['owner', 'generation', 'accountId', 'personaUid', 'epoch'].every(k => intent[k] === meta[k]), 'CONFLICT');
    const observed = evidence(await bounded(() => readback({ read: readBroker, operation: row.item.record }), bounds.handlerMs));
    return locked(async () => {
      await fence(); await binding(meta); const done = await move(opId, observed.phase, observed.remoteEvidence);
      await change(s => { s.slots = s.slots.filter(x => !(x.kind === 'operation' && x.opId === opId)); }); await publish(); return done;
    });
  }
  async function readBroker(command, params = {}) {
    const descriptor = getPersonaBrokerCommand(command);
    check(descriptor && !descriptor.mutating && !descriptor.sideEffecting, 'INVALID_REQUEST');
    await fence(); const response = await broker.request({ version: 1, requestId: randomId(), command, params });
    check(response?.ok === true, 'UNAVAILABLE'); await fence(); return response;
  }
  async function readStatus() {
    const s = await fence(), recovery = await hold(), domain = await storage.list('operation');
    return { version: 1, coreId: token.ownerId, generation: token.generation, wake, ...recovery, revision: domain.revision,
      controlRevision: s.revision, passCount: s.passCount, lastPassAt: s.lastPassAt, asOf: when(),
      budgets: { operations: s.slots.filter(t => t.kind === 'operation').length, tabs: s.slots.filter(t => t.kind === 'tab').length,
        operationLimit: bounds.operations, tabLimit: bounds.tabs } };
  }
  const api = Object.freeze({
    initialize, readStatus, storage,
    assertMutationAllowed: mutable, assertCurrent: fence, publish,
    broker: Object.freeze({ read: readBroker }),
    operations: Object.freeze({ execute, reconcile }),
    timers: Object.freeze({
      schedule: input => locked(async () => { await putTimer(input); await arm(); }),
      async list() { return structuredClone((await fence()).timers); },
      pass,
      reconcile: async ({ id: timerId, owner: timerOwner, generation, readback }) => {
        owner({ owner: timerOwner, generation }); id(timerId); check(typeof readback === 'function'); await fence();
        const row = (await fence()).timers.find(t => t.id === timerId);
        check(row?.phase === 'HELD' && row.owner === timerOwner && row.generation === generation, 'CONFLICT');
        const observed = evidence(await bounded(readback, bounds.handlerMs));
        return locked(async () => {
          await change(s => {
            const t = s.timers.find(x => x.id === timerId); check(t?.phase === 'HELD', 'CONFLICT');
            t.phase = observed.phase === 'APPLIED' ? 'COMPLETED' : 'MISSED'; t.completedAt = when();
            t.receipt = observed;
            if (t.intervalMs !== null) { t.phase = 'SCHEDULED'; t.dueAt = stamp(now() + t.intervalMs); }
            if (s.recoveryReason === 'INTERRUPTED_TIMER' && !s.timers.some(x => x.phase === 'HELD')) s.recoveryReason = null;
          }); await arm(); await publish(); return { reconciled: timerId };
        });
      },
      cancel: input => locked(async () => { owner(input); id(input.id); await change(s => {
        const row = s.timers.find(x => x.id === input.id); check(row && row.owner === input.owner && row.generation === input.generation && !['RUNNING', 'HELD'].includes(row.phase), 'CONFLICT');
        s.timers = s.timers.filter(x => x.id !== input.id);
      }); await arm(); })
    }),
    tabs: Object.freeze({
      reserve: ({ binding: meta, opId, targetKey }) => locked(() => reserve(meta, 'tab', opId, targetKey)),
      attach: ({ permit, tabId }) => locked(async () => {
        await assertSlot(permit); check(Number.isSafeInteger(tabId) && tabId >= 0);
        const op = (await storage.read('operation', permit.opId)).item?.record;
        check(op?.phase === 'APPLIED' && op.kind === 'persona.open' && op.targetKey === permit.targetKey &&
          op.remoteEvidence?.observation?.tabId === tabId && op.remoteEvidence?.intent?.personaUid === permit.personaUid, 'CONFLICT');
        check(tabs && typeof tabs.tag === 'function' && typeof tabs.inspect === 'function', 'UNAVAILABLE');
        const persona = await readBroker('persona.get', { personaUid: permit.personaUid });
        const observed = await tabs.inspect(tabId);
        check(typeof persona.result.cookieStoreId === 'string' && observed && observed.cookieStoreId === persona.result.cookieStoreId &&
          (observed.tag === undefined || observed.tag === permit.id), 'OWNERSHIP_UNKNOWN');
        // The caller obtains this tab from the Persona Broker, never tabs.create.
        await tabs.tag(tabId, permit.id);
        await change(s => { const slot = s.slots.find(x => x.id === permit.id); slot.tabId = tabId; slot.phase = 'ACTIVE'; });
      }),
      reconcile: ({ permit, binding: meta }) => locked(async () => {
        await fence(); await binding(meta);
        const slot = (await fence()).slots.find(x => x.kind === 'tab' && x.id === permit.id);
        check(slot && ['owner', 'generation', 'accountId', 'personaUid', 'epoch'].every(k => slot[k] === meta[k]), 'CONFLICT');
        const op = (await storage.read('operation', slot.opId)).item?.record;
        check(op?.kind === 'persona.open' && op.phase === 'APPLIED' && op.remoteEvidence?.intent?.personaUid === slot.personaUid, 'RECOVERY_HOLD');
        check(tabs && typeof tabs.findOwned === 'function', 'UNAVAILABLE');
        const matches = await tabs.findOwned(slot.id);
        check(matches.length <= 1, 'OWNERSHIP_UNKNOWN');
        if (matches.length === 0) {
          // A previously tagged tab is now absent. Unknown untagged dispatches
          // cannot use a missing numeric tab ID as proof of non-application.
          check(slot.tabId !== null, 'OWNERSHIP_UNKNOWN');
          await change(s => { s.slots = s.slots.filter(x => x.id !== slot.id); }); return { phase: 'RELEASED' };
        }
        const persona = await readBroker('persona.get', { personaUid: slot.personaUid });
        check(typeof persona.result.cookieStoreId === 'string' && matches[0].cookieStoreId === persona.result.cookieStoreId, 'OWNERSHIP_UNKNOWN');
        const changed = await change(s => { const row = s.slots.find(x => x.id === slot.id); row.tabId = matches[0].id; row.coreGeneration = token.generation; row.phase = 'ACTIVE'; });
        return { phase: 'ACTIVE', permit: changed.slots.find(x => x.id === slot.id) };
      }),
      release: ({ permit }) => locked(async () => {
        await fence(); const slot = (await fence()).slots.find(x => x.id === permit.id);
        check(slot && slot.owner === permit.owner && slot.generation === permit.generation, 'CONFLICT');
        // No tab is closed here. Occupied/unknown tabs retain their allocation.
        const op = (await storage.read('operation', slot.opId)).item?.record;
        const undispatched = !op || ['NOT_APPLIED', 'FAILED'].includes(op.phase);
        check(undispatched || (slot.tabId !== null && !OPEN.has(op.phase) && tabs && await tabs.isGone(slot.tabId, slot.id)), 'RECOVERY_HOLD');
        await change(s => { s.slots = s.slots.filter(x => x.id !== slot.id); });
      })
    }),
    async handleAlarm(alarm) { if (![NEXT_ALARM, HEARTBEAT_ALARM].includes(alarm?.name)) return { ignored: true }; const wasStarted = Boolean(starting); await initialize(); return wasStarted ? pass() : { started: true }; },
    close() { closed = true; storage.close(); control.close(); broker.close?.(); }
  });
  return api;
}
