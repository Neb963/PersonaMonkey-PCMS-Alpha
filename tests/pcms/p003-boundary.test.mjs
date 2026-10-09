import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const JS_FILES=[
  "extension/pcms/core/persona-broker-contract.js",
  "extension/pcms/core/bootstrap.js",
  "extension/pcms/app/app.js"
];

test("A003-02 derivative PCMS bootstrap has no raw PersonaMonkey/browser authority", async () => {
  for (const path of JS_FILES) {
    const source=await readFile(path, "utf8");
    assert.doesNotMatch(source, /\bbrowser\s*(?:\.|\[)/, `${path} must not call raw browser APIs`);
    assert.doesNotMatch(source, /sendNativeMessage|nativeMessaging|indexedDB/i, `${path} must not call privileged storage/native APIs`);
    assert.doesNotMatch(source, /(?:\.\.\/)+lib\//, `${path} must not import PersonaMonkey implementation services`);
    assert.doesNotMatch(source, /management-integration|pcms-client|persona-api/i, `${path} must not couple to PersonaMonkey service transports`);
  }
});

test("A003-02 PCMS app entry uses only the new namespace bootstrap", async () => {
  const html=await readFile("extension/pcms/app/index.html", "utf8");
  const app=await readFile("extension/pcms/app/app.js", "utf8");
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(app, /from "\.\.\/core\/bootstrap\.js"/);
  assert.doesNotMatch(html + app, /PCMS_REQUEST|PCMS_EVENTS|pcms-client/);
});

test("A003-03 P003 additions remain outside the frozen P002 upstream blob set", async () => {
  const manifest=JSON.parse(await readFile("docs/upstream/import-manifest.json", "utf8"));
  const destinations=new Set(manifest.entries.map((entry) => entry.destinationPath));
  for (const path of [
    "extension/pcms/core/persona-broker-contract.js",
    "extension/pcms/core/bootstrap.js",
    "extension/pcms/app/index.html",
    "extension/pcms/app/app.js",
    "extension/pcms/app/app.css"
  ]) {
    assert.equal(destinations.has(path), false, `${path} must remain a derivative PCMS file`);
  }
  for (const legacy of [
    "extension/pcms/index.html",
    "extension/pcms/pcms.js",
    "extension/pcms/pcms.css"
  ]) {
    assert.equal(destinations.has(legacy), true, `${legacy} must remain covered by P002 integrity verification`);
  }
});
