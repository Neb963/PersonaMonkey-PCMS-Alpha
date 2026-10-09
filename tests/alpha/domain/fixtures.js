// Synthetic identifiers and source only. No account data or credentials.
export const WHEN = '2026-10-09T00:00:00.000Z';
export const RELEASE = 'a'.repeat(64);
export const account = (overrides = {}) => ({ accountId: 'account-one', personaUid: 'persona-one', epoch: 1,
  name: 'Synthetic account', sessionState: 'UNKNOWN', revision: 0, asOf: WHEN, ...overrides });
export const binding = (overrides = {}) => ({ repository: 'fixture/generators', ref: 'main', root: 'generators', folder: 'source-one',
  slug: 'generator-one', commitSha: 'b'.repeat(40), blobs: { 'main.pjs': 'c'.repeat(40) }, status: 'READY', releaseId: RELEASE, ...overrides });
export const generator = (overrides = {}) => ({ key: 'generator-one', accountId: 'account-one', personaUid: 'persona-one',
  accountBindingEpoch: 1, fleetIntent: 'EXCLUDED', listingObserved: 'UNKNOWN', deployState: 'RESERVED', refreshState: 'SLEEPING',
  sourceBinding: null, releaseId: null, revision: 0, asOf: WHEN, attentionRefs: [], ...overrides });
export const release = (overrides = {}) => ({ releaseId: RELEASE, source: binding(),
  files: { pjs: 'output\n  synthetic\r\n', html: '<p>synthetic</p>\n', thumbnail: new Uint8Array([255, 216, 255, 217]) },
  createdAt: WHEN, ...overrides });
export const operation = (overrides = {}) => ({ opId: 'operation-one', kind: 'generator.save', targetKey: 'generator-one',
  sourceRevision: 'revision-one', accountBindingEpoch: 1, phase: 'PREPARED', startedAt: WHEN, ...overrides });
export const write = (kind, record, expectedRevision = record.revision || 0) => ({ kind, record, expectedRevision });
