// P031 harness: the real background Core (createBackgroundPcmsCore) over one shared durable
// store, with the P030 fake background document as its sandbox host and a mutable clock.
// A "new context" (event-page unload, browser restart) is a new Core over the same rows.
import { createPcmsInternalBrokerEndpointRegistry } from "../../../extension/lib/pcms-internal-broker-endpoint.js";
import { createPcmsAuditJournal } from "../../../extension/pcms/audit/journal.js";
import { createBackgroundPcmsCore } from "../../../extension/pcms/background/core-factory.js";
import { createBackgroundSandboxFrameFactory } from "../../../extension/pcms/background/sandbox/frame-factory.js";
import { MODULE_RUNTIME_AVAILABILITY } from "../../../extension/pcms/runtime/browser-floor.js";
import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";
import { createAccountsService } from "../../../pcms-modules/p014/accounts.js";
import { createDeployerService } from "../../../pcms-modules/p015/deployer.js";
import { createExplorerService } from "../../../pcms-modules/p016/explorer.js";
import { createRefresherService } from "../../../pcms-modules/p017/refresher.js";
import { createStatisticsService } from "../../../pcms-modules/p018/statistics.js";
import { createProvisioningService } from "../../../pcms-modules/p019/provisioning.js";
import { makeAuditBackend, makeMemoryBackend } from "../p023/harness.mjs";
import { integrationHandler } from "../p028/harness.mjs";
import { CONTROLLER_URL, makeBackgroundDocument } from "../p030/harness.mjs";

export const START = "2026-10-08T12:00:00.000Z";

export const FEATURE_FACTORIES = Object.freeze({
  accounts: createAccountsService,
  deployer: createDeployerService,
  explorer: createExplorerService,
  refresher: createRefresherService,
  statistics: createStatisticsService,
  provisioning: createProvisioningService
});

export const AVAILABLE = Object.freeze({ state: MODULE_RUNTIME_AVAILABILITY.AVAILABLE, reason: null, message: null, browser: null });
export const UNAVAILABLE = Object.freeze({
  state: MODULE_RUNTIME_AVAILABILITY.UNAVAILABLE,
  reason: "BROWSER_TOO_OLD",
  message: "Requires Firefox 154+",
  browser: null
});

export function makeClock(start = START) {
  let ms = Date.parse(start);
  const clock = () => new Date(ms).toISOString();
  clock.advance = (delta) => { ms += delta; return clock(); };
  clock.set = (iso) => { ms = Date.parse(iso); return clock(); };
  return clock;
}

export function makeWorld({ clock = makeClock() } = {}) {
  return { shared: { rows: new Map() }, clock };
}

// One background context: its own Core objects and its own background document.
export async function openContext(world, { wake = "COLD", support = AVAILABLE, initialize = true, documentMode = "sandboxed" } = {}) {
  const backend = makeMemoryBackend(world.shared);
  const storageBroker = createPcmsStorageBroker({ backend, clock: world.clock });
  const auditJournal = createPcmsAuditJournal({ backend: makeAuditBackend(backend), clock: world.clock });
  const registry = createPcmsInternalBrokerEndpointRegistry();
  const handler = integrationHandler();
  registry.register({ ready: async () => {}, handleRequest: (request) => handler.handleRequest(request), attachEvents: async () => true });
  const document = makeBackgroundDocument({ mode: documentMode });
  const factory = createBackgroundSandboxFrameFactory({ documentRef: document, pageUrl: CONTROLLER_URL, loadTimeoutMs: 200 });
  let supportStatus = support;
  const core = createBackgroundPcmsCore({
    transport: registry.createEndpoint(),
    featureFactories: FEATURE_FACTORIES,
    storageBroker,
    auditJournal,
    clock: world.clock,
    moduleHost: {
      frameFactory: (request) => factory.create(request),
      support: { getStatus: async () => supportStatus }
    }
  });
  const context = {
    core,
    document,
    factory,
    initialized: null,
    setSupport(status) { supportStatus = status; },
    // The alarm coordinator's due pass: interrupted recovery, declarations, due delivery.
    async duePass({ wakeKind = "WARM" } = {}) {
      const recovered = await core.timers.recoverInterrupted({});
      await core.declareTimerSchedules({ wake: wakeKind, recovered: recovered.recovered });
      return core.timers.runDue({});
    },
    // Event-page unload: every frame of this document disappears with it.
    unload() {
      for (const frame of document.frames) frame.remove();
      core.close();
    }
  };
  if (initialize) context.initialized = await core.initialize({ wake });
  return context;
}

export async function settle(turns = 20) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export async function moduleData(world, moduleId) {
  const backend = makeMemoryBackend(world.shared);
  const storageBroker = createPcmsStorageBroker({ backend, clock: world.clock });
  const rows = await storageBroker.namespace("module." + moduleId + ".data").list();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function auditEvents(world) {
  const backend = makeMemoryBackend(world.shared);
  const auditJournal = createPcmsAuditJournal({ backend: makeAuditBackend(backend), clock: world.clock });
  const events = [];
  let afterSequence = 0;
  for (;;) {
    const page = await auditJournal.read({ afterSequence, limit: 100 });
    events.push(...page.events);
    if (!page.hasMore || page.events.length === 0) break;
    afterSequence = page.events.at(-1).sequence;
  }
  return events;
}

// Puts a Core timer row into DISPATCHING, as an unload in the middle of delivery leaves it.
export async function interruptTimer(world, timerId) {
  const backend = makeMemoryBackend(world.shared);
  const storageBroker = createPcmsStorageBroker({ backend, clock: world.clock });
  const store = storageBroker.namespace("core.timers");
  const row = await store.get(timerId);
  return store.compareAndSwap(timerId, { expectedRevision: row.revision, value: { ...row.value, state: "DISPATCHING" } });
}
