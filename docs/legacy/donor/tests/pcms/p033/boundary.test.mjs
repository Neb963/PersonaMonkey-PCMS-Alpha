// P033 boundaries: module text is rendered as text, the dashboard constructs no Core, the
// Statistics UI pilot stays a read-only projection, and the sandbox runtime (module-ui.js)
// runs a module UI entry with only the Core kit and its private port.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";

import { emptyPcmsContributionSnapshot, legacyModuleIds, modulePageModel } from "../../../extension/pcms/app/contributions.js";
import { PCMS_V2_BUILTIN_MODULE_IDS } from "../../../extension/pcms/app/router-v2.js";
import { BOARD_UI_SOURCE } from "./fixtures.mjs";

test("A033-01 dashboard module surfaces render text only and construct no Core service", async () => {
  const files = ["contributions.js", "module-view.js", "module-actions.js", "module-frame-host.js", "app.js"];
  const sources = await Promise.all(files.map((name) => readFile("extension/pcms/app/" + name, "utf8")));
  for (const [index, source] of sources.entries()) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function/, files[index]);
    assert.doesNotMatch(source, /createBackgroundPcmsCore|createPcmsLiveCore|createPcmsUiContributionHost|indexedDB\s*\.|browser\s*\.(?:tabs|runtime\.sendNativeMessage|contextualIdentities)/, files[index]);
  }
  const host = await readFile("extension/pcms/integration/ui-contributions.js", "utf8");
  assert.doesNotMatch(host, /\bbrowser\s*\.|\bchrome\s*\.|document\.|fetch\s*\(/);
});

test("A033-01 Statistics UI pilot obeys the P018 read-only boundary", async () => {
  const source = await readFile("pcms-modules/p018/ui.js", "utf8");
  assert.doesNotMatch(source, /\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source, /sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/i);
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b/);
  assert.doesNotMatch(source, /document\.|querySelector|MutationObserver|fetch\s*\(/);
  assert.doesNotMatch(source, /\.append\s*\(|transitionAndAppend|compareAndSwap|gate\.mutate|remoteOperation/i);
  assert.doesNotMatch(source, /^import\b/m, "the pilot reads only its injected service");
});

test("A033-03 without Core contributions the inherited shell is unchanged", () => {
  const empty = emptyPcmsContributionSnapshot();
  assert.deepEqual(legacyModuleIds(empty), [...PCMS_V2_BUILTIN_MODULE_IDS]);
  assert.equal(modulePageModel(empty, { moduleId: "statistics", view: null, objectId: null }).message, "This module isn't installed");
});

// --- module-ui.js in a VM with a minimal DOM -----------------------------------------------

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this._text = ""; this.nodeType = 1; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  set className(value) { this.attributes.class = value; }
}

function makeSandbox() {
  const nodes = { root: new FakeNode("main"), moduleUiStatus: new FakeNode("p") };
  const listeners = {};
  const parent = { name: "dashboard" };
  const window = {
    parent,
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    removeEventListener(type, listener) { listeners[type] = (listeners[type] || []).filter((item) => item !== listener); },
    dispatch(type, event) { for (const listener of [...(listeners[type] || [])]) listener(event); }
  };
  const document = {
    title: "",
    getElementById: (id) => nodes[id] || null,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) })
  };
  // Only host objects are injected; intrinsics (Function, Promise, …) stay the VM realm's own,
  // so the module entry compiles inside the sandbox realm (which has no fetch or browser).
  const context = vm.createContext({ window, document, TextEncoder, setTimeout, clearTimeout, self: { origin: "null" } });
  return { context, window, nodes, parent };
}

test("A033-02 SEC module-ui.js runs a module UI entry with the Core kit over its private port only", async () => {
  const source = await readFile("extension/pcms/sandbox/module-ui.js", "utf8");
  const { context, window, nodes, parent } = makeSandbox();
  vm.runInContext(source, context);

  // A message from anything but the embedding parent is ignored.
  const stray = new MessageChannel();
  window.dispatch("message", { source: { name: "other" }, data: { type: "pcms.module-ui.bootstrap", version: 1, sessionId: "session-0001" }, ports: [stray.port2] });
  assert.equal(nodes.moduleUiStatus.textContent, "");
  stray.port1.close();

  const channel = new MessageChannel();
  const received = [];
  const requests = [];
  const done = new Promise((resolve) => {
    channel.port1.on("message", (message) => {
      received.push(message);
      if (message.type === "ready") {
        channel.port1.postMessage({ version: 1, sessionId: "session-0002", type: "load", source: BOARD_UI_SOURCE, context: { moduleId: "fixture.board", title: "Fixture board" } });
      }
      if (message.type === "request") {
        requests.push([message.method, message.params]);
        let result = null;
        let ok = true;
        if (message.method === "listRows") result = { rows: [{ id: "alpha", cells: { card: "alpha" } }], next: null };
        if (message.method === "invoke" && message.params.actionId === "other-module-action") ok = false;
        if (message.method === "invoke" && message.params.actionId === "reset") result = { cancelled: true };
        channel.port1.postMessage(ok
          ? { version: 1, sessionId: "session-0002", type: "response", requestId: message.requestId, ok: true, result }
          : { version: 1, sessionId: "session-0002", type: "response", requestId: message.requestId, ok: false, error: { code: "PCMS_UI_ACTION_UNKNOWN", message: "no" } });
      }
      // The page reports "loaded" once the module entry's own promise settles.
      if (message.type === "loaded") resolve();
    });
  });
  window.dispatch("message", { source: parent, data: { type: "pcms.module-ui.bootstrap", version: 1, sessionId: "session-0002" }, ports: [channel.port2] });
  await done;
  channel.port1.close();

  assert.equal(received[0].type, "ready");
  assert.ok(received.some((message) => message.type === "loaded"));
  assert.deepEqual(requests.map(([method, params]) => method + ":" + (params.actionId || params.view || params.height || "")),
    ["listRows:cards", "invoke:other-module-action", "invoke:record-probe", "resize:360", "invoke:reset"]);
  const facts = JSON.parse(requests[2][1].input.facts);
  assert.equal(facts.browserAbsent, true);
  assert.equal(facts.chromeAbsent, true);
  assert.equal(facts.rowsRead, 1);
  assert.equal(facts.undeclaredActionRejected, true);
  assert.equal(facts.network, "no-fetch");
  // The module rendered into its own root through the kit; text stayed text.
  assert.match(nodes.root.textContent, /Fixture board \(runtime module page\)/);
  assert.match(nodes.root.textContent, /alpha/);
  assert.match(nodes.root.textContent, /Reset cancelled/);
});

test("A033-02 SEC the module-UI kit refuses markup injection and unknown attributes", async () => {
  const source = await readFile("extension/pcms/sandbox/module-ui.js", "utf8");
  const { context, window, parent } = makeSandbox();
  vm.runInContext(source, context);
  const channel = new MessageChannel();
  let outcomes = null;
  const result = new Promise((resolve) => {
    channel.port1.on("message", (message) => {
      if (message.type === "ready") {
        channel.port1.postMessage({ version: 1, sessionId: "session-0003", type: "load", context: { moduleId: "m" },
          source: `(ui) => {
            const outcomes = [];
            for (const attempt of [() => ui.h("script"), () => ui.h("iframe"), () => ui.h("div", { onload: "x" }), () => ui.h("a", { href: "https://x" }), () => ui.h("div", { style: "x" })]) {
              try { attempt(); outcomes.push("allowed"); } catch (error) { outcomes.push("refused"); }
            }
            const node = ui.h("p", { text: "<img src=x onerror=alert(1)>" });
            outcomes.push(node.textContent);
            return ui.invoke("report", null, { outcomes });
          }` });
      }
      if (message.type === "request") {
        outcomes = message.params.input.outcomes;
        channel.port1.postMessage({ version: 1, sessionId: "session-0003", type: "response", requestId: message.requestId, ok: true, result: null });
      }
      if (message.type === "loaded") resolve(outcomes);
    });
  });
  window.dispatch("message", { source: parent, data: { type: "pcms.module-ui.bootstrap", version: 1, sessionId: "session-0003" }, ports: [channel.port2] });
  const reported = await result;
  channel.port1.close();
  assert.deepEqual(reported, ["refused", "refused", "refused", "refused", "refused", "<img src=x onerror=alert(1)>"]);
});
