import { createGitHubPathTemplates, assertGitHubPath } from '../../providers/github/paths.mjs';
import { normalizeGeneratorKey, normalizeSourceBinding, normalizeRelease } from '../../domain/records.js';

const SHA = /^[a-f0-9]{40}$/;
const RELEASE_HASH = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['BLOCKED', 'IN_DEVELOPMENT', 'READY']);
const FAILURES = Object.freeze({
  INVALID_REQUEST: ['Invalid source-catalog request', false],
  NOT_APPLIED: ['Requested source or deployable release is not available', false],
  UNSUPPORTED_CAPABILITY: ['Source data or provider response is unsupported', false],
  WAITING_HUMAN: ['GitHub access requires operator attention', false],
  CONFLICT: ['Source or local revision has changed', false],
  STALE_REVISION: ['Local revision has changed', false],
  STALE_BINDING: ['Generator account binding has changed', false],
  SOURCE_DRIFT: ['Confirmed source does not match its recorded revision', false],
  RECOVERY_HOLD: ['Local state requires reconciliation', false],
  RATE_LIMIT: ['GitHub request budget exhausted', true],
  UNAVAILABLE: ['Source catalog is temporarily unavailable', true]
});
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const isPlain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const success = (result, revision = 0) => ({ ok: true, result, revision });
const failed = (code, revision = 0) => {
  const [message, retryable] = FAILURES[code] || FAILURES.UNAVAILABLE;
  return { ok: false, error: { code: FAILURES[code] ? code : 'UNAVAILABLE', message, retryable }, revision };
};
class SourceFault extends Error { constructor(code) { super(code); this.code = code; } }
function reject(code) { throw new SourceFault(code); }
function requireValid(condition) { if (!condition) reject('INVALID_REQUEST'); }
function external(result) {
  if (!isPlain(result) || typeof result.ok !== 'boolean') reject('UNSUPPORTED_CAPABILITY');
  if (!result.ok) reject(typeof result.error?.code === 'string' && FAILURES[result.error.code] ? result.error.code : 'UNAVAILABLE');
  return result.result;
}
function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) reject('UNSUPPORTED_CAPABILITY');
  try { return decoder.decode(bytes); } catch { reject('UNSUPPORTED_CAPABILITY'); }
}

/** Exactly one valid standalone directive; malformed/ambiguous directives fail closed. */
export function parseDeploymentStatus(markdown) {
  if (typeof markdown !== 'string') return 'BLOCKED';
  const lines = markdown.split('\n');
  let selected = null;
  for (const line of lines) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (/^[ \t]*status\s*:/i.test(clean)) {
      const match = /^Status: (BLOCKED|IN_DEVELOPMENT|READY)$/.exec(clean);
      if (!match || selected !== null) return 'BLOCKED';
      selected = match[1];
    }
  }
  return selected || 'BLOCKED';
}

/** Framed byte hash: UTF-8 text bytes are preserved, JPEG is raw bytes; no docs/commit SHA. */
export async function canonicalReleaseId({ pjs, html, thumbnail }, digest = globalThis.crypto?.subtle) {
  if (!(pjs instanceof Uint8Array) || !(html instanceof Uint8Array) || !(thumbnail instanceof Uint8Array) ||
      thumbnail.length === 0 || !digest || typeof digest.digest !== 'function') {
    reject('INVALID_REQUEST');
  }
  // Fail closed on non-UTF-8 source; no newline, Unicode, BOM or whitespace rewriting.
  decode(pjs); decode(html);
  const components = [['pjs', pjs], ['html', html], ['thumbnail.jpeg', thumbnail]];
  const chunks = [encoder.encode('PCMS-ALPHA-RELEASE-V1\0')];
  let size = chunks[0].length;
  for (const [label, bytes] of components) {
    const name = encoder.encode(label + '\0');
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length));
    chunks.push(name, length, bytes);
    size += name.length + length.length + bytes.length;
  }
  const framed = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { framed.set(chunk, offset); offset += chunk.length; }
  let hash;
  try { hash = await digest.digest('SHA-256', framed); }
  catch { reject('UNAVAILABLE'); }
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/** Eligibility signal only; actual sleep, drift, ownership and operation gates belong to Deployer. */
export function hasNewDeployableRelease(source, confirmedReleaseId) {
  return !!source && source.status === 'READY' && RELEASE_HASH.test(source.releaseId || '') &&
    (confirmedReleaseId === null || RELEASE_HASH.test(confirmedReleaseId)) && source.releaseId !== confirmedReleaseId;
}

/** Read-only GitHub source inspection; optional P102 storage is used only for explicit local bind(). */
export function createSourceCatalog({ github, repository = 'Neb963/per-gens', mappings, paths = {},
  storage = null, clock = () => new Date().toISOString(), digest = globalThis.crypto?.subtle } = {}) {
  if (!github || typeof github.snapshot !== 'function' || typeof github.readBlob !== 'function' ||
      typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !Array.isArray(mappings) || mappings.length < 1 || mappings.length > 10000 ||
      typeof clock !== 'function') throw new TypeError('Invalid source catalog configuration');
  const templates = createGitHubPathTemplates(paths);
  const bySlug = new Map(), byFile = new Set();
  const entries = mappings.map(mapping => {
    if (!isPlain(mapping) || Object.keys(mapping).sort().join(',') !== 'folder,slug')
      throw new TypeError('An explicit folder and slug are required');
    const slug = normalizeGeneratorKey(mapping.slug);
    const resolved = templates.resolve({ folder: mapping.folder, slug });
    if (bySlug.has(slug)) throw new TypeError('Duplicate generator source slug');
    for (const file of Object.values(resolved)) {
      if (byFile.has(file.toLowerCase())) throw new TypeError('Ambiguous source path mapping');
      byFile.add(file.toLowerCase());
    }
    const root = assertGitHubPath(templates.templates.root.replace(/\{(folder|slug)\}/g, (_, k) => mapping[k]));
    const entry = Object.freeze({ slug, folder: mapping.folder, paths: resolved, root });
    bySlug.set(slug, entry);
    return entry;
  });
  const last = entries.length;
  const now = () => {
    const value = clock();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) reject('UNAVAILABLE');
    return value;
  };
  async function blob(blobSha) {
    if (!SHA.test(blobSha)) reject('UNSUPPORTED_CAPABILITY');
    const bytes = external(await github.readBlob({ repository, blobSha }));
    if (!(bytes instanceof Uint8Array)) reject('UNSUPPORTED_CAPABILITY');
    return bytes;
  }
  async function inspect(entry, snapshot) {
    const { commitSha, blobs } = snapshot;
    if (!SHA.test(commitSha) || !isPlain(blobs)) reject('UNSUPPORTED_CAPABILITY');
    const expected = Object.values(entry.paths);
    const found = {};
    for (const path of expected) if (Object.hasOwn(blobs, path)) {
      if (!SHA.test(blobs[path])) reject('UNSUPPORTED_CAPABILITY');
      found[path] = blobs[path];
    }
    let status = 'BLOCKED';
    const statusBlob = found[entry.paths.status];
    if (statusBlob) {
      const bytes = await blob(statusBlob);
      // A non-text status cannot establish readiness, but an adapter/network failure propagates.
      try { status = parseDeploymentStatus(decoder.decode(bytes)); } catch { status = 'BLOCKED'; }
    }
    let files = null, releaseId = null;
    if (status === 'READY' && ['pjs', 'html', 'thumbnail'].every(name => found[entry.paths[name]])) {
      const [pjs, html, thumbnail] = await Promise.all(['pjs', 'html', 'thumbnail'].map(name => blob(found[entry.paths[name]])));
      if (thumbnail.length && pjs.byteLength + html.byteLength <= 4 * 1024 * 1024 && thumbnail.byteLength <= 1024 * 1024) {
        // Invalid UTF-8 is not a deployable release; still report the literal READY directive.
        try {
          releaseId = await canonicalReleaseId({ pjs, html, thumbnail }, digest);
          files = { pjs: decode(pjs), html: decode(html), thumbnail };
        } catch (error) {
          if (!(error instanceof SourceFault) || !['INVALID_REQUEST', 'UNSUPPORTED_CAPABILITY'].includes(error.code)) throw error;
        }
      }
    }
    const binding = normalizeSourceBinding({ repository, ref: 'main', root: entry.root, folder: entry.folder,
      slug: entry.slug, commitSha, blobs: found, status, releaseId });
    return { binding, files };
  }
  async function selected(entriesToRead, expectedSha = null) {
    const paths = entriesToRead.flatMap(entry => Object.values(entry.paths));
    const snapshot = external(await github.snapshot({ repository, ref: 'main', paths }));
    if (!isPlain(snapshot) || !SHA.test(snapshot.commitSha) || !isPlain(snapshot.blobs)) reject('UNSUPPORTED_CAPABILITY');
    if (expectedSha !== null && expectedSha !== snapshot.commitSha) reject('CONFLICT');
    return Promise.all(entriesToRead.map(entry => inspect(entry, snapshot)));
  }
  async function run(fn) {
    try { return success(await fn()); }
    catch (error) { return failed(error?.code && FAILURES[error.code] ? error.code : 'UNAVAILABLE', error?.currentRevision || 0); }
  }
  function entryFor(key) {
    requireValid(typeof key === 'string' && bySlug.has(key));
    return bySlug.get(key);
  }
  async function single(key) { return (await selected([entryFor(key)]))[0]; }
  return Object.freeze({
    scan(params = {}) {
      return run(async () => {
        requireValid(isPlain(params) && Object.keys(params).every(key => ['cursor', 'limit'].includes(key)));
        const limit = params.limit === undefined ? 32 : params.limit;
        requireValid(Number.isSafeInteger(limit) && limit >= 1 && limit <= 32);
        let offset = 0, expectedSha = null;
        if (params.cursor !== undefined && params.cursor !== null) {
          const match = /^s1:([1-9][0-9]*):([a-f0-9]{40})$/.exec(params.cursor);
          requireValid(match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) < last);
          offset = Number(match[1]); expectedSha = match[2];
        }
        const page = entries.slice(offset, offset + limit);
        const inspected = await selected(page, expectedSha);
        const commitSha = inspected[0].binding.commitSha;
        return { items: inspected.map(item => item.binding), cursor: offset + limit < last ? `s1:${offset + limit}:${commitSha}` : null, asOf: now() };
      });
    },
    get(params = {}) {
      return run(async () => {
        requireValid(isPlain(params) && Object.keys(params).length === 1 && typeof params.key === 'string');
        return (await single(params.key)).binding;
      });
    },
    resolveRelease(params = {}) {
      return run(async () => {
        requireValid(isPlain(params) && Object.keys(params).length === 1 && typeof params.key === 'string');
        const { binding, files } = await single(params.key);
        if (!files || !binding.releaseId || binding.status !== 'READY') reject('NOT_APPLIED');
        return normalizeRelease({ releaseId: binding.releaseId, source: binding, files, createdAt: now() });
      });
    },
    bind(params = {}) {
      return run(async () => {
        requireValid(isPlain(params) && storage && typeof storage.read === 'function' && typeof storage.commit === 'function' &&
          typeof params.key === 'string' && Number.isSafeInteger(params.expectedRevision) && params.expectedRevision >= 0 &&
          Number.isSafeInteger(params.accountBindingEpoch) && params.accountBindingEpoch >= 1 &&
          typeof params.opId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(params.opId) &&
          (params.options === undefined || isPlain(params.options) && Object.keys(params.options).length === 0));
        const old = await storage.read('generator', params.key);
        if (!old?.item) reject('NOT_APPLIED');
        if (old.revision !== params.expectedRevision) reject('STALE_REVISION');
        if (old.item.record.accountBindingEpoch !== params.accountBindingEpoch) reject('STALE_BINDING');
        const binding = (await single(params.key)).binding;
        const prior = old.item.record.sourceBinding;
        if (prior && (prior.repository !== binding.repository || prior.folder !== binding.folder || prior.slug !== binding.slug))
          reject('CONFLICT');
        const result = await storage.commit({ expectedRevision: params.expectedRevision, writes: [{ kind: 'generator',
          expectedRevision: old.item.revision, record: { ...old.item.record, sourceBinding: binding } }] });
        return result.items[0].record.sourceBinding;
      });
    }
  });
}