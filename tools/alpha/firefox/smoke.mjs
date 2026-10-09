import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IsolatedFirefox } from './harness.mjs';
import { waitFor } from '../../firefox/packaged-harness.mjs';
import { newReport, saveReport } from './report.mjs';

const root = resolve(process.env.FIREFOX_SMOKE_DIR || join(tmpdir(), 'alpha-p101-smoke'));
const reportPath = resolve(process.env.FIREFOX_SMOKE_REPORT || join(root, 'report.json'));
const report = await newReport('isolated-smoke');
let h, server, error;
const hits = [];
try {
  report.stage = 'fixture';
  server = createServer((request, response) => {
    hits.push(request.url);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Alpha isolated smoke</title><main id="ready">alpha-p101-loopback-ok</main>');
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  report.stage = 'pinned-browser';
  h = await IsolatedFirefox.create({ root: join(root, 'profiles'), allowedOrigins: [origin] });
  report.firefox = h.artifact;
  await h.start();
  report.stage = 'loopback-dom';
  await h.navigate(origin + '/smoke');
  assert.equal(await h.pageScript('return document.getElementById("ready")?.textContent;'), 'alpha-p101-loopback-ok');
  assert.ok(hits.includes('/smoke'));
  report.checks.loopbackDomVerified = true;
  report.stage = 'deny-unlisted-origin';
  const count = hits.length;
  // Same server, distinct origin: neither loopback bypass nor redirects widen
  // the exact allowlist. No public/provider endpoint is contacted by this test.
  try { await h.navigate(`http://localhost:${server.address().port}/must-not-arrive`); } catch { /* cancelled navigation */ }
  await waitFor(() => h.deniedLoopbackOrigin(`http://localhost:${server.address().port}`), 'parent observer confirms exact-origin denial');
  assert.equal(hits.length, count);
  report.checks.unlistedOriginBlocked = true;
  report.passed = true;
} catch (failure) { error = failure; }
finally {
  await h?.dispose();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(done => server.close(done));
  await saveReport(reportPath, report, error);
}
if (error) throw new Error('P101 isolated smoke failed; see the bounded report', { cause: error });
