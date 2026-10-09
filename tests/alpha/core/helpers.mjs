import { normalizeRecord, assertRecordUpdate } from '../../../extension/alpha/domain/records.js';
import { AlphaDataError, canonical } from '../../../extension/alpha/domain/validation.js';
import { createAlphaCore } from '../../../extension/alpha/core/core.mjs';

export function memoryDomain() {
  let revision = 0; const records = new Map();
  const key = (kind, record) => record[{ account: 'accountId', generator: 'key', operation: 'opId', release: 'releaseId' }[kind]];
  return {
    async open() {}, close() {},
    async snapshot() { return { revision }; },
    async list(kind) { return { revision, items: [...records.values()].filter(r => r.kind === kind).map(r => structuredClone(r.item)) }; },
    async read(kind, id) { return { revision, item: structuredClone(records.get(kind + ':' + id)?.item || null) }; },
    async commit({ expectedRevision, writes }) {
      if (expectedRevision !== revision) throw new AlphaDataError('STALE_REVISION');
      const prepared = writes.map(w => {
        const record = normalizeRecord(w.kind, w.record), address = w.kind + ':' + key(w.kind, record), old = records.get(address)?.item;
        if ((old?.revision || 0) !== w.expectedRevision) throw new AlphaDataError('STALE_REVISION');
        assertRecordUpdate(w.kind, old?.record, record);
        return { address, kind: w.kind, item: { revision: (old?.revision || 0) + 1,
          record: ['account', 'generator'].includes(w.kind) ? { ...record, revision: (old?.revision || 0) + 1 } : record } };
      });
      for (const r of prepared) records.set(r.address, r); revision++;
      return { revision, items: prepared.map(r => structuredClone(r.item)) };
    }
  };
}
export function memoryControl() {
  let s = { schemaVersion: 1, revision: 0, generation: 0, ownerId: 'unclaimed', timers: [], slots: [], lastPassAt: null, passCount: 0, recoveryReason: null };
  return { async read() { return structuredClone(s); }, async change(token, mutate) {
    if (token && (token.generation !== s.generation || token.ownerId !== s.ownerId)) throw new AlphaDataError('CONFLICT');
    const next = structuredClone(s); mutate(next); next.revision++; s = next; return structuredClone(s);
  }, close() {} };
}
export const META = Object.freeze({ owner: 'accounts', generation: 1, accountId: 'test-account', personaUid: '10100000-0000-4000-8000-000000000201', epoch: 1 });
export function operation(opId, targetKey = META.accountId) { return { opId, kind: 'persona.updateIdentity', targetKey, sourceRevision: 'persona-v1', accountBindingEpoch: 1, phase: 'PREPARED', startedAt: '2026-10-09T00:00:00.000Z' }; }
export async function fixture(extra = {}) {
  let time = Date.parse('2026-10-09T00:00:00.000Z'), ids = 0;
  const storage = extra.storage || memoryDomain(), control = extra.control || memoryControl(), values = {}, alarmRows = new Map(), sent = [];
  if (!(await storage.read('account', META.accountId)).item) await storage.commit({ expectedRevision: 0, writes: [{ kind: 'account', expectedRevision: 0,
    record: { accountId: META.accountId, personaUid: META.personaUid, epoch: 1, name: 'Synthetic account', sessionState: 'UNKNOWN', revision: 0, asOf: '2026-10-09T00:00:00.000Z' } }] });
  const broker = { async request(request) { sent.push(structuredClone(request)); return { version: 1, requestId: request.requestId, operationId: request.operationId,
    ok: true, bootId: 'broker-boot', revision: 1, result: { personaUid: META.personaUid, name: 'Observed' } }; } };
  const session = { async get(k) { return { [k]: values[k] }; }, async set(v) { Object.assign(values, structuredClone(v)); } };
  const alarms = { async create(name, info) { alarmRows.set(name, info); }, async clear(name) { alarmRows.delete(name); } };
  const options = { storage, control, broker, session, alarms, now: () => time, randomId: () => 'test-id-' + ++ids, ...extra };
  const core = createAlphaCore(options); await core.initialize();
  return { core, storage, control, sent, values, alarmRows, options, advance(ms) { time += ms; } };
}
export const confirm = async () => ({ phase: 'APPLIED', evidence: { targetKey: META.accountId, sourceRevision: 'persona-v1', observed: true } });
export const same = (a, b) => canonical(a) === canonical(b);
