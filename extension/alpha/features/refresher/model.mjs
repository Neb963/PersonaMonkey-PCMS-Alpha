/** P304: pure timing, eligibility and capacity rules. No remote operations. */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const JITTER = 30 * MINUTE;
export const DEFAULT_CONFIG = Object.freeze({ activeHours: 24, sleepHours: 72, margin: 0.10,
  observedCapacity: null, manualCap: null });
export const HEALTH = Object.freeze(['HEALTHY', 'OUTAGE', 'SHUTDOWN', 'UNKNOWN']);
export const PHASE = Object.freeze(['ACTIVE', 'SLEEPING', 'INELIGIBLE']);
export const invalid = (code = 'INVALID_REQUEST') => { throw Object.assign(new Error(code), { code }); };
export const check = (condition, code) => { if (!condition) invalid(code); };
export const integer = v => Number.isSafeInteger(v) && v >= 0;
export function timestamp(value) {
  const t = typeof value === 'number' ? value : Date.parse(value);
  check(Number.isSafeInteger(t) && t >= 0 && t <= 8.64e15);
  return t;
}
export function duration(hours) {
  check(typeof hours === 'number' && Number.isFinite(hours) && hours >= 1 && hours <= 24 * 365);
  const millis = hours * HOUR;
  check(Number.isSafeInteger(millis));
  return millis;
}
export function validateConfig(config) {
  check(config && typeof config === 'object' && !Array.isArray(config));
  const allowed = Object.keys(DEFAULT_CONFIG);
  check(Object.keys(config).length === allowed.length && Object.keys(config).every(k => allowed.includes(k)));
  duration(config.activeHours); duration(config.sleepHours);
  check(typeof config.margin === 'number' && Number.isFinite(config.margin) && config.margin >= 0 && config.margin <= .5);
  check(config.observedCapacity === null || (integer(config.observedCapacity) && config.observedCapacity <= 1_000_000));
  check(config.manualCap === null || (integer(config.manualCap) && config.manualCap >= 1 && config.manualCap <= 1_000_000));
  return config;
}
export function capacity(config, eligibleCount) {
  validateConfig(config);
  check(integer(eligibleCount) && eligibleCount <= 1_000_000);
  // Unobserved feed capacity is UNKNOWN, not an invented fixed public limit.
  const observed = config.observedCapacity === null ? 0 : Math.floor(config.observedCapacity / (1 + config.margin));
  const safe = Math.min(eligibleCount, observed);
  const target = eligibleCount ? Math.max(1, Math.ceil(eligibleCount * config.activeHours /
    (config.activeHours + config.sleepHours))) : 0;
  return { eligibleCount, safeCap: safe, automaticCap: Math.min(safe, target),
    cap: config.manualCap === null ? Math.min(safe, target) : Math.min(safe, config.manualCap),
    targetPosition: n => Math.ceil(n * (1 + config.margin)) };
}
export function eligible(record) {
  return Boolean(record && record.fleetIntent === 'MANAGED' && record.listingObserved === 'PUBLIC' &&
    record.releaseId && record.sourceBinding?.status === 'READY' && record.deployState === 'DEPLOYED' &&
    Array.isArray(record.attentionRefs) && record.attentionRefs.length === 0);
}
export function offset(random) {
  const number = random();
  check(typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1);
  return Math.round((2 * number - 1) * JITTER);
}
export function sleeping(row, now, config, random) {
  const extra = Math.max(0, offset(random));
  return { ...row, phase: 'SLEEPING', activeStartedAt: null, activeHealthyMs: 0,
    activeTargetMs: null, sleepStartedAt: now, sleepUntil: now + duration(config.sleepHours) + extra };
}
export function active(row, now, config, random) {
  return { ...row, phase: 'ACTIVE', activeStartedAt: now, activeHealthyMs: 0,
    activeTargetMs: Math.max(MINUTE, duration(config.activeHours) + offset(random)), sleepUntil: null };
}
export function fresh(record, now) {
  return { key: record.key, accountId: record.accountId, personaUid: record.personaUid,
    accountBindingEpoch: record.accountBindingEpoch, phase: 'SLEEPING', manualOut: false,
    activeStartedAt: null, activeHealthyMs: 0, activeTargetMs: null,
    sleepStartedAt: now, sleepUntil: now, lastConfirmedRefresh: null, lastObservation: null };
}
export function reconcile(row, record, now, config, random) {
  if (!row) return { ...fresh(record, now), phase: eligible(record) ? 'SLEEPING' : 'INELIGIBLE' };
  check(row.key === record.key, 'RECOVERY_HOLD');
  if (row.accountId !== record.accountId || row.personaUid !== record.personaUid ||
      row.accountBindingEpoch !== record.accountBindingEpoch) {
    // Never carry an ACTIVE slot over a Persona/Account binding change.
    return { ...fresh(record, now), manualOut: row.manualOut, phase: 'INELIGIBLE',
      lastConfirmedRefresh: row.lastConfirmedRefresh, lastObservation: row.lastObservation };
  }
  if (!eligible(record)) {
    const paused = row.phase === 'ACTIVE' ? sleeping(row, now, config, random) : row;
    return { ...paused, phase: 'INELIGIBLE', activeStartedAt: null,
      activeHealthyMs: 0, activeTargetMs: null };
  }
  if (row.phase === 'INELIGIBLE') return { ...row, phase: 'SLEEPING',
    sleepStartedAt: row.sleepStartedAt ?? now, sleepUntil: Math.max(now, row.sleepUntil ?? now) };
  return row;
}
export function initialState() {
  return { schemaVersion: 1, revision: 0, config: { ...DEFAULT_CONFIG },
    health: { checkpointAt: null, state: 'UNKNOWN', runId: null, evidenceRefs: [] }, schedules: {} };
}
export function assertState(state) {
  check(state?.schemaVersion === 1 && integer(state.revision), 'RECOVERY_HOLD');
  try { validateConfig(state.config); } catch { invalid('RECOVERY_HOLD'); }
  check(state.health && HEALTH.includes(state.health.state) &&
    (state.health.checkpointAt === null || Number.isSafeInteger(state.health.checkpointAt)) &&
    (state.health.runId === null || typeof state.health.runId === 'string') &&
    Array.isArray(state.health.evidenceRefs), 'RECOVERY_HOLD');
  check(state.schedules && typeof state.schedules === 'object' && !Array.isArray(state.schedules), 'RECOVERY_HOLD');
  for (const [key, row] of Object.entries(state.schedules)) {
    check(row?.key === key && typeof row.accountId === 'string' &&
      typeof row.personaUid === 'string' && integer(row.accountBindingEpoch) &&
      PHASE.includes(row.phase) && typeof row.manualOut === 'boolean' &&
      integer(row.activeHealthyMs) && (row.activeTargetMs === null || integer(row.activeTargetMs)) &&
      (row.phase !== 'ACTIVE' || (row.activeStartedAt !== null && row.activeTargetMs !== null)) &&
      ['activeStartedAt', 'sleepStartedAt', 'sleepUntil'].every(k => row[k] === null || integer(row[k])) &&
      ['lastConfirmedRefresh', 'lastObservation'].every(k => row[k] === null || Number.isSafeInteger(row[k])),
    'RECOVERY_HOLD');
  }
  return state;
}
