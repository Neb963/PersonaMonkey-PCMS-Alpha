import assert from "node:assert/strict";
import { profileAllowsUrl, hostMatchesRule, matchPattern, userScriptMatches, userScriptHostAllowed, userScriptCookieDomainAllowed, routeDecision, buildProxyInfo, proxyInfoMatches, isExtensionOrigin, isLocalOrReservedHost } from "../lib/policy.js";
import { parseUserscriptMetadata } from "../lib/userscripts.js";
import { normalizeState } from "../lib/storage.js";

assert.equal(hostMatchesRule("www.example.com", "*.example.com"), true);
assert.equal(hostMatchesRule("evil-example.com", "*.example.com"), false);
assert.equal(matchPattern("https://sub.example.com/a?q=1", "*://*.example.com/*"), true);
assert.equal(matchPattern("https://example.org/a", "*://*.example.com/*"), false);

const extensionBaseUrl = "moz-extension://persona-route-manager/";
assert.equal(isExtensionOrigin({ url: `${extensionBaseUrl}options/options.html`, type: "main_frame", tabId: 4 }, extensionBaseUrl), true);
assert.equal(isExtensionOrigin({ url: "https://api.example/", type: "xmlhttprequest", tabId: 4, documentUrl: `${extensionBaseUrl}options/options.html` }, extensionBaseUrl), true);
assert.equal(isExtensionOrigin({ url: "https://am.i.mullvad.net/", type: "main_frame", tabId: 41, originUrl: `${extensionBaseUrl}options/options.html` }, extensionBaseUrl), false);

const profile = { blockLocalNetwork:true, domainMode:"allowlist", allowedDomains:["*.example.com"], blockedDomains:["ads.example.com"] };
assert.equal(profileAllowsUrl(profile, "https://app.example.com/").allowed, true);
assert.equal(profileAllowsUrl(profile, "https://ads.example.com/").allowed, false);
assert.equal(profileAllowsUrl(profile, "http://127.0.0.1/").allowed, false);
assert.equal(profileAllowsUrl(profile, "https://outside.test/").allowed, false);
assert.equal(profileAllowsUrl({ blockLocalNetwork: true }, "http://[::ffff:127.0.0.1]/").reason, "local-network-blocked");
assert.equal(profileAllowsUrl({ blockLocalNetwork: true }, "http://[::ffff:8.8.8.8]/").allowed, true);
assert.equal(isLocalOrReservedHost("[::ffff:7f00:1]"), true, "IPv4-mapped loopback must remain blocked");
assert.equal(isLocalOrReservedHost("[::ffff:c0a8:101]"), true, "IPv4-mapped private LAN addresses must remain blocked");
assert.equal(isLocalOrReservedHost("0:0:0:0:0:ffff:ac10:1"), true, "expanded mapped IPv6 private addresses must remain blocked");
assert.equal(isLocalOrReservedHost("[::ffff:808:808]"), false, "public IPv4-mapped IPv6 addresses are not local by this policy");

const state = normalizeState({
  global:{ unmanagedPolicy:"direct" },
  profiles:{ "firefox-container-1": { managed:true, routeId:"r1", killSwitch:true, blockLocalNetwork:true } },
  routes:{ r1:{ type:"socks", host:"10.1.2.3", port:1080, proxyDNS:true } },
  scripts:{}
});
const d = { cookieStoreId:"firefox-container-1", url:"https://example.com/" };
const decision = routeDecision(state,d);
assert.equal(decision.mode,"proxy");
const proxy = buildProxyInfo(decision.route,"firefox-container-1")[0];
assert.equal(proxy.proxyDNS,true);
assert.equal(proxyInfoMatches({type:"socks",host:"10.1.2.3",port:1080,proxyDNS:true},decision.route),true);
assert.equal(proxyInfoMatches({type:"direct"},decision.route),false);

const us = `// ==UserScript==\n// @name Demo\n// @match https://example.com/*\n// @exclude-match https://example.com/private/*\n// @run-at document-start\n// @grant none\n// ==/UserScript==\nconsole.log('x');`;
const meta = parseUserscriptMetadata(us,"x");
assert.equal(meta.name,"Demo");
assert.equal(meta.runAt,"document_start");
assert.equal(userScriptMatches({...meta},"https://example.com/page"),true);
assert.equal(userScriptMatches({...meta},"https://example.com/private/x"),false);
assert.equal(meta.hostScopeDeclared, true);
assert.equal(userScriptHostAllowed(meta, "https://example.com/path"), true);
assert.equal(userScriptHostAllowed(meta, "https://outside.test/path"), false);
assert.equal(userScriptCookieDomainAllowed(meta, "example.com"), true);
assert.equal(userScriptCookieDomainAllowed(meta, ".example.com"), false, "exact match rules do not authorize subdomain cookie domains");
const subdomainScope = parseUserscriptMetadata("// ==UserScript==\n// @match https://*.example.com/*\n// ==/UserScript==");
assert.equal(userScriptCookieDomainAllowed(subdomainScope, ".example.com"), true);
const implicitScope = parseUserscriptMetadata("// ==UserScript==\n// @grant GM_info\n// ==/UserScript==");
assert.equal(implicitScope.hostScopeDeclared, false);
assert.equal(userScriptHostAllowed(implicitScope, "https://example.com/"), false, "the runtime wildcard fallback does not grant cookie host authority");
const ambiguousInclude = parseUserscriptMetadata("// ==UserScript==\n// @include ^https://.*\\.example\\.com/.*$\n// ==/UserScript==");
assert.equal(userScriptHostAllowed(ambiguousInclude, "https://example.com/"), false, "arbitrary include regexes grant no cookie host authority");

console.log("policy tests passed");

// include-only script must not become match-all
assert.equal(userScriptMatches({matches:[],includes:['https://example.com/special/*'],excludeMatches:[],excludes:[]},'https://example.com/special/a'),true);
assert.equal(userScriptMatches({matches:[],includes:['https://example.com/special/*'],excludeMatches:[],excludes:[]},'https://not-example.com/a'),false);
