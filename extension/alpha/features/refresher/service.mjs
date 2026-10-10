/** P304 background-only Refresher policy engine. No Perchance mutation or browser calls.
 * P403 must provide observed health, durable Core wakeups and execution fencing. */
import { DEFAULT_CONFIG, HEALTH, assertState, active, capacity, check,
  eligible, integer, reconcile, sleeping, timestamp,
  validateConfig } from './model.mjs';
import { createRefresherStore } from './store.mjs';

const knownErrors = new Set(['INVALID_REQUEST', 'STALE_REVISION', 'STALE_BINDING',
  'RECOVERY_HOLD', 'UNAVAILABLE', 'CONFLICT']);
const error = (e, revision) => { const code = knownErrors.has(e?.code || e?.message) ? e.code || e.message : 'UNAVAILABLE';
  return { ok: false, error: { code, message: code, retryable: false }, revision }; };
const ok = (result, revision) => ({ ok: true, result, revision });
const validKey = key => typeof key === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(key);

export function createRefresherService({ storage, ledger = createRefresherStore(),
  clock = () => Date.now(), random = Math.random,
  maxHealthyGapMs = 15 * 60_000 } = {}) {
  check(storage && typeof storage.list === 'function' && typeof storage.read === 'function' &&
    ledger && typeof ledger.read === 'function' && typeof ledger.transact === 'function' &&
    typeof clock === 'function' && typeof random === 'function' && integer(maxHealthyGapMs) && maxHealthyGapMs > 0);
  let lastRevision = 0;
  const run = async fn => { try { return await fn(); } catch (e) { return error(e, lastRevision); } };
  const time = () => timestamp(clock());
  const snapshot = async () => { const s = assertState(await ledger.read()); lastRevision = s.revision; return s; };
  const change = async (expectedRevision, fn) => {
    const r = await ledger.transact(expectedRevision, fn); lastRevision = r.revision; return r;
  };
  function ensureOpts(params) { check(params && typeof params === 'object' && !Array.isArray(params)); }
  function checkVersion(v) { check(integer(v)); }
  async function generators() {
    const listed = await storage.list('generator');
    check(integer(listed.revision) && Array.isArray(listed.items), 'RECOVERY_HOLD');
    const rows = listed.items.map(i => i.record);
    check(rows.every(r => validKey(r.key)) && new Set(rows.map(r => r.key)).size === rows.length, 'RECOVERY_HOLD');
    return { rows, inventoryRevision: listed.revision };
  }
  const validSet = params => {
    ensureOpts(params); check(validKey(params.key)); checkVersion(params.expectedRevision);
    check(['PULL_IN', 'PULL_OUT'].includes(params.options?.action));
  };
  async function status(params = {}) { return run(async () => {
    ensureOpts(params);
    check(params.limit === undefined || (integer(params.limit) && params.limit > 0 && params.limit <= 250));
    check(params.accountId === undefined || (typeof params.accountId === 'string' && params.accountId.length > 0));
    const state = await snapshot(), { rows, inventoryRevision } = await generators();
    const filtered = rows.filter(r => params.accountId === undefined || r.accountId === params.accountId)
      .sort((a,b) => a.key.localeCompare(b.key));
    const cursor = params.cursor === undefined ? null : /^r([0-9]+):([0-9]+):([0-9]+)$/.exec(params.cursor);
    check(params.cursor === undefined || (cursor && Number(cursor[1]) === state.revision &&
      Number(cursor[2]) === inventoryRevision), 'STALE_REVISION');
    const offset = cursor ? Number(cursor[3]) : 0;
    check(integer(offset), 'INVALID_REQUEST');
    const size = params.limit ?? 100;
    const items = filtered.slice(offset, offset + size).map(r => ({ ...r,
      refreshState: state.schedules[r.key]?.phase ?? 'INELIGIBLE' }));
    return ok({ items, cursor: offset + size < filtered.length ? `r${state.revision}:${inventoryRevision}:${offset + size}` : null,
      asOf: new Date(time()).toISOString() }, state.revision);
  }); }
  async function configure(params) { return run(async () => {
    ensureOpts(params); checkVersion(params.expectedRevision);
    const changes = params.options; check(changes && typeof changes === 'object' && !Array.isArray(changes));
    check(Object.keys(changes).length > 0 && Object.keys(changes).every(k => Object.hasOwn(DEFAULT_CONFIG,k)));
    const r = await change(params.expectedRevision, s => {
      const next = { ...s.config, ...changes };
      if (next.manualCap === 0) next.manualCap = null;
      validateConfig(next);
      const eligibleCount = Object.values(s.schedules).filter(x => x.phase !== 'INELIGIBLE').length;
      const cap = capacity(next, eligibleCount);
      check(next.manualCap === null || (next.observedCapacity !== null &&
        next.manualCap <= Math.floor(next.observedCapacity / (1 + next.margin))));
      s.config = next;
      return { activeHours: next.activeHours, sleepHours: next.sleepHours, margin: next.margin,
        targetCap: cap.cap, automaticCap: cap.automaticCap, observedCapacity: next.observedCapacity ?? 0,
        ...(next.manualCap === null ? {} : { manualCap: next.manualCap }) }; 
    });
    return ok(r.result, r.revision);
  }); }
  async function setEligibility(params) { return run(async () => {
    validSet(params); const row = (await storage.read('generator', params.key)).item?.record;
    check(row && validKey(row.key), 'STALE_BINDING');
    check(row.accountBindingEpoch === params.accountBindingEpoch &&
      row.personaUid === params.personaUid && row.accountId === params.accountId, 'STALE_BINDING');
    const at = time();
    const r = await change(params.expectedRevision, s => {
      const current = reconcile(Object.hasOwn(s.schedules, params.key) ? s.schedules[params.key] : null, row, at, s.config, random);
      const manualOut = params.options.action === 'PULL_OUT';
      let next = current;
      if (manualOut && current.phase === 'ACTIVE') next = sleeping(current, at, s.config, random);
      if (manualOut && current.phase === 'SLEEPING') next = { ...current, manualOut: true };
      next = { ...next, manualOut };
      s.schedules[params.key] = next;
      return next;
    });
    return ok({ ...row, refreshState: r.result.phase }, r.revision);
  }); }
  /** Caller must supply a real browser-run token; WARM event-page wake retains it.
   * OUTAGE requires observation evidence; absence/unknown cannot accrue time. */
  async function checkpoint({ at = clock(), state, runId, evidenceRefs = [] } = {}) { return run(async () => {
    const now = timestamp(at);
    check(HEALTH.includes(state) && typeof runId === 'string' && runId.length > 0 && runId.length <= 256);
    check(Array.isArray(evidenceRefs) && evidenceRefs.length <= 32 &&
      evidenceRefs.every(x => typeof x === 'string' && x.length > 0 && x.length <= 256));
    check(state !== 'OUTAGE' || evidenceRefs.length > 0);
    const r = await change(null, s => {
      const previous = s.health;
      check(previous.checkpointAt === null || now >= previous.checkpointAt, 'RECOVERY_HOLD');
      const gap = previous.checkpointAt === null ? 0 : now - previous.checkpointAt;
      // A new browserRun means a cold start: never accrue across shutdown.
      // A WARM wake with the same runId is not itself a pause.
      const advance = previous.state === 'HEALTHY' && state === 'HEALTHY' &&
        previous.runId === runId ? Math.min(gap, maxHealthyGapMs) : 0;
      if (advance) for (const row of Object.values(s.schedules)) if (row.phase === 'ACTIVE')
        row.activeHealthyMs += advance;
      s.health = { checkpointAt: now, state, runId, evidenceRefs: [...evidenceRefs] };
      return { creditedMs: advance, state, checkpointAt: now };
    });
    return ok(r.result, r.revision);
  }); }
  async function planPass(params = {}) { return run(async () => {
    ensureOpts(params);
    const { rows } = await generators(), now = time();
    const r = await change(null, state => {
      const seen = new Set(), candidates = [], activeRows = [];
      for (const generator of rows) {
        seen.add(generator.key);
        const entry = reconcile(Object.hasOwn(state.schedules, generator.key) ? state.schedules[generator.key] : null, generator, now, state.config, random);
        state.schedules[generator.key] = entry;
        if (!eligible(generator)) continue;
        if (entry.phase === 'ACTIVE') activeRows.push(entry);
        else if (entry.phase === 'SLEEPING' && !entry.manualOut && now >= entry.sleepUntil) candidates.push(entry);
      }
      // Missing inventory is not proof of deletion. Fence absent ACTIVE slots.
      for (const entry of Object.values(state.schedules)) if (!seen.has(entry.key) && entry.phase === 'ACTIVE') {
        entry.phase = 'INELIGIBLE'; entry.activeStartedAt = null; entry.activeHealthyMs = 0; entry.activeTargetMs = null;
      }
      const pool = rows.filter(eligible);
      const cap = capacity(state.config, pool.length);
      for (const entry of activeRows) if (entry.activeHealthyMs >= entry.activeTargetMs)
        state.schedules[entry.key] = sleeping(entry, now, state.config, random);
      let running = activeRows.filter(e => state.schedules[e.key].phase === 'ACTIVE');
      // Reducing capacity may preempt active slots, with durable minimum sleep.
      running.sort((a,b) => a.activeHealthyMs - b.activeHealthyMs || a.key.localeCompare(b.key));
      for (const row of running.slice(cap.cap)) state.schedules[row.key] = sleeping(row, now, state.config, random);
      running = running.slice(0, cap.cap);
      if (state.health.state !== 'HEALTHY') return [];
      candidates.sort((a,b) => a.sleepStartedAt - b.sleepStartedAt || a.key.localeCompare(b.key));
      const promoted = [];
      for (const row of candidates.slice(0, Math.max(0, cap.cap - running.length))) {
        state.schedules[row.key] = active(row, now, state.config, random);
        promoted.push(row.key);
      }
      return promoted;
    });
    return ok(r.result, r.revision);
  }); }
  async function inspect() { return snapshot(); }
  return Object.freeze({ status, configure, setEligibility, planPass, checkpoint, inspect });
}
