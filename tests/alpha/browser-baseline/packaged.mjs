import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileText, sha256File } from '../../../tools/firefox/lib.mjs';
import { waitFor } from '../../../tools/firefox/packaged-harness.mjs';
import { IsolatedFirefox } from '../../../tools/alpha/firefox/harness.mjs';
import { packagedBroker } from '../../../tools/alpha/firefox/broker.mjs';
import { newReport, saveReport } from '../../../tools/alpha/firefox/report.mjs';
import { REPO_ROOT } from '../../../tools/alpha/firefox/pin.mjs';
import { INTEGRATION_ERROR_CODES } from '../../../extension/lib/management-integration-protocol.js';

const PRODUCT = 'persona-route-manager@local';
const UID = '10100000-0000-4000-8000-000000000001';
const root = resolve(process.env.FIREFOX_PACKAGED_DIR || join(tmpdir(), 'alpha-p101-packaged'));
const reportPath = resolve(process.env.FIREFOX_PACKAGED_REPORT || join(root, 'report.json'));
const report = await newReport('packaged-personamonkey-baseline');
let h, broker, server, error, sequence = 0;
const hits = [];
const request = (command, params = {}, options = {}) => broker.request({
  command, params, requestId: `p101-request-${++sequence}`, ...options,
});
async function mutate(command, params, operationId, precondition) {
  if (!precondition) { const state = await request('system.describe'); assert.equal(state.ok, true);
    precondition = { bootId: state.bootId, revision: state.revision }; }
  return request(command, params, { operationId, precondition });
}
function succeeded(response) { assert.equal(response.ok, true); return response.result; }
function items(result) { return Array.isArray(result) ? result : result.items; }
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function brokerReady(label) {
  // Only discovery reads wait for a newly created/woken extension context.
  // Never retry a mutation or a malformed typed response.
  const response = await waitFor(async () => {
    try {
      const state = await request('system.describe');
      assert.equal(state.ok, true); return state;
    } catch (failure) {
      if (failure.code !== 'PCMS_PERSONA_BROKER_TRANSPORT_UNAVAILABLE') throw failure;
      report.bootFailureCode = failure.code;
      report.bootTransportFailure = h.lastBrokerTransportFailure || null; return null;
    }
  }, label);
  delete report.bootFailureCode; delete report.bootTransportFailure;
  return response;
}
try {
  report.stage = 'reproducible-xpi';
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, 'extension/manifest.json'), 'utf8'));
  const xpi = join(REPO_ROOT, `dist/persona-route-manager-v${manifest.version}.xpi`);
  await execFileText(process.execPath, [join(REPO_ROOT, 'scripts/build-extension.mjs')], { cwd: REPO_ROOT });
  const firstHash = await sha256File(xpi);
  await execFileText(process.execPath, [join(REPO_ROOT, 'scripts/build-extension.mjs')], { cwd: REPO_ROOT });
  assert.equal(await sha256File(xpi), firstHash);
  report.product = { id: PRODUCT, version: manifest.version, xpiSha256: firstHash };
  const modules = ['pcms/core/persona-broker.js', 'pcms/core/persona-broker-contract.js', 'pcms/platform/firefox-persona-broker-transport.js'];
  for (const file of modules) {
    const { stdout } = await execFileText('unzip', ['-p', xpi, file]);
    assert.equal(digest(Buffer.from(stdout)), digest(await readFile(join(REPO_ROOT, 'extension', file))));
  }
  const members = (await execFileText('unzip', ['-Z1', xpi])).stdout.split('\n');
  assert.ok(!members.some(p => /^(tests|tools)\/|(^|\/)browser-baseline\//.test(p)));
  report.checks.reproducibleXpiAndExactBrokerBytes = true;

  report.stage = 'persistent-install';
  server = createServer((req, res) => { hits.push(req.url); res.end('routing fixture'); });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  h = await IsolatedFirefox.create({ root: join(root, 'profiles'), allowedOrigins: [origin] });
  report.firefox = h.artifact;
  await h.start();
  await h.navigate(origin + '/reachable-control');
  assert.equal(await h.pageScript('return document.body.textContent;'), 'routing fixture');
  assert.ok(hits.includes('/reachable-control'));
  const controlHits = hits.length;
  await h.navigate('about:blank');
  report.checks.routingFixtureReachableBeforeProduct = true;
  assert.equal(await h.install(xpi), PRODUCT);
  const extension = await h.extension(PRODUCT);
  assert.equal(extension.manifestVersion, 3);
  assert.equal(extension.persistent, false);
  // PersonaMonkey's preserved management document is independent of Alpha's
  // future product UI and the donor's dynamic PCMS feature-module dashboard.
  let tab = await h.openPage(PRODUCT, 'pcms/index.html');
  broker = packagedBroker(h);
  const initial = await brokerReady('PersonaMonkey broker boot');
  assert.equal(initial.result.integrationProtocolVersion, 1);
  assert.equal(initial.result.authority.allowDirect, false);
  assert.ok(initial.result.commands.some(c => c.command === 'persona.create'));
  assert.ok(initial.result.commands.some(c => c.command === 'route.assign'));
  assert.deepEqual(items(succeeded(await request('persona.list'))), []);
  succeeded(await request('system.status'));
  report.checks.packagedInstallAndTypedBrokerDescribe = true;

  report.stage = 'persona-and-default-block';
  const createParams = { personaUid: UID, name: 'P101 disposable Persona' };
  const createState = await request('system.describe');
  const createPrecondition = { bootId: createState.bootId, revision: createState.revision };
  const created = succeeded(await mutate('persona.create', createParams, 'p101-create-once', createPrecondition));
  assert.equal(created.persona.personaUid, UID);
  assert.match(created.persona.cookieStoreId, /^firefox-container-\d+$/);
  const cookieStoreId = created.persona.cookieStoreId;
  assert.equal(items(succeeded(await request('persona.list'))).length, 1);
  const defaultPersona = succeeded(await request('persona.get', { personaUid: UID }));
  assert.equal(defaultPersona.personaUid, UID);
  assert.equal(defaultPersona.health.routeId, '__block__');
  assert.equal(defaultPersona.health.status, 'blocked');
  const replay = succeeded(await mutate('persona.create', createParams, 'p101-create-once', createPrecondition));
  assert.equal(replay.persona.cookieStoreId, cookieStoreId);
  assert.equal(items(succeeded(await request('persona.list'))).length, 1);
  const blocked = succeeded(await mutate('route.assign', { personaUid: UID, routeId: '__block__' }, 'p101-assign-block'));
  assert.equal(blocked.route.id, '__block__');
  assert.equal(blocked.persona.personaUid, UID);
  report.checks.personaUidContainerAndCorrelatedCreate = true;
  report.checks.newPersonaDefaultsToBlock = true;
  report.checks.blockRouteAssignment = true;

  report.stage = 'invalid-stale-and-direct-writes';
  const beforeFaults = await request('system.describe');
  const stale = await mutate('persona.updateIdentity', { personaUid: UID, changes: { name: 'must-not-apply' } },
    'p101-stale-revision', { bootId: beforeFaults.bootId, revision: beforeFaults.revision + 1 });
  assert.equal(stale.ok, false); assert.equal(stale.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT);
  const denied = await mutate('route.assign', { personaUid: UID, routeId: '__direct__', allowDirect: true }, 'p101-direct-denied');
  assert.equal(denied.ok, false); assert.equal(denied.error.code, INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED);
  const invalid = await mutate('persona.updateIdentity', { personaUid: UID, changes: { name: 'must-not-apply' }, unexpected: true }, 'p101-invalid-fields');
  assert.equal(invalid.ok, false); assert.equal(invalid.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST);
  assert.equal(succeeded(await request('persona.get', { personaUid: UID })).name, createParams.name);
  assert.equal((await request('system.describe')).revision, beforeFaults.revision);
  report.checks.staleRevisionAndUnknownFieldsRejected = true;
  report.checks.directDeniedWithoutMutation = true;

  report.stage = 'fail-closed-network';
  const beforeHandles = await h.client.command('WebDriver:GetWindowHandles');
  await h.observeFixtureNavigation(origin + '/must-be-blocked');
  const opened = succeeded(await mutate('persona.open', { personaUid: UID, url: origin + '/must-be-blocked', active: false }, 'p101-open-blocked'));
  assert.equal(opened.personaUid, UID); assert.equal(opened.cookieStoreId, cookieStoreId);
  const afterHandles = await h.client.command('WebDriver:GetWindowHandles');
  const blockedHandle = (afterHandles.value ?? afterHandles).find(v => !(beforeHandles.value ?? beforeHandles).includes(v));
  assert.ok(blockedHandle);
  await h.client.command('WebDriver:SwitchToWindow', { handle: blockedHandle });
  const navigation = await waitFor(async () => {
    const result = await h.fixtureNavigationResult(); return result.stopped ? result : null;
  }, 'Block route stops the real fixture navigation');
  assert.notEqual(navigation.status, 0);
  assert.equal(hits.length, controlHits);
  await h.closePage(blockedHandle);
  await h.client.command('WebDriver:SwitchToWindow', { handle: tab });
  report.checks.blockedPersonaCannotReachAllowedLoopback = true;

  report.stage = 'sender-boundary';
  const popup = await h.openPage(PRODUCT, 'popup/popup.html');
  await assert.rejects(() => request('system.describe'), e => e.code === 'PCMS_PERSONA_BROKER_TRANSPORT_UNAVAILABLE');
  await h.closePage(popup);
  await h.client.command('WebDriver:SwitchToWindow', { handle: tab });
  report.checks.nonPcmsDocumentCannotUseInternalBroker = true;

  report.stage = 'idle-wake';
  const beforeIdle = await request('system.describe');
  broker.close(); await h.closePage(tab);
  assert.equal((await h.forceIdleUnload(PRODUCT)).state, 'stopped');
  tab = await h.openPage(PRODUCT, 'pcms/index.html'); broker = packagedBroker(h);
  const warm = await brokerReady('typed broker resumes after forced event-page unload');
  assert.notEqual(warm.bootId, beforeIdle.bootId);
  assert.equal(succeeded(await request('persona.get', { personaUid: UID })).cookieStoreId, cookieStoreId);
  report.checks.idleUnloadAndTypedBrokerWake = true;

  report.stage = 'browser-restart';
  const beforeRestart = await request('system.describe');
  broker.close(); await h.closePage(tab); await h.restart();
  // Deliberately no Addon:Install call after either unload or full restart.
  assert.equal((await h.extension(PRODUCT)).id, PRODUCT);
  tab = await h.openPage(PRODUCT, 'pcms/index.html'); broker = packagedBroker(h);
  const cold = await brokerReady('typed broker resumes after browser restart');
  assert.notEqual(cold.bootId, beforeRestart.bootId);
  const persisted = succeeded(await request('persona.get', { personaUid: UID }));
  assert.equal(persisted.cookieStoreId, cookieStoreId); assert.equal(persisted.name, createParams.name);
  assert.equal(persisted.health.routeId, '__block__');
  assert.equal(items(succeeded(await request('persona.list'))).length, 1);
  const oldBoot = await mutate('route.assign', { personaUid: UID, routeId: '__block__' }, 'p101-old-boot',
    { bootId: beforeRestart.bootId, revision: beforeRestart.revision });
  assert.equal(oldBoot.ok, false); assert.equal(oldBoot.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT);
  const replayAfterRestart = succeeded(await mutate('persona.create', createParams, 'p101-create-once', createPrecondition));
  assert.equal(replayAfterRestart.persona.cookieStoreId, cookieStoreId);
  assert.equal(items(succeeded(await request('persona.list'))).length, 1);
  assert.equal(hits.length, controlHits);
  await h.closePage(tab);
  report.checks.persistentXpiAndPersonaSurviveBrowserRestart = true;
  report.checks.oldBootRejectedAndCreateReplayDoesNotDuplicate = true;
  report.acceptanceIds = ['AP101-01', 'AP101-02', 'AP101-03'];
  report.passed = true;
} catch (failure) { error = failure; }
finally {
  broker?.close(); await h?.dispose();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(done => server.close(done));
  await saveReport(reportPath, report, error);
}
if (error) throw new Error(`P101 packaged baseline failed; see ${reportPath}`, { cause: error });
