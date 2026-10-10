/** P403 execution composition. Browser/provider authority remains with PersonaMonkey/P103. */
import { classifyRetry } from '../../features/visibility/service.mjs';
import { eligible } from '../../features/refresher/model.mjs';
import { canonicalPjs, prepareRefreshComment } from './comment.mjs';
import { createRefreshLedger, validateRefreshState } from './ledger.mjs';

const MIN_OBSERVATION_MS = 600_000;
const MAX_ATTEMPTS = 3;
const codes = new Set(['INVALID_REQUEST', 'STALE_BINDING', 'SOURCE_DRIFT', 'RECOVERY_HOLD',
  'UNSUPPORTED_CAPABILITY', 'OWNERSHIP_UNKNOWN', 'UNCERTAIN', 'WAITING_HUMAN',
  'RATE_LIMIT', 'CONFLICT', 'UNAVAILABLE', 'STALE_REVISION']);
const err = code => Object.assign(new Error(code), { code });
const check = (value, code = 'RECOVERY_HOLD') => { if (!value) throw err(code); };
const failed = code => ({ ok: false, error: { code, message: code, retryable: false }, revision: 0 });
const good = result => ({ ok: true, result, revision: 0 });
const unwrap = result => {
  check(result && typeof result.ok === 'boolean', 'UNSUPPORTED_CAPABILITY');
  if (!result.ok) throw err(codes.has(result.error?.code) ? result.error.code : 'UNAVAILABLE');
  return result.result;
};
const time = value => Number.isSafeInteger(value) && value >= 0;
const keyOK = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(value);
const baseJob = () => ({ state: 'OBSERVE', attempts: 0, lastAttemptAtMs: null,
  lastSavedAtMs: null, nextAllowedAtMs: null, reloadForAttempt: 0,
  comment: null, pending: null, attentionReason: null });
const attentionCodes = new Set(['SOURCE_DRIFT', 'RECOVERY_HOLD', 'UNCERTAIN',
  'WAITING_HUMAN', 'STALE_BINDING', 'OWNERSHIP_UNKNOWN', 'UNSUPPORTED_CAPABILITY']);

export function createRefreshExecution({
  scheduler, visibility, storage, provider, journal, core, contextFor,
  browser = null, attention = null, ledger = createRefreshLedger(),
  clock = () => Date.now(), minStaggerMs = 60_000, maxPerPass = 4
} = {}) {
  check(scheduler && typeof scheduler.planPass === 'function' &&
    typeof scheduler.inspect === 'function' && visibility &&
    typeof visibility.getPosition === 'function' && storage &&
    typeof storage.read === 'function' && typeof storage.commit === 'function' && provider &&
    typeof provider.read === 'function' && typeof provider.probe === 'function' &&
    typeof provider.save === 'function' && journal &&
    typeof journal.prepare === 'function' && typeof journal.read === 'function' &&
    core && typeof core.assertMutationAllowed === 'function' &&
    typeof core.assertCurrent === 'function' &&
    typeof contextFor === 'function' && ledger &&
    typeof ledger.read === 'function' && typeof ledger.update === 'function' &&
    typeof clock === 'function' && time(minStaggerMs) && minStaggerMs >= 60_000 &&
    Number.isSafeInteger(maxPerPass) && maxPerPass >= 1 && maxPerPass <= 16,
  'INVALID_REQUEST');
  const now = () => { const t = clock(); check(time(t), 'INVALID_REQUEST'); return t; };
  const snapshot = async () => validateRefreshState(await ledger.read());
  async function update(key, patch) {
    await ledger.update(s => {
      s.jobs[key] = { ...(s.jobs[key] ?? baseJob()), ...patch };
    });
  }
  async function alert(key, code) {
    await update(key, { attentionReason: code });
    // P404 is optional; the durable reason remains visible if notification fails.
    if (attention && typeof attention.raise === 'function') {
      try { await attention.raise({ key, code, source: 'REFRESH' }); } catch {}
    }
  }
  async function suspend(key, code) {
    await update(key, { state: 'SUSPENDED', attentionReason: code,
      nextAllowedAtMs: null });
    await alert(key, code);
    return { key, action: 'SUSPENDED', reason: code };
  }
  async function hold(key, code) {
    await update(key, { state: 'RECONCILE', attentionReason: code });
    await alert(key, code);
    return { key, action: 'RECONCILE', reason: code };
  }
  async function binding(key, schedule, { mutation = true } = {}) {
    await core.assertCurrent();
    if (mutation) await core.assertMutationAllowed();
    const row = await storage.read('generator', key);
    const generator = row.item?.record;
    check(generator && schedule && (!mutation ||
      (eligible(generator) && schedule.phase === 'ACTIVE')) &&
      generator.key === key && generator.personaUid === schedule.personaUid &&
      generator.accountId === schedule.accountId &&
      generator.accountBindingEpoch === schedule.accountBindingEpoch, 'STALE_BINDING');
    const account = (await storage.read('account', generator.accountId)).item?.record;
    check(account && account.personaUid === generator.personaUid &&
      account.epoch === generator.accountBindingEpoch, 'STALE_BINDING');
    check(account.sessionState === 'VERIFIED', 'WAITING_HUMAN');
    const context = await contextFor({ generator, account });
    check(context && context.accountId === generator.accountId &&
      context.personaUid === generator.personaUid &&
      context.epoch === generator.accountBindingEpoch &&
      time(context.routeRevision) && time(context.capabilityRevision), 'STALE_BINDING');
    return { generator, context };
  }
  async function observedSource(context, generator, previous) {
    const release = (await storage.read('release', generator.releaseId)).item?.record;
    check(release && release.releaseId === generator.releaseId &&
      release.source?.status === 'READY' &&
      release.source.slug === generator.key, 'SOURCE_DRIFT');
    const observed = unwrap(await provider.read({ context, targetKey: generator.key }));
    check(observed && observed.ownership === 'CONFIRMED' &&
      observed.listing === 'PUBLIC' && typeof observed.sourceRevision === 'string' &&
      observed.sourceRevision.length > 0 && observed.files, 'OWNERSHIP_UNKNOWN');
    await canonicalPjs(observed.files, release, previous);
    return { release, observed };
  }
  async function reload(key, row, job, t) {
    // Only a caller-owned PersonaMonkey lease adapter may issue browser actions.
    if (!browser || typeof browser.reload !== 'function')
      return suspend(key, 'UNSUPPORTED_CAPABILITY');
    const { context } = await binding(key, row);
    const opId = 'refresh.reload.' + key + '.' + t.toString(36);
    await update(key, { state: 'RELOADING', reloadForAttempt: job.attempts,
      nextAllowedAtMs: t + MIN_OBSERVATION_MS, pending: { opId, kind: 'reload' } });
    try {
      const result = await browser.reload({ context, targetKey: key, opId });
      check(result?.ok === true && result.result?.confirmed === true,
        'UNCERTAIN');
      await update(key, { state: 'BACKOFF', pending: null });
      return { key, action: 'RELOADED', nextAtMs: t + MIN_OBSERVATION_MS };
    } catch {
      return hold(key, 'UNCERTAIN');
    }
  }
  async function save(key, row, job, t) {
    const state = await snapshot();
    if (state.lastSaveAtMs !== null) {
      check(t >= state.lastSaveAtMs, 'RECOVERY_HOLD');
      if (t - state.lastSaveAtMs < minStaggerMs)
        return { key, action: 'STAGGERED', nextAtMs: state.lastSaveAtMs + minStaggerMs };
    }
    const { generator, context } = await binding(key, row);
    const { release, observed } = await observedSource(context, generator, job.comment);
    const capabilities = await provider.probe(context);
    check(Array.isArray(unwrap(capabilities)) &&
      capabilities.result.includes('generator.save') && time(capabilities.revision),
    'UNSUPPORTED_CAPABILITY');
    const opId = 'refresh.' + key + '.' + t.toString(36) + '.' + state.revision.toString(36);
    const staged = await prepareRefreshComment(observed.files, release, job.comment, t.toString(36) +
      '-' + state.revision.toString(36));
    const intent = { opId, kind: 'save', comment: staged.comment,
      beforeRevision: observed.sourceRevision, releaseId: release.releaseId };
    // Atomic reservation, before any external provider mutation.
    await ledger.update(s => {
      const current = s.jobs[key] ?? baseJob();
      check(s.revision === state.revision &&
        !['PREPARED', 'DISPATCHING', 'RELOADING', 'RECONCILE', 'SUSPENDED'].includes(current.state) &&
        (s.lastSaveAtMs === null || t - s.lastSaveAtMs >= minStaggerMs),
      'STALE_REVISION');
      s.lastSaveAtMs = t;
      s.jobs[key] = { ...current, state: 'PREPARED', pending: intent };
    });
    try {
      await journal.prepare({ opId, kind: 'save', targetKey: key,
        sourceRevision: observed.sourceRevision,
        accountBindingEpoch: generator.accountBindingEpoch });
      await core.assertCurrent();
      await core.assertMutationAllowed();
      await update(key, { state: 'DISPATCHING' });
      const after = unwrap(await provider.save({
        context, targetKey: key, opId, expectedRevision: capabilities.revision,
        expectedSourceRevision: observed.sourceRevision,
        accountBindingEpoch: generator.accountBindingEpoch, files: staged.files
      }));
      check(after?.ownership === 'CONFIRMED' && after.listing === 'PUBLIC' &&
        typeof after.sourceRevision === 'string' && after.sourceRevision.length > 0 &&
        after.files?.pjs === staged.files.pjs, 'UNCERTAIN');
      // Independent exact readback; saved bytes alone are never visibility proof.
      const current = unwrap(await provider.read({ context, targetKey: key }));
      check(current.sourceRevision === after.sourceRevision &&
        current.listing === 'PUBLIC' && current.ownership === 'CONFIRMED',
      'UNCERTAIN');
      await canonicalPjs(current.files, release, staged.comment);
      const confirmedComment = { ...staged.comment, targetKey: key,
        saveReceipt: after.sourceRevision, sourceRevision: after.sourceRevision };
      await update(key, { state: 'OBSERVE', attempts: Math.min(MAX_ATTEMPTS, job.attempts + 1),
        lastAttemptAtMs: t, lastSavedAtMs: t, nextAllowedAtMs: t + MIN_OBSERVATION_MS,
        comment: confirmedComment, pending: null, attentionReason: null });
      return { key, action: 'SAVED_WAIT_FOR_OBSERVATION', sourceRevision: after.sourceRevision };
    } catch (error) {
      return hold(key, codes.has(error?.code) ? error.code : 'UNCERTAIN');
    }
  }
  async function step(key, schedule, activeCount, margin, t) {
    const state = await snapshot(), job = state.jobs[key] ?? baseJob();
    if (job.state === 'SUSPENDED') return { key, action: 'SUSPENDED', reason: job.attentionReason };
    if (job.state === 'RECONCILE')
      return { key, action: 'RECONCILE', reason: job.attentionReason };
    if (['PREPARED', 'DISPATCHING', 'RELOADING'].includes(job.state))
      return hold(key, 'RECOVERY_HOLD');
    const position = visibility.getPosition({ key });
    const observation = unwrap(await position);
    check(observation && observation.key === key &&
      Number.isFinite(Date.parse(observation.asOf)) &&
      Date.parse(observation.asOf) <= t, 'UNAVAILABLE');
    // Cached observations, especially a snapshot from before a save, cannot prove recovery.
    if (job.lastSavedAtMs !== null && Date.parse(observation.asOf) <= job.lastSavedAtMs)
      return { key, action: 'WAIT_FOR_FRESH_OBSERVATION' };
    const advice = classifyRetry({
      observation, activeCount, margin, failedAttempts: job.attempts,
      lastAttemptAtMs: job.lastAttemptAtMs, nowMs: t
    });
    if (advice.action === 'ON_TARGET') {
      await update(key, { state: 'ON_TARGET', attempts: 0, lastAttemptAtMs: null,
        reloadForAttempt: 0, nextAllowedAtMs: null, attentionReason: null });
      return { key, action: 'ON_TARGET', target: advice.target,
        renderedPosition: observation.renderedPosition };
    }
    if (advice.action === 'WAIT_FOR_OBSERVATION') return { key, action: 'WAIT_FOR_OBSERVATION' };
    if (advice.action === 'SUSPEND') return suspend(key, observation.status === 'LIKELY_FILTERED' ?
      'LIKELY_FILTERED' : 'RETRY_EXHAUSTED');
    if (advice.action === 'BACKOFF' ||
      (job.nextAllowedAtMs !== null && t < job.nextAllowedAtMs))
      return { key, action: 'BACKOFF', nextAtMs: Math.max(t, job.nextAllowedAtMs ??
        t + (advice.delayMs ?? MIN_OBSERVATION_MS)) };
    if (job.attempts > 0 && job.reloadForAttempt !== job.attempts)
      return reload(key, schedule, job, t);
    return save(key, schedule, job, t);
  }
  return Object.freeze({
    async pass() {
      try {
        const t = now();
        unwrap(await scheduler.planPass());
        const s = await scheduler.inspect();
        check(s && s.config && s.schedules, 'RECOVERY_HOLD');
        if (s.health?.state !== 'HEALTHY') return good({ items: [], health: s.health?.state ?? 'UNKNOWN' });
        const active = Object.values(s.schedules).filter(row => row.phase === 'ACTIVE');
        const journalState = await snapshot();
        active.sort((a, b) => (journalState.jobs[a.key]?.lastAttemptAtMs ?? -1) -
          (journalState.jobs[b.key]?.lastAttemptAtMs ?? -1) || a.key.localeCompare(b.key));
        const items = [];
        for (const schedule of active.slice(0, maxPerPass)) {
          const key = schedule.key;
          try { items.push(await step(key, schedule, active.length, s.config.margin, t)); }
          catch (error) {
            const code = codes.has(error?.code) ? error.code : 'UNAVAILABLE';
            items.push(attentionCodes.has(code) ? await suspend(key, code) :
              { key, action: 'WAIT', reason: code });
          }
        }
        return good({ items, activeCount: active.length, asOf: new Date(t).toISOString() });
      } catch (error) { return failed(codes.has(error?.code) ? error.code : 'UNAVAILABLE'); }
    },
    /** Authoritative read only: never replays an ambiguous provider save. */
    async reconcile({ key } = {}) {
      try {
        check(keyOK(key), 'INVALID_REQUEST');
        const s = await snapshot(), job = s.jobs[key];
        check(job && job.state === 'RECONCILE' && job.pending?.kind === 'save',
          'RECOVERY_HOLD');
        const row = (await scheduler.inspect()).schedules[key];
        const { generator, context } = await binding(key, row, { mutation: false });
        const release = (await storage.read('release', generator.releaseId)).item?.record;
        const observed = unwrap(await provider.read({ context, targetKey: key }));
        const operation = await journal.read(job.pending.opId);
        check(operation && operation.kind === 'save' && operation.targetKey === key &&
          operation.accountBindingEpoch === generator.accountBindingEpoch &&
          operation.sourceRevision === job.pending.beforeRevision &&
          ['APPLIED', 'UNCERTAIN', 'HELD', 'DISPATCHING'].includes(operation.phase) &&
          observed.ownership === 'CONFIRMED' && observed.listing === 'PUBLIC' &&
          typeof observed.sourceRevision === 'string' && observed.sourceRevision.length > 0 &&
          observed.sourceRevision !== job.pending.beforeRevision,
        'RECOVERY_HOLD');
        // Exact source + new provider revision is independent positive evidence.
        // Reconciliation never redispatches the provider mutation.
        await canonicalPjs(observed.files, release, job.pending.comment);
        await binding(key, row, { mutation: false });
        if (operation.phase !== 'APPLIED') {
          const persisted = await storage.read('operation', job.pending.opId);
          check(persisted.item && persisted.item.record.phase === operation.phase &&
            persisted.item.record.opId === operation.opId &&
            persisted.item.record.accountBindingEpoch === generator.accountBindingEpoch,
          'RECOVERY_HOLD');
          await storage.commit({ expectedRevision: persisted.revision, writes: [{
            kind: 'operation', expectedRevision: persisted.item.revision,
            record: { ...persisted.item.record, phase: 'APPLIED', remoteEvidence: {
              disposition: 'READBACK_CONFIRMED', sourceRevision: observed.sourceRevision,
              ownership: 'CONFIRMED', listing: 'PUBLIC'
            } }
          }] });
        }
        const t = now();
        await update(key, { state: 'OBSERVE', comment: {
          ...job.pending.comment, sourceRevision: observed.sourceRevision,
          saveReceipt: observed.sourceRevision
        }, pending: null, attempts: Math.min(MAX_ATTEMPTS, job.attempts + 1),
          lastAttemptAtMs: t, lastSavedAtMs: t,
          nextAllowedAtMs: t + MIN_OBSERVATION_MS, attentionReason: null });
        return good({ key, state: 'OBSERVE' });
      } catch (error) { return failed(codes.has(error?.code) ? error.code : 'RECOVERY_HOLD'); }
    },
    inspect: snapshot
  });
}
