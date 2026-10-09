import assert from "node:assert/strict";

const values = {
  "gm-values:s1": { shared: "alpha" }
};
const userConnectListeners = [];
const cookieCalls = [];

globalThis.browser = {
  storage: {
    local: {
      async get(key) {
        if (key === null) return structuredClone(values);
        if (typeof key === "string") return { [key]: structuredClone(values[key]) };
        return {};
      },
      async set(next) { Object.assign(values, structuredClone(next)); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      }
    }
  },
  runtime: {
    getManifest() { return { version: "0.8.0-test" }; },
    async getPlatformInfo() { return { arch: "x86-64", os: "linux" }; },
    async getBrowserInfo() { return { name: "Firefox", version: "155" }; },
    onUserScriptConnect: { addListener(fn) { userConnectListeners.push(fn); } }
  },
  cookies: {
      async getAll(options) {
        cookieCalls.push({ method: "list", options: structuredClone(options) });
      return [
        { name: "sid", value: "container-cookie", domain: "example.com", hostOnly: true, httpOnly: true, storeId: options.storeId },
        { name: "subdomain", value: "hidden-cookie", domain: ".example.com", hostOnly: false, storeId: options.storeId }
      ];
    },
    async set(options) {
      cookieCalls.push({ method: "set", options: structuredClone(options) });
      return { ...options };
    },
    async remove(options) {
      cookieCalls.push({ method: "delete", options: structuredClone(options) });
      return { ...options };
    }
  },
  tabs: { async create() { throw new Error("not used"); }, async remove() {}, async update() {} },
  notifications: { async create() { return "notification"; } }
};

const state = {
  global: { unmanagedPolicy: "direct", userscripts: { dependencyFetch: "direct" } },
  profiles: {
    "firefox-container-a": { containerId: "firefox-container-a", managed: true, routeId: "__direct__" },
    "firefox-container-b": { containerId: "firefox-container-b", managed: true, routeId: "__direct__" }
  },
  routes: {},
  scripts: {
    s1: {
      id: "s1",
      name: "Shared values",
      code: "void 0;",
      enabled: true,
      profileIds: ["firefox-container-a", "firefox-container-b"],
      matches: ["https://example.com/*"],
      hostScopeDeclared: true,
      excludeMatches: [],
      includes: [],
      excludes: [],
      runAt: "document_idle",
      injectInto: "content",
      world: "USER_SCRIPT",
      grants: ["GM_getValue", "GM_setValue", "GM_cookie"],
      requires: [],
      resources: {},
      connects: ["outside.test"],
      allFrames: false,
      unwrap: false,
      updatedAt: "2026-09-24T00:00:00.000Z"
    }
  }
};

const gm = await import(`../lib/gm-compat.js?scope=${Date.now()}`);
const first = await gm.prepareUserscriptInjection(state.scripts.s1, {
  tab: { id: 1, cookieStoreId: "firefox-container-a", url: "https://example.com/a" },
  url: "https://example.com/a"
});
assert.match(first.code, /"shared":"alpha"/, "Persona A must load the script-ID-scoped GM value");

gm.configureGMCompat({
  getState: async () => structuredClone(state),
  onAutomationSignal: async ({ status }) => status
});
assert.equal(userConnectListeners.length, 1);

async function connect(tabId, cookieStoreId) {
  const replies = [];
  const messageListeners = [];
  const port = {
    sender: {
      userScriptWorldId: first.worldId,
      url: "https://example.com/page",
      tab: { id: tabId, cookieStoreId, url: "https://example.com/page" }
    },
    onDisconnect: { addListener() {} },
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
    postMessage(message) { replies.push(message); },
    disconnect() { replies.push({ disconnected: true }); }
  };
  userConnectListeners[0](port);
  for (let i = 0; i < 50 && !messageListeners.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(messageListeners.length, 1, "assigned Persona should receive a GM bridge");
  return {
    async call(id, method, args = {}) {
      messageListeners[0]({ id, method, args });
      for (let i = 0; i < 50 && !replies.some((entry) => entry.replyTo === id); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return replies.find((entry) => entry.replyTo === id);
    }
  };
}

const personaA = await connect(10, "firefox-container-a");
const write = await personaA.call("write-shared", "setValue", { key: "shared", value: "beta" });
assert.equal(write.ok, true);
assert.equal(values["gm-values:s1"].shared, "beta", "GM values persist under the userscript ID, not the Persona/container ID");

const second = await gm.prepareUserscriptInjection(state.scripts.s1, {
  tab: { id: 2, cookieStoreId: "firefox-container-b", url: "https://example.com/b" },
  url: "https://example.com/b"
});
assert.equal(second.worldId, first.worldId, "the same userscript keeps one isolated userscript world across assigned Personas");
assert.match(second.code, /"shared":"beta"/, "Persona B must observe the value written by Persona A for the same script ID");

const personaB = await connect(11, "firefox-container-b");
const cookieA = await personaA.call("cookie-a", "cookieList", { options: { domain: "example.com" } });
const cookieB = await personaB.call("cookie-b", "cookieList", { options: { domain: "example.com" } });
assert.equal(cookieA.ok, true);
assert.equal(cookieB.ok, true);
assert.equal(cookieCalls[0].options.storeId, "firefox-container-a");
assert.equal(cookieCalls[1].options.storeId, "firefox-container-b");
assert.notEqual(cookieCalls[0].options.storeId, cookieCalls[1].options.storeId, "GM_cookie must stay scoped to the calling tab's contextual identity");
assert.equal(cookieA.result.length, 1, "authorized host cookies remain available while broader domain cookies are filtered");
assert.equal(cookieA.result[0].httpOnly, true, "authorized GM_cookie reads preserve browser-authorized httpOnly cookies");

const crossHostQuery = await personaA.call("cookie-cross-host", "cookieList", { options: { url: "https://outside.test/" } });
assert.equal(crossHostQuery.ok, false, "@connect does not extend GM_cookie authority to a different host");
assert.match(crossHostQuery.error, /outside the userscript's declared host scope/);
const broadDomainQuery = await personaA.call("cookie-broad-domain", "cookieList", { options: { domain: ".example.com" } });
assert.equal(broadDomainQuery.ok, false, "an exact-host script cannot enumerate cookies for every subdomain");
const partitionEscape = await personaA.call("cookie-partition-escape", "cookieList", { options: { partitionKey: { topLevelSite: "https://outside.test" } } });
assert.equal(partitionEscape.ok, false, "partition selectors cannot move cookie access to another host");
const firstPartyEscape = await personaA.call("cookie-first-party-escape", "cookieList", { options: { firstPartyDomain: "outside.test" } });
assert.equal(firstPartyEscape.ok, false, "first-party selectors cannot move cookie access to another host");

const beforeRejectedMutations = cookieCalls.length;
const crossHostSet = await personaA.call("cookie-set-cross-host", "cookieSet", {
  options: { url: "https://outside.test/", name: "sid", value: "forged", domain: "outside.test" }
});
assert.equal(crossHostSet.ok, false, "cookieSet rejects a caller-supplied URL outside the declared host scope");
const partitionEscapeSet = await personaA.call("cookie-set-partition-escape", "cookieSet", {
  options: { url: "https://example.com/", name: "sid", value: "forged", partitionKey: { topLevelSite: "https://outside.test" } }
});
assert.equal(partitionEscapeSet.ok, false, "cookieSet rejects partition selectors outside the declared host scope");
const firstPartyEscapeDelete = await personaA.call("cookie-delete-first-party-escape", "cookieDelete", {
  options: { url: "https://example.com/", name: "sid", firstPartyDomain: "outside.test" }
});
assert.equal(firstPartyEscapeDelete.ok, false, "cookieDelete rejects first-party selectors outside the declared host scope");
assert.equal(cookieCalls.length, beforeRejectedMutations, "rejected cookie mutations never reach the browser cookie API");

const cookieSet = await personaA.call("cookie-set-authorized", "cookieSet", {
  options: { url: "https://example.com/", name: "sid", value: "authorized", domain: "example.com", httpOnly: true }
});
assert.equal(cookieSet.ok, true, "authorized same-host cookie writes remain available");
assert.equal(cookieCalls.at(-1).method, "set");
assert.equal(cookieCalls.at(-1).options.storeId, "firefox-container-a", "cookieSet overwrites script-supplied store scope with the calling container");
assert.equal(cookieCalls.at(-1).options.httpOnly, true, "authorized GM_cookie writes preserve the httpOnly request");
const cookieDelete = await personaA.call("cookie-delete-authorized", "cookieDelete", {
  options: { url: "https://example.com/", name: "sid", domain: "example.com" }
});
assert.equal(cookieDelete.ok, true, "authorized same-host cookie deletion remains available");
assert.equal(cookieCalls.at(-1).method, "delete");
assert.equal(cookieCalls.at(-1).options.storeId, "firefox-container-a", "cookieDelete remains scoped to the calling container");

const deniedSignal = await personaA.call("signal-needs-grant", "automationSignal", { status: "complete" });
assert.equal(deniedSignal.ok, false, "automation signaling requires an explicit grant");
state.scripts.s1.grants.push("Persona.signal");
const grantedSignal = await personaA.call("signal-with-grant", "automationSignal", { status: "complete" });
assert.equal(grantedSignal.ok, true);
assert.equal(grantedSignal.result, "complete");

const deniedTabData = await personaA.call("tab-data-needs-grant", "getTabData");
assert.equal(deniedTabData.ok, false, "tab data lookup requires an explicit grant");
state.scripts.s1.grants.push("GM_getTabData", "GM_saveTabData", "GM_getTabsData");
const saveTabData = await personaA.call("tab-data-save", "saveTabData", { data: { draft: "kept" } });
assert.equal(saveTabData.ok, true);
const getTabData = await personaA.call("tab-data-get", "getTabData");
assert.deepEqual(getTabData.result, { draft: "kept" });
const getTabsData = await personaA.call("tabs-data-get", "getTabsData");
assert.deepEqual(getTabsData.result["10"], { draft: "kept" });

console.log("GM value sharing and container-scoped cookie compatibility tests passed");
