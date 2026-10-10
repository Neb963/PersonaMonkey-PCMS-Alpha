import test from 'node:test';
import { normalizeInventoryFact } from '../../../extension/alpha/features/inventory/facts.mjs';
import assert from 'node:assert/strict';
import { createBackupExporter, decodeBackupFile, encodeBackupFile, BackupError, UNENCRYPTED_CONSENT } from '../../../extension/alpha/backup/bundle.js';

const clock = () => '2026-10-09T18:00:00.000Z';
const snapshot = () => ({ schemaVersion: 1, revision: 5, records: [
  { kind: 'release', record: { files: { thumbnail: new Uint8Array([0, 2, 255]) } } },
  { kind: 'operation', record: { phase: 'UNCERTAIN' } }
], journal: [{ revision: 5, changes: [] }] });
const make = options => createBackupExporter({ alphaStorage: { snapshot: async () => snapshot() }, clock, ...options });
const code = e => e?.code;

test('explicit unencrypted informed consent, honest absent inventory and read-only staging', async () => {
  const x = make();
  assert.equal(x.previewExport().encrypted, false);
  assert.equal(x.previewExport().unavailable.find(i => i.item === 'perchance.passwords').reason, 'UNAVAILABLE');
  await assert.rejects(x.exportBackup(), e => code(e) === 'UNENCRYPTED_CONSENT_REQUIRED');
  const { file, bundle, inventory } = await x.exportBackup({ consent: UNENCRYPTED_CONSENT });
  assert.equal(bundle.manifest.encrypted, false);
  assert.equal(bundle.personaMonkey.byteLength, 0);
  assert.equal(inventory.find(i => i.item === 'personaMonkey.personas').availability, 'UNAVAILABLE');
  assert.equal(inventory.find(i => i.item === 'alpha.journal').availability, 'EXPORTED');
  assert.equal(bundle.manifest.absentItems.find(i => i.item === 'alpha.githubCredential').reason, 'NOT_AUTHORIZED');
  const decoded = await decodeBackupFile(file);
  assert.equal(Buffer.compare(Buffer.from(decoded.alpha), Buffer.from(bundle.alpha)), 0);
  const preview = await x.stageRestore(file);
  assert.equal(preview.verified, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.proposedRecoveryState, 'RECOVERY_HOLD');
  assert.equal(preview.recordCount, 2);
  assert.equal(preview.operationCount, 1);
  assert.equal(preview.backupRevision, 5);
  assert.equal(preview.requiresPersonaAndProviderReconciliation, true);
  assert.ok(!Object.hasOwn(x, 'restore'));
});

test('explicit successful PersonaMonkey and approved sensitive data; exact binary roundtrip', async () => {
  let calls = 0;
  const x = make({
    personaMonkeyExport: async () => ({
      bytes: new Uint8Array([1, 128, 255]),
      includedItems: ['personaMonkey.personas', 'personaMonkey.routes']
    }),
    sensitiveExports: {
      'personaMonkey.cookies': async () => {
        calls++;
        return new TextEncoder().encode('PRIVATE-FIXTURE-NOT-PRINTED');
      }
    }
  });
  const out = await x.exportBackup({
    consent: UNENCRYPTED_CONSENT, includeSensitive: ['personaMonkey.cookies']
  });
  assert.equal(calls, 1);
  assert.equal(out.bundle.manifest.absentItems.some(x => x.item === 'personaMonkey.personas'), false);
  assert.equal(out.bundle.manifest.absentItems.some(x => x.item === 'personaMonkey.userscripts'), true);
  assert.equal(out.bundle.manifest.absentItems.some(x => x.item === 'personaMonkey.cookies'), false);
  assert.equal(Buffer.compare(Buffer.from((await decodeBackupFile(out.file)).personaMonkey), Buffer.from([1, 128, 255])), 0);
  assert.equal(Buffer.compare(Buffer.from(await encodeBackupFile(await decodeBackupFile(out.file))), Buffer.from(out.file)), 0);
});

test('checksum tampering, malformed schema and unauthorized entries fail closed', async () => {
  const x = make(); const { file } = await x.exportBackup({ consent: UNENCRYPTED_CONSENT });
  const src = JSON.parse(new TextDecoder().decode(file));
  const modified = change => {
    const o = structuredClone(src);
    change(o);
    return new TextEncoder().encode(JSON.stringify(o));
  };
  await assert.rejects(decodeBackupFile(modified(x => x.alpha = 'AA==')), e => e instanceof BackupError && ['INTEGRITY_MISMATCH', 'INVALID_BACKUP'].includes(e.code));
  await assert.rejects(decodeBackupFile(modified(x => x.manifest.encrypted = true)), e => code(e) === 'INVALID_BACKUP');
  await assert.rejects(decodeBackupFile(modified(x => x.manifest.absentItems[0].reason = 'SUCCEEDED')), e => code(e) === 'INVALID_BACKUP');
  await assert.rejects(decodeBackupFile(modified(x => x.manifestSha256 = 'f'.repeat(64))), e => code(e) === 'INTEGRITY_MISMATCH');
  await assert.rejects(decodeBackupFile(modified(x => x.authorizedSensitiveEntries.unknown = 'AA==')), e => code(e) === 'INVALID_BACKUP');
  await assert.rejects(decodeBackupFile(new TextEncoder().encode('{')), e => code(e) === 'INVALID_BACKUP');
  assert.throws(() => make({ sensitiveExports: { 'unexpected.secret': async () => new Uint8Array([1]) } }), TypeError);
  await assert.rejects(x.exportBackup({ consent: UNENCRYPTED_CONSENT, includeSensitive: ['alpha.githubCredential'] }), e => code(e) === 'EXPORT_UNAVAILABLE');
});

test('failed source reads never produce partial archive or leak error payload', async () => {
  const x = make({
    personaMonkeyExport: async () => { throw new Error('PRIVATE-FIXTURE-NOT-PRINTED'); }
  });
  await assert.rejects(x.exportBackup({ consent: UNENCRYPTED_CONSENT }), e => code(e) === 'EXPORT_UNAVAILABLE' && !e.message.includes('PRIVATE-FIXTURE'));
  const failStorage = createBackupExporter({
    alphaStorage: { snapshot: async () => { throw Error('PRIVATE-FIXTURE-NOT-PRINTED'); } }, clock
  });
  await assert.rejects(failStorage.exportBackup({ consent: UNENCRYPTED_CONSENT }), e => code(e) === 'RECOVERY_HOLD' && !e.message.includes('PRIVATE-FIXTURE'));
});

const fact = (key, edits = {}) => normalizeInventoryFact({
  key, accountId: 'account-a', personaUid: 'persona-a', accountBindingEpoch: 2,
  providerSourceRevision: 'provider-r7', acceptedSourceRevision: 'accepted-r6',
  listing: 'PUBLIC', observedAt: clock(), lastSeenAt: clock(),
  ownershipObserved: true, discoveryRevision: 5, observationRevision: 7,
  ignoredVersion: null,
  drift: { id: 'drift-7', expected: 'accepted-r6', observed: 'provider-r7', firstSeenAt: clock() },
  ...edits
});
const driftFact = fact('g0001');
const ignoredFact = fact('g0002', { providerSourceRevision: 'provider-r8', acceptedSourceRevision: 'accepted-r8', ignoredVersion: 'provider-r8', drift: null });

test('nonempty P204 source-drift and exact ignored revision are integrity-checked and visibly reconciliation-bound', async () => {
  let reads = 0;
  const x = make({ inventoryFactsStore: { async list() { reads++; return [ignoredFact, driftFact]; } } });
  assert.equal(x.previewExport().potentiallyExportable.includes('alpha.inventoryFacts'), true);
  const out = await x.exportBackup({ consent: UNENCRYPTED_CONSENT });
  assert.equal(reads, 1);
  assert.equal(out.bundle.manifest.version, 1);
  assert.equal(out.bundle.manifest.coverageRevision, 2);
  assert.match(out.bundle.manifest.hashes.inventoryFacts, /^[a-f0-9]{64}$/);
  assert.equal(out.bundle.manifest.absentItems.some(row => row.item === 'alpha.inventoryFacts'), false);
  assert.equal(out.inventory.find(row => row.item === 'alpha.inventoryFacts').availability, 'EXPORTED');
  const decoded = await decodeBackupFile(out.file);
  assert.equal(Buffer.compare(Buffer.from(decoded.inventoryFacts), Buffer.from(out.bundle.inventoryFacts)), 0);
  const recovered = JSON.parse(new TextDecoder().decode(decoded.inventoryFacts));
  assert.deepEqual(recovered.map(row => row.key), ['g0001', 'g0002']);
  assert.equal(recovered[0].drift.observed, 'provider-r7');
  assert.equal(recovered[1].ignoredVersion, 'provider-r8');
  assert.equal(Buffer.compare(Buffer.from(await encodeBackupFile(decoded)), Buffer.from(out.file)), 0);
  const preview = await x.stageRestore(out.file);
  assert.equal(preview.verified, true); // integrity only, NEVER a declaration of restorable completeness
  assert.equal(preview.integrityVerified, true);
  assert.equal(preview.recoveryCompleteness, 'PARTIAL');
  assert.equal(preview.crossStoreAtomic, false);
  assert.equal(preview.inventoryFactsCount, 2);
  assert.equal(preview.inventoryDriftCount, 1);
  assert.equal(preview.inventoryIgnoredRevisionCount, 1);
  assert.equal(preview.missing.some(row => row.item === 'alpha.inventoryFacts'), false);
  assert.equal(preview.proposedRecoveryState, 'RECOVERY_HOLD');
  assert.equal(preview.applied, false);
});

test('absent P204 facts and pre-repair v1 archives cannot be reported as complete or silently restored', async () => {
  const x = make();
  const out = await x.exportBackup({ consent: UNENCRYPTED_CONSENT });
  assert.equal(out.bundle.manifest.coverageRevision, 2);
  assert.equal(out.bundle.manifest.absentItems.find(row => row.item === 'alpha.inventoryFacts').reason, 'UNAVAILABLE');
  assert.equal(Object.hasOwn(out.bundle.manifest.hashes, 'inventoryFacts'), false);
  assert.equal((await x.stageRestore(out.file)).recoveryCompleteness, 'PARTIAL');
  const legacyManifest = structuredClone(out.bundle.manifest);
  delete legacyManifest.coverageRevision;
  legacyManifest.absentItems = legacyManifest.absentItems.filter(row => row.item !== 'alpha.inventoryFacts');
  const legacyFile = await encodeBackupFile({
    manifest: legacyManifest, alpha: out.bundle.alpha, personaMonkey: out.bundle.personaMonkey,
    authorizedSensitiveEntries: out.bundle.authorizedSensitiveEntries
  });
  const legacyDecoded = await decodeBackupFile(legacyFile);
  assert.equal(legacyDecoded.manifest.coverageRevision, undefined);
  assert.equal(Object.hasOwn(legacyDecoded, 'inventoryFacts'), false);
  const preview = await x.stageRestore(legacyFile);
  assert.equal(preview.schemaVersion, 1);
  assert.equal(preview.integrityVerified, true);
  assert.equal(preview.recoveryCompleteness, 'PARTIAL');
  assert.equal(preview.inventoryFactsCount, 0);
  assert.equal(preview.missing.find(row => row.item === 'alpha.inventoryFacts').reason, 'UNAVAILABLE');
  assert.equal(preview.available.find(row => row.item === 'alpha.inventoryFacts').availability, 'UNAVAILABLE');
});

test('P204 component corruption, fake completeness, missing sections and unsupported coverage versions fail closed', async () => {
  const withFacts = await make({ inventoryFactsStore: { list: async () => [driftFact, ignoredFact] } })
    .exportBackup({ consent: UNENCRYPTED_CONSENT });
  const noFacts = await make().exportBackup({ consent: UNENCRYPTED_CONSENT });
  const parse = file => JSON.parse(new TextDecoder().decode(file));
  const fileOf = value => new TextEncoder().encode(JSON.stringify(value));
  const sha = async b => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), i => i.toString(16).padStart(2, '0')).join('');
  const rehashManifest = async value => { value.manifestSha256 = await sha(fileOf(value.manifest)); return fileOf(value); };
  const good = parse(withFacts.file);
  const badBytes = structuredClone(good);
  badBytes.inventoryFacts = 'AA==';
  await assert.rejects(decodeBackupFile(fileOf(badBytes)), e => code(e) === 'INVALID_BACKUP' || code(e) === 'INTEGRITY_MISMATCH');
  const badHash = structuredClone(good);
  badHash.manifest.hashes.inventoryFacts = 'f'.repeat(64);
  await assert.rejects(decodeBackupFile(await rehashManifest(badHash)), e => code(e) === 'INTEGRITY_MISMATCH');
  const gone = structuredClone(good);
  delete gone.inventoryFacts;
  await assert.rejects(decodeBackupFile(fileOf(gone)), e => code(e) === 'INVALID_BACKUP');
  const fakeAbsent = structuredClone(good);
  fakeAbsent.manifest.absentItems.push({ item: 'alpha.inventoryFacts', reason: 'UNAVAILABLE' });
  await assert.rejects(decodeBackupFile(await rehashManifest(fakeAbsent)), e => code(e) === 'INVALID_BACKUP');
  const fakeComplete = parse(noFacts.file);
  fakeComplete.manifest.absentItems = fakeComplete.manifest.absentItems.filter(row => row.item !== 'alpha.inventoryFacts');
  await assert.rejects(decodeBackupFile(await rehashManifest(fakeComplete)), e => code(e) === 'INVALID_BACKUP');
  const version = structuredClone(good);
  version.manifest.coverageRevision = 3;
  await assert.rejects(decodeBackupFile(await rehashManifest(version)), e => code(e) === 'INVALID_BACKUP');
  const forgedRows = structuredClone(good);
  const rows = JSON.parse(atob(forgedRows.inventoryFacts));
  rows[1].ignoredVersion = { invalid: true };
  const bytes = fileOf(rows);
  forgedRows.inventoryFacts = btoa(String.fromCharCode(...bytes));
  forgedRows.manifest.hashes.inventoryFacts = await sha(bytes);
  await assert.rejects(decodeBackupFile(await rehashManifest(forgedRows)), e => code(e) === 'INVALID_BACKUP');
});

test('P204 read failure and invalid observation facts never create an archive or leak source data', async () => {
  const sourceFailure = make({ inventoryFactsStore: { async list() { throw Error('PRIVATE-FIXTURE-NOT-PRINTED'); } } });
  await assert.rejects(sourceFailure.exportBackup({ consent: UNENCRYPTED_CONSENT }),
    e => code(e) === 'RECOVERY_HOLD' && !e.message.includes('PRIVATE-FIXTURE'));
  const duplicate = make({ inventoryFactsStore: { list: async () => [driftFact, driftFact] } });
  await assert.rejects(duplicate.exportBackup({ consent: UNENCRYPTED_CONSENT }),
    e => code(e) === 'EXPORT_UNAVAILABLE');
  assert.throws(() => make({ inventoryFactsStore: { list: null } }), TypeError);
});
