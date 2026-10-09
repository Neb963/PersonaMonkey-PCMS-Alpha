import { assertGitHubPath, createGitHubPathTemplates } from './paths.mjs';

const SHA = /^[a-f0-9]{40}$/;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const VALID_FAILURES = Object.freeze({
  INVALID_REQUEST: ['Invalid GitHub adapter request', false],
  WAITING_HUMAN: ['GitHub credentials or repository access require operator attention', false],
  CONFLICT: ['GitHub source changed; re-read before attempting a new write', false],
  RATE_LIMIT: ['GitHub request budget exhausted', true],
  UNAVAILABLE: ['GitHub is temporarily unavailable', true],
  UNCERTAIN: ['GitHub write outcome is ambiguous; reconcile branch HEAD before retry', false],
  NOT_APPLIED: ['GitHub source not present', false],
  UNSUPPORTED_CAPABILITY: ['Unsupported GitHub response', false]
});
function ok(result) { return {ok: true, result, revision: 0}; }
function failure(code) {
  const [message, retryable] = VALID_FAILURES[code];
  return {ok: false, error: {code, message, retryable}, revision: 0};
}
class AdapterFault extends Error { constructor(code) { super(code); this.code = code; } }
function reject(code) { throw new AdapterFault(code); }
const isSha = value => typeof value === 'string' && SHA.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function failIf(condition) { if (condition) reject('INVALID_REQUEST'); }
function validatePath(path, allowed) {
  try { assertGitHubPath(path); } catch { reject('INVALID_REQUEST'); }
  failIf(!allowed.has(path));
  return path;
}
function encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }
function encode64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(result);
}
function decode64(text, maxBytes) {
  if (typeof text !== 'string' || text.length > Math.ceil(maxBytes / 3) * 4 + 16 ||
      !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(text)) reject('UNSUPPORTED_CAPABILITY');
  let binary;
  try { binary = atob(text.replace(/[\r\n]/g, '')); } catch { reject('UNSUPPORTED_CAPABILITY'); }
  if (binary.length > maxBytes) reject('UNSUPPORTED_CAPABILITY');
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function limitedBody(response, maxBytes) {
  const header = response.headers.get('content-length');
  if (header !== null && (!/^\d+$/.test(header) || Number(header) > maxBytes)) reject('UNSUPPORTED_CAPABILITY');
  if (!response.body || typeof response.body.getReader !== 'function') {
    // Some deterministic fixtures expose text() without a stream.
    if (typeof response.text !== 'function') reject('UNSUPPORTED_CAPABILITY');
    const data = await response.text();
    if (new TextEncoder().encode(data).length > maxBytes) reject('UNSUPPORTED_CAPABILITY');
    return data;
  }
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) reject('UNSUPPORTED_CAPABILITY');
      length += value.length;
      if (length > maxBytes) reject('UNSUPPORTED_CAPABILITY');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  try { return new TextDecoder('utf-8', {fatal: true}).decode(out); }
  catch { reject('UNSUPPORTED_CAPABILITY'); }
}
function classifyStatus(status, headers, updatingRef = false) {
  if (status === 429 || (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after')))) return 'RATE_LIMIT';
  if (status === 401 || status === 403 || status === 404) return 'WAITING_HUMAN';
  if (status === 409 || (updatingRef && status === 422)) return 'CONFLICT';
  if (status >= 500 || status === 408) return 'UNAVAILABLE';
  return 'UNSUPPORTED_CAPABILITY';
}

/**
 * Frozen GitHubAdapter boundary. The caller must durably PREPARE opId before commit.
 * No local storage, PersonaMonkey browser authority, status parsing or retries occur here.
 */
export function createGitHubAdapter({
  repository = 'Neb963/per-gens', secretRef, resolveSecret, fetchImpl = globalThis.fetch,
  paths = {}, bindings, maxFileBytes = DEFAULT_MAX_BYTES, timeoutMs = 15000
} = {}) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(secretRef || '') ||
      typeof resolveSecret !== 'function' || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > DEFAULT_MAX_BYTES ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('Invalid GitHub adapter configuration');
  }
  // The operator's explicit folder/slug bindings are the entire path allowlist.
  // This prevents even syntactically safe requests from reading/writing unrelated docs.
  const templates = createGitHubPathTemplates(paths);
  if (!Array.isArray(bindings) || !bindings.length || bindings.length > 10000) {
    throw new TypeError('Explicit GitHub generator bindings are required');
  }
  const allowed = new Set(), folded = new Set();
  for (const binding of bindings) {
    const resolved = templates.resolve(binding);
    for (const path of Object.values(resolved)) {
      if (folded.has(path.toLowerCase())) throw new TypeError('Ambiguous generator bindings');
      folded.add(path.toLowerCase());
      allowed.add(path);
    }
  }
  const [owner, repo] = repository.split('/');
  assertGitHubPath(owner); assertGitHubPath(repo);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  function assertRepo(input, withRef = false) {
    failIf(!plain(input) || input.repository !== repository || (withRef && input.ref !== 'main'));
  }
  async function token() {
    let value;
    try { value = await resolveSecret(secretRef); } catch { reject('WAITING_HUMAN'); }
    if (typeof value !== 'string' || !value.length || /[\r\n\0]/.test(value)) reject('WAITING_HUMAN');
    return value;
  }
  async function request(bearer, method, endpoint, body, {updatingRef = false} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url + endpoint, {
          method, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
          headers: {'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${bearer}`},
          ...(body === undefined ? {} : {body: JSON.stringify(body)})
        });
      } catch { reject(updatingRef ? 'UNCERTAIN' : 'UNAVAILABLE'); }
      if (!response || typeof response.status !== 'number' || !response.headers?.get) reject(updatingRef ? 'UNCERTAIN' : 'UNSUPPORTED_CAPABILITY');
      if (response.status === 404 && method === 'GET' && endpoint.startsWith('/contents/')) return {missing: true};
      if (!response.ok) reject(classifyStatus(response.status, response.headers, updatingRef));
      let data;
      try { data = JSON.parse(await limitedBody(response, RESPONSE_LIMIT)); }
      catch (e) { if (updatingRef) reject('UNCERTAIN'); if (e instanceof AdapterFault) throw e; reject('UNSUPPORTED_CAPABILITY'); }
      return data;
    } finally { clearTimeout(timer); }
  }
  async function head(bearer) {
    const data = await request(bearer, 'GET', '/git/ref/heads/main');
    if (data?.object?.type !== 'commit' || !isSha(data.object.sha)) reject('UNSUPPORTED_CAPABILITY');
    return data.object.sha;
  }
  async function commitTree(bearer, commitSha) {
    const data = await request(bearer, 'GET', `/git/commits/${commitSha}`);
    if (!isSha(data?.tree?.sha)) reject('UNSUPPORTED_CAPABILITY');
    return data.tree.sha;
  }
  async function blobIdAt(bearer, path, sha) {
    const data = await request(bearer, 'GET', `/contents/${encodePath(path)}?ref=${sha}`);
    if (data?.missing) return null;
    if (data?.type !== 'file' || data.path !== path || !isSha(data.sha)) reject('UNSUPPORTED_CAPABILITY');
    return data.sha;
  }
  async function run(fn) {
    try { return ok(await fn()); }
    catch (e) { return failure(e instanceof AdapterFault ? e.code : 'UNAVAILABLE'); }
  }
  function assertPaths(paths) {
    failIf(!Array.isArray(paths) || paths.length < 1 || paths.length > 128);
    const clean = paths.map(path => validatePath(path, allowed));
    failIf(new Set(clean.map(path => path.toLowerCase())).size !== clean.length);
    return clean;
  }
  async function snapshot(input) {
    return run(async () => {
      assertRepo(input, true);
      const paths = assertPaths(input.paths);
      const bearer = await token();
      const commitSha = await head(bearer);
      const blobs = Object.create(null);
      for (const path of paths) {
        const id = await blobIdAt(bearer, path, commitSha);
        if (id !== null) blobs[path] = id;
      }
      return {commitSha, blobs};
    });
  }
  async function readBlob(input) {
    return run(async () => {
      assertRepo(input); failIf(!isSha(input.blobSha));
      const bearer = await token();
      const data = await request(bearer, 'GET', `/git/blobs/${input.blobSha}`);
      if (data?.sha !== input.blobSha || data?.encoding !== 'base64' ||
          !Number.isSafeInteger(data?.size) || data.size < 0 || data.size > maxFileBytes) reject('UNSUPPORTED_CAPABILITY');
      const bytes = decode64(data.content, maxFileBytes);
      if (bytes.length !== data.size) reject('UNSUPPORTED_CAPABILITY');
      return bytes;
    });
  }
  async function commit(input) {
    return run(async () => {
      assertRepo(input, true);
      failIf(!isSha(input.expectedHeadSha) || input.secretRef !== secretRef ||
        typeof input.opId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(input.opId) ||
        !plain(input.files) || !plain(input.expectedBlobs));
      const keys = assertPaths(Object.keys(input.files));
      failIf(Object.keys(input.expectedBlobs).length !== keys.length ||
          keys.some(path => !Object.hasOwn(input.expectedBlobs, path)));
      for (const path of keys) {
        failIf(!(input.files[path] instanceof Uint8Array) || input.files[path].byteLength > maxFileBytes ||
          !(input.expectedBlobs[path] === null || isSha(input.expectedBlobs[path])));
      }
      const bearer = await token();
      if (await head(bearer) !== input.expectedHeadSha) reject('CONFLICT');
      const baseTree = await commitTree(bearer, input.expectedHeadSha);
      for (const path of keys) {
        if (await blobIdAt(bearer, path, input.expectedHeadSha) !== input.expectedBlobs[path]) reject('CONFLICT');
      }
      // Stage unreachable objects first. The only mutation of main is the final non-forced CAS-like ref update.
      const entries = [];
      for (const path of keys) {
        const blob = await request(bearer, 'POST', '/git/blobs', {content: encode64(input.files[path]), encoding: 'base64'});
        if (!isSha(blob?.sha)) reject('UNSUPPORTED_CAPABILITY');
        entries.push({path, mode: '100644', type: 'blob', sha: blob.sha});
      }
      const tree = await request(bearer, 'POST', '/git/trees', {base_tree: baseTree, tree: entries});
      if (!isSha(tree?.sha)) reject('UNSUPPORTED_CAPABILITY');
      const created = await request(bearer, 'POST', '/git/commits', {
        message: `Fix live deployment: ${input.opId}`, tree: tree.sha, parents: [input.expectedHeadSha]
      });
      if (!isSha(created?.sha)) reject('UNSUPPORTED_CAPABILITY');
      // Detect a concurrent developer merge before the final write; the non-FF update rejects later races.
      if (await head(bearer) !== input.expectedHeadSha) reject('CONFLICT');
      await request(bearer, 'PATCH', '/git/refs/heads/main', {sha: created.sha, force: false}, {updatingRef: true});
      // A successful HTTP response does not substitute for authoritative branch readback.
      let observed;
      try { observed = await head(bearer); } catch { reject('UNCERTAIN'); }
      if (observed !== created.sha) reject('UNCERTAIN');
      return {commitSha: created.sha, blobs: Object.fromEntries(entries.map(entry => [entry.path, entry.sha]))};
    });
  }
  return Object.freeze({snapshot, readBlob, commit});
}
