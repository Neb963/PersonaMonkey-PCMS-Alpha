/** P302: sleep-only, source-commit-pinned unlisted deployment.
 * P201 owns scheduling and recovery; P103 owns all provider execution.
 * P402 owns AI review, human approval and publication. No tab/DOM authority here.
 */
import { canonicalReleaseId } from '../sources/catalog.mjs';
import { normalizeGeneratorKey } from '../../domain/records.js';
import { id, instant } from '../../domain/validation.js';

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const OPEN = new Set(['PREPARED', 'DISPATCHING', 'UNCERTAIN', 'HELD']);
const ERRORS = Object.freeze({
  INVALID_REQUEST: 'Invalid deployer request.',
  STALE_REVISION: 'Generator or provider revision changed.',
  STALE_BINDING: 'The account Persona binding changed.',
  UNSUPPORTED_CAPABILITY: 'The required provider capability is unavailable.',
  OWNERSHIP_UNKNOWN: 'Account-scoped ownership is not confirmed.',
  SOURCE_DRIFT: 'Remote source differs from the confirmed baseline.',
  CONFLICT: 'Generator is active, quarantined, or otherwise ineligible.',
  RATE_LIMIT: 'The provider operation budget is exhausted.',
  WAITING_HUMAN: 'Operator intervention is required.',
  RECOVERY_HOLD: 'Unresolved external mutation requires reconciliation.',
  NOT_APPLIED: 'Provider mutation did not apply.',
  UNCERTAIN: 'Provider mutation outcome is uncertain.',
  UNAVAILABLE: 'Deployment service is unavailable.'
});
class Rejected extends Error { constructor(code) { super(code); this.code = code; } }
const check = (condition, code = 'INVALID_REQUEST') => { if (!condition) throw new Rejected(code); };
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const success = (result, revision = 0) => ({ ok: true, result, revision });
const failure = (code, revision = 0) => ({
  ok: false, error: { code: ERRORS[code] ? code : 'UNAVAILABLE',
    message: ERRORS[code] || ERRORS.UNAVAILABLE, retryable: code === 'RATE_LIMIT' || code === 'UNAVAILABLE' },
  revision
});
const codeOf = error => ERRORS[error?.code] ? error.code : 'UNAVAILABLE';
function unwrap(result) {
  check(obj(result) && typeof result.ok === 'boolean', 'UNSUPPORTED_CAPABILITY');
  if (!result.ok) throw new Rejected(ERRORS[result.error?.code] ? result.error.code : 'UNAVAILABLE');
  return result.result;
}
function keyOf(value) { try { return normalizeGeneratorKey(value); } catch { throw new Rejected('INVALID_REQUEST'); } }
function opIdOf(value) { check(typeof value === 'string' && value.length <= 110); try { return id(value); } catch { throw new Rejected('INVALID_REQUEST'); } }
function guard(params) {
  check(obj(params) && typeof params.key === 'string' && typeof params.accountId === 'string' &&
    Number.isSafeInteger(params.expectedRevision) && params.expectedRevision >= 0 &&
    Number.isSafeInteger(params.accountBindingEpoch) && params.accountBindingEpoch >= 1 &&
    obj(params.options) && obj(params.options.context));
  keyOf(params.key); opIdOf(params.opId);
  try { id(params.accountId); } catch { throw new Rejected('INVALID_REQUEST'); }
  const context = params.options.context;
  check(context.accountId === params.accountId && typeof context.personaUid === 'string' &&
    context.epoch === params.accountBindingEpoch &&
    Number.isSafeInteger(context.routeRevision) && context.routeRevision >= 0 &&
    Number.isSafeInteger(context.capabilityRevision) && context.capabilityRevision >= 0);
  check(Object.keys(params.options).every(k => ['context', 'manualRetry', 'originalOpId'].includes(k)) &&
    (params.options.manualRetry === undefined || params.options.manualRetry === true) &&
    (params.options.originalOpId === undefined || typeof params.options.originalOpId === 'string'));
  return context;
}
function sleeping(generator) {
  if (generator.refreshState === 'ACTIVE' || generator.deployState === 'ACTIVE') return false;
  if (generator.refreshState === 'SLEEPING') return true;
  return generator.releaseId === null && generator.deployState === 'UNDEPLOYED' &&
    generator.refreshState === 'INELIGIBLE';
}
function sameFiles(a, b) {
  return obj(a) && obj(b) && typeof a.pjs === 'string' && a.pjs === b.pjs &&
    typeof a.html === 'string' && a.html === b.html &&
    a.thumbnail instanceof Uint8Array && b.thumbnail instanceof Uint8Array &&
    a.thumbnail.length === b.thumbnail.length &&
    a.thumbnail.every((byte, i) => byte === b.thumbnail[i]);
}
async function contentHash(files) {
  check(obj(files) && typeof files.pjs === 'string' && typeof files.html === 'string' &&
    files.thumbnail instanceof Uint8Array, 'UNSUPPORTED_CAPABILITY');
  try { return await canonicalReleaseId({
    pjs: new TextEncoder().encode(files.pjs),
    html: new TextEncoder().encode(files.html), thumbnail: files.thumbnail
  }); } catch { throw new Rejected('SOURCE_DRIFT'); }
}

export function createDeployerService({
  storage, sourceCatalog, provider, journal, facts, core,
  clock = () => new Date().toISOString()
} = {}) {
  if (!storage || !['read', 'list', 'commit'].every(k => typeof storage[k] === 'function') ||
      !sourceCatalog || typeof sourceCatalog.resolveRelease !== 'function' ||
      !provider || !['read', 'probe', 'save', 'setListing'].every(k => typeof provider[k] === 'function') ||
      !journal || !['prepare', 'read'].every(k => typeof journal[k] === 'function') ||
      !facts || typeof facts.get !== 'function' ||
      !core || typeof core.assertCurrent !== 'function' ||
      typeof core.assertMutationAllowed !== 'function') {
    throw new TypeError('Deployer requires P102, P103, P203, P204 and P201 services');
  }
  const now = () => instant(clock());
  const run = async fn => { try { return await fn(); } catch (error) {
    return failure(codeOf(error), error?.currentRevision || 0);
  } };
  async function op(idValue) {
    const row = await storage.read('operation', opIdOf(idValue));
    check(row.item, 'NOT_APPLIED');
    return row.item.record;
  }
  async function record(params, context, requireSleep = true) {
    const [row, account] = await Promise.all([
      storage.read('generator', params.key),
      storage.read('account', params.accountId)
    ]);
    check(row.item, 'NOT_APPLIED');
    const generator = row.item.record, a = account.item?.record;
    check(generator.accountId === params.accountId && generator.personaUid === context.personaUid &&
      generator.accountBindingEpoch === params.accountBindingEpoch &&
      a && a.accountId === params.accountId && a.personaUid === context.personaUid &&
      a.epoch === params.accountBindingEpoch, 'STALE_BINDING');
    check(a.sessionState === 'VERIFIED', 'WAITING_HUMAN');
    check(generator.revision === params.expectedRevision, 'STALE_REVISION');
    if (requireSleep) check(sleeping(generator), 'CONFLICT');
    return { generator, row };
  }
  async function providerRead(context, key) {
    const observed = unwrap(await provider.read({ context, targetKey: key }));
    check(obj(observed) && observed.ownership === 'CONFIRMED' &&
      ['UNLISTED', 'PUBLIC', 'UNKNOWN'].includes(observed.listing) &&
      typeof observed.sourceRevision === 'string' && observed.sourceRevision.length > 0,
    'OWNERSHIP_UNKNOWN');
    return observed;
  }
  async function releaseAt(key) {
    const release = unwrap(await sourceCatalog.resolveRelease({ key }));
    check(obj(release) && HASH.test(release.releaseId) &&
      release.source?.status === 'READY' && release.source.ref === 'main' &&
      release.source.slug === key && COMMIT.test(release.source.commitSha),
    'NOT_APPLIED');
    check(await contentHash(release.files) === release.releaseId, 'SOURCE_DRIFT');
    return release;
  }
  async function previousRelease(generator) {
    if (!generator.releaseId) return null;
    const row = await storage.read('release', generator.releaseId);
    check(row.item && row.item.record.releaseId === generator.releaseId, 'RECOVERY_HOLD');
    return row.item.record;
  }
  async function observedBaseline(generator, context, observed, previous) {
    const fact = await facts.get(generator.key);
    if (fact) {
      check(fact.accountId === generator.accountId &&
        fact.personaUid === generator.personaUid &&
        fact.accountBindingEpoch === generator.accountBindingEpoch &&
        fact.ownershipObserved === true, 'STALE_BINDING');
      check(fact.acceptedSourceRevision === null ||
        fact.acceptedSourceRevision === observed.sourceRevision ||
        fact.ignoredVersion === observed.sourceRevision, 'SOURCE_DRIFT');
      check(fact.drift === null || fact.ignoredVersion === observed.sourceRevision, 'SOURCE_DRIFT');
    }
    if (previous) check(sameFiles(observed.files, previous.files), 'SOURCE_DRIFT');
    else if (!fact) {
      // No confirmed release and no inventory revision: never overwrite an
      // imported or potentially edited generator on a mere slug match.
      check(observed.listing === 'UNLISTED' && obj(observed.files) &&
        observed.files.pjs === '' && observed.files.html === '' &&
        observed.files.thumbnail instanceof Uint8Array && observed.files.thumbnail.length === 0,
      'SOURCE_DRIFT');
    }
  }
  async function update(opId, validPhases, phase, observation, generatorChange = null) {
    const operationRow = await storage.read('operation', opId);
    check(operationRow.item && validPhases.includes(operationRow.item.record.phase), 'RECOVERY_HOLD');
    const original = operationRow.item.record;
    const remoteEvidence = { ...(obj(original.remoteEvidence) ? original.remoteEvidence : {}),
      observation };
    const writes = [{ kind: 'operation', expectedRevision: operationRow.item.revision,
      record: { ...original, phase, remoteEvidence } }];
    if (generatorChange) {
      const row = await storage.read('generator', original.targetKey);
      check(row.revision === operationRow.revision, 'STALE_REVISION');
      check(row.item && row.item.record.accountBindingEpoch === original.accountBindingEpoch, 'STALE_BINDING');
      check(row.item.record.revision === generatorChange.expectedRevision, 'STALE_REVISION');
      writes.push({ kind: 'generator', expectedRevision: row.item.revision,
        record: { ...row.item.record, ...generatorChange.patch, asOf: now() } });
    }
    await storage.commit({ expectedRevision: operationRow.revision, writes });
    return op(opId);
  }
  async function stillSleeping(params, context) {
    await core.assertCurrent();
    return (await record(params, context)).generator;
  }
  async function step(action, parentId, params, context, observed, details) {
    await stillSleeping(params, context);
    const childId = parentId + '.' + action;
    check(!(await journal.read(childId)), 'RECOVERY_HOLD');
    const capabilityProof = await provider.probe(context);
    const capabilities = unwrap(capabilityProof);
    check(Array.isArray(capabilities) && capabilities.includes(
      action === 'save' || action === 'restore' ? 'generator.save' : 'generator.setPrivacy'
    ), 'UNSUPPORTED_CAPABILITY');
    await journal.prepare({ opId: childId, kind: action === 'restore' ? 'save' :
      action === 'unlist' ? 'setListing' : 'save',
      targetKey: params.key, sourceRevision: observed.sourceRevision,
      accountBindingEpoch: params.accountBindingEpoch });
    const common = { context, targetKey: params.key, opId: childId,
      expectedRevision: capabilityProof.revision,
      accountBindingEpoch: params.accountBindingEpoch,
      expectedSourceRevision: observed.sourceRevision };
    check(Number.isSafeInteger(common.expectedRevision) && common.expectedRevision >= 0,
      'UNSUPPORTED_CAPABILITY');
    const receipt = action === 'unlist'
      ? await provider.setListing({ ...common, listing: 'UNLISTED' })
      : await provider.save({ ...common, files: details.files });
    unwrap(receipt);
    const after = await providerRead(context, params.key);
    check(after.listing === 'UNLISTED', 'UNCERTAIN');
    if (action !== 'unlist') {
      check(sameFiles(after.files, details.files), 'UNCERTAIN');
      check(await contentHash(after.files) === details.releaseId, 'UNCERTAIN');
    }
    return after;
  }
  async function readyForApply(parent, params, context) {
    check(parent.kind === 'deployer.apply' && parent.phase === 'PREPARED' &&
      parent.targetKey === params.key && parent.accountBindingEpoch === params.accountBindingEpoch &&
      parent.sourceRevision === params.expectedRevision, 'RECOVERY_HOLD');
    const intent = parent.remoteEvidence?.intent;
    check(obj(intent) && HASH.test(intent.releaseId) && COMMIT.test(intent.commitSha) &&
      typeof intent.expectedProviderRevision === 'string', 'RECOVERY_HOLD');
    const current = (await releaseAt(params.key));
    check(current.releaseId === intent.releaseId &&
      current.source.commitSha === intent.commitSha, 'CONFLICT');
    const { generator } = await record(params, context);
    check(generator.releaseId === intent.previousReleaseId, 'CONFLICT');
    const old = await previousRelease(generator);
    const observed = await providerRead(context, params.key);
    check(observed.sourceRevision === intent.expectedProviderRevision, 'SOURCE_DRIFT');
    await observedBaseline(generator, context, observed, old);
    check(observed.listing !== 'UNKNOWN', 'RECOVERY_HOLD');
    return { intent, current, old, observed, generator };
  }
  async function quarantine(parent, params, context, observed, phase) {
    const { generator } = await record(params, context);
    check(observed.listing === 'UNLISTED', 'RECOVERY_HOLD');
    const intent = parent.remoteEvidence.intent;
    const mark = 'deployer.failed.' + intent.releaseId;
    const refs = [...new Set([...generator.attentionRefs, mark])];
    return update(parent.opId, phase === 'APPLIED' ? ['DISPATCHING'] : ['HELD'],
      phase, { disposition: 'ROLLED_BACK', sourceRevision: observed.sourceRevision,
        releaseId: generator.releaseId, listing: 'UNLISTED' }, {
        expectedRevision: generator.revision,
        patch: { deployState: 'QUARANTINED', refreshState: generator.releaseId ? 'SLEEPING' : 'INELIGIBLE',
          listingObserved: 'UNLISTED', attentionRefs: refs }
      });
  }
  async function restore(parent, params, context, finalPhase = 'FAILED') {
    const intent = parent.remoteEvidence?.intent;
    check(obj(intent) && HASH.test(intent.releaseId), 'RECOVERY_HOLD');
    await stillSleeping(params, context);
    let observed = await providerRead(context, params.key);
    check(observed.listing === 'UNLISTED', 'RECOVERY_HOLD');
    const previous = intent.previousReleaseId
      ? (await storage.read('release', intent.previousReleaseId)).item?.record : null;
    check(!intent.previousReleaseId || previous, 'RECOVERY_HOLD');
    const desired = (await storage.read('release', intent.releaseId)).item?.record;
    check(desired, 'RECOVERY_HOLD');
    const isPrior = previous && sameFiles(observed.files, previous.files);
    const isDesired = sameFiles(observed.files, desired.files);
    // An unexpected third source is not safe to overwrite or "fix".
    check(isPrior || isDesired || (!previous && isDesired), 'SOURCE_DRIFT');
    if (previous && !isPrior) {
      observed = await step('restore', parent.opId, params, context, observed, {
        files: previous.files, releaseId: previous.releaseId
      });
      check(sameFiles(observed.files, previous.files), 'UNCERTAIN');
    }
    return quarantine(parent, params, context, observed, finalPhase);
  }
  const service = {
    prepare(params = {}) { return run(async () => {
      const context = guard(params);
      await core.assertMutationAllowed();
      const { generator, row } = await record(params, context);
      const next = await releaseAt(params.key);
      check(generator.releaseId !== next.releaseId, 'NOT_APPLIED');
      check(!generator.attentionRefs.includes('deployer.failed.' + next.releaseId) ||
        params.options.manualRetry === true, 'CONFLICT');
      const pending = await storage.list('operation');
      check(!pending.items.some(item => item.record.targetKey === params.key &&
        OPEN.has(item.record.phase)), 'RECOVERY_HOLD');
      const previous = await previousRelease(generator);
      const observed = await providerRead(context, params.key);
      await observedBaseline(generator, context, observed, previous);
      check(observed.listing !== 'UNKNOWN' &&
        (previous !== null || observed.listing === 'UNLISTED'), 'RECOVERY_HOLD');
      await core.assertCurrent();
      const existing = await storage.read('release', next.releaseId);
      if (existing.item) check(existing.item.record.source.commitSha === next.source.commitSha &&
        sameFiles(existing.item.record.files, next.files), 'CONFLICT');
      const intent = { releaseId: next.releaseId, commitSha: next.source.commitSha,
        previousReleaseId: generator.releaseId,
        expectedProviderRevision: observed.sourceRevision, initialListing: observed.listing };
      const operation = { opId: params.opId, kind: 'deployer.apply', targetKey: params.key,
        sourceRevision: generator.revision, accountBindingEpoch: params.accountBindingEpoch,
        phase: 'PREPARED', startedAt: now(), remoteEvidence: { intent } };
      await storage.commit({ expectedRevision: row.revision, writes: [
        ...(!existing.item ? [{ kind: 'release', expectedRevision: 0, record: next }] : []),
        { kind: 'operation', expectedRevision: 0, record: operation }
      ] });
      return success(await op(params.opId));
    }); },
    apply(params = {}) { return run(async () => {
      const context = guard(params);
      const parent = await op(params.opId);
      const { intent, current, observed } = await readyForApply(parent, params, context);
      await core.assertCurrent();
      await update(parent.opId, ['PREPARED'], 'DISPATCHING', { disposition: 'STARTED' });
      let after = observed;
      try {
        if (after.listing === 'PUBLIC') after = await step('unlist', parent.opId, params, context, after);
        after = await step('save', parent.opId, params, context, after, {
          files: current.files, releaseId: current.releaseId
        });
        const generator = await stillSleeping(params, context);
        const completed = await update(parent.opId, ['DISPATCHING'], 'APPLIED', {
          sourceRevision: after.sourceRevision, releaseId: intent.releaseId,
          commitSha: intent.commitSha, listing: 'UNLISTED'
        }, { expectedRevision: generator.revision, patch: {
          deployState: 'STAGED', listingObserved: 'UNLISTED',
          refreshState: generator.releaseId ? 'SLEEPING' : 'INELIGIBLE'
        } });
        return success(completed);
      } catch (error) {
        const code = codeOf(error);
        const ambiguous = ['UNCERTAIN', 'SOURCE_DRIFT', 'RECOVERY_HOLD', 'STALE_BINDING',
          'OWNERSHIP_UNKNOWN', 'UNAVAILABLE', 'STALE_REVISION'].includes(code);
        try {
          await update(parent.opId, ['DISPATCHING'], ambiguous ? 'UNCERTAIN' : 'HELD',
            { disposition: code });
          if (!ambiguous) {
            const held = await op(parent.opId);
            await restore(held, params, context);
          }
        } catch {
          return failure('RECOVERY_HOLD');
        }
        return failure(ambiguous ? 'UNCERTAIN' : code);
      }
    }); },
    reconcile(params = {}) { return run(async () => {
      const context = guard(params);
      const parent = await op(params.opId);
      check(parent.kind === 'deployer.apply' && parent.targetKey === params.key &&
        ['PREPARED', 'UNCERTAIN', 'HELD'].includes(parent.phase), 'RECOVERY_HOLD');
      const intent = parent.remoteEvidence?.intent;
      check(obj(intent) && HASH.test(intent.releaseId), 'RECOVERY_HOLD');
      await record(params, context, false);
      const observed = await providerRead(context, params.key);
      const target = (await storage.read('release', intent.releaseId)).item?.record;
      const previous = intent.previousReleaseId
        ? (await storage.read('release', intent.previousReleaseId)).item?.record : null;
      check(target && (!intent.previousReleaseId || previous), 'RECOVERY_HOLD');
      // Reconcile with no external dispatch, never replay a possibly saved
      // remote operation or overwrite a third revision.
      if (observed.listing === 'UNLISTED' && sameFiles(observed.files, target.files)) {
        check(parent.phase !== 'PREPARED', 'RECOVERY_HOLD');
        const child = await storage.read('operation', parent.opId + '.save');
        if (child.item && ['UNCERTAIN', 'HELD'].includes(child.item.record.phase)) {
          check(child.item.record.kind === 'save' &&
            child.item.record.accountBindingEpoch === params.accountBindingEpoch,
            'RECOVERY_HOLD');
          await storage.commit({ expectedRevision: child.revision, writes: [{
            kind: 'operation', expectedRevision: child.item.revision,
            record: { ...child.item.record, phase: 'APPLIED', remoteEvidence: {
              disposition: 'READBACK_CONFIRMED', sourceRevision: observed.sourceRevision,
              listing: 'UNLISTED' } }
          }] });
        }
        const { generator } = await record(params, context);
        return success(await update(parent.opId, [parent.phase], 'APPLIED', {
          disposition: 'READBACK_CONFIRMED', sourceRevision: observed.sourceRevision,
          releaseId: target.releaseId, listing: 'UNLISTED'
        }, { expectedRevision: generator.revision, patch: {
          deployState: 'STAGED', listingObserved: 'UNLISTED',
          refreshState: generator.releaseId ? 'SLEEPING' : 'INELIGIBLE'
        } }));
      }
      if (previous && sameFiles(observed.files, previous.files) ||
          parent.phase === 'PREPARED' && observed.sourceRevision === intent.expectedProviderRevision) {
        const finalPhase = parent.phase === 'HELD' ? 'FAILED' : 'NOT_APPLIED';
        return success(await update(parent.opId, [parent.phase], finalPhase, {
          disposition: 'NO_DEPLOYMENT', sourceRevision: observed.sourceRevision,
          listing: observed.listing
        }));
      }
      throw new Rejected('RECOVERY_HOLD');
    }); },
    rollback(params = {}) { return run(async () => {
      const context = guard(params);
      let parent;
      if (params.options.originalOpId !== undefined) {
        opIdOf(params.options.originalOpId);
        const original = await op(params.options.originalOpId);
        check(original.phase === 'APPLIED' && original.kind === 'deployer.apply' &&
          original.targetKey === params.key && original.accountBindingEpoch === params.accountBindingEpoch,
        'CONFLICT');
        const { generator, row } = await record(params, context);
        check(!generator.attentionRefs.includes('deployer.failed.' +
          original.remoteEvidence.intent.releaseId), 'CONFLICT');
        check(!(await storage.read('operation', params.opId)).item, 'CONFLICT');
        const created = { opId: params.opId, kind: 'deployer.rollback',
          targetKey: params.key, sourceRevision: params.expectedRevision,
          accountBindingEpoch: params.accountBindingEpoch, phase: 'PREPARED',
          startedAt: now(), remoteEvidence: { intent: original.remoteEvidence.intent,
            originalOpId: original.opId } };
        await storage.commit({ expectedRevision: row.revision, writes: [
          { kind: 'operation', expectedRevision: 0, record: created }
        ] });
        parent = await update(params.opId, ['PREPARED'], 'DISPATCHING', {
          disposition: 'ROLLBACK_REQUESTED' });
        const restored = await restore(parent, params, context, 'APPLIED');
        return success(restored);
      }
      parent = await op(params.opId);
      check(parent.kind === 'deployer.apply' && parent.targetKey === params.key &&
        ['HELD', 'UNCERTAIN'].includes(parent.phase), 'RECOVERY_HOLD');
      if (parent.phase === 'UNCERTAIN') parent = await update(parent.opId,
        ['UNCERTAIN'], 'HELD', { disposition: 'RECONCILE_BEFORE_ROLLBACK' });
      return success(await restore(parent, params, context));
    }); }
  };
  return Object.freeze(service);
}
