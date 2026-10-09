import test from 'node:test';
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
