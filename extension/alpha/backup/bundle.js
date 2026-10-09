/** P205: read-only, explicitly UNENCRYPTED backup framing, never provider authority. */
export const BACKUP_FORMAT = 'personamonkey-pcms-alpha-backup';
export const BACKUP_VERSION = 1;
export const UNENCRYPTED_CONSENT = 'EXPORT UNENCRYPTED BACKUP';
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const te = new TextEncoder(), td = new TextDecoder('utf-8', { fatal: true });
const SHA = /^[0-9a-f]{64}$/;
const SENSITIVE = Object.freeze(['personaMonkey.cookies', 'personaMonkey.gmValues', 'personaMonkey.routeCredentials', 'alpha.githubCredential']);
const COMPONENTS = Object.freeze(['alpha.records', 'alpha.journal', 'personaMonkey.personas', 'personaMonkey.routes', 'personaMonkey.userscripts', 'personaMonkey.workflows', ...SENSITIVE, 'personaMonkey.activeSessions', 'personaMonkey.nativeCredentials', 'perchance.passwords']);
const CODES = new Set(['INVALID_BACKUP', 'INTEGRITY_MISMATCH', 'UNENCRYPTED_CONSENT_REQUIRED', 'EXPORT_UNAVAILABLE', 'BACKUP_TOO_LARGE', 'RECOVERY_HOLD']);
export class BackupError extends Error {
  constructor(code) { super('Backup operation failed (' + (CODES.has(code) ? code : 'INVALID_BACKUP') + ').'); this.name = 'BackupError'; this.code = CODES.has(code) ? code : 'INVALID_BACKUP'; }
}
function fail(code = 'INVALID_BACKUP') { throw new BackupError(code); }
function plain(x) { return x !== null && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null); }
function fields(x, names) {
  if (!plain(x) || Reflect.ownKeys(x).length !== names.length) fail();
  const ds = Object.getOwnPropertyDescriptors(x);
  if (!names.every(k => Object.hasOwn(ds, k) && ds[k].enumerable && Object.hasOwn(ds[k], 'value'))) fail();
  return x;
}
function bytes(x) { if (!(x instanceof Uint8Array) || x.byteLength > MAX_BACKUP_BYTES) fail('BACKUP_TOO_LARGE'); return new Uint8Array(x); }
function b64(x) {
  const b = bytes(x); let text = '';
  for (let i = 0; i < b.length; i += 8192) text += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(text);
}
function unb64(x) {
  if (typeof x !== 'string' || x.length > Math.ceil(MAX_BACKUP_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x)) fail();
  let v; try { v = atob(x); } catch { fail(); }
  const b = Uint8Array.from(v, c => c.charCodeAt(0));
  if (b64(b) !== x) fail();
  return b;
}
async function hash(value) {
  try { const v = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', value)); return Array.from(v, b => b.toString(16).padStart(2, '0')).join(''); }
  catch { fail('EXPORT_UNAVAILABLE'); }
}
const digest = x => hash(bytes(x));
function timestamp(x) {
  if (typeof x !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)) fail();
  try { if (new Date(x).toISOString() !== x) fail(); } catch { fail(); }
  return x;
}
function safeJsonClone(value, depth = 0, parents = new Set()) {
  if (depth > 32) fail();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Uint8Array) return { __alphaBackupU8: b64(value) };
  if (typeof value !== 'object' || value === null || parents.has(value)) fail();
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) fail();
      return value.map(v => safeJsonClone(v, depth + 1, parents));
    }
    if (!plain(value)) fail();
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '__alphaBackupU8' || key === '__proto__' || key === 'constructor' || key === 'prototype') fail();
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d.enumerable || !Object.hasOwn(d, 'value')) fail();
      out[key] = safeJsonClone(d.value, depth + 1, parents);
    }
    if (Object.getOwnPropertySymbols(value).length) fail();
    return out;
  } finally { parents.delete(value); }
}
function parseAlpha(x, depth = 0) {
  if (depth > 32) fail();
  if (Array.isArray(x)) return x.map(y => parseAlpha(y, depth + 1));
  if (plain(x)) {
    if (Object.hasOwn(x, '__alphaBackupU8')) { fields(x, ['__alphaBackupU8']); return unb64(x.__alphaBackupU8); }
    const o = Object.create(null);
    for (const [k, v] of Object.entries(x)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k)) fail();
      o[k] = parseAlpha(v, depth + 1);
    }
    return o;
  }
  if (x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) return x;
  fail();
}
function encodeAlpha(s) {
  if (!plain(s) || s.schemaVersion !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Array.isArray(s.records) || !Array.isArray(s.journal)) fail('EXPORT_UNAVAILABLE');
  return te.encode(JSON.stringify(safeJsonClone(s)));
}
function decodeAlpha(input) {
  let result;
  try { result = parseAlpha(JSON.parse(td.decode(input))); } catch { fail(); }
  if (!plain(result) || result.schemaVersion !== 1 || !Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.records) || !Array.isArray(result.journal)) fail();
  if (result.records.length > 1_000_000 || result.journal.length > 1024) fail();
  return result;
}
function normalizeAbsent(items) {
  if (!Array.isArray(items) || items.length > COMPONENTS.length) fail();
  const seen = new Set();
  return items.map(row => {
    fields(row, ['item', 'reason']);
    if (!COMPONENTS.includes(row.item) || seen.has(row.item) || !['UNAVAILABLE', 'NOT_AUTHORIZED', 'NOT_EXPORTED', 'UNSUPPORTED'].includes(row.reason)) fail();
    seen.add(row.item);
    return { item: row.item, reason: row.reason };
  });
}
function verifyManifest(m) {
  fields(m, ['version', 'encrypted', 'createdAt', 'hashes', 'absentItems']);
  if (m.version !== 1 || m.encrypted !== false) fail();
  timestamp(m.createdAt);
  if (!plain(m.hashes) || !SHA.test(m.hashes.alpha) || !SHA.test(m.hashes.personaMonkey)) fail();
  const keys = Object.keys(m.hashes);
  if (keys.some(k => !['alpha', 'personaMonkey', ...SENSITIVE].includes(k) || !SHA.test(m.hashes[k])) || keys.length > SENSITIVE.length + 2) fail();
  const absent = normalizeAbsent(m.absentItems);
  if (absent.some(x => x.item === 'alpha.records' || x.item === 'alpha.journal')) fail();
  if (absent.some(x => SENSITIVE.includes(x.item) && Object.hasOwn(m.hashes, x.item))) fail();
  return m;
}
function inventory(absent, sensitiveKeys) {
  const no = new Map(absent.map(x => [x.item, x.reason]));
  return COMPONENTS.map(item => Object.freeze({
    item,
    availability: no.has(item) ? 'UNAVAILABLE' : SENSITIVE.includes(item) && !sensitiveKeys.includes(item) ? 'UNAVAILABLE' : 'EXPORTED',
    reason: no.get(item) || null,
    restorableWithoutReconciliation: false
  }));
}
function fieldsSafeMap(input) {
  if (!plain(input) || Object.getOwnPropertySymbols(input).length) fail();
  const o = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (!SENSITIVE.includes(key)) fail();
    o[key] = bytes(value);
  }
  return o;
}
export async function encodeBackupFile(bundle) {
  fields(bundle, ['manifest', 'personaMonkey', 'alpha', 'authorizedSensitiveEntries']);
  const m = verifyManifest(bundle.manifest);
  const a = bytes(bundle.alpha), p = bytes(bundle.personaMonkey);
  decodeAlpha(a);
  const sensitive = fieldsSafeMap(bundle.authorizedSensitiveEntries);
  const expected = ['alpha', 'personaMonkey', ...Object.keys(sensitive)].sort();
  if (JSON.stringify(Object.keys(m.hashes).sort()) !== JSON.stringify(expected)) fail();
  if (await digest(a) !== m.hashes.alpha || await digest(p) !== m.hashes.personaMonkey) fail('INTEGRITY_MISMATCH');
  for (const [key, value] of Object.entries(sensitive)) if (await digest(value) !== m.hashes[key]) fail('INTEGRITY_MISMATCH');
  const envelope = { format: BACKUP_FORMAT, version: BACKUP_VERSION, manifest: m, manifestSha256: await hash(te.encode(JSON.stringify(m))), alpha: b64(a), personaMonkey: b64(p), authorizedSensitiveEntries: Object.fromEntries(Object.entries(sensitive).map(([k, v]) => [k, b64(v)])) };
  const output = te.encode(JSON.stringify(envelope));
  if (output.length > MAX_BACKUP_BYTES) fail('BACKUP_TOO_LARGE');
  return output;
}
export async function decodeBackupFile(file) {
  const data = bytes(file); let x;
  try { x = JSON.parse(td.decode(data)); } catch { fail(); }
  fields(x, ['format', 'version', 'manifest', 'manifestSha256', 'alpha', 'personaMonkey', 'authorizedSensitiveEntries']);
  if (x.format !== BACKUP_FORMAT || x.version !== BACKUP_VERSION || !SHA.test(x.manifestSha256)) fail();
  const m = verifyManifest(x.manifest);
  if (await hash(te.encode(JSON.stringify(m))) !== x.manifestSha256) fail('INTEGRITY_MISMATCH');
  if (!plain(x.authorizedSensitiveEntries)) fail();
  const sensitive = Object.create(null);
  for (const [k, v] of Object.entries(x.authorizedSensitiveEntries)) { if (!SENSITIVE.includes(k)) fail(); sensitive[k] = unb64(v); }
  const bundle = { manifest: m, alpha: unb64(x.alpha), personaMonkey: unb64(x.personaMonkey), authorizedSensitiveEntries: sensitive };
  await encodeBackupFile(bundle);
  const absent = new Map(m.absentItems.map(x => [x.item, x.reason]));
  if ((bundle.personaMonkey.length === 0) !== absent.has('personaMonkey.personas')) fail();
  for (const name of SENSITIVE) if (Boolean(sensitive[name]) === absent.has(name)) fail();
  return bundle;
}
/** Only exact, separately authorized read-only export callbacks are injectable. */
export function createBackupExporter({ alphaStorage, personaMonkeyExport = null, sensitiveExports = {}, clock = () => new Date().toISOString() } = {}) {
  if (typeof alphaStorage?.snapshot !== 'function' || (personaMonkeyExport !== null && typeof personaMonkeyExport !== 'function') || !plain(sensitiveExports) || typeof clock !== 'function') throw new TypeError('Unsupported backup source');
  if (Object.keys(sensitiveExports).some(k => !SENSITIVE.includes(k) || typeof sensitiveExports[k] !== 'function')) throw new TypeError('Unsupported sensitive export source');
  const unavailable = () => COMPONENTS.filter(x => x !== 'alpha.records' && x !== 'alpha.journal').map(item => ({ item, reason: 'UNAVAILABLE' }));
  async function build({ consent, includeSensitive = [] } = {}) {
    if (consent !== UNENCRYPTED_CONSENT) fail('UNENCRYPTED_CONSENT_REQUIRED');
    if (!Array.isArray(includeSensitive) || new Set(includeSensitive).size !== includeSensitive.length || includeSensitive.some(k => !SENSITIVE.includes(k))) fail();
    let snapshot;
    try { snapshot = await alphaStorage.snapshot(); } catch { fail('RECOVERY_HOLD'); }
    const alpha = encodeAlpha(snapshot);
    let personaMonkey = new Uint8Array(), includedItems = [];
    if (personaMonkeyExport) {
      let payload;
      try { payload = await personaMonkeyExport(); } catch { fail('EXPORT_UNAVAILABLE'); }
      if (!plain(payload) || !Array.isArray(payload.includedItems) || payload.includedItems.some(x => !COMPONENTS.includes(x) || !x.startsWith('personaMonkey.') || SENSITIVE.includes(x)) || new Set(payload.includedItems).size !== payload.includedItems.length) fail('EXPORT_UNAVAILABLE');
      personaMonkey = bytes(payload.bytes);
      if (!personaMonkey.length || !payload.includedItems.length || !payload.includedItems.includes('personaMonkey.personas')) fail('EXPORT_UNAVAILABLE');
      includedItems = payload.includedItems;
    }
    const entries = Object.create(null);
    for (const key of includeSensitive) {
      if (typeof sensitiveExports[key] !== 'function') fail('EXPORT_UNAVAILABLE');
      try { entries[key] = bytes(await sensitiveExports[key]()); } catch { fail('EXPORT_UNAVAILABLE'); }
      if (!entries[key].length) fail('EXPORT_UNAVAILABLE');
    }
    const absent = unavailable().filter(x => !includedItems.includes(x.item) && !Object.hasOwn(entries, x.item)).map(x => ({ item: x.item, reason: includeSensitive.includes(x.item) ? 'UNAVAILABLE' : SENSITIVE.includes(x.item) ? 'NOT_AUTHORIZED' : 'UNAVAILABLE' }));
    const m = { version: 1, encrypted: false, createdAt: timestamp(clock()), hashes: { alpha: await digest(alpha), personaMonkey: await digest(personaMonkey) }, absentItems: absent };
    for (const [key, value] of Object.entries(entries)) m.hashes[key] = await digest(value);
    const bundle = { manifest: m, alpha, personaMonkey, authorizedSensitiveEntries: entries };
    const file = await encodeBackupFile(bundle);
    return { bundle, file, inventory: inventory(absent, Object.keys(entries)), snapshotRevision: snapshot.revision };
  }
  return Object.freeze({
    previewExport() {
      const absent = unavailable().map(x => ({ item: x.item, reason: SENSITIVE.includes(x.item) ? 'NOT_AUTHORIZED' : x.reason }));
      return { encrypted: false, requiresExplicitConsent: true, availableFrom: ['alpha.records', 'alpha.journal'], potentiallyExportable: [ ...(personaMonkeyExport ? ['PersonaMonkey validated export only'] : []), ...Object.keys(sensitiveExports) ], unavailable: absent };
    },
    exportBackup: build,
    async stageRestore(file) {
      const bundle = await decodeBackupFile(file);
      const backupAlpha = decodeAlpha(bundle.alpha);
      let current;
      try { current = await alphaStorage.snapshot(); } catch { fail('RECOVERY_HOLD'); }
      return Object.freeze({
        verified: true,
        encrypted: false,
        createdAt: bundle.manifest.createdAt,
        schemaVersion: 1,
        backupRevision: backupAlpha.revision,
        currentRevision: current.revision,
        recordCount: backupAlpha.records.length,
        operationCount: backupAlpha.records.filter(x => x?.kind === 'operation').length,
        missing: bundle.manifest.absentItems.map(x => ({ ...x })),
        available: inventory(bundle.manifest.absentItems, Object.keys(bundle.authorizedSensitiveEntries)),
        proposedRecoveryState: 'RECOVERY_HOLD',
        requiresPersonaAndProviderReconciliation: true,
        applied: false
      });
    }
  });
}
