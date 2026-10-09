import { cookieStorageBytes } from "./persona-intelligence.js";

function webOrigin(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null;
  } catch { return null; }
}

function inspectPageStorage() {
  const bytes = (storage) => {
    let total = 0;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i) || "";
      total += new Blob([key, storage.getItem(key) || ""]).size;
    }
    return { items: storage.length, bytes: total };
  };
  return Promise.all([
    indexedDB.databases ? indexedDB.databases().catch(() => []) : Promise.resolve([]),
    globalThis.caches?.keys ? caches.keys().catch(() => []) : Promise.resolve([]),
    navigator.storage?.estimate ? navigator.storage.estimate().catch(() => ({})) : Promise.resolve({})
  ]).then(([databases, cacheNames, estimate]) => ({
    origin: location.origin,
    localStorage: bytes(localStorage),
    sessionStorage: bytes(sessionStorage),
    indexedDB: { databases: databases.length },
    cacheStorage: { caches: cacheNames.length },
    estimated: { usage: Number(estimate.usage) || 0, quota: Number(estimate.quota) || 0 }
  }));
}

function clearPageCaches() {
  sessionStorage.clear();
  return globalThis.caches?.keys
    ? caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name))))
    : Promise.resolve([]);
}

export function createPersonaStorageService({ browserApi = browser, cookieService, assertPersona } = {}) {
  if (!cookieService) throw new Error("Persona storage service requires cookieService");

  async function tabs(profileId) {
    if (assertPersona) await assertPersona(profileId);
    return browserApi.tabs.query({ cookieStoreId: profileId });
  }

  async function summary(profileId) {
    const [cookies, openTabs] = await Promise.all([cookieService.list(profileId), tabs(profileId)]);
    const firstByOrigin = new Map();
    for (const tab of openTabs) {
      const origin = webOrigin(tab.url);
      if (origin && tab.id != null && !firstByOrigin.has(origin)) firstByOrigin.set(origin, tab.id);
    }
    const inspected = [];
    for (const tabId of firstByOrigin.values()) {
      try {
        const result = await browserApi.scripting.executeScript({ target: { tabId }, func: inspectPageStorage });
        if (result?.[0]?.result) inspected.push(result[0].result);
      } catch {}
    }
    const sum = (path) => inspected.reduce((total, item) => total + (Number(path(item)) || 0), 0);
    const byDomain = Object.entries(cookies.reduce((counts, cookie) => {
      const domain = String(cookie.domain || "unknown").replace(/^\./, "");
      counts[domain] = (counts[domain] || 0) + 1;
      return counts;
    }, {})).map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
    return {
      cookies: { count: cookies.length, bytes: cookieStorageBytes(cookies), byDomain },
      localStorage: { items: sum((x) => x.localStorage.items), bytes: sum((x) => x.localStorage.bytes) },
      sessionStorage: { items: sum((x) => x.sessionStorage.items), bytes: sum((x) => x.sessionStorage.bytes) },
      indexedDB: { databases: sum((x) => x.indexedDB.databases) },
      cacheStorage: { caches: sum((x) => x.cacheStorage.caches) },
      estimated: { usage: sum((x) => x.estimated.usage), quota: sum((x) => x.estimated.quota) },
      activeTabs: openTabs.length,
      inspectedOrigins: inspected.map((item) => item.origin),
      complete: false,
      note: "Site-storage counts cover origins currently open in this persona; clearing remains container-scoped."
    };
  }

  async function clear(profileId, scope = "cookies") {
    if (assertPersona) await assertPersona(profileId);
    // This service handles in-place, container-scoped data clears only. A true
    // full wipe is owned by Persona rotation in personas.js; it must not clear
    // this container in place and leave its identity intact.
    if (!["cookies", "siteData"].includes(scope)) throw new Error("Unknown persona storage clear scope");
    const result = { scope, cookies: 0, siteData: false, openOriginCaches: 0 };
    if (scope === "cookies") {
      const cleared = await cookieService.clear(profileId);
      result.cookies = cleared.removed;
    }
    if (scope === "siteData") {
      if (!browserApi.browsingData?.remove) throw new Error("Container-scoped browsingData API is unavailable");
      await browserApi.browsingData.remove(
        { cookieStoreId: profileId },
        { localStorage: true, indexedDB: true }
      );
      result.siteData = true;
      for (const tab of await tabs(profileId)) {
        if (tab.id == null || !webOrigin(tab.url)) continue;
        try {
          await browserApi.scripting.executeScript({ target: { tabId: tab.id }, func: clearPageCaches });
          result.openOriginCaches++;
        } catch {}
      }
    }
    return result;
  }

  const clearCookies = (profileId) => clear(profileId, "cookies");
  const clearSiteData = (profileId) => clear(profileId, "siteData");

  return { inspect: summary, summary, clear, clearCookies, clearSiteData };
}
