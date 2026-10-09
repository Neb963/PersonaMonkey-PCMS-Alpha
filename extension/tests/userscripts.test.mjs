import assert from 'node:assert/strict';
import { parseUserscriptMetadata, analyzeGrants, shouldUseMainWorld, worldIdForScript } from '../lib/userscripts.js';
import { normalizeScript } from '../lib/storage.js';
import { assertExternalArtifactMetadataMatchesSource, validateExternalArtifactIdentity } from '../lib/external-artifact-integrity.js';

const code = `// ==UserScript==
// @name My Tool
// @namespace test
// @version 1.2.3
// @include https://example.com/*
// @exclude https://example.com/private/*
// @run-at document-start
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_xmlhttpRequest
// @connect api.example.net
// @require https://cdn.example.net/lib.js
// @resource icon https://cdn.example.net/icon.png
// @noframes
// ==/UserScript==
console.log('ok');`;
const meta = parseUserscriptMetadata(code);
assert.equal(meta.name, 'My Tool');
assert.equal(meta.runAt, 'document_start');
assert.deepEqual(meta.matches, []);
assert.deepEqual(meta.includes, ['https://example.com/*']);
assert.equal(meta.allFrames, false);
assert.deepEqual(meta.connects, ['api.example.net']);
assert.equal(meta.hostScopeDeclared, true, 'an explicit @include is recorded separately from the runtime wildcard fallback');
assert.equal(meta.resources.icon, 'https://cdn.example.net/icon.png');
assert.equal(analyzeGrants(meta.grants).compatible, true);
const normalized = normalizeScript({ ...meta, code }, 'x');
assert.deepEqual(normalized.matches, [], 'include-only scripts must not become match-all');
assert.equal(normalized.includes[0], 'https://example.com/*');
assert.equal(shouldUseMainWorld(normalized), false);

const none = parseUserscriptMetadata(`// ==UserScript==\n// @name Page\n// @grant none\n// ==/UserScript==`);
assert.equal(shouldUseMainWorld(none), true);
assert.equal(none.hostScopeDeclared, false);
const noneInContent = parseUserscriptMetadata(`// ==UserScript==\n// @name Isolated\n// @grant none\n// @inject-into content\n// ==/UserScript==`);
assert.equal(noneInContent.world, 'USER_SCRIPT', '@inject-into content must override @grant none in the review disclosure');
assert.equal(shouldUseMainWorld(noneInContent), false, 'the disclosed execution world must match runtime selection');
const privileged = parseUserscriptMetadata(`// ==UserScript==\n// @match https://example.com/*\n// @grant Persona.signal\n// @grant GM_getTabData\n// @grant GM_saveTabData\n// @grant GM_getTabsData\n// ==/UserScript==`);
assert.equal(analyzeGrants(privileged.grants).compatible, true, 'signal and tab-data grants are recognized by import validation');
assert.equal(analyzeGrants(['GM_totallyUnknown']).compatible, false);
const collisionA = await worldIdForScript('foo-bar-1234abcd');
const collisionB = await worldIdForScript('foo.bar-1234abcd');
assert.match(collisionA, /^persona-[0-9a-f]{64}$/);
assert.notEqual(collisionA, collisionB, 'punctuation-different script IDs must not collapse into one isolated world');
assert.equal(await worldIdForScript('foo-bar-1234abcd'), collisionA, 'world IDs must be stable across calls');
assert.notEqual(await worldIdForScript(`long-${'x'.repeat(600)}-a`), await worldIdForScript(`long-${'x'.repeat(600)}-b`), 'long script IDs must retain distinct identities');

const artifactMarker = {
  artifactId: 'org.example/package@1/component', sha256: 'a'.repeat(64), ownerKey: 'b'.repeat(64),
  provenance: { packageId: 'org.example/package', packageVersion: '1', component: 'component' },
  installedAt: '2026-01-01T00:00:00.000Z'
};
const safeArtifactSource = '// ==UserScript==\n// @name Safe\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\n';
const validArtifact = { ...parseUserscriptMetadata(safeArtifactSource), id: 'artifact', code: safeArtifactSource, enabled: true, autoRun: false, externalArtifact: artifactMarker };
assert.equal(assertExternalArtifactMetadataMatchesSource(validArtifact), true);
for (const resource of ['https://cdn.example.test/a.js', '//cdn.example.test/a.js', '/assets/a.js', '../a.js']) {
  const sourceWithResource = safeArtifactSource.replace('// @grant none', `// @grant none\n// @resource helper ${resource}`);
  const invalidArtifact = { ...parseUserscriptMetadata(sourceWithResource), id: 'artifact', code: sourceWithResource, enabled: true, autoRun: false, externalArtifact: artifactMarker };
  assert.throws(() => assertExternalArtifactMetadataMatchesSource(invalidArtifact), /safe source/,
    `resource ${resource} must not be accepted as a local-looking dependency`);
}
const dataResourceSource = safeArtifactSource.replace('// @grant none', '// @grant none\n// @resource icon data:image/png;base64,AA==');
const dataResourceArtifact = { ...parseUserscriptMetadata(dataResourceSource), id: 'artifact', code: dataResourceSource, enabled: true, autoRun: false, externalArtifact: artifactMarker };
assert.equal(assertExternalArtifactMetadataMatchesSource(dataResourceArtifact), true, 'self-contained data resources are safe');
for (const updateField of ['updateURL', 'downloadURL']) {
  const invalidArtifact = { ...validArtifact, [updateField]: 'https://cdn.example.test/update.js' };
  assert.throws(() => assertExternalArtifactMetadataMatchesSource(invalidArtifact), /safe source/,
    `${updateField} cannot be forged outside the digested metadata block`);
}
assert.throws(() => validateExternalArtifactIdentity({ ...validArtifact, externalArtifact: { ...artifactMarker, ownerKey: 'not-an-owner-hash' } }), /identity metadata is invalid/,
  'runtime validation requires a well-formed opaque ownership marker');
assert.throws(() => validateExternalArtifactIdentity({ ...validArtifact, autoRun: true }), /workflow-only/,
  'raw autoRun state must be checked before storage normalization can force it off');
assert.throws(() => validateExternalArtifactIdentity({ ...validArtifact, enabled: 'false' }), /enabled state must be boolean/,
  'invalid enabled types cannot normalize to enabled=true');
console.log('userscript parser tests passed');
