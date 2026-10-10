/** P405: local, explicitly unencrypted Firefox downloads and ID-fenced retention.
 * This is a Core-owned service; caller must serialize calls in the Alpha background.
 */
export const BACKUP_FOLDER = 'PersonaMonkey-PCMS-Alpha-backups';
const MAX_TRACKED = 256;
const MAX_BYTES = 128 * 1024 * 1024;
const fail = code => { const error = new Error(`Backup downloads (${code}).`); error.code = code; throw error; };
const validId = x => Number.isSafeInteger(x) && x >= 0;
const safeStamp = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString() === x;
const ownFilename = f => typeof f === 'string' && f.replaceAll('\\','/').split('/').includes(BACKUP_FOLDER) && /\/personamonkey-pcms-alpha-\d{8}T\d{6}-[a-f0-9]{12}\.json$/.test(f.replaceAll('\\','/'));
const current = x => typeof x === 'object' && x !== null && x.version === 1 && Array.isArray(x.entries) && x.entries.length <= MAX_TRACKED && x.entries.every(e => validId(e.id) && safeStamp(e.createdAt) && ['PENDING', 'COMPLETE', 'INTERRUPTED', 'UNKNOWN', 'REMOVED'].includes(e.state) && typeof e.filename === 'string' && ownFilename('/' + e.filename)) && new Set(x.entries.map(e=>e.id)).size === x.entries.length;
const clone = entries => ({ version: 1, entries: entries.map(e => ({ ...e })) });

export function createBackupDownloads({ downloads, manifestStore, makeBlobUrl, revokeBlobUrl, clock = () => new Date().toISOString(), random = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12), maxComplete = 7 } = {}) {
  if (typeof downloads?.download !== 'function' || typeof downloads?.search !== 'function' || typeof downloads?.removeFile !== 'function' || typeof manifestStore?.read !== 'function' || typeof manifestStore?.write !== 'function' || typeof makeBlobUrl !== 'function' || typeof revokeBlobUrl !== 'function' || typeof clock !== 'function' || typeof random !== 'function' || !Number.isInteger(maxComplete) || maxComplete < 1 || maxComplete > 90) throw new TypeError('P405 requires authorized download and durable tracking ports');
  let queue = Promise.resolve();
  const serialized = task => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };
  async function load() { let data; try { data = await manifestStore.read(); } catch { fail('RECOVERY_HOLD'); } if (data == null) return clone([]); if (!current(data)) fail('RECOVERY_HOLD'); return clone(data.entries); }
  async function save(x) { if (!current(x)) fail('RECOVERY_HOLD'); try { await manifestStore.write(x); } catch { fail('RECOVERY_HOLD'); } }
  async function find(id) { try { const rows = await downloads.search({id}); return Array.isArray(rows) ? rows.find(row => row.id === id) ?? null : null; } catch { return null; } }
  function classify(row, entry) { if (!row || !ownFilename(row.filename) || !row.filename.replaceAll('\\','/').endsWith('/' + entry.filename)) return 'UNKNOWN'; return row.state === 'complete' ? 'COMPLETE' : row.state === 'interrupted' ? 'INTERRUPTED' : 'PENDING'; }
  async function inspect() {
    const state = await load(), warnings = [];
    for (const entry of state.entries) {
      if (entry.state === 'REMOVED') continue;
      const next = classify(await find(entry.id), entry);
      // A previously complete file must not be silently demoted by transient
      // history queries; this is a warning, never permission to delete.
      if (entry.state === 'COMPLETE' && next === 'UNKNOWN') warnings.push('KNOWN_DOWNLOAD_UNVERIFIABLE');
      else entry.state = next;
      if (next === 'UNKNOWN') warnings.push('KNOWN_DOWNLOAD_UNVERIFIABLE');
    }
    return { state, warnings };
  }
  async function discoverUnknown(known) {
    try {
      const rows = await downloads.search({query: [BACKUP_FOLDER], limit: 1000});
      if (!Array.isArray(rows)) return {count: null, warning: 'UNTRACKED_FILES_NOT_ENUMERABLE'};
      return {count: rows.filter(x => typeof x.filename === 'string' && x.filename.replaceAll('\\','/').split('/').includes(BACKUP_FOLDER) && !known.has(x.id)).length, warning: 'UNTRACKED_FILES_NOT_ENUMERABLE'};
    } catch { return {count: null, warning: 'UNTRACKED_FILES_NOT_ENUMERABLE'}; }
  }
  async function maintain() {
    const { state, warnings } = await inspect();
    const active = state.entries.filter(x => x.state === 'COMPLETE').sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id-a.id);
    const old = active.slice(maxComplete);
    for (const entry of old) {
      const row = await find(entry.id);
      if (classify(row, entry) !== 'COMPLETE') { warnings.push('KNOWN_DOWNLOAD_UNVERIFIABLE'); continue; }
      try { await downloads.removeFile(entry.id); entry.state = 'REMOVED'; }
      catch { warnings.push('KNOWN_FILE_DELETE_FAILED'); }
    }
    await save(state);
    const unknown = await discoverUnknown(new Set(state.entries.map(x=>x.id)));
    if (unknown.count) warnings.push('UNKNOWN_DOWNLOADS_LEFT_UNTOUCHED');
    warnings.push(unknown.warning); // Download history cannot prove folder completeness.
    return Object.freeze({retained:state.entries.filter(x=>x.state === 'COMPLETE').length, pending:state.entries.filter(x=>x.state === 'PENDING').length, unknownCount:unknown.count, warnings:[...new Set(warnings)]});
  }
  async function exportFile(file) {
    if (!(file instanceof Uint8Array) || file.byteLength === 0 || file.byteLength > MAX_BYTES) fail('INVALID_BACKUP');
    const time = clock(), nonce = random();
    if (!safeStamp(time) || !/^[a-f0-9]{12}$/.test(nonce)) fail('INVALID_REQUEST');
    const filename = `personamonkey-pcms-alpha-${time.replace(/[-:]/g,'').slice(0,15)}-${nonce}.json`;
    const relative = `${BACKUP_FOLDER}/${filename}`;
    const url = makeBlobUrl(file);
    let id;
    try { id = await downloads.download({url, filename:relative, conflictAction:'uniquify', saveAs:false}); }
    catch { revokeBlobUrl(url); fail('DOWNLOAD_FAILED'); }
    if (!validId(id)) { revokeBlobUrl(url); fail('DOWNLOAD_FAILED'); }
    // Keep the blob URL until the caller handles completion, and only then
    // revoke; do not revoke immediately after downloads.download resolves.
    try {
      const state = await load();
      if (state.entries.some(x=>x.id === id)) fail('RECOVERY_HOLD');
      const updated = [...state.entries.filter(x=>x.state !== 'REMOVED')];
      if (updated.length >= MAX_TRACKED) fail('RECOVERY_HOLD');
      updated.push({id,filename:relative,createdAt:time,state:'PENDING'});
      await save(clone(updated));
    } catch { revokeBlobUrl(url); throw new Error('Backup downloads (RECOVERY_HOLD).'); }
    return Object.freeze({id,filename:relative,status:'PENDING',url});
  }
  return Object.freeze({
    /** Never call without explicit unencrypted-export consent upstream. */
    downloadFile:file => serialized(() => exportFile(file)),
    /** May run on download-completion or recovery alarm. Caller owns URL revocation. */
    maintain:() => serialized(maintain),
    async releaseUrl(url) { revokeBlobUrl(url); },
    async status() { return serialized(async () => { const {state,warnings} = await inspect(); return {entries:state.entries.map(({id,filename,createdAt,state}) => ({id,filename,createdAt,state})),warnings}; }); }
  });
}

/** Concrete Firefox port; instantiate once inside the background Alpha Core.
 * Reconciliation must also be invoked on startup/alarm to recover missed events.
 */
export function createFirefoxBackupDownloads({firefox = globalThis.browser, urlApi = globalThis.URL, BlobType = globalThis.Blob, maxComplete = 7} = {}) {
  if (!firefox?.storage?.local || !firefox?.downloads?.onChanged?.addListener || !urlApi?.createObjectURL || !urlApi?.revokeObjectURL || typeof BlobType !== 'function') throw new TypeError('Firefox download capability unavailable');
  const key = 'alpha.backup.tracked-downloads.v1';
  const urls = new Map();
  const store = {
    async read() { const obj = await firefox.storage.local.get(key); return obj?.[key] ?? null; },
    async write(value) { await firefox.storage.local.set({[key]: value}); }
  };
  const service = createBackupDownloads({downloads: firefox.downloads, manifestStore:store,
    makeBlobUrl(bytes) { return urlApi.createObjectURL(new BlobType([bytes],{type:'application/json'})); },
    revokeBlobUrl(url) { urlApi.revokeObjectURL(url); }, maxComplete });
  let closed = false;
  async function releaseIfDone(id) {
    const url = urls.get(id); if (!url) return;
    try {
      const rows = await firefox.downloads.search({id});
      if (rows.some(x=>x.id===id && (x.state==='complete' || x.state==='interrupted'))) { urls.delete(id); urlApi.revokeObjectURL(url); }
    } catch { /* Keep blob alive until browser removes this event page. */ }
  }
  function changed(delta) {
    if (closed || !validId(delta?.id) || !delta?.state?.current || !['complete','interrupted'].includes(delta.state.current)) return;
    void releaseIfDone(delta.id).then(() => service.maintain()).catch(() => {});
  }
  firefox.downloads.onChanged.addListener(changed);
  return Object.freeze({
    async downloadFile(bytes) {
      if (closed) fail('UNAVAILABLE');
      const receipt = await service.downloadFile(bytes);
      urls.set(receipt.id,receipt.url);
      await releaseIfDone(receipt.id);
      return Object.freeze({id:receipt.id,filename:receipt.filename,status:receipt.status});
    },
    maintain:service.maintain,
    status:service.status,
    close() { closed = true; firefox.downloads.onChanged.removeListener?.(changed); for(const u of urls.values()) urlApi.revokeObjectURL(u); urls.clear(); }
  });
}