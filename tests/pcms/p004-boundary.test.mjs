import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("A004-01 sandbox manifest contract is isolated and eval-bounded", async () => {
  const manifest=JSON.parse(await readFile("extension/pcms/sandbox/manifest-fragment.json", "utf8"));
  assert.deepEqual(manifest.sandbox.pages, ["pcms/sandbox/controller.html"]);
  const csp=manifest.content_security_policy.sandbox;
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /script-src 'self' 'unsafe-eval'/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /allow-same-origin/);
});

test("A004-02 sandbox implementation does not import or call privileged authorities", async () => {
  const paths=[
    "extension/pcms/sandbox/protocol.js",
    "extension/pcms/sandbox/controller-runtime.js",
    "extension/pcms/sandbox/controller.js",
    "extension/pcms/runtime/sandbox-host.js"
  ];
  for (const path of paths) {
    const source=await readFile(path, "utf8");
    assert.doesNotMatch(source, /\bbrowser\s*(?:\.|\[)/, path + " must not access browser.*");
    assert.doesNotMatch(source, /\bchrome\s*(?:\.|\[)/, path + " must not access chrome.*");
    assert.doesNotMatch(source, /sendNativeMessage|nativeMessaging|indexedDB/i, path + " must not access native messaging or IndexedDB");
    assert.doesNotMatch(source, /management-integration|persona-api|mullvad-native|pcms-client/i, path + " must not import PersonaMonkey internals");
  }
});

test("A004-02 bootstrap is one-time and privileged host has no ambient window message listener", async () => {
  const child=await readFile("extension/pcms/sandbox/controller-runtime.js", "utf8");
  const host=await readFile("extension/pcms/runtime/sandbox-host.js", "utf8");
  assert.match(child, /event\?\.source !== windowRef\.parent/);
  assert.match(child, /event\?\.origin !== windowRef\.location\.origin/);
  assert.match(child, /windowRef\.removeEventListener\("message", onBootstrap\)/);
  assert.match(host, /postMessage\([\s\S]*?"\*", \[channel\.port2\]\)/);
  assert.doesNotMatch(host, /windowRef\.addEventListener\("message"/);
});

test("A004-03 sandbox page has no external resource or form surface", async () => {
  const html=await readFile("extension/pcms/sandbox/controller.html", "utf8");
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<(?:iframe|form|img|link)\b/i);
  assert.match(html, /controller\.js/);
});
