// Data-only boundaries. Errors never include the rejected value or a provider error.
const MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Alpha record is invalid.',
  STALE_REVISION: 'Alpha storage revision changed.',
  STALE_BINDING: 'Alpha account binding changed.',
  CONFLICT: 'Alpha record conflicts with stored state.',
  RECOVERY_HOLD: 'Alpha storage requires recovery.',
  UNAVAILABLE: 'Alpha storage is unavailable.'
});

export class AlphaDataError extends Error {
  constructor(code, currentRevision) {
    super(MESSAGES[code] || MESSAGES.INVALID_REQUEST);
    this.name = 'AlphaDataError';
    this.code = code;
    this.retryable = false;
    if (Number.isSafeInteger(currentRevision)) this.currentRevision = currentRevision;
  }
}

export function requireData(condition, code = 'INVALID_REQUEST', revision) {
  if (!condition) throw new AlphaDataError(code, revision);
}

export function exact(value, required, optional = []) {
  requireData(value !== null && typeof value === 'object' && !Array.isArray(value));
  const proto = Object.getPrototypeOf(value);
  requireData(proto === Object.prototype || proto === null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  requireData(required.every(key => Object.hasOwn(descriptors, key)));
  for (const key of Reflect.ownKeys(descriptors)) {
    const d = descriptors[key];
    requireData(typeof key === 'string' && allowed.has(key) && d.enumerable && Object.hasOwn(d, 'value'));
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));
}

// This catches recognizable credential material, not arbitrary secrets hidden in prose.
// Callers must keep all credentials in the secret backend, including in source files.
export function noCredentials(value) {
  requireData(!/(?:\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(value));
  return value;
}

export function text(value, max = 4096, empty = false) {
  requireData(typeof value === 'string' && value.length <= max && (empty || value.length > 0));
  requireData(!value.includes('\u0000') && value.isWellFormed());
  return noCredentials(value);
}

export function id(value) {
  text(value, 256);
  requireData(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value));
  return value;
}

export function revision(value, minimum = 0) {
  requireData(Number.isSafeInteger(value) && value >= minimum);
  return value;
}

export function instant(value) {
  requireData(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value));
  const canonical = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
  const time = Date.parse(canonical);
  requireData(Number.isFinite(time) && new Date(time).toISOString() === canonical);
  return canonical;
}

export function member(value, allowed) {
  requireData(allowed.includes(value));
  return value;
}

export function relativePath(value, allowEmpty = false) {
  text(value, 1024, allowEmpty);
  if (value === '' && allowEmpty) return value;
  requireData(!/[\\\u0000-\u001f\u007f:%?#]/.test(value));
  requireData(value.split('/').every(p => p && p !== '.' && p !== '..' && p.trim() === p));
  return value;
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const CREDENTIAL_KEYS = /(?:password|passwd|credential|authorization|cookie|session(?:data|id|key|token)|(?:access|refresh|auth|api|private)?token|(?:api|private|secret)key|secret)/i;

/** Bounded JSON evidence only; no DOM objects, binary data, accessors or credentials. */
export function safeDetails(input) {
  let nodes = 0;
  const ancestors = new Set();
  function clone(value, depth) {
    requireData(++nodes <= 10000 && depth <= 16);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value, 65536, true);
    if (typeof value === 'number') { requireData(Number.isFinite(value)); return value; }
    requireData(value !== null && typeof value === 'object' && !ancestors.has(value));
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        requireData(value.length <= 1000);
        const d = Object.getOwnPropertyDescriptors(value);
        requireData(Reflect.ownKeys(d).length === value.length + 1);
        return Array.from({ length: value.length }, (_, i) => {
          requireData(d[i]?.enumerable && Object.hasOwn(d[i], 'value'));
          return clone(d[i].value, depth + 1);
        });
      }
      const keys = Reflect.ownKeys(value);
      requireData(keys.every(k => typeof k === 'string' && !UNSAFE_KEYS.has(k)));
      const data = exact(value, keys);
      return Object.fromEntries(keys.sort().map(key => {
        text(key, 128);
        // A reference is an opaque identifier, never credential material itself.
        if (key === 'secretRef') return [key, id(data[key])];
        requireData(!CREDENTIAL_KEYS.test(key.replace(/[^a-z]/gi, '')));
        return [key, clone(data[key], depth + 1)];
      }));
    } finally { ancestors.delete(value); }
  }
  const result = clone(input, 0);
  requireData(result !== null && typeof result === 'object' && !Array.isArray(result));
  return result;
}

// Stable serialization is for storage integrity, not the deployable ReleaseId algorithm.
export function canonical(value) {
  if (value instanceof Uint8Array) return JSON.stringify({ bytes: Array.from(value) });
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
