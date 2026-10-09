import assert from "node:assert/strict";

const store = {};
globalThis.browser = {
  storage: { local: { async get(key) { return { [key]: store[key] }; }, async set(value) { Object.assign(store, value); } } },
  runtime: {
    getManifest() { return { version: "0.6.0" }; },
    async getPlatformInfo() { return { arch: "x86-64", os: "linux" }; },
    async getBrowserInfo() { return { name: "Firefox", version: "153" }; },
    onUserScriptConnect: undefined
  }
};

const posted = [];
globalThis.window = {
  postMessage(value, target) { posted.push({ value, target }); }
};

const { prepareUserscriptInjection } = await import(`../lib/gm-compat.js?signal=${Date.now()}`);
const tab = { id: 42, url: "https://am.i.mullvad.net/", cookieStoreId: "firefox-container-1", incognito: false };
const script = {
  id: "signal-example",
  name: "Signal example",
  code: "Persona.complete({ok:true,source:'bridge-test'});",
  enabled: true,
  profileIds: [tab.cookieStoreId],
  matches: ["https://am.i.mullvad.net/*"],
  excludes: [],
  excludeMatches: [],
  includes: [],
  runAt: "document_idle",
  requires: [],
  resources: {},
  connects: [],
  allFrames: false,
  updatedAt: "x",
  grants: ["none"],
  injectInto: "auto",
  unwrap: false
};

const prepared = await prepareUserscriptInjection(script, {
  tab,
  url: tab.url,
  automationToken: "token-123"
});
assert.equal(prepared.world, "MAIN");
assert.match(prepared.code, /Persona/);
assert.doesNotMatch(prepared.code, /token-123/);
assert.doesNotMatch(prepared.code, /postMessage/);

assert.throws(() => Function("window", prepared.code)(globalThis.window), /isolated-world userscript grant/);
assert.equal(posted.length, 0, "MAIN-world script code must not receive the completion token over page messaging");

console.log("Persona.complete main-world bridge test passed");
