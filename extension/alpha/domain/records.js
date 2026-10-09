import { exact, id, text, revision, instant, member, relativePath, safeDetails, requireData, canonical } from './validation.js';

export const RECORD_KINDS = Object.freeze(['account', 'generator', 'release', 'operation']);
export const OPERATION_PHASES = Object.freeze(['PREPARED', 'DISPATCHING', 'APPLIED', 'NOT_APPLIED', 'UNCERTAIN', 'FAILED', 'HELD']);
const HASH = /^[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function normalizeGeneratorKey(value) {
  // Preserve the pinned donor's accepted slug grammar; reject noncanonical aliases.
  requireData(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(value));
  return value;
}

function hash(value) { requireData(typeof value === 'string' && HASH.test(value)); return value; }
function gitSha(value) { requireData(typeof value === 'string' && GIT_SHA.test(value)); return value; }
function nullableHash(value) { return value === null ? null : hash(value); }

/** @returns {import('../contracts/index.d.ts').AccountRecord} */
export function normalizeAccount(input) {
  const r = exact(input, ['accountId', 'personaUid', 'epoch', 'name', 'sessionState', 'revision', 'asOf']);
  return { accountId: id(r.accountId), personaUid: id(r.personaUid), epoch: revision(r.epoch, 1),
    name: text(r.name, 256), sessionState: member(r.sessionState, ['VERIFIED', 'UNKNOWN', 'WAITING_HUMAN']),
    revision: revision(r.revision), asOf: instant(r.asOf) };
}

/** @returns {import('../contracts/index.d.ts').SourceBinding} */
export function normalizeSourceBinding(input) {
  const r = exact(input, ['repository', 'ref', 'root', 'folder', 'slug', 'commitSha', 'blobs', 'status', 'releaseId']);
  text(r.repository, 256);
  requireData(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.repository));
  requireData(r.ref === 'main');
  requireData(r.blobs && typeof r.blobs === 'object' && !Array.isArray(r.blobs));
  const keys = Reflect.ownKeys(r.blobs);
  requireData(keys.length <= 64 && keys.every(k => typeof k === 'string' && !['__proto__', 'prototype', 'constructor'].includes(k)));
  const blobs = exact(r.blobs, keys);
  return { repository: r.repository, ref: 'main', root: relativePath(r.root, true), folder: relativePath(r.folder),
    slug: normalizeGeneratorKey(r.slug), commitSha: gitSha(r.commitSha),
    blobs: Object.fromEntries(keys.sort().map(k => [relativePath(k), gitSha(blobs[k])])),
    status: member(r.status, ['BLOCKED', 'IN_DEVELOPMENT', 'READY']), releaseId: nullableHash(r.releaseId) };
}

/** @returns {import('../contracts/index.d.ts').GeneratorRecord} */
export function normalizeGenerator(input) {
  const r = exact(input, ['key', 'accountId', 'personaUid', 'accountBindingEpoch', 'fleetIntent', 'listingObserved',
    'deployState', 'refreshState', 'sourceBinding', 'releaseId', 'revision', 'asOf', 'attentionRefs']);
  const key = normalizeGeneratorKey(r.key);
  const sourceBinding = r.sourceBinding === null ? null : normalizeSourceBinding(r.sourceBinding);
  requireData(sourceBinding === null || sourceBinding.slug === key);
  requireData(Array.isArray(r.attentionRefs) && r.attentionRefs.length <= 256);
  const refs = safeDetails({ refs: r.attentionRefs }).refs.map(id);
  requireData(new Set(refs).size === refs.length);
  return { key, accountId: id(r.accountId), personaUid: id(r.personaUid), accountBindingEpoch: revision(r.accountBindingEpoch, 1),
    fleetIntent: member(r.fleetIntent, ['MANAGED', 'EXCLUDED']), listingObserved: member(r.listingObserved, ['PUBLIC', 'UNLISTED', 'UNKNOWN']),
    deployState: id(r.deployState), refreshState: id(r.refreshState), sourceBinding, releaseId: nullableHash(r.releaseId),
    revision: revision(r.revision), asOf: instant(r.asOf), attentionRefs: refs };
}

/** @returns {import('../contracts/index.d.ts').ReleaseRecord} */
export function normalizeRelease(input) {
  const r = exact(input, ['releaseId', 'source', 'files', 'createdAt']);
  const releaseId = hash(r.releaseId), source = normalizeSourceBinding(r.source);
  requireData(source.releaseId === releaseId);
  const files = exact(r.files, ['pjs', 'html', 'thumbnail']);
  const pjs = text(files.pjs, 4 * 1024 * 1024, true), html = text(files.html, 4 * 1024 * 1024, true);
  // These are local memory bounds inherited from the donor, not provider quotas.
  requireData(new TextEncoder().encode(pjs).length + new TextEncoder().encode(html).length <= 4 * 1024 * 1024);
  requireData(files.thumbnail instanceof Uint8Array && Object.getPrototypeOf(files.thumbnail) === Uint8Array.prototype);
  requireData(files.thumbnail.length > 0 && files.thumbnail.length <= 1024 * 1024);
  return { releaseId, source, files: { pjs, html, thumbnail: new Uint8Array(files.thumbnail) }, createdAt: instant(r.createdAt) };
}

/** @returns {import('../contracts/index.d.ts').Operation} */
export function normalizeOperation(input) {
  const r = exact(input, ['opId', 'kind', 'targetKey', 'sourceRevision', 'accountBindingEpoch', 'phase', 'startedAt'], ['result', 'remoteEvidence']);
  const sourceRevision = typeof r.sourceRevision === 'number' ? revision(r.sourceRevision) : text(r.sourceRevision, 256);
  return { opId: id(r.opId), kind: id(r.kind), targetKey: id(r.targetKey), sourceRevision,
    accountBindingEpoch: revision(r.accountBindingEpoch, 1), phase: member(r.phase, OPERATION_PHASES), startedAt: instant(r.startedAt),
    ...(Object.hasOwn(r, 'result') ? { result: safeDetails(r.result) } : {}),
    ...(Object.hasOwn(r, 'remoteEvidence') ? { remoteEvidence: safeDetails(r.remoteEvidence) } : {}) };
}

export function normalizeRecord(kind, record) {
  member(kind, RECORD_KINDS);
  return ({ account: normalizeAccount, generator: normalizeGenerator, release: normalizeRelease, operation: normalizeOperation })[kind](record);
}

export function recordKey(kind, record) {
  return record[{ account: 'accountId', generator: 'key', release: 'releaseId', operation: 'opId' }[member(kind, RECORD_KINDS)]];
}

export function normalizeRecordKey(kind, key) {
  member(kind, RECORD_KINDS);
  return kind === 'generator' ? normalizeGeneratorKey(key) : kind === 'release' ? hash(key) : id(key);
}

const TRANSITIONS = Object.freeze({
  PREPARED: ['DISPATCHING', 'NOT_APPLIED', 'FAILED', 'HELD'],
  DISPATCHING: ['APPLIED', 'NOT_APPLIED', 'UNCERTAIN', 'HELD'],
  UNCERTAIN: ['APPLIED', 'NOT_APPLIED', 'HELD'],
  HELD: ['APPLIED', 'NOT_APPLIED', 'FAILED'],
  APPLIED: [], NOT_APPLIED: [], FAILED: []
});

export function assertRecordUpdate(kind, previous, next) {
  if (!previous) {
    if (kind === 'operation') requireData(next.phase === 'PREPARED', 'CONFLICT');
    return;
  }
  if (kind === 'release') requireData(canonical(previous) === canonical(next), 'CONFLICT');
  if (kind === 'account') {
    requireData(next.epoch >= previous.epoch, 'STALE_BINDING');
    requireData(next.personaUid === previous.personaUid || next.epoch > previous.epoch, 'STALE_BINDING');
  }
  if (kind === 'operation') {
    for (const field of ['opId', 'kind', 'targetKey', 'sourceRevision', 'accountBindingEpoch', 'startedAt'])
      requireData(previous[field] === next[field], 'CONFLICT');
    requireData(TRANSITIONS[previous.phase].includes(next.phase), 'CONFLICT');
    if (['UNCERTAIN', 'HELD'].includes(previous.phase) && ['APPLIED', 'NOT_APPLIED'].includes(next.phase))
      requireData(next.remoteEvidence && Object.keys(next.remoteEvidence).length > 0, 'CONFLICT');
  }
}
