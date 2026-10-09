import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { git, requireThat } from '../governance.mjs';

export const P201_FILE = 'tests/alpha/core/packaged.test.mjs';
export const P201_CASES = Object.freeze([
  'AP201-01 startup and sender/request authorization',
  'AP201-02 two clients one core',
  'AP201-02 idle unload and warm alarm wake',
  'AP201-02 cold browser restart',
  'AP201-03 UNCERTAIN and RECOVERY_HOLD',
  'AP201-03 bounded alarms and operation/tab budgets',
]);
const CORE_PATH = /^extension\/alpha\/(?:core|bootstrap)\//;
const LEGACY = /^extension\/pcms\/(?:background\/|integration\/(?:live-core|composition)\.js$)/;
const CONSTRUCTORS = /\b(?:createPcmsLiveCore|createBackgroundPcmsCore|createFirefoxPcmsCoreHost|createModuleRuntimeBroker)\s*\(/;
const specifiers = source => [...source.matchAll(
  /(?:\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["'])|(?:\bimport\s*\(\s*["']([^"']+)["']\s*\))/g
)].map(m => m[1] || m[2]);

async function filesUnder(root, path) {
  const out = [], dir = join(root, path);
  let info;
  try { info = await lstat(dir); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  requireThat(info.isDirectory() && !info.isSymbolicLink(), 'Core/test discovery cannot follow symlinks');
  for (const e of await readdir(dir, { withFileTypes: true })) {
    requireThat(!e.isSymbolicLink(), 'Core/test discovery cannot follow symlinks');
    const child = `${path}/${e.name}`;
    if (e.isDirectory()) out.push(...await filesUnder(root, child));
    else if (e.isFile()) out.push(child);
  }
  return out.sort();
}

// Triggered by product bytes/reachability and predecessor main, never plan status,
// claimed acceptance, optional environment flags or a branch-controlled manifest of tests.
export async function verifyDerivative(root, mainRef) {
  root = resolve(root);
  const coreFiles = [...await filesUnder(root, 'extension/alpha/core'),
    ...await filesUnder(root, 'extension/alpha/bootstrap')];
  const previous = git(root, ['ls-tree', '-r', '--name-only', mainRef, 'extension/alpha/core', 'extension/alpha/bootstrap']);
  const bootstrap = 'extension/lib/recovery-bootstrap.js';
  const baseline = await readFile(join(root, 'docs/legacy/donor', bootstrap));
  const p201 = coreFiles.length > 0 || previous.length > 0 ||
    !(await readFile(join(root, bootstrap))).equals(baseline);
  const manifest = JSON.parse(await readFile(join(root, 'extension/manifest.json')));
  requireThat(manifest.background?.type === 'module' && Array.isArray(manifest.background.scripts) &&
    manifest.background.scripts.length > 0 && manifest.background.persistent !== true,
  'Derivative must retain an event background with PersonaMonkey authority');
  const sources = new Map(), queue = manifest.background.scripts.map(p => `extension/${p}`);
  while (queue.length) {
    const path = queue.shift();
    if (sources.has(path)) continue;
    const full = resolve(root, path);
    requireThat(full.startsWith(join(root, 'extension') + '/') && await realpath(full) === full && (await lstat(full)).isFile(),
      'Background import escaped the derivative product');
    const source = await readFile(full, 'utf8'); sources.set(path, source);
    if (LEGACY.test(path)) {
      continue; // Historical product graph is tested on the frozen donor.
    }
    if (p201 && (CORE_PATH.test(path) || path === bootstrap)) {
      requireThat(!/\bimport\s*\(\s*[^"' \t\r\n]/.test(source) && !/\beval\s*\(|\bimportScripts\s*\(/.test(source),
        'Core bootstrap must have an inspectable import graph');
    }
    for (const specifier of specifiers(source)) {
      requireThat(specifier.startsWith('.') || specifier.startsWith('/'), 'Uninspectable background module');
      queue.push(relative(root, resolve(specifier.startsWith('/') ? join(root, 'extension') : dirname(full),
        specifier.startsWith('/') ? `.${specifier}` : specifier)));
    }
  }
  requireThat(sources.has(bootstrap) && specifiers(sources.get(bootstrap))[0] === './routing-gate.js' &&
    sources.has('extension/lib/routing-gate.js') && sources.has('extension/background.js') &&
    sources.has('extension/lib/pcms-internal-broker-endpoint.js'),
  'Derivative is missing PersonaMonkey routing/broker authority');
  if (!p201) return { p201: 'NOT_IMPLEMENTED', providerLive: false };
  for (const [path, source] of sources) requireThat(!LEGACY.test(path) && !CONSTRUCTORS.test(source),
    'Alpha Core and legacy Core authority cannot coexist');
  requireThat([...sources.keys()].some(p => CORE_PATH.test(p)), 'Alpha Core is not reachable from the packaged background');
  const testFiles = (await filesUnder(root, 'tests/alpha/core')).filter(p => /\.(?:test|spec)\.(?:mjs|cjs|js)$/.test(p));
  requireThat(testFiles.includes(P201_FILE), `Required P201 packaged acceptance file is missing: ${P201_FILE}`);
  requireThat((await readFile(join(root, P201_FILE), 'utf8')).includes('tools/alpha/firefox/harness.mjs'),
    'P201 acceptance must use the actual packaged Firefox harness');
  return { p201: 'REQUIRED', testFiles, providerLive: false };
}

export function validateP201Events(events, packagedFile) {
  const completed = events.filter(e => e.type === 'test:pass' || e.type === 'test:fail');
  requireThat(completed.length > 0 && !completed.some(e => e.type === 'test:fail' || e.data.skip || e.data.todo),
    'P201 tests failed, skipped, TODO or absent');
  const summary = events.find(e => e.type === 'test:summary' && e.data.file === undefined);
  requireThat(summary && summary.data.success === true && summary.data.counts.failed === 0 &&
    summary.data.counts.cancelled === 0 && summary.data.counts.skipped === 0 && summary.data.counts.todo === 0,
  'P201 test execution lacks a successful complete summary');
  for (const name of P201_CASES) {
    const matches = completed.filter(e => e.data.name === name && resolve(e.data.file || '') === packagedFile &&
      e.data.details?.type === 'test');
    requireThat(matches.length === 1 && matches[0].type === 'test:pass', `Required P201 case did not execute: ${name}`);
  }
  return { p201: 'EXECUTED', cases: [...P201_CASES], providerLive: false };
}
