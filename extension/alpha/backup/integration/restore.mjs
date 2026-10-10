/** P405 restore orchestration. Authority is a vetted Core-owned restore port,
 * never direct IndexedDB, raw native messages or PersonaMonkey internals.
 * An absent port means restore is UNSUPPORTED, never a simulated success.
 */
export const RESTORE_CONFIRMATION = 'RESTORE UNENCRYPTED BACKUP';
const CHECKS = Object.freeze(['core', 'bindings', 'sessions', 'providers', 'operations', 'inventory']);
const code = value => { const e = new Error(`Backup restore (${value}).`); e.code = value; return e; };
const fail = value => { throw code(value); };
const hasMethods = (o, names) => o && names.every(n => typeof o[n] === 'function');
const BYTES = 128 * 1024 * 1024;
async function sha(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), x=>x.toString(16).padStart(2,'0')).join('');
}
function requiredSections(bundle) {
  const m=bundle.manifest, absent=new Set(m.absentItems.map(x=>x.item));
  const components = ['alpha.records','alpha.journal'];
  if (!absent.has('alpha.inventoryFacts') && bundle.inventoryFacts?.length) components.push('alpha.inventoryFacts');
  for (const item of ['personaMonkey.personas','personaMonkey.routes','personaMonkey.userscripts','personaMonkey.workflows']) if (!absent.has(item)) components.push(item);
  for (const item of Object.keys(bundle.authorizedSensitiveEntries)) components.push(item);
  return components;
}
const goodHold = v => v && v.state === 'RECOVERY_HOLD' && typeof v.holdId === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(v.holdId) && v.durable === true;
function normalizeChecks(result) {
  if (!result || typeof result !== 'object' || !CHECKS.every(k=>typeof result[k] === 'boolean')) fail('RECOVERY_HOLD');
  return Object.freeze(Object.fromEntries(CHECKS.map(k=>[k,result[k]])));
}
export function createBackupRestore({ exporter, decodeFile, authority = null, now = () => Date.now(), randomId = () => crypto.randomUUID() } = {}) {
  if (!hasMethods(exporter,['stageRestore']) || typeof decodeFile !== 'function' || typeof now !== 'function' || typeof randomId !== 'function') throw new TypeError('P405 requires verified P205 archive decoder and staged preview');
  // The production P201 core does not currently implement this port; fail
  // closed rather than manufacture authority from private DB/native helpers.
  const ready = Boolean(hasMethods(authority,['supported','begin','replace','status','reconcile','release']));
  let staged = null;
  async function stage(file) {
    if (!(file instanceof Uint8Array) || file.byteLength === 0 || file.byteLength > BYTES) fail('INVALID_BACKUP');
    staged = null;
    const copy = new Uint8Array(file);
    let preview, bundle, digest;
    try { [preview,bundle,digest] = await Promise.all([exporter.stageRestore(copy),decodeFile(copy),sha(copy)]); }
    catch { fail('INVALID_BACKUP'); }
    if (preview?.verified !== true || preview?.integrityVerified !== true || preview?.applied !== false || bundle?.manifest?.encrypted !== false) fail('INVALID_BACKUP');
    const id = randomId(); if (typeof id !== 'string' || id.length < 8 || id.length > 128) fail('INVALID_REQUEST');
    staged = {id,digest,bundle,expiresAt:now() + 10*60_000};
    return Object.freeze({ id, digest, ...preview, requiresConfirmation:RESTORE_CONFIRMATION, supported:ready, requiredSections:requiredSections(bundle) });
  }
  async function finish(holdId) {
    let hold;
    try { hold = await authority.status({holdId}); } catch { fail('RECOVERY_HOLD'); }
    if (hold?.state !== 'RECOVERY_HOLD' || hold.holdId !== holdId) fail('RECOVERY_HOLD');
    let checks;
    try { checks = normalizeChecks(await authority.reconcile({holdId})); } catch { fail('RECOVERY_HOLD'); }
    const unresolved=CHECKS.filter(k=>checks[k]!==true);
    if (unresolved.length) return Object.freeze({state:'RECOVERY_HOLD',holdId,unresolved,released:false});
    try { const released=await authority.release({holdId,checks}); if (released?.state !== 'RUNNING' || released.holdId !== holdId) fail('RECOVERY_HOLD'); }
    catch { fail('RECOVERY_HOLD'); }
    return Object.freeze({state:'RUNNING',holdId,unresolved:[],released:true});
  }
  async function apply({id,digest,confirmation}={}) {
    if (!staged || id !== staged.id || digest !== staged.digest || confirmation !== RESTORE_CONFIRMATION || now()>staged.expiresAt) fail('PREVIEW_MISMATCH');
    if (!ready) fail('UNSUPPORTED_CAPABILITY');
    const item=staged;
    // Never perform a destructive partial restore without an authoritative
    // restoration capability for every section actually present in the file.
    let supported;
    try { supported=await authority.supported(); } catch { fail('RECOVERY_HOLD'); }
    if (!Array.isArray(supported) || requiredSections(item.bundle).some(s=>!supported.includes(s))) fail('UNSUPPORTED_CAPABILITY');
    staged=null; // no accidental retry of ambiguous provider mutations
    let hold;
    try { hold=await authority.begin({digest:item.digest,sourceRevision:item.bundle.manifest.createdAt}); }
    catch { fail('RECOVERY_HOLD'); }
    if (!goodHold(hold)) fail('RECOVERY_HOLD');
    try {
      const result=await authority.replace({holdId:hold.holdId,bundle:item.bundle,expectedDigest:item.digest});
      if (result?.state!=='APPLIED' || result.holdId!==hold.holdId) fail('RECOVERY_HOLD');
    } catch { fail('RECOVERY_HOLD'); } // never repeat replacement on uncertainty
    return finish(hold.holdId);
  }
  async function resumeReconciliation({holdId}={}) {
    if (!ready || typeof holdId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(holdId)) fail('UNSUPPORTED_CAPABILITY');
    return finish(holdId); // read/reconcile only; never replays replace()
  }
  return Object.freeze({ stage, apply, resumeReconciliation, supported:ready });
}