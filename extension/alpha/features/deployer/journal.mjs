/** Durable P102-backed ledger used by P103. An explicit P103 FAILED:
 * NOT_APPLIED receipt is P102 NOT_APPLIED; other FAILED receipts remain HELD.
 * P201/PersonaMonkey retain all control and execution ownership.
 */
import { id, instant, requireData } from '../../domain/validation.js';

export function createDeployerJournal({ storage, clock = () => new Date().toISOString() } = {}) {
  if (!storage || !['read', 'commit'].every(k => typeof storage[k] === 'function')) {
    throw new TypeError('Deployer journal requires P102 storage');
  }

  async function read(opId) {
    id(opId);
    const row = await storage.read('operation', opId);
    return row.item?.record ?? null;
  }

  async function transition(opId, allowed, phase, evidence) {
    const row = await storage.read('operation', opId);
    requireData(row.item && allowed.includes(row.item.record.phase), 'RECOVERY_HOLD');
    const next = { ...row.item.record, phase,
      ...(evidence === undefined ? {} : { remoteEvidence: evidence }) };
    await storage.commit({ expectedRevision: row.revision, writes: [
      { kind: 'operation', expectedRevision: row.item.revision, record: next }
    ] });
    return read(opId);
  }

  return Object.freeze({
    read,
    async prepare({ opId, kind, targetKey, sourceRevision, accountBindingEpoch }) {
      id(opId); id(kind); id(targetKey);
      requireData(typeof sourceRevision === 'string' && sourceRevision.length > 0 &&
        Number.isSafeInteger(accountBindingEpoch) && accountBindingEpoch > 0, 'INVALID_REQUEST');
      requireData(!(await read(opId)), 'CONFLICT');
      const snapshot = await storage.read('operation', opId);
      const record = { opId, kind, targetKey, sourceRevision, accountBindingEpoch,
        phase: 'PREPARED', startedAt: instant(clock()) };
      await storage.commit({ expectedRevision: snapshot.revision,
        writes: [{ kind: 'operation', expectedRevision: 0, record }] });
      return read(opId);
    },
    dispatch(opId) { return transition(opId, ['PREPARED'], 'DISPATCHING'); },
    async complete(opId, outcome) {
      requireData(outcome && ['APPLIED', 'NOT_APPLIED', 'UNCERTAIN', 'FAILED', 'HELD']
        .includes(outcome.phase), 'INVALID_REQUEST');
      // P102 requires durable, nonempty evidence when resolving a dispatched
      // operation. Provider-supplied messages are deliberately never persisted.
      const evidence = { disposition: outcome.phase,
        ...(typeof outcome.code === 'string' ? { code: outcome.code } : {}),
        ...(outcome.remoteEvidence &&
          typeof outcome.remoteEvidence.sourceRevision === 'string' ?
          { sourceRevision: outcome.remoteEvidence.sourceRevision } : {}),
        ...(outcome.remoteEvidence &&
          ['UNLISTED', 'PUBLIC', 'UNKNOWN'].includes(outcome.remoteEvidence.listing) ?
          { listing: outcome.remoteEvidence.listing } : {}) };
      // P103 reports FAILED for explicit provider refusals. P102 deliberately
      // has no DISPATCHING -> FAILED edge: verified non-application settles as
      // NOT_APPLIED; every other failure stays HELD for reconciliation.
      // Report the adapter's transport disposition without forging durable state.
      const persistedPhase = outcome.phase === 'FAILED'
        ? outcome.code === 'NOT_APPLIED' ? 'NOT_APPLIED' : 'HELD'
        : outcome.phase;
      const persisted = await transition(opId, ['DISPATCHING'], persistedPhase, evidence);
      return { ...persisted, phase: outcome.phase };
    }
  });
}
