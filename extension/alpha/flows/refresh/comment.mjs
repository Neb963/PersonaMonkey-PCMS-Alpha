/** Exact, transient PJS-only source comment. Never part of the GitHub release. */
import { canonicalReleaseId } from '../../features/sources/catalog.mjs';
const encoder = new TextEncoder();
const hex = value => [...new Uint8Array(value)].map(b => b.toString(16).padStart(2, '0')).join('');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (yes, code = 'SOURCE_DRIFT') => { if (!yes) fail(code); };
const bytesEqual = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array &&
  a.length === b.length && a.every((v, i) => v === b[i]);
const filesOK = value => value && typeof value.pjs === 'string' &&
  typeof value.html === 'string' && value.thumbnail instanceof Uint8Array;

export async function hashPjs(source) {
  check(typeof source === 'string' && typeof globalThis.crypto?.subtle?.digest === 'function',
    'UNSUPPORTED_CAPABILITY');
  return hex(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(source)));
}

/** Only a previously recorded, byte-exact suffix may be removed. */
export async function canonicalPjs(readbackFiles, release, previous = null) {
  check(filesOK(readbackFiles) && filesOK(release?.files) &&
    /^[a-f0-9]{64}$/.test(release.releaseId));
  check(readbackFiles.html === release.files.html &&
    bytesEqual(readbackFiles.thumbnail, release.files.thumbnail));
  let base = readbackFiles.pjs;
  if (previous !== null) {
    check(previous.targetKey === release.source?.slug);
    check(previous && typeof previous.insertionBytes === 'string' &&
      typeof previous.insertionOffset === 'number' &&
      Number.isSafeInteger(previous.insertionOffset) && previous.insertionOffset >= 0 &&
      /^[a-f0-9]{64}$/.test(previous.sourceBeforeHash) &&
      /^[a-f0-9]{64}$/.test(previous.sourceAfterHash));
    check(await hashPjs(base) === previous.sourceAfterHash &&
      base.endsWith(previous.insertionBytes));
    base = base.slice(0, base.length - previous.insertionBytes.length);
    check(encoder.encode(base).length === previous.insertionOffset &&
      await hashPjs(base) === previous.sourceBeforeHash);
  }
  check(base === release.files.pjs);
  const hash = await canonicalReleaseId({
    pjs: encoder.encode(base), html: encoder.encode(readbackFiles.html),
    thumbnail: readbackFiles.thumbnail
  });
  check(hash === release.releaseId);
  return base;
}

export async function prepareRefreshComment(readbackFiles, release, previous, token) {
  check(typeof token === 'string' && /^[a-z0-9-]{1,64}$/.test(token), 'INVALID_REQUEST');
  const base = await canonicalPjs(readbackFiles, release, previous);
  const insertionBytes = '\n/* PCMS_REFRESH:' + token + ' */';
  const pjs = base + insertionBytes;
  const comment = {
    targetKey: release.source?.slug ?? null,
    insertionBytes,
    insertionOffset: encoder.encode(base).length,
    sourceBeforeHash: await hashPjs(base),
    sourceAfterHash: await hashPjs(pjs),
    saveReceipt: null,
    sourceRevision: null
  };
  return {
    files: { pjs, html: readbackFiles.html, thumbnail: new Uint8Array(readbackFiles.thumbnail) },
    comment
  };
}
