import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import { CONTROLLER_BUNDLE_PATH, buildControllerBundle } from "./controller-bundle.mjs";

test("A030-02 controller page loads a classic script generated from the P004 modules", async () => {
  const html = await readFile("extension/pcms/sandbox/controller.html", "utf8");
  assert.match(html, /<script src="controller\.js"><\/script>/);
  assert.doesNotMatch(html, /type="module"/, "opaque-origin sandbox pages cannot fetch ES modules");
  const shipped = await readFile(CONTROLLER_BUNDLE_PATH, "utf8");
  assert.equal(shipped, await buildControllerBundle(), "controller.js is out of date; run the generator with --write");
  assert.doesNotMatch(shipped, /^\s*(?:import|export)\b/m);
});

test("A030-02 generated controller bootstraps once from its parent and runs supplied source", async () => {
  const listeners = new Set();
  const parent = {};
  const windowRef = {
    parent,
    location: { origin: "moz-extension://pcms-p030-bundle" },
    addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); }
  };
  const context = vm.createContext({ window: windowRef, TextEncoder, setTimeout, clearTimeout, queueMicrotask });
  vm.runInContext(await readFile(CONTROLLER_BUNDLE_PATH, "utf8"), context, { filename: CONTROLLER_BUNDLE_PATH });
  assert.equal(listeners.size, 1);

  // A browser deserializes every message into the receiving realm; do the same here.
  const inRealm = vm.runInContext("(json) => JSON.parse(json)", context);
  const channel = new MessageChannel();
  const framePort = {
    postMessage: (message) => channel.port2.postMessage(message),
    close: () => channel.port2.close(),
    start: () => {},
    addEventListener(type, listener) {
      channel.port2.on(type, (data) => listener({ data: inRealm(JSON.stringify(data)) }));
    }
  };
  const messages = [];
  const next = () => new Promise((resolve) => channel.port1.once("message", resolve));
  const bootstrap = inRealm(JSON.stringify({ type: "pcms.sandbox.bootstrap", version: 1, sessionId: "bundle-1" }));
  // A message from a window other than the parent is ignored.
  for (const listener of [...listeners]) listener({ source: {}, origin: windowRef.location.origin, data: bootstrap, ports: [framePort] });
  assert.equal(listeners.size, 1);
  const ready = next();
  for (const listener of [...listeners]) listener({ source: parent, origin: windowRef.location.origin, data: bootstrap, ports: [framePort] });
  messages.push(await ready);
  assert.deepEqual(messages[0], { version: 1, sessionId: "bundle-1", type: "ready" });
  assert.equal(listeners.size, 0, "bootstrap is one-time");

  const loaded = next();
  channel.port1.postMessage({ version: 1, sessionId: "bundle-1", type: "request", requestId: "r1", method: "controller.load",
    params: { source: "(api) => ({ start(){ return { sum: 40 + 2, version: api.version }; } })", initial: null } });
  const response = await loaded;
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { sum: 42, version: 1 });
  channel.port1.close();
});
