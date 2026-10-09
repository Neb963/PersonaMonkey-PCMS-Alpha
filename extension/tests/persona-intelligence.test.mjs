import assert from "node:assert/strict";
import { cookieStorageBytes, currentRouteTest, personaCard, routeHealthSnapshot, routeTestContext, routeVerificationContext, ROUTE_TEST_MAX_AGE_MS } from "../lib/persona-intelligence.js";

assert.equal(cookieStorageBytes([{name:"sid",value:"abc",domain:"example.com",path:"/"}]), 21);
const blocked = routeHealthSnapshot({managed:true,routeId:"__block__",killSwitch:true}, null, {ready:true});
assert.equal(blocked.status, "blocked");
assert.equal(blocked.protected, true);
const direct = routeHealthSnapshot({managed:true,routeId:"__direct__",killSwitch:true}, null, {ready:true});
assert.equal(direct.status, "direct");
assert.equal(direct.protected, false, "Direct must never be represented as protected, even when its kill switch is enabled");
const healthy = routeHealthSnapshot({managed:true,routeId:"nl",killSwitch:true}, {name:"Proxy NL",provider:"generic",type:"socks",proxyDNS:true,country:"Netherlands"}, {ready:true,proxyControl:"controlled_by_this_extension",strictProxyVerification:true}, {ok:true,checkedAt:"2026-01-01T00:00:00.000Z",data:{ip:"1.2.3.4"},dns:{checked:true,leaking:false}}, Date.parse("2026-01-01T00:00:01.000Z"));
assert.equal(healthy.status, "healthy");
assert.equal(healthy.protected, true, "managed proxy Personas retain kill-switch protection semantics");
assert.equal(routeHealthSnapshot({managed:true,routeId:"nl",killSwitch:false}, {id:"nl",enabled:true}, {ready:true,proxyControl:"controlled_by_this_extension"}).protected, false,
  "disabling the kill switch still marks a proxy Persona unprotected");
assert.equal(healthy.dns, true);
assert.equal(healthy.ageMs, 1000);
const untested = routeHealthSnapshot(
  {managed:true,routeId:"nl"},
  {id:"nl",name:"Proxy NL",provider:"generic",type:"socks",proxyDNS:true,enabled:true},
  {ready:true,proxyControl:"controlled_by_this_extension",strictProxyVerification:true}
);
assert.equal(untested.status, "untested");
assert.equal(untested.dns, false, "configured proxy DNS must not be mistaken for observed DNS verification");

const incompleteDns = routeHealthSnapshot(
  {managed:true,routeId:"nl"},
  {name:"Mullvad NL",provider:"mullvad",type:"socks",proxyDNS:true},
  {ready:true,proxyControl:"controllable_by_this_extension",strictProxyVerification:true},
  {ok:false,error:"CORS blocked",checkedAt:"2026-01-01T00:00:00.000Z",data:{ip:"1.2.3.4",mullvad_exit_ip:true},dns:{checked:false,leaking:null,error:"CORS blocked"}},
  Date.parse("2026-01-01T00:00:01.000Z")
);
assert.equal(incompleteDns.status, "warning");
assert.equal(incompleteDns.proxy, true, "a verified Mullvad exit remains a successful proxy check when DNS is incomplete");
assert.equal(incompleteDns.dns, false);
assert.match(incompleteDns.reason, /DNS check incomplete/);
assert.doesNotMatch(incompleteDns.reason, /Proxy, DNS, and exit verified/);

const leakingDns = routeHealthSnapshot(
  {managed:true,routeId:"nl"},
  {name:"Mullvad NL",provider:"mullvad",type:"socks",proxyDNS:true},
  {ready:true,proxyControl:"controllable_by_this_extension",strictProxyVerification:true},
  {ok:false,error:"DNS leak detected",checkedAt:"2026-01-01T00:00:00.000Z",data:{ip:"1.2.3.4",mullvad_exit_ip:true},dns:{checked:true,leaking:true}},
  Date.parse("2026-01-01T00:00:01.000Z")
);
assert.equal(leakingDns.status, "error");
assert.equal(leakingDns.proxy, true, "a DNS leak must not be mislabeled as a failed proxy exit");
assert.equal(leakingDns.dns, false);
assert.match(leakingDns.reason, /DNS leak detected/);
const leakingDnsWithoutExit = routeHealthSnapshot(
  {managed:true,routeId:"nl"},
  {name:"Mullvad NL",provider:"mullvad",type:"socks",proxyDNS:true},
  {ready:true,proxyControl:"controllable_by_this_extension",strictProxyVerification:true},
  {ok:false,error:"DNS leak detected",checkedAt:"2026-01-01T00:00:00.000Z",data:{},dns:{checked:true,leaking:true}},
  Date.parse("2026-01-01T00:00:01.000Z")
);
assert.equal(leakingDnsWithoutExit.status, "error");
assert.equal(leakingDnsWithoutExit.proxy, false);
assert.equal(leakingDnsWithoutExit.reason, "Route exit not verified; DNS leak detected");

const genericProxyUnverified = routeHealthSnapshot(
  {managed:true,routeId:"generic",killSwitch:true},
  {id:"generic",name:"Generic proxy",provider:"generic",type:"http",enabled:true},
  {ready:true,proxyControl:"controlled_by_this_extension",strictProxyVerification:false},
  {ok:true,checkedAt:"2026-01-01T00:00:00.000Z",data:{ip:"203.0.113.20"},dns:{checked:true,leaking:null}},
  Date.parse("2026-01-01T00:00:01.000Z")
);
assert.equal(genericProxyUnverified.status, "warning");
assert.equal(genericProxyUnverified.proxy, false, "a public IP alone must not verify a generic proxy when strict proxy verification is disabled");
assert.equal(genericProxyUnverified.dns, false, "unknown DNS leak status must not be presented as verified");
assert.equal(genericProxyUnverified.exitIp, "203.0.113.20", "the observed public IP remains available without claiming it came from the configured proxy");
assert.match(genericProxyUnverified.reason, /route use is unverified/);
assert.match(genericProxyUnverified.reason, /DNS leak status is unknown/);
const unknownDns = routeHealthSnapshot(
  {managed:true,routeId:"generic",killSwitch:true},
  {id:"generic",name:"Generic proxy",provider:"generic",type:"http",enabled:true},
  {ready:true,proxyControl:"controlled_by_this_extension",strictProxyVerification:true},
  {ok:true,checkedAt:"2026-01-01T00:00:00.000Z",data:{ip:"203.0.113.22"},dns:{checked:true,leaking:null}},
  Date.parse("2026-01-01T00:00:01.000Z")
);
assert.equal(unknownDns.status, "warning");
assert.equal(unknownDns.proxy, true, "verified proxy exit remains independent from unknown DNS evidence");
assert.equal(unknownDns.dns, false);
assert.equal(unknownDns.reason, "Exit verified; DNS leak status is unknown");
const mullvadRouteUnverified = routeHealthSnapshot(
  {managed:true,routeId:"mullvad",killSwitch:true},
  {id:"mullvad",name:"Mullvad route",provider:"mullvad",type:"socks",enabled:true},
  {ready:true,proxyControl:"controlled_by_this_extension",strictProxyVerification:false},
  {ok:true,checkedAt:"2026-01-01T00:00:00.000Z",data:{ip:"203.0.113.21",mullvad_exit_ip:true},dns:{checked:true,leaking:false}},
  Date.parse("2026-01-01T00:00:01.000Z")
);
assert.equal(mullvadRouteUnverified.status, "warning");
assert.equal(mullvadRouteUnverified.proxy, false, "an observed Mullvad exit does not identify the selected route without strict proxy verification");
assert.match(mullvadRouteUnverified.reason, /configured route use is unverified/);
const card = personaCard({containerId:"firefox-container-2",personaUid:"50000000-0000-4000-8000-000000000001",name:"Research",lastUsedAt:"today"},{name:"Research",icon:"tree",color:"purple"},{activeTabs:3,cookies:[{name:"a",value:"b"}],health:healthy});
assert.equal(card.activeTabs, 3);
assert.equal(card.id, "firefox-container-2");
assert.equal(card.cookieStoreId, "firefox-container-2");
assert.equal(card.personaUid, "50000000-0000-4000-8000-000000000001");
assert.equal(card.icon, "tree");
assert.equal(card.cookies.count, 1);

const directVerificationSecurity = { ready: true, privacySafe: true, privacyRequired: true, proxyControl: "controllable_by_this_extension", strictProxyVerification: true };
const directVerificationProfile = { containerId: "direct-p1", managed: true, routeId: "__direct__", killSwitch: true, blockLocalNetwork: true };
const directVerification = routeVerificationContext(directVerificationProfile, null, directVerificationSecurity);
assert.ok(directVerification, "Direct must have a stable verification context even though it has no protected route-test cache context");
assert.equal(
  directVerification,
  routeVerificationContext({ ...directVerificationProfile }, null, { ...directVerificationSecurity }),
  "unchanged Direct configuration must retain the same verification context"
);
assert.notEqual(
  directVerification,
  routeVerificationContext({ ...directVerificationProfile, routeId: "__block__" }, null, directVerificationSecurity),
  "changing Direct to Block during verification must invalidate the result"
);
assert.notEqual(
  directVerification,
  routeVerificationContext({ ...directVerificationProfile, killSwitch: false }, null, directVerificationSecurity),
  "changing protection settings during Direct verification must invalidate the result"
);

const now = Date.parse("2026-01-01T00:00:01.000Z");
const profile = { containerId: "p1", managed: true, routeId: "a", killSwitch: true };
const route = { id: "a", name: "Route A", type: "socks", host: "127.0.0.1", port: 1080, password: "secret", proxyDNS: true, enabled: true };
const security = { ready: true, privacySafe: true, privacyRequired: true, proxyControl: "controllable_by_this_extension", strictProxyVerification: true };
const result = { ok: true, checkedAt: new Date(now - 1000).toISOString(), data: { ip: "203.0.113.9" }, dns: { checked: true, leaking: false } };
const entry = { context: routeTestContext(profile, route, security), result };
function observed(p, r, s, test = entry, time = now) {
  const live = currentRouteTest(p, r, s, test, time);
  return routeHealthSnapshot(p, r, s, live, time);
}
assert.equal(observed(profile, route, security).status, "healthy");
assert.equal(observed(profile, route, security).exitIp, "203.0.113.9");
for (const [changedProfile, changedRoute, changedSecurity] of [
  [{ ...profile, routeId: "__block__" }, null, security],
  [{ ...profile, routeId: "__direct__" }, null, security],
  [{ ...profile, routeId: "b" }, { ...route, id: "b" }, security],
  [profile, { ...route, enabled: false }, security],
  [profile, { ...route, host: "127.0.0.2" }, security],
  [profile, { ...route, password: "new-secret" }, security],
  [profile, null, security],
  [profile, route, { ...security, privacySafe: false }],
  [profile, route, { ...security, strictProxyVerification: false }],
  [profile, route, { ...security, proxyControl: "controlled_by_other_extensions" }],
  [profile, route, { ...security, proxyControl: "unknown" }]
]) {
  const snapshot = observed(changedProfile, changedRoute, changedSecurity);
  assert.notEqual(snapshot.status, "healthy", "old route evidence must not survive a route or protection change");
  assert.equal(snapshot.exitIp, null, "old exit IP must not survive a route or protection change");
  assert.equal(snapshot.checkedAt, null);
}
const expired = observed(profile, route, security, entry, now + ROUTE_TEST_MAX_AGE_MS + 1000);
assert.equal(expired.status, "untested");
assert.equal(expired.exitIp, null);
assert.equal(observed(profile, route, security, null).status, "untested", "background restart drops live evidence");
const nextRoute = { ...route, host: "127.0.0.2" };
const nextEntry = { context: routeTestContext(profile, nextRoute, security), result: { ...result, data: { ip: "203.0.113.10" } } };
assert.equal(observed(profile, nextRoute, security, nextEntry).exitIp, "203.0.113.10", "fresh evidence for an edited route remains visible");
console.log("persona intelligence tests passed");
