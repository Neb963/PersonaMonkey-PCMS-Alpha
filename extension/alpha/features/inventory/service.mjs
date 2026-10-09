/** P204 inventory service. P102 owns identities and CAS; P103 owns account discovery.
 * This service performs NO provider mutation, public-feed lookup or browser execution.
 */
import { normalizeGenerator, normalizeGeneratorKey } from '../../domain/records.js';
import { instant, id, revision } from '../../domain/validation.js';
import { collectAccountGenerators } from '../../providers/perchance/adapter.mjs';
import { createGeneratorIndex } from './index.mjs';
import { normalizeInventoryFact } from './facts.mjs';

const messages = Object.freeze({
  INVALID_REQUEST: 'Invalid inventory request.', STALE_REVISION: 'Inventory changed; refresh required.',
  STALE_BINDING: 'Account Persona binding changed.', OWNERSHIP_UNKNOWN: 'Ownership is not confirmed.',
  CONFLICT: 'Generator ownership or discovery conflicts.',
  UNSUPPORTED_CAPABILITY: 'Account inventory capability is unavailable.',
  UNAVAILABLE: 'Inventory read is unavailable.', RECOVERY_HOLD: 'Inventory reconciliation required.',
  SOURCE_DRIFT: 'Unexpected provider source revision.', NOT_APPLIED: 'No matching generator.'
});
const error = (code, current = 0) => ({ ok: false, error: { code: messages[code] ? code : 'UNAVAILABLE',
  message: messages[code] || messages.UNAVAILABLE, retryable: false }, revision: current });
const ok = (result, revision = 0) => ({ ok: true, result, revision });
class Rejected extends Error { constructor(code) { super(code); this.code = code; } }
const check = (condition, code = 'INVALID_REQUEST') => { if (!condition) throw new Rejected(code); };
const valid = v => v && typeof v === 'object' && !Array.isArray(v);
const sameBinding = (account, context) => account && account.accountId === context.accountId &&
  account.personaUid === context.personaUid && account.epoch === context.epoch;
const cleanVersion = v => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 256);
const stableDriftId = (key, sequence) => `inventory.drift.${key}.${sequence}`;

export function createInventoryService({ storage, provider, facts, clock = () => new Date().toISOString() } = {}) {
  if (!storage || !['read', 'list', 'commit'].every(k => typeof storage[k] === 'function') ||
      !provider || !['listGenerators', 'observe'].every(k => typeof provider[k] === 'function') ||
      !facts || !['get', 'list', 'putMany'].every(k => typeof facts[k] === 'function') ||
      typeof clock !== 'function') throw new TypeError('Inventory requires P102 storage, P103 provider and durable facts');
  let cached = null;
  const run = async callback => {
    try { return await callback(); }
    catch (e) { return error(e?.code || e?.message); }
  };
  const now = () => instant(clock());
  async function accountFor(context) {
    check(valid(context) && typeof context.accountId === 'string' && typeof context.personaUid === 'string' &&
      Number.isSafeInteger(context.epoch) && context.epoch > 0 &&
      Number.isSafeInteger(context.routeRevision) && Number.isSafeInteger(context.capabilityRevision));
    const result = await storage.read('account', context.accountId);
    const account = result.item?.record;
    check(sameBinding(account, context), 'STALE_BINDING');
    check(account.sessionState === 'VERIFIED', 'OWNERSHIP_UNKNOWN');
    return account;
  }
  function entryOK(entry) {
    try { normalizeGeneratorKey(entry.key); } catch { throw new Rejected('CONFLICT'); }
    // The P103 account adapter uses a narrower observed account-key grammar.
    check(entry.key === 'hub' || (entry.key.length >= 4 && entry.key.length <= 80 &&
      /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(entry.key)), 'CONFLICT');
    check(valid(entry.readback) && entry.readback.ownership === 'CONFIRMED' &&
      ['PUBLIC', 'UNLISTED', 'UNKNOWN'].includes(entry.readback.listing) &&
      cleanVersion(entry.readback.sourceRevision), 'CONFLICT');
    instant(entry.readback.asOf);
  }
  function factFor(entry, account, previous, prior, asOf, discoveryRevision) {
    const version = entry.readback.sourceRevision;
    const old = prior && sameBinding({ accountId: prior.accountId, personaUid: prior.personaUid,
      epoch: prior.accountBindingEpoch }, { ...account, epoch: account.epoch }) ? prior : null;
    const expected = old ? old.acceptedSourceRevision : version;
    const ignored = old?.ignoredVersion === version ? version : null;
    const differs = expected !== null && version !== null && expected !== version;
    const drift = differs ? old?.drift?.observed === version ? old.drift : {
      id: stableDriftId(entry.key, (old?.observationRevision ?? 0) + 1),
      expected, observed: version, firstSeenAt: asOf
    } : null;
    const fact = {
      key: entry.key, accountId: account.accountId, personaUid: account.personaUid,
      accountBindingEpoch: account.epoch, providerSourceRevision: version,
      acceptedSourceRevision: expected, listing: entry.readback.listing,
      observedAt: asOf, lastSeenAt: asOf, ownershipObserved: true,
      discoveryRevision, observationRevision: (old?.observationRevision ?? 0) + 1,
      ignoredVersion: ignored, drift
    };
    const refs = previous?.attentionRefs ?? [];
    const preserved = refs.filter(ref => !ref.startsWith(`inventory.drift.${entry.key}.`));
    if (drift && !ignored) preserved.push(drift.id);
    return { fact: normalizeInventoryFact(fact), refs: preserved };
  }
  async function reconcileEntries(context, entries, { complete = false, asOf } = {}) {
    const account = await accountFor(context), time = asOf ? instant(asOf) : now();
    const seen = new Set();
    for (const entry of entries) { entryOK(entry); check(!seen.has(entry.key), 'CONFLICT'); seen.add(entry.key); }
    const [persisted, storedFacts] = await Promise.all([storage.list('generator'), facts.list()]);
    const byKey = new Map(persisted.items.map(item => [item.record.key, item]));
    const factsByKey = new Map(storedFacts.map(fact => [fact.key, normalizeInventoryFact(fact)]));
    const updates = [], nextFacts = [];
    for (const entry of entries) {
      const existing = byKey.get(entry.key)?.record;
      check(!existing || existing.accountId === account.accountId, 'CONFLICT');
      check(!existing || (existing.personaUid === account.personaUid && existing.accountBindingEpoch === account.epoch), 'STALE_BINDING');
      const prior = factsByKey.get(entry.key);
      check(!prior || prior.accountId === account.accountId, 'CONFLICT');
      const { fact, refs } = factFor(entry, account, existing, prior, time, persisted.revision + 1);
      nextFacts.push(fact);
      // Preserve all independent release, operational, and operator intent facts.
      const proposed = normalizeGenerator(existing ? { ...existing,
        listingObserved: entry.readback.listing, asOf: time, attentionRefs: refs } : {
        key: entry.key, accountId: account.accountId, personaUid: account.personaUid,
        accountBindingEpoch: account.epoch, fleetIntent: 'EXCLUDED',
        listingObserved: entry.readback.listing, deployState: 'UNDEPLOYED',
        refreshState: 'INELIGIBLE', sourceBinding: null, releaseId: null,
        revision: 0, asOf: time, attentionRefs: refs
      });
      if (!existing || existing.listingObserved !== proposed.listingObserved ||
          existing.asOf !== proposed.asOf || JSON.stringify(existing.attentionRefs) !== JSON.stringify(refs))
        updates.push({ kind: 'generator', expectedRevision: existing?.revision ?? 0, record: proposed });
    }
    // A complete account discovery may mark missing observations, but NEVER
    // deletes/reassigns the durable GeneratorRecord or infers public visibility.
    if (complete) for (const prior of storedFacts) {
      if (prior.accountId !== account.accountId || !prior.ownershipObserved || seen.has(prior.key)) continue;
      nextFacts.push(normalizeInventoryFact({ ...prior, ownershipObserved: false, observedAt: time,
        discoveryRevision: persisted.revision + 1, observationRevision: prior.observationRevision + 1 }));
    }
    // P102 limits each atomic commit to 64 writes. A partial import is recoverable:
    // no old records are deleted; caller must retry/reconcile if any batch fails.
    let currentRevision = persisted.revision;
    for (let i = 0; i < updates.length; i += 64) {
      const result = await storage.commit({ expectedRevision: currentRevision, writes: updates.slice(i, i + 64) });
      currentRevision = result.revision;
    }
    // Commit facts after identity writes. A failed ledger write is a recovery hold,
    // not proof of a complete successful discovery. A later scan reconciles.
    for (let i = 0; i < nextFacts.length; i += 64) {
      try { await facts.putMany(nextFacts.slice(i, i + 64)); }
      catch { throw new Rejected('RECOVERY_HOLD'); }
    }
    cached = null;
    return { count: entries.length, revision: currentRevision, complete, asOf: time };
  }
  async function inventoryIndex() {
    const list = await storage.list('generator');
    if (!cached || cached.revision !== list.revision) cached = createGeneratorIndex(list.items.map(item => item.record), list.revision);
    return cached;
  }
  async function localRead(key) {
    normalizeGeneratorKey(key);
    const row = await storage.read('generator', key);
    check(row.item, 'NOT_APPLIED');
    return { record: row.item.record, storeRevision: row.revision };
  }
  async function scanAccount(context) {
    await accountFor(context);
    // P103 rejects malformed identities, duplicate pages, repeated/stale cursors
    // and incomplete discovery. No public-feed API is consulted here.
    const remote = await collectAccountGenerators(provider, context);
    if (!remote.ok) return remote;
    return run(async () => {
      const result = await reconcileEntries(context, remote.result.items, { complete: true, asOf: remote.result.asOf });
      return ok(result, result.revision);
    });
  }
  const service = {
    async list(params = {}) { return run(async () => {
      check(valid(params)); const idx = await inventoryIndex();
      const page = idx.query(params);
      return ok({ items: page.items, cursor: page.cursor, asOf: now() }, page.revision);
    }); },
    async get({ key } = {}) { return run(async () => {
      const item = await localRead(key); return ok(item.record, item.storeRevision);
    }); },
    async observe({ key, accountId, accountBindingEpoch, expectedRevision, opId, options } = {}) { return run(async () => {
      // Bulk account enumeration deliberately uses a separate opt-in option;
      // a single-key observation uses P103 readback/ownership confirmation.
      id(accountId); id(opId); revision(accountBindingEpoch, 1); revision(expectedRevision);
      check(valid(options));
      const stored = await storage.read('account', accountId);
      const a = stored.item?.record;
      check(a && a.sessionState === 'VERIFIED', 'OWNERSHIP_UNKNOWN');
      const context = options?.context;
      check(valid(context) && sameBinding(a, context) && accountBindingEpoch === a.epoch, 'STALE_BINDING');
      if (key === undefined) {
        check(expectedRevision === a.revision, 'STALE_REVISION');
        return scanAccount(context);
      }
      normalizeGeneratorKey(key);
      const current = await localRead(key);
      check(current.record.revision === expectedRevision, 'STALE_REVISION');
      const remote = await provider.observe({ context, targetKey: key });
      if (!remote?.ok) return remote?.error ? error(remote.error.code) : error('UNAVAILABLE');
      const result = await reconcileEntries(context, [{ key, readback: remote.result }], { asOf: remote.result.asOf });
      const local = await localRead(key);
      return ok(local.record, result.revision);
    }); },
    async setIntent({ key, accountId, accountBindingEpoch, expectedRevision, opId, options } = {}) {
      return run(async () => {
        normalizeGeneratorKey(key); id(accountId); id(opId);
        revision(accountBindingEpoch, 1); revision(expectedRevision);
        check(valid(options) && ['MANAGED', 'EXCLUDED'].includes(options.fleetIntent));
        const [local, account] = await Promise.all([localRead(key), storage.read('account', accountId)]);
        check(local.record.accountId === accountId && account.item &&
          sameBinding(account.item.record, { accountId, personaUid: local.record.personaUid, epoch: accountBindingEpoch }), 'STALE_BINDING');
        check(local.record.accountBindingEpoch === accountBindingEpoch, 'STALE_BINDING');
        check(local.record.revision === expectedRevision, 'STALE_REVISION');
        if (local.record.fleetIntent === options.fleetIntent) return ok(local.record, local.storeRevision);
        const result = await storage.commit({ expectedRevision: local.storeRevision,
          writes: [{ kind: 'generator', expectedRevision, record: { ...local.record,
            fleetIntent: options.fleetIntent, asOf: now() } }] });
        cached = null;
        return ok((await localRead(key)).record, result.revision);
      });
    },
    async inspectDrift({ key } = {}) { return run(async () => {
      const local = await localRead(key), fact = await facts.get(key);
      check(!fact || (fact.accountId === local.record.accountId && fact.personaUid === local.record.personaUid &&
        fact.accountBindingEpoch === local.record.accountBindingEpoch), 'STALE_BINDING');
      // The frozen service returns GeneratorRecord; evidence is persisted in
      // facts and its stable attentionRefs, not smuggled into the record shape.
      return ok(local.record, local.storeRevision);
    }); },
    async previewDelete({ key } = {}) { return run(async () => {
      const local = (await localRead(key)).record;
      return ok([`generator:${local.key}`, `account:${local.accountId}`,
        ...(local.sourceBinding ? [`source:${local.sourceBinding.folder}`] : []),
        ...(local.releaseId ? [`release:${local.releaseId}`] : []),
        `provider-delete-requires-separate-confirmed-operation`]);
    }); },
    async delete() { return error('UNSUPPORTED_CAPABILITY'); }
  };
  return Object.freeze(service);
}

/** Read the P204-owned durable evidence without mutating the frozen GeneratorRecord. */
export async function readInventoryFact(facts, key) {
  normalizeGeneratorKey(key);
  const row = await facts.get(key);
  return row === null ? null : normalizeInventoryFact(row);
}

/** Suppress only the exact observed source revision; a new revision reopens drift. */
export async function ignoreDriftForObservedRevision(facts, { key, expectedObservationRevision, sourceRevision, accountId, accountBindingEpoch, at }) {
  normalizeGeneratorKey(key); id(accountId); revision(accountBindingEpoch, 1); revision(expectedObservationRevision, 1);
  check(cleanVersion(sourceRevision) && sourceRevision !== null);
  const prior = await facts.get(key);
  check(prior && prior.accountId === accountId && prior.accountBindingEpoch === accountBindingEpoch, 'STALE_BINDING');
  check(prior.observationRevision === expectedObservationRevision &&
    prior.drift?.observed === sourceRevision && prior.providerSourceRevision === sourceRevision, 'STALE_REVISION');
  const next = normalizeInventoryFact({ ...prior, ignoredVersion: sourceRevision,
    observationRevision: prior.observationRevision + 1, observedAt: instant(at) });
  await facts.compareAndPut(next, expectedObservationRevision);
  return next;
}

/** Deployers may adopt a new baseline ONLY with an APPLIED durable source receipt.
 * This does not mutate Perchance or P102's canonical GeneratorRecord.
 */
export async function adoptConfirmedSourceVersion(facts, { key, accountId, accountBindingEpoch,
  expectedObservationRevision, operation, at }) {
  normalizeGeneratorKey(key); id(accountId); revision(accountBindingEpoch, 1); revision(expectedObservationRevision, 1);
  check(valid(operation) && operation.phase === 'APPLIED' &&
    operation.targetKey === key && operation.accountBindingEpoch === accountBindingEpoch &&
    valid(operation.remoteEvidence) && cleanVersion(operation.remoteEvidence.sourceRevision) &&
    operation.remoteEvidence.sourceRevision !== null, 'RECOVERY_HOLD');
  const prior = await facts.get(key);
  check(prior && prior.accountId === accountId && prior.accountBindingEpoch === accountBindingEpoch &&
    prior.ownershipObserved === true, 'STALE_BINDING');
  check(prior.observationRevision === expectedObservationRevision &&
    prior.providerSourceRevision === operation.remoteEvidence.sourceRevision, 'STALE_REVISION');
  const next = normalizeInventoryFact({ ...prior, acceptedSourceRevision: prior.providerSourceRevision,
    drift: null, ignoredVersion: null, observationRevision: prior.observationRevision + 1,
    observedAt: instant(at) });
  await facts.compareAndPut(next, expectedObservationRevision);
  return next;
}
