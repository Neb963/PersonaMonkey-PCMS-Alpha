/** P301 new-reservation engine. P401 owns higher-level supply composition.
 * All browser effects remain behind the injected PersonaMonkey-owned P103 adapter.
 */
import { normalizeGenerator, normalizeGeneratorKey, normalizeSourceBinding } from '../../domain/records.js';
import { createGitHubPathTemplates } from '../../providers/github/paths.mjs';
import { collectAccountGenerators } from '../../providers/perchance/adapter.mjs';

const MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Invalid reservation request.', CONFLICT: 'Slug or source folder collision.',
  STALE_REVISION: 'Reservation state has changed.', STALE_BINDING: 'Account Persona binding has changed.',
  OWNERSHIP_UNKNOWN: 'Account ownership cannot be confirmed.',
  UNSUPPORTED_CAPABILITY: 'A required provider capability is unavailable.',
  WAITING_HUMAN: 'Operator intervention is required.', RECOVERY_HOLD: 'Reconciliation is required.',
  NOT_APPLIED: 'Remote reservation was not confirmed.', UNCERTAIN: 'Remote mutation outcome is ambiguous.',
  UNAVAILABLE: 'A provider or storage is unavailable.', RATE_LIMIT: 'Provider request budget exhausted.'
});
const fail = (code, revision = 0) => ({ ok: false, error: {
  code: MESSAGES[code] ? code : 'UNAVAILABLE', message: MESSAGES[code] || MESSAGES.UNAVAILABLE,
  retryable: code === 'UNAVAILABLE' || code === 'RATE_LIMIT'
}, revision });
const success = (result, revision) => ({ ok: true, result, revision });
const isPlain = x => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,89}$/;
const SHA = /^[a-f0-9]{40}$/;
const LIVE = new Set(['PREPARED', 'DISPATCHING', 'UNCERTAIN', 'HELD']);
class Fault extends Error { constructor(code) { super(code); this.code = code; } }
const check = (condition, code = 'INVALID_REQUEST') => { if (!condition) throw new Fault(code); };
const trusted = response => {
  check(isPlain(response) && typeof response.ok === 'boolean', 'UNSUPPORTED_CAPABILITY');
  if (!response.ok) throw new Fault(MESSAGES[response.error?.code] ? response.error.code : 'UNAVAILABLE');
  return response.result;
};
const timestamp = clock => {
  const value = clock();
  check(typeof value === 'string' && new Date(value).toISOString() === value, 'UNAVAILABLE');
  return value;
};
const validSlug = key => typeof key === 'string' &&
  (key === 'hub' || key.length >= 4 && key.length <= 80 &&
  /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(key));
function canonicalSlug(key) { check(validSlug(key)); normalizeGeneratorKey(key); return key; }
const intent = record => record?.remoteEvidence?.intent;
const marker = opId => '# Generator reservation\nStatus: BLOCKED\n\nReservation-Operation: ' + opId + '\n';

/** No 200-slot quota is imposed; limits here bound one client request in memory. */
export function parsePastedSlugs(input) {
  check(typeof input === 'string' && input.length <= 1024 * 1024);
  const keys = input.split(/[\s,;]+/).filter(Boolean);
  check(keys.length >= 1 && keys.length <= 10000);
  const seen = new Set();
  for (const key of keys) { canonicalSlug(key); check(!seen.has(key), 'CONFLICT'); seen.add(key); }
  return keys;
}

/** Only new P301 create reservations affect balancing, never imported inventory. */
export function selectReservationAccount(accounts, operations) {
  check(Array.isArray(accounts) && Array.isArray(operations));
  const eligible = accounts.filter(a => a.sessionState === 'VERIFIED')
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
  check(eligible.length > 0, 'WAITING_HUMAN');
  const counts = new Map(eligible.map(a => [a.accountId, 0]));
  for (const op of operations) {
    const i = intent(op);
    if (op.kind === 'create' && i?.reservation === 'P301' &&
        !['NOT_APPLIED', 'FAILED'].includes(op.phase) && counts.has(i.accountId)) {
      counts.set(i.accountId, counts.get(i.accountId) + 1);
    }
  }
  return eligible.reduce((best, a) => counts.get(a.accountId) < counts.get(best.accountId) ? a : best);
}

/** Connect P103's create journal to P102's strict durable Operation store.
 * P102 represents a null pre-create provider source revision as the string 'none'.
 */
export function createReservationJournal(storage) {
  check(storage && typeof storage.read === 'function' && typeof storage.commit === 'function');
  const get = async opId => {
    const row = await storage.read('operation', opId), record = row.item?.record;
    check(record?.kind === 'create' && intent(record)?.reservation === 'P301', 'RECOVERY_HOLD');
    return { row, record };
  };
  const update = async (opId, allowed, phase, observation, code) => {
    const { row, record } = await get(opId);
    check(allowed.includes(record.phase), 'RECOVERY_HOLD');
    const next = { ...record, phase,
      remoteEvidence: { ...record.remoteEvidence,
        ...(observation ? { observation } : {}) },
      ...(code ? { result: { code } } : {}) };
    await storage.commit({ expectedRevision: row.revision,
      writes: [{ kind: 'operation', expectedRevision: row.item.revision, record: next }] });
    return { ...next, sourceRevision: null };
  };
  return Object.freeze({
    async read(opId) {
      const row = await storage.read('operation', opId), record = row.item?.record;
      return record?.kind === 'create' && intent(record)?.reservation === 'P301' ?
        { ...record, sourceRevision: null } : null;
    },
    dispatch: opId => update(opId, ['PREPARED'], 'DISPATCHING'),
    complete: (opId, receipt) => {
      check(isPlain(receipt) && ['APPLIED','UNCERTAIN','HELD','FAILED'].includes(receipt.phase), 'RECOVERY_HOLD');
      // P102 does not allow DISPATCHING -> FAILED. Retain uncertain mutations in HELD.
      const phase = receipt.phase === 'FAILED' ? 'HELD' : receipt.phase;
      return update(opId, ['DISPATCHING'], phase, receipt.remoteEvidence ?? null,
        MESSAGES[receipt.code] ? receipt.code : undefined);
    }
  });
}

export function createReservationService({
  storage, perchance, github, contextForAccount, repository = 'Neb963/per-gens',
  secretRef, paths = {}, now = () => new Date().toISOString(),
  assertMutationAllowed = async () => {}
} = {}) {
  check(storage && ['read','list','commit'].every(k => typeof storage[k] === 'function') &&
    perchance && ['probe','listGenerators','create'].every(k => typeof perchance[k] === 'function') &&
    github && ['snapshot','readBlob','commit'].every(k => typeof github[k] === 'function') &&
    typeof contextForAccount === 'function' && typeof assertMutationAllowed === 'function' &&
    typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
    typeof secretRef === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(secretRef) && typeof now === 'function');
  const templates = createGitHubPathTemplates(paths), decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let lastRevision = 0;
  async function run(callback) {
    try { return await callback(); }
    catch (e) { return fail(MESSAGES[e?.code] ? e.code : 'UNAVAILABLE', lastRevision); }
  }
  const read = async (kind, key) => {
    const result = await storage.read(kind, key); lastRevision = result.revision; return result;
  };
  const list = async kind => {
    const result = await storage.list(kind); lastRevision = result.revision; return result;
  };
  const commit = async (revision, writes) => {
    const result = await storage.commit({ expectedRevision: revision, writes });
    lastRevision = result.revision; return result;
  };
  async function accountContext(account) {
    check(account?.sessionState === 'VERIFIED', 'WAITING_HUMAN');
    const context = await contextForAccount(Object.freeze({ ...account }));
    check(isPlain(context) && context.accountId === account.accountId &&
      context.personaUid === account.personaUid && context.epoch === account.epoch &&
      Number.isSafeInteger(context.routeRevision) && context.routeRevision >= 0 &&
      Number.isSafeInteger(context.capabilityRevision) && context.capabilityRevision >= 0, 'STALE_BINDING');
    return context;
  }
  const inventory = async context => {
    const page = trusted(await collectAccountGenerators(perchance, context));
    check(Array.isArray(page.items) && page.cursor === null, 'UNSUPPORTED_CAPABILITY');
    return page.items;
  };
  function location(key, folder) {
    const files = templates.resolve({ slug: key, folder });
    const root = templates.templates.root.replace(/\{(folder|slug)\}/g, (_, part) => part === 'folder' ? folder : key);
    return { files, root };
  }
  async function githubObservation(loc) {
    const state = trusted(await github.snapshot({
      repository, ref: 'main', paths: [loc.files.status]
    }));
    check(isPlain(state) && SHA.test(state.commitSha) && isPlain(state.blobs),
      'UNSUPPORTED_CAPABILITY');
    const sha = state.blobs[loc.files.status];
    if (sha === undefined) return { absent: true, commitSha: state.commitSha };
    check(SHA.test(sha), 'UNSUPPORTED_CAPABILITY');
    const bytes = trusted(await github.readBlob({ repository, blobSha: sha }));
    check(bytes instanceof Uint8Array, 'UNSUPPORTED_CAPABILITY');
    let text;
    try { text = decoder.decode(bytes); } catch { throw new Fault('UNSUPPORTED_CAPABILITY'); }
    return { absent: false, commitSha: state.commitSha, blobSha: sha, text };
  }
  async function transition(opId, phases, nextPhase, observation = null) {
    const row = await read('operation', opId);
    check(row.item && phases.includes(row.item.record.phase), 'RECOVERY_HOLD');
    const record = { ...row.item.record, phase: nextPhase,
      ...(observation ? { remoteEvidence: { ...row.item.record.remoteEvidence, observation } } : {}) };
    await commit(row.revision, [{ kind: 'operation', expectedRevision: row.item.revision, record }]);
    return record;
  }
  function newOp(opId, kind, key, epoch, data, sourceRevision = 'none') {
    return { opId, kind, targetKey: key, sourceRevision,
      accountBindingEpoch: epoch, phase: 'PREPARED', startedAt: timestamp(now),
      remoteEvidence: { intent: data } };
  }
  async function ensureGenerator(create, context) {
    const row = await read('generator', create.targetKey), reservation = intent(create);
    if (row.item) {
      const record = row.item.record;
      check(record.accountId === reservation.accountId &&
        record.personaUid === reservation.personaUid &&
        record.accountBindingEpoch === create.accountBindingEpoch &&
        (!record.sourceBinding || record.sourceBinding.folder === reservation.folder &&
        record.sourceBinding.repository === repository), 'CONFLICT');
      return record;
    }
    const record = normalizeGenerator({
      key: create.targetKey, accountId: context.accountId, personaUid: context.personaUid,
      accountBindingEpoch: context.epoch, fleetIntent: 'EXCLUDED', listingObserved: 'UNLISTED',
      deployState: 'RESERVED', refreshState: 'INELIGIBLE', sourceBinding: null, releaseId: null,
      revision: 0, asOf: timestamp(now), attentionRefs: []
    });
    await commit(row.revision, [{ kind: 'generator', expectedRevision: 0, record }]);
    return (await read('generator', create.targetKey)).item.record;
  }
  async function confirmedCreate(create) {
    const i = intent(create);
    check(create.kind === 'create' && i?.reservation === 'P301', 'INVALID_REQUEST');
    const account = (await read('account', i.accountId)).item?.record;
    check(account && account.personaUid === i.personaUid &&
      account.epoch === create.accountBindingEpoch, 'STALE_BINDING');
    const context = await accountContext(account), found =
      (await inventory(context)).find(e => e.key === create.targetKey);
    if (!found) {
      if (LIVE.has(create.phase)) await transition(create.opId, [create.phase], 'NOT_APPLIED',
        { absentInAccountInventory: true, at: timestamp(now) });
      throw new Fault('NOT_APPLIED');
    }
    check(found.readback.ownership === 'CONFIRMED' && found.readback.listing === 'UNLISTED' &&
      typeof found.readback.sourceRevision === 'string' && found.readback.sourceRevision.length > 0,
    'RECOVERY_HOLD');
    if (create.phase === 'PREPARED') await transition(create.opId, ['PREPARED'], 'DISPATCHING');
    if (create.phase !== 'APPLIED') await transition(create.opId,
      ['DISPATCHING','UNCERTAIN','HELD'], 'APPLIED',
      { ownership: 'CONFIRMED', listing: 'UNLISTED', sourceRevision: found.readback.sourceRevision });
    return { create: (await read('operation', create.opId)).item.record, context };
  }
  async function finalizeGitHub(create, githubOp, loc, observed) {
    check(!observed.absent && observed.text === marker(create.opId), 'CONFLICT');
    const i = intent(create);
    const account = (await read('account', i.accountId)).item?.record;
    check(account && account.personaUid === i.personaUid && account.epoch === create.accountBindingEpoch,
      'STALE_BINDING');
    const record = await ensureGenerator(create, await accountContext(account));
    const binding = normalizeSourceBinding({
      repository, ref: 'main', root: loc.root, folder: i.folder, slug: create.targetKey,
      commitSha: observed.commitSha, blobs: { [loc.files.status]: observed.blobSha },
      status: 'BLOCKED', releaseId: null
    });
    check(!record.sourceBinding || record.sourceBinding.folder === binding.folder &&
      record.sourceBinding.repository === binding.repository, 'CONFLICT');
    const currentOp = await read('operation', githubOp.opId);
    if (currentOp.item?.record.phase === 'APPLIED') {
      check((await read('generator', create.targetKey)).item?.record.sourceBinding?.folder === i.folder,
        'RECOVERY_HOLD');
      return currentOp.item.record;
    }
    if (currentOp.item?.record.phase === 'PREPARED')
      await transition(githubOp.opId, ['PREPARED'], 'DISPATCHING');
    const op = await read('operation', githubOp.opId), gen = await read('generator', create.targetKey);
    check(op.revision === gen.revision && ['DISPATCHING','UNCERTAIN','HELD'].includes(op.item?.record.phase),
      'RECOVERY_HOLD');
    await commit(op.revision, [
      { kind: 'generator', expectedRevision: gen.item.revision,
        record: { ...gen.item.record, sourceBinding: binding, asOf: timestamp(now) } },
      { kind: 'operation', expectedRevision: op.item.revision,
        record: { ...op.item.record, phase: 'APPLIED', remoteEvidence: {
          ...op.item.record.remoteEvidence, observation: {
            path: loc.files.status, commitSha: observed.commitSha, blobSha: observed.blobSha,
            reservationMarkerConfirmed: true
          }
        } } }
    ]);
    return (await read('operation', githubOp.opId)).item.record;
  }
  async function githubStage(create, reconcile = false) {
    const i = intent(create), loc = location(create.targetKey, i.folder);
    const account = (await read('account', i.accountId)).item?.record;
    check(account && account.epoch === create.accountBindingEpoch &&
      account.personaUid === i.personaUid, 'STALE_BINDING');
    await ensureGenerator(create, await accountContext(account));
    const rows = (await list('operation')).items.filter(row =>
      row.record.kind === 'reservation.github' && row.record.targetKey === create.targetKey &&
      intent(row.record)?.createOpId === create.opId);
    let latest = rows.at(-1)?.record;
    const snapshot = await githubObservation(loc);
    if (!snapshot.absent && snapshot.text !== marker(create.opId)) {
      if (latest && LIVE.has(latest.phase))
        await transition(latest.opId, [latest.phase], 'HELD');
      throw new Fault('CONFLICT');
    }
    if (!latest || latest.phase === 'NOT_APPLIED') {
      check(snapshot.absent, 'RECOVERY_HOLD');
      // Clearing an earlier uncertain write is insufficient if another target
      // still holds the Core. Admission happens before preparing the next op.
      await assertMutationAllowed();
      const index = rows.length + 1;
      const opId = create.opId + '.gh.' + index;
      check(ID.test(opId), 'INVALID_REQUEST');
      const before = await read('operation', opId);
      check(!before.item, 'CONFLICT');
      const prepared = newOp(opId, 'reservation.github', create.targetKey,
        create.accountBindingEpoch, { createOpId: create.opId, accountId: i.accountId, folder: i.folder }, snapshot.commitSha);
      await commit(before.revision, [{ kind: 'operation', expectedRevision: 0, record: prepared }]);
      latest = prepared;
    }
    if (latest.phase === 'APPLIED') {
      check(!snapshot.absent && snapshot.text === marker(create.opId), 'RECOVERY_HOLD');
      return finalizeGitHub(create, latest, loc, snapshot);
    }
    if (!snapshot.absent) return finalizeGitHub(create, latest, loc, snapshot);
    if (latest.phase !== 'PREPARED') {
      // Only explicit reconcile may start another GitHub attempt, and only
      // after a read proves that this operation's status document is absent.
      check(reconcile && ['DISPATCHING','UNCERTAIN','HELD'].includes(latest.phase), 'UNCERTAIN');
      await transition(latest.opId, [latest.phase], 'NOT_APPLIED',
        { missingAtCommitSha: snapshot.commitSha, path: loc.files.status });
      return githubStage(create, true);
    }
    await transition(latest.opId, ['PREPARED'], 'DISPATCHING');
    const receipt = await github.commit({
      repository, ref: 'main', expectedHeadSha: snapshot.commitSha,
      expectedBlobs: { [loc.files.status]: null },
      files: { [loc.files.status]: encoder.encode(marker(create.opId)) },
      opId: latest.opId, secretRef
    });
    if (!receipt?.ok) {
      await transition(latest.opId, ['DISPATCHING'], 'UNCERTAIN');
      throw new Fault('UNCERTAIN');
    }
    let readback;
    try { readback = await githubObservation(loc); }
    catch {
      await transition(latest.opId, ['DISPATCHING'], 'UNCERTAIN');
      throw new Fault('UNCERTAIN');
    }
    if (readback.absent || readback.text !== marker(create.opId)) {
      await transition(latest.opId, ['DISPATCHING'], 'UNCERTAIN');
      throw new Fault('UNCERTAIN');
    }
    return finalizeGitHub(create, latest, loc, readback);
  }
  function guard(params) {
    check(isPlain(params) && ID.test(params.opId) &&
      Number.isSafeInteger(params.expectedRevision) && params.expectedRevision >= 0 &&
      Number.isSafeInteger(params.accountBindingEpoch) && params.accountBindingEpoch >= 1 &&
      (params.options === undefined || isPlain(params.options) &&
      Object.keys(params.options).every(k => k === 'folder')));
    return canonicalSlug(params.key);
  }
  return Object.freeze({
    preview(params = {}) {
      return run(async () => {
        check(isPlain(params) && typeof params.key === 'string' &&
          Object.keys(params).every(k => k === 'key'));
        return success(parsePastedSlugs(params.key), lastRevision);
      });
    },
    reserve(params = {}) {
      return run(async () => {
        const key = guard(params), folder = params.options?.folder ?? key;
        const loc = location(key, folder);
        await assertMutationAllowed();
        const accounts = await list('account'), generators = await list('generator'),
          operations = await list('operation');
        check(accounts.revision === generators.revision && accounts.revision === operations.revision &&
          accounts.revision === params.expectedRevision, 'STALE_REVISION');
        check(!generators.items.some(r => r.record.key === key ||
          r.record.sourceBinding?.folder === folder && r.record.sourceBinding.repository === repository),
        'CONFLICT');
        check(!operations.items.some(r => r.record.opId === params.opId ||
          r.record.targetKey === key && ['create','reservation.github'].includes(r.record.kind)), 'CONFLICT');
        const available = accounts.items.map(r => r.record);
        const chosen = selectReservationAccount(available, operations.items.map(r => r.record));
        check(chosen.epoch === params.accountBindingEpoch, 'STALE_BINDING');
        // Check full authenticated inventory for *every* eligible account; absence
        // in a public listing is never ownership or availability evidence.
        for (const account of available) {
          const context = await accountContext(account);
          check(!(await inventory(context)).some(row => row.key === key), 'CONFLICT');
        }
        check((await githubObservation(loc)).absent, 'CONFLICT');
        const context = await accountContext(chosen);
        const probe = await perchance.probe(context);
        const capabilities = trusted(probe);
        check(Array.isArray(capabilities) && capabilities.includes('generator.create') &&
          capabilities.includes('generator.list') && Number.isSafeInteger(probe.revision) &&
          probe.revision >= 0, 'UNSUPPORTED_CAPABILITY');
        const before = await read('operation', params.opId);
        check(!before.item && before.revision === params.expectedRevision, 'STALE_REVISION');
        const prepared = newOp(params.opId, 'create', key, chosen.epoch, {
          reservation: 'P301', accountId: chosen.accountId, personaUid: chosen.personaUid, folder
        });
        await commit(before.revision, [{ kind: 'operation', expectedRevision: 0, record: prepared }]);
        const created = await perchance.create({
          context, targetKey: key, opId: params.opId, expectedRevision: probe.revision,
          accountBindingEpoch: chosen.epoch, expectedSourceRevision: null
        });
        if (!created?.ok) throw new Fault(MESSAGES[created?.error?.code] ?
          created.error.code : 'UNCERTAIN');
        check(created.result?.ownership === 'CONFIRMED' && created.result.listing === 'UNLISTED' &&
          typeof created.result.sourceRevision === 'string' && created.result.sourceRevision.length > 0,
        'RECOVERY_HOLD');
        const op = (await read('operation', params.opId)).item?.record;
        check(op?.phase === 'APPLIED', 'RECOVERY_HOLD');
        return success(await githubStage(op), lastRevision);
      });
    },
    reconcile(params = {}) {
      return run(async () => {
        const key = guard(params), op = (await read('operation', params.opId)).item?.record;
        check(op && op.kind === 'create' && op.targetKey === key &&
          intent(op)?.reservation === 'P301' && op.accountBindingEpoch === params.accountBindingEpoch,
        'INVALID_REQUEST');
        const confirmed = await confirmedCreate(op);
        return success(await githubStage(confirmed.create, true), lastRevision);
      });
    }
  });
}
