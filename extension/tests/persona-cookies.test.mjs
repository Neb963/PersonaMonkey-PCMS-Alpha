import assert from "node:assert/strict";
import { createPersonaCookieService, cookieIdentity } from "../lib/persona-cookies.js";

const calls = [];
const stores = new Map([
  ["firefox-container-1", [
    { name:"sid", value:"one", domain:".example.com", hostOnly:false, path:"/", secure:true, httpOnly:true, sameSite:"lax", session:false, expirationDate:2000000000, storeId:"firefox-container-1", firstPartyDomain:"", partitionKey:{topLevelSite:"https://example.com"} },
    { name:"prefs", value:"a", domain:"sub.example.com", hostOnly:true, path:"/app", secure:false, httpOnly:false, sameSite:"unspecified", session:true, storeId:"firefox-container-1", firstPartyDomain:"sub.example.com", partitionKey:null },
    { name:"third-party", value:"partitioned", domain:"cdn.example.net", hostOnly:true, path:"/", secure:true, httpOnly:false, sameSite:"none", session:true, storeId:"firefox-container-1", firstPartyDomain:"", partitionKey:{topLevelSite:"https://example.com",hasCrossSiteAncestor:true} }
  ]],
  ["firefox-container-2", [
    { name:"sid", value:"two", domain:".example.com", hostOnly:false, path:"/", secure:true, httpOnly:true, sameSite:"lax", session:true, storeId:"firefox-container-2", firstPartyDomain:"example.com", partitionKey:null }
  ]]
]);

function exactKey(cookie) {
  return cookieIdentity(cookie);
}

const browserApi = {
  cookies: {
    async getAll(details) {
      calls.push(["getAll", structuredClone(details)]);
      let rows = stores.get(details.storeId) || [];
      if (!Object.prototype.hasOwnProperty.call(details, "firstPartyDomain")) {
        throw new Error("First-Party Isolation is enabled, but the required 'firstPartyDomain' attribute was not set");
      }
      if (details.firstPartyDomain !== null) {
        rows = rows.filter((cookie) => (cookie.firstPartyDomain ?? "") === details.firstPartyDomain);
      }
      if (!Object.prototype.hasOwnProperty.call(details, "partitionKey")) {
        rows = rows.filter((cookie) => !cookie.partitionKey?.topLevelSite);
      } else if (details.partitionKey?.topLevelSite) {
        rows = rows.filter((cookie) => cookie.partitionKey?.topLevelSite === details.partitionKey.topLevelSite);
      }
      return structuredClone(rows);
    },
    async remove(details) {
      calls.push(["remove", structuredClone(details)]);
      const list = stores.get(details.storeId) || [];
      const index = list.findIndex((cookie) => cookie.name === details.name
        && new URL(details.url).hostname === cookie.domain.replace(/^\./, "")
        && (!Object.prototype.hasOwnProperty.call(details, "firstPartyDomain") || details.firstPartyDomain === cookie.firstPartyDomain)
        && (!details.partitionKey || JSON.stringify(details.partitionKey) === JSON.stringify(cookie.partitionKey)));
      if (index >= 0) list.splice(index, 1);
      return index >= 0 ? { url: details.url, name: details.name, storeId: details.storeId } : null;
    },
    async set(details) {
      calls.push(["set", structuredClone(details)]);
      const record = {
        name: details.name,
        value: details.value,
        domain: details.domain || new URL(details.url).hostname,
        hostOnly: !details.domain,
        path: details.path || "/",
        secure: details.secure === true,
        httpOnly: details.httpOnly === true,
        sameSite: details.sameSite || "unspecified",
        session: details.expirationDate == null,
        expirationDate: details.expirationDate,
        firstPartyDomain: details.firstPartyDomain ?? "",
        partitionKey: details.partitionKey || null,
        storeId: details.storeId
      };
      const list = stores.get(details.storeId) || [];
      const index = list.findIndex((cookie) => exactKey(cookie) === exactKey(record));
      if (index >= 0) list[index] = record; else list.push(record);
      stores.set(details.storeId, list);
      return structuredClone(record);
    }
  }
};

const allowed = new Set(["firefox-container-1", "firefox-container-2"]);
const service = createPersonaCookieService({
  browserApi,
  assertPersona: async (id) => { if (!allowed.has(id)) throw new Error("not managed"); }
});

const one = await service.list("firefox-container-1");
assert.equal(one.length, 3, "listing must include first-party-isolated and dynamically partitioned cookies in the persona store");
assert.deepEqual(one.find((cookie) => cookie.name === "third-party").partitionKey, {topLevelSite:"https://example.com",hasCrossSiteAncestor:true});
assert.equal((await service.list("firefox-container-2"))[0].value, "two");
assert.deepEqual(calls[0][1], {
  storeId:"firefox-container-1",
  firstPartyDomain:null,
  partitionKey:{}
}, "listing must request every first-party domain and both partitioned/unpartitioned cookie jars");

await service.remove("firefox-container-1", one[0]);
const removeCall = calls.find((call) => call[0] === "remove");
assert.equal(removeCall[1].storeId, "firefox-container-1");
assert.equal(removeCall[1].firstPartyDomain, "");
assert.deepEqual(removeCall[1].partitionKey, { topLevelSite:"https://example.com" });
assert.equal((await service.list("firefox-container-2")).length, 1, "other persona must not be touched");

const remaining = (await service.list("firefox-container-1")).find((cookie) => cookie.name === "prefs");
await service.set("firefox-container-1", { ...remaining, value:"changed", path:"/changed" }, remaining);
assert.equal((await service.list("firefox-container-1")).some((cookie) => cookie.value === "changed"), true);

stores.get("firefox-container-1").push({ name:"a", value:"1", domain:"example.com", hostOnly:true, path:"/", secure:false, httpOnly:false, sameSite:"lax", session:true, firstPartyDomain:"example.com", partitionKey:null, storeId:"firefox-container-1" });
stores.get("firefox-container-1").push({ name:"b", value:"2", domain:"deep.example.com", hostOnly:true, path:"/", secure:false, httpOnly:false, sameSite:"lax", session:true, firstPartyDomain:"", partitionKey:{topLevelSite:"https://example.com"}, storeId:"firefox-container-1" });
stores.get("firefox-container-1").push({ name:"c", value:"3", domain:"other.test", hostOnly:true, path:"/", secure:false, httpOnly:false, sameSite:"lax", session:true, firstPartyDomain:"other.test", partitionKey:null, storeId:"firefox-container-1" });
const cleared = await service.clear("firefox-container-1", { domain:"example.com" });
assert.equal(cleared.removed, 3);
const afterDomainClear = await service.list("firefox-container-1");
assert.equal(afterDomainClear.some((cookie) => cookie.domain.replace(/^\./, "") === "example.com" || cookie.domain.endsWith(".example.com")), false);
assert.equal(afterDomainClear.some((cookie) => cookie.domain === "other.test"), true);
assert.equal((await service.list("firefox-container-2"))[0].value, "two", "domain clear must not touch the same site in another persona");

await assert.rejects(() => service.list("firefox-container-99"), /not managed/);

const setCallsBeforeInvalidMetadata = calls.filter((call) => call[0] === "set").length;
await assert.rejects(
  () => service.set("firefox-container-1", { ...remaining, firstPartyDomain: { domain:"example.com" } }),
  { message:"Cookie firstPartyDomain must be a string or null" }
);
await assert.rejects(
  () => service.set("firefox-container-1", { ...remaining, firstPartyDomain:"https://example.com/path" }),
  { message:"Cookie firstPartyDomain must be an empty string or a domain" }
);
await assert.rejects(
  () => service.set("firefox-container-1", { ...remaining, partitionKey:"https://example.com" }),
  { message:"Cookie partitionKey must be null or an object with topLevelSite" }
);
await assert.rejects(
  () => service.set("firefox-container-1", { ...remaining, partitionKey:{ topLevelSite:"moz-extension://test" } }),
  { message:"Cookie partitionKey.topLevelSite must be an HTTP(S) site URL without credentials, path, query, or fragment" }
);
await assert.rejects(
  () => service.set("firefox-container-1", { ...remaining, partitionKey:{ topLevelSite:"https://user:pass@example.com" } }),
  { message:"Cookie partitionKey.topLevelSite must be an HTTP(S) site URL without credentials, path, query, or fragment" }
);
await assert.rejects(
  () => service.set("firefox-container-1", { ...remaining, partitionKey:{ topLevelSite:"https://example.com/path?query=1" } }),
  { message:"Cookie partitionKey.topLevelSite must be an HTTP(S) site URL without credentials, path, query, or fragment" }
);
await assert.rejects(
  () => service.set("firefox-container-1", { ...remaining, firstPartyDomain:"example.com", partitionKey:{topLevelSite:"https://example.com"} }),
  { message:"Cookie cannot have both firstPartyDomain and partitionKey" }
);
assert.equal(calls.filter((call) => call[0] === "set").length, setCallsBeforeInvalidMetadata, "impossible isolation metadata must be rejected before reaching Firefox");
console.log("persona cookie isolation tests passed");
