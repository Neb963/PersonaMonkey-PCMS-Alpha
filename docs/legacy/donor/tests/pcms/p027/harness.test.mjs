import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadBrowserPin, validateBrowserPin } from '../../../tools/firefox/lib.mjs';
import { waitFor } from '../../../tools/firefox/packaged-harness.mjs';
test('A027-01 browser floor rejects pre-sandbox pins', async () => {
  const pin = await loadBrowserPin(); assert.ok(Number(pin.version.split('.')[0]) >= 154);
  assert.throws(() => validateBrowserPin({...pin,version:'153.0b10'}), /154\+/);
});
test('A027-02 bounded polling returns observed state and fails on missing evidence', async () => {
  let calls = 0;
  assert.equal(await waitFor(() => ++calls === 2 ? 'observed' : false, 'test'), 'observed');
  await assert.rejects(waitFor(() => false, 'missing evidence', 1), /Timed out: missing evidence/);
});
test('A027-03 hosted acceptance drives a separate probe and the unmodified product package', async () => {
  const workflow = await readFile('.github/workflows/firefox.yml','utf8');
  assert.match(workflow, /npm run firefox:packaged/);
  assert.match(workflow, /node --test tests\/pcms\/p026/);
  assert.doesNotMatch(workflow, /MOZ_DISABLE_CONTENT_SANDBOX/);
  const manifest = JSON.parse(await readFile('extension/manifest.json','utf8'));
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '153.0');
  const fixture = JSON.parse(await readFile('tests/pcms/p027/platform-fixture/manifest.json','utf8'));
  assert.notEqual(fixture.browser_specific_settings.gecko.id, manifest.browser_specific_settings.gecko.id);
  assert.deepEqual(fixture.sandbox.pages, ['sandbox.html']);
});
