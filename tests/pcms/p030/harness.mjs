// P030 fake background document. Each <iframe> that loads gets its own
// controller realm (installSandboxControllerRuntime over a fake window), so the
// real P004 host/runtime protocol runs end to end through the P030 frame factory.
import { installSandboxControllerRuntime } from "../../../extension/pcms/sandbox/controller-runtime.js";

export const CONTROLLER_URL = "moz-extension://pcms-p030-test/pcms/sandbox/controller.html";

function makeSandboxWindow(origin) {
  const listeners = new Map();
  return {
    parent: {},
    location: { origin },
    addEventListener(type, listener) {
      const set = listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event) { for (const listener of [...(listeners.get(type) || [])]) listener(event); }
  };
}

class FakeFrame {
  constructor(doc) {
    this.ownerDocument = doc;
    this.attributes = new Map();
    this.listeners = new Map();
    this.contentWindow = null;
    this.child = null;
    this.removed = false;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    const set = this.listeners.get(type) || new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) || [])]) listener({ type, target: this }); }
  get contentDocument() {
    if (!this.contentWindow) return null;
    return this.ownerDocument.mode === "same-origin" ? { reachable: true } : null;
  }
  remove() {
    if (this.removed) return;
    this.removed = true;
    this.ownerDocument.body.children.delete(this);
    this.child?.dispose();
    this.child = null;
    this.contentWindow = null;
  }
  attached() {
    const doc = this.ownerDocument;
    if (doc.mode === "hang") return;
    queueMicrotask(() => {
      if (this.removed) return;
      if (doc.mode === "error") { this.dispatch("error"); return; }
      const windowRef = makeSandboxWindow("moz-extension://pcms-p030-test");
      this.child = installSandboxControllerRuntime({ windowRef, capabilityTimeoutMs: 750 });
      const self = this;
      const contentWindow = {
        postMessage(data, targetOrigin, ports) {
          if (self.removed) return;
          windowRef.emit("message", { source: windowRef.parent, origin: windowRef.location.origin, data, ports });
        }
      };
      if (doc.mode !== "same-origin") {
        Object.defineProperty(contentWindow, "document", {
          get() { throw Object.assign(new Error("Permission denied"), { name: "SecurityError" }); }
        });
      } else {
        contentWindow.document = { reachable: true };
      }
      this.contentWindow = contentWindow;
      doc.loads.push(this.getAttribute("src"));
      this.dispatch("load");
    });
  }
}

export function makeBackgroundDocument({ mode = "sandboxed" } = {}) {
  const doc = {
    mode,
    loads: [],
    created: [],
    body: {
      children: new Set(),
      appendChild(frame) {
        this.children.add(frame);
        frame.attached();
        return frame;
      }
    },
    createElement(tag) {
      if (tag !== "iframe") throw new Error("unexpected element " + tag);
      const frame = new FakeFrame(doc);
      doc.created.push(frame);
      return frame;
    },
    get frames() {
      return [...doc.body.children];
    }
  };
  return doc;
}
