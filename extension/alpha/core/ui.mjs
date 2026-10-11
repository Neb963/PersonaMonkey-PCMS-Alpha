import { exact, id, revision, safeDetails, requireData, text, relativePath } from '../domain/validation.js';

const METHODS = Object.freeze({
  accounts: ['list', 'get', 'enroll', 'verifySession', 'previewRebind', 'rebind'],
  inventory: ['list', 'get', 'observe', 'setIntent', 'inspectDrift', 'previewDelete', 'delete'],
  sourceCatalog: ['scan', 'get', 'bind', 'resolveRelease'],
  reservation: ['preview', 'reserve', 'reconcile'], deployer: ['prepare', 'apply', 'reconcile', 'rollback'],
  aiReview: ['queue', 'get', 'start', 'recordReview', 'approveIntent'],
  refresher: ['status', 'configure', 'setEligibility', 'planPass'], visibility: ['observeRecent', 'getPosition', 'collectStats'],
  attention: ['list', 'get', 'acknowledge', 'raise'], backup: ['previewExport', 'export', 'previewRestore', 'restore', 'retain'],
  supply: ['preview', 'processBatch'], release: ['scanReady', 'stage', 'startAi', 'markReady', 'resume', 'reconcile', 'failUpdate']
});
const WRITES = new Set(['accounts.enroll', 'accounts.verifySession', 'accounts.rebind', 'inventory.observe', 'inventory.setIntent', 'inventory.delete',
  'sourceCatalog.bind', 'reservation.reserve', 'reservation.reconcile', 'deployer.prepare', 'deployer.apply', 'deployer.reconcile', 'deployer.rollback',
  'aiReview.start', 'aiReview.recordReview', 'aiReview.approveIntent', 'refresher.configure', 'refresher.setEligibility',
  'attention.acknowledge', 'attention.raise', 'backup.export', 'backup.restore', 'backup.retain',
  'supply.processBatch', 'release.stage', 'release.startAi', 'release.markReady',
  'release.resume', 'release.reconcile', 'release.failUpdate']);
const MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Invalid Alpha request.', STALE_REVISION: 'Alpha changed; refresh before trying again.', STALE_BINDING: 'Account Persona binding changed.',
  UNSUPPORTED_CAPABILITY: 'This Alpha capability is unavailable.', OWNERSHIP_UNKNOWN: 'Ownership has not been confirmed.',
  SOURCE_DRIFT: 'Source reconciliation is required.', CONFLICT: 'Alpha authority changed.', RATE_LIMIT: 'Alpha resource budget is exhausted.',
  WAITING_HUMAN: 'Operator action is required.', RECOVERY_HOLD: 'Unresolved work must be reconciled before changing state.',
  NOT_APPLIED: 'The requested record is unavailable.', UNCERTAIN: 'The outcome is uncertain; reconcile before retrying.', UNAVAILABLE: 'Alpha is unavailable.'
});
export const UI_TYPE = 'PCMS_UI_REQUEST'; // PersonaMonkey already delegates this transport to its product client.
export function failure(code, requestId = null, current = 0) {
  if (!Object.hasOwn(MESSAGES, code)) code = 'UNAVAILABLE';
  return { ok: false, requestId, error: { code, message: MESSAGES[code], retryable: code === 'UNAVAILABLE' || code === 'RATE_LIMIT' }, revision: current };
}
export function authorizeSender(sender, runtime) {
  try {
    const root = new URL(runtime.getURL('')), url = new URL(sender?.url);
    requireData(sender.id === runtime.id && url.protocol === 'moz-extension:' && url.host === root.host && !url.username && !url.password &&
      /^\/alpha\/(?:ui|popup)\/[a-zA-Z0-9_/-]+\.html$/.test(url.pathname) &&
      (sender.frameId === undefined || sender.frameId === 0) && (sender.origin === undefined || sender.origin === `${root.protocol}//${root.host}`));
    return true;
  } catch { return false; }
}
export function validateUiRequest(raw) {
  const r = exact(raw, ['v', 'requestId', 'command', 'params'], ['expectedRevision']);
  requireData(r.v === 1); id(r.requestId); requireData(r.requestId.length <= 128 && typeof r.command === 'string');
  const pieces = r.command.split('.'); requireData(pieces.length === 2 && Object.hasOwn(METHODS, pieces[0]) && METHODS[pieces[0]].includes(pieces[1]));
  const write = WRITES.has(r.command);
  let params;
  if (r.command === 'supply.preview') {
    params = exact(r.params, ['text']);
    text(params.text, 24000);
    if (r.expectedRevision !== undefined) revision(r.expectedRevision);
  } else if (r.command === 'supply.processBatch') {
    params = exact(r.params, ['expectedRevision','text','batchId'],
      ['offset','limit','imports']);
    text(params.text, 24000);
    requireData(typeof params.batchId === 'string' &&
      /^[A-Za-z0-9_-]{1,32}$/.test(params.batchId));
    revision(params.expectedRevision);
    revision(r.expectedRevision);
    requireData(params.expectedRevision === r.expectedRevision, 'STALE_REVISION');
    if (params.offset !== undefined) revision(params.offset);
    if (params.limit !== undefined) requireData(Number.isSafeInteger(params.limit) &&
      params.limit >= 1 && params.limit <= 16);
    if (params.imports !== undefined) {
      requireData(Array.isArray(params.imports) && params.imports.length <= 200);
      const used = new Set();
      for (const item of params.imports) {
        const entry = exact(item,['key','folder']);
        id(entry.key); relativePath(entry.folder);
        requireData(!used.has(entry.key)); used.add(entry.key);
      }
    }
  } else {
    params = exact(r.params, write ?
      ['expectedRevision', 'accountBindingEpoch', 'opId'] : [],
      write ? ['key', 'accountId', 'options'] : ['key', 'accountId', 'cursor', 'limit']);
    if (params.key !== undefined) id(params.key);
    if (params.accountId !== undefined) id(params.accountId);
    if (params.limit !== undefined) requireData(Number.isSafeInteger(params.limit) &&
      params.limit > 0 && params.limit <= 200);
    if (params.cursor !== undefined) requireData(typeof params.cursor === 'string' &&
      params.cursor.length <= 1024);
    if (write) {
      revision(r.expectedRevision); revision(params.expectedRevision);
      revision(params.accountBindingEpoch, 1); id(params.opId);
      requireData(r.expectedRevision === params.expectedRevision, 'STALE_REVISION');
    } else if (r.expectedRevision !== undefined) revision(r.expectedRevision);
  }
  safeDetails(params);
  requireData(new TextEncoder().encode(JSON.stringify(r)).length <= 32768);
  return { request: structuredClone(r), service: pieces[0], method: pieces[1], write };
}
export function createUiDispatcher({ runtime, ensureCore, services }) {
  let tail = Promise.resolve();
  const dispatch = async (raw, sender) => {
    let requestId = null, current = 0;
    try {
      requireData(authorizeSender(sender, runtime));
      const envelope = exact(raw, ['type', 'request']); requireData(envelope.type === UI_TYPE);
      const { request, service, method, write } = validateUiRequest(envelope.request); requestId = request.requestId;
      const core = await ensureCore(), status = await core.readStatus(); current = status.revision;
      if (write) { requireData(request.expectedRevision === current, 'STALE_REVISION'); await core.assertMutationAllowed(); }
      requireData(typeof services[service]?.[method] === 'function', 'UNSUPPORTED_CAPABILITY');
      const reply = await services[service][method](request.params);
      requireData(reply && typeof reply.ok === 'boolean' && Number.isSafeInteger(reply.revision) && reply.revision >= 0, 'UNAVAILABLE');
      await core.assertCurrent();
      if (!reply.ok) return failure(reply.error?.code, requestId, reply.revision);
      // The implemented services return P102 safe projections. Backup binary
      // export and provider capabilities remain separately composed slices.
      const result = structuredClone(reply.result); safeDetails({ result });
      await core.publish(); return { ok: true, requestId, result, revision: reply.revision };
    } catch (error) { return failure(error?.code || 'UNAVAILABLE', requestId, current); }
  };
  return Object.freeze({ handle(raw, sender) {
    // Serialize optimistic mutations and reads across every UI client. No port
    // or keepalive is needed; reconnects requery the durable revision.
    const next = tail.then(() => dispatch(raw, sender), () => dispatch(raw, sender)); tail = next.catch(() => {}); return next;
  } });
}
