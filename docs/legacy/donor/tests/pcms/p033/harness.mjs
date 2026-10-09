// P033 harness: the real background Core (createBackgroundPcmsCore) over one shared durable
// store with the P030 fake background document, as in P031, plus an injected bundled-module
// list. The Statistics entry loads the real pcms-modules/p018/ui.js; a fixture built-in is
// added only by appending one entry, exactly as a new built-in module would be.
import { createPcmsInternalBrokerEndpointRegistry } from "../../../extension/lib/pcms-internal-broker-endpoint.js";
import { createPcmsAuditJournal } from "../../../extension/pcms/audit/journal.js";
import { createBackgroundPcmsCore } from "../../../extension/pcms/background/core-factory.js";
import { createBackgroundSandboxFrameFactory } from "../../../extension/pcms/background/sandbox/frame-factory.js";
import { PCMS_BUNDLED_MODULES } from "../../../extension/pcms/integration/bundled-modules.js";
import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";
import { makeAuditBackend, makeMemoryBackend } from "../p023/harness.mjs";
import { integrationHandler } from "../p028/harness.mjs";
import { CONTROLLER_URL, makeBackgroundDocument } from "../p030/harness.mjs";
import { AVAILABLE, FEATURE_FACTORIES, makeClock } from "../p031/harness.mjs";
import { SHELF_ID } from "./fixtures.mjs";

export { AVAILABLE, UNAVAILABLE, makeClock } from "../p031/harness.mjs";

export function makeWorld({ clock = makeClock() } = {}) {
  return { shared: { rows: new Map() }, clock };
}

// The packaged loader imports "/pcms-modules/..."; in Node the same path maps to the repo.
export function repoImport(path) {
  return import(new URL("../../.." + path, import.meta.url).href);
}

export async function openContext(world, { support = AVAILABLE, shelf = null, wake = "COLD" } = {}) {
  const backend = makeMemoryBackend(world.shared);
  const storageBroker = createPcmsStorageBroker({ backend, clock: world.clock });
  const auditJournal = createPcmsAuditJournal({ backend: makeAuditBackend(backend), clock: world.clock });
  const registry = createPcmsInternalBrokerEndpointRegistry();
  const handler = integrationHandler();
  registry.register({ ready: async () => {}, handleRequest: (request) => handler.handleRequest(request), attachEvents: async () => true });
  const document = makeBackgroundDocument({ mode: "sandboxed" });
  const factory = createBackgroundSandboxFrameFactory({ documentRef: document, pageUrl: CONTROLLER_URL, loadTimeoutMs: 200 });
  let supportStatus = support;
  // Exactly the shipped list, plus (optionally) one more entry for the fixture built-in.
  const bundledModules = [...PCMS_BUNDLED_MODULES, ...(shelf ? [{ moduleId: SHELF_ID, ui: "/pcms-modules/fixture-shelf/ui.js", dependsOn: [] }] : [])];
  const core = createBackgroundPcmsCore({
    transport: registry.createEndpoint(),
    featureFactories: FEATURE_FACTORIES,
    storageBroker,
    auditJournal,
    clock: world.clock,
    moduleHost: {
      frameFactory: (request) => factory.create(request),
      support: { getStatus: async () => supportStatus }
    },
    bundledModules,
    importBundledModule: async (path) => path === "/pcms-modules/fixture-shelf/ui.js"
      ? { createUiContribution: () => shelf.contribution }
      : repoImport(path)
  });
  const ui = core.ui;
  const context = {
    core,
    ui,
    document,
    storageBroker,
    auditJournal,
    setSupport(status) { supportStatus = status; },
    unload() {
      for (const frame of document.frames) frame.remove();
      core.close();
    }
  };
  await core.initialize({ wake });
  return context;
}

export async function settle(turns = 20) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function byId(snapshot, moduleId) {
  return snapshot.modules.find((item) => item.moduleId === moduleId) || null;
}
