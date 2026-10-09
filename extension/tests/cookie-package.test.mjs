import assert from "node:assert/strict";
import {
  COOKIE_PACKAGE_FORMAT,
  COOKIE_PACKAGE_VERSION,
  createCookiePackage,
  encodeCookiePackage,
  decodeCookiePackage,
  validateCookieRecords
} from "../lib/cookie-package.js";

const source = [{
  name:"sid",
  value:"secret",
  domain:".example.com",
  hostOnly:false,
  path:"/",
  secure:true,
  httpOnly:true,
  sameSite:"lax",
  session:false,
  expirationDate:2000000000,
  firstPartyDomain:"",
  partitionKey:{topLevelSite:"https://example.com"}
}];

const pkg = createCookiePackage({
  cookies: source,
  persona:{name:"Work",color:"blue",colorCode:"#37adff",icon:"briefcase",cookieStoreId:"must-not-export"},
  appVersion:"0.6.2"
});
assert.equal(pkg.format, COOKIE_PACKAGE_FORMAT);
assert.equal(pkg.formatVersion, COOKIE_PACKAGE_VERSION);
assert.equal(pkg.persona.name, "Work");
assert.equal("cookieStoreId" in pkg.persona, false, "local container ids must not be portable bindings");
assert.equal(pkg.cookies[0].firstPartyDomain, "");
assert.deepEqual(pkg.cookies[0].partitionKey, {topLevelSite:"https://example.com"});

const encoded = encodeCookiePackage({cookies:source,persona:{name:"Work"},appVersion:"0.6.2"});
const decoded = decodeCookiePackage(encoded);
assert.equal(decoded.cookies.length, 1);
assert.equal(decoded.cookies[0].value, "secret");
assert.equal(decoded.persona.name, "Work");

assert.throws(() => decodeCookiePackage("{}"), /Unsupported PersonaMonkey cookie package format/);
assert.throws(() => decodeCookiePackage("not json"), /not valid JSON/);
assert.throws(() => validateCookieRecords([{name:"missing-domain",value:"1"}]), /missing a domain/);
assert.throws(
  () => validateCookieRecords([{ ...source[0], firstPartyDomain:{ domain:"example.com" } }]),
  { message:"Cookie firstPartyDomain must be a string or null" }
);
assert.throws(
  () => validateCookieRecords([{ ...source[0], firstPartyDomain:"https://example.com/path" }]),
  { message:"Cookie firstPartyDomain must be an empty string or a domain" }
);
assert.throws(
  () => validateCookieRecords([{ ...source[0], partitionKey:{ topLevelSite:"https://example.com", unexpected:true } }]),
  { message:"Cookie partitionKey must contain a topLevelSite and optional boolean hasCrossSiteAncestor" }
);
assert.throws(
  () => validateCookieRecords([{ ...source[0], partitionKey:{ topLevelSite:"moz-extension://test" } }]),
  { message:"Cookie partitionKey.topLevelSite must be an HTTP(S) site URL without credentials, path, query, or fragment" }
);
assert.throws(
  () => validateCookieRecords([{ ...source[0], partitionKey:{ topLevelSite:"https://user:pass@example.com" } }]),
  { message:"Cookie partitionKey.topLevelSite must be an HTTP(S) site URL without credentials, path, query, or fragment" }
);
assert.throws(
  () => validateCookieRecords([{ ...source[0], partitionKey:{ topLevelSite:"https://example.com/path?query=1" } }]),
  { message:"Cookie partitionKey.topLevelSite must be an HTTP(S) site URL without credentials, path, query, or fragment" }
);
assert.throws(
  () => validateCookieRecords([{ ...source[0], firstPartyDomain:"example.com" }]),
  { message:"Cookie cannot have both firstPartyDomain and partitionKey" }
);
assert.equal(validateCookieRecords([{
  ...source[0], domain:"cdn.example.net", partitionKey:{topLevelSite:"https://shop.example.org",hasCrossSiteAncestor:true}
}])[0].domain, "cdn.example.net", "partition scope does not need to match the cookie domain");
assert.equal(validateCookieRecords([{
  ...source[0], domain:"cdn.example.net", firstPartyDomain:"example.com", partitionKey:null
}])[0].firstPartyDomain, "example.com", "FPI domain does not need to match the cookie domain"
);
assert.throws(() => validateCookieRecords(new Array(20001).fill({name:"a",domain:"example.com"})), /exceeds 20000 cookies/);
console.log("persona cookie package tests passed");
