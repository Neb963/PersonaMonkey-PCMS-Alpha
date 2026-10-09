// ADR-003 §1: controller frames live in the background page document (ADR-002).
// One <iframe src="pcms/sandbox/controller.html"> per module generation; the
// runtime broker removes it on dispose, fence or failed activation. Frames are
// ephemeral: an event-page unload discards the document and every frame with it.
//
// The factory never hands out a frame it cannot prove is isolated. A declared
// sandbox page has an opaque origin, so the background (same extension origin)
// must not be able to reach its document. A frame whose document is reachable
// (for example Firefox < 154, which ignores the manifest `sandbox` key) is removed
// and activation fails closed.

import { MODULE_RUNTIME_CONTROLLER_PAGE } from "../../runtime/browser-floor.js";
import { assertModuleId } from "../../modules/package.js";

export const SANDBOX_FRAME_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "PCMS_SANDBOX_FRAME_INVALID_REQUEST",
  DUPLICATE_GENERATION: "PCMS_SANDBOX_FRAME_DUPLICATE_GENERATION",
  CAPACITY: "PCMS_SANDBOX_FRAME_CAPACITY",
  LOAD_FAILED: "PCMS_SANDBOX_FRAME_LOAD_FAILED",
  LOAD_TIMEOUT: "PCMS_SANDBOX_FRAME_LOAD_TIMEOUT",
  NOT_ISOLATED: "PCMS_SANDBOX_FRAME_NOT_ISOLATED"
});

export class SandboxFrameError extends Error {
  constructor(code) {
    super("Sandbox controller frame unavailable: " + code);
    this.name = "SandboxFrameError";
    this.code = code;
  }
}

function frameError(code) {
  return new SandboxFrameError(code);
}

// Opaque-origin check from the parent side: the frame has a window, but its
// document is unreachable (null or SecurityError) from the extension origin.
export function isFrameIsolated(frame) {
  if (!frame?.contentWindow) return false;
  let reachable = null;
  try { reachable = frame.contentDocument; } catch { reachable = null; }
  if (reachable) return false;
  try { return !frame.contentWindow.document; } catch { return true; }
}

export function createBackgroundSandboxFrameFactory({
  documentRef = globalThis.document,
  pageUrl,
  loadTimeoutMs = 5_000,
  maxFrames = 64,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis)
} = {}) {
  if (!documentRef || typeof documentRef.createElement !== "function") {
    throw new TypeError("Sandbox frame factory requires the background document");
  }
  if (typeof pageUrl !== "string" || !pageUrl.endsWith("/" + MODULE_RUNTIME_CONTROLLER_PAGE)) {
    throw new TypeError("Sandbox frame factory requires the declared controller page URL");
  }
  if (!Number.isInteger(loadTimeoutMs) || loadTimeoutMs < 100 || loadTimeoutMs > 60_000) {
    throw new RangeError("Sandbox frame load timeout is out of bounds");
  }
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 256) {
    throw new RangeError("Sandbox frame capacity is out of bounds");
  }
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw new TypeError("Sandbox frame factory timers are unavailable");
  }

  const live = new Map();

  function remove(key, frame) {
    if (live.get(key)?.frame === frame) live.delete(key);
    try { frame.remove(); } catch {}
  }

  function waitForLoad(frame) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        frame.removeEventListener?.("load", onLoad);
        frame.removeEventListener?.("error", onError);
        if (error) reject(error); else resolve();
      };
      const onLoad = () => finish(null);
      const onError = () => finish(frameError(SANDBOX_FRAME_ERROR_CODES.LOAD_FAILED));
      const timer = setTimer(() => finish(frameError(SANDBOX_FRAME_ERROR_CODES.LOAD_TIMEOUT)), loadTimeoutMs);
      frame.addEventListener("load", onLoad);
      frame.addEventListener("error", onError);
    });
  }

  async function create({ moduleId, generation } = {}) {
    try { assertModuleId(moduleId); } catch { throw frameError(SANDBOX_FRAME_ERROR_CODES.INVALID_REQUEST); }
    if (!Number.isSafeInteger(generation) || generation < 1) throw frameError(SANDBOX_FRAME_ERROR_CODES.INVALID_REQUEST);
    const key = moduleId + "#" + generation;
    if (live.has(key)) throw frameError(SANDBOX_FRAME_ERROR_CODES.DUPLICATE_GENERATION);
    if (live.size >= maxFrames) throw frameError(SANDBOX_FRAME_ERROR_CODES.CAPACITY);

    const frame = documentRef.createElement("iframe");
    // Defence in depth: the iframe sandbox attribute also forces an opaque origin.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("hidden", "");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.setAttribute("data-pcms-module", moduleId);
    frame.setAttribute("data-pcms-generation", String(generation));
    const record = { frame, disposed: false };
    live.set(key, record);

    try {
      const loaded = waitForLoad(frame);
      frame.setAttribute("src", pageUrl);
      (documentRef.body || documentRef.documentElement).appendChild(frame);
      await loaded;
      if (record.disposed) throw frameError(SANDBOX_FRAME_ERROR_CODES.LOAD_FAILED);
      if (!isFrameIsolated(frame)) throw frameError(SANDBOX_FRAME_ERROR_CODES.NOT_ISOLATED);
    } catch (error) {
      record.disposed = true;
      remove(key, frame);
      throw error;
    }

    return Object.freeze({
      frame,
      moduleId,
      generation,
      dispose() {
        if (record.disposed) return false;
        record.disposed = true;
        remove(key, frame);
        return true;
      }
    });
  }

  function disposeAll() {
    const records = [...live.entries()];
    for (const [key, record] of records) {
      record.disposed = true;
      remove(key, record.frame);
    }
    return records.length;
  }

  return Object.freeze({
    create,
    disposeAll,
    list() {
      return Object.freeze([...live.keys()].sort());
    },
    get size() { return live.size; }
  });
}

// One-time isolation probe for createModuleRuntimeSupport(): load the declared
// controller page, check it is opaque, remove it.
export function createSandboxIsolationProbe(factory) {
  if (!factory || typeof factory.create !== "function") throw new TypeError("Sandbox isolation probe requires a frame factory");
  let sequence = 0;
  return async function probeIsolation() {
    const handle = await factory.create({ moduleId: "pcms.sandbox-probe", generation: ++sequence });
    handle.dispose();
    return true;
  };
}
