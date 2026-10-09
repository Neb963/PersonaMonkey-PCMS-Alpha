// Background binding of the module runtime host (ADR-003 §1): controller frames live in the
// background page document, created by the P030 frame factory from the declared sandbox
// page, and the browser floor is detected once per Core context. Without a background
// document (Node tests, or a non-DOM context) the runtime reports UNAVAILABLE and Core
// keeps working.
import {
  MODULE_RUNTIME_AVAILABILITY,
  MODULE_RUNTIME_CONTROLLER_PAGE,
  MODULE_RUNTIME_UNAVAILABLE_REASONS,
  createModuleRuntimeSupport
} from "../../runtime/browser-floor.js";
import { createBackgroundSandboxFrameFactory, createSandboxIsolationProbe } from "../sandbox/frame-factory.js";

const NO_HOST_STATUS = Object.freeze({
  state: MODULE_RUNTIME_AVAILABILITY.UNAVAILABLE,
  reason: MODULE_RUNTIME_UNAVAILABLE_REASONS.BROWSER_UNKNOWN,
  message: "Requires Firefox 154+ (no background document)",
  browser: null
});

export function createBackgroundModuleRuntimeOptions({
  capabilities = {},
  documentRef = globalThis.document,
  browserRef = globalThis.browser,
  frameFactory = null,
  support = null
} = {}) {
  // Explicit injection (tests) wins over the Firefox binding.
  if (frameFactory || support) {
    return Object.freeze({ capabilities, frameFactory, support, dispose() { return 0; } });
  }
  if (!documentRef || typeof documentRef.createElement !== "function" || typeof browserRef?.runtime?.getURL !== "function") {
    return Object.freeze({
      capabilities,
      frameFactory: null,
      support: Object.freeze({ getStatus: async () => NO_HOST_STATUS }),
      dispose() { return 0; }
    });
  }
  const factory = createBackgroundSandboxFrameFactory({
    documentRef,
    pageUrl: browserRef.runtime.getURL(MODULE_RUNTIME_CONTROLLER_PAGE)
  });
  return Object.freeze({
    capabilities,
    frameFactory: (request) => factory.create(request),
    support: createModuleRuntimeSupport({
      getBrowserInfo: () => browserRef.runtime.getBrowserInfo(),
      getManifest: () => browserRef.runtime.getManifest(),
      probeIsolation: createSandboxIsolationProbe(factory)
    }),
    dispose() { return factory.disposeAll(); }
  });
}
