import assert from "node:assert/strict";
import {
  SECURITY_AUTHORIZATION_REQUIRED,
  securityAuthorizationError,
  securityDelta
} from "../lib/security-delta.js";
import { securityDeltaLine } from "../options/security-review.js";
import { DEFAULT_SETTINGS } from "../lib/constants.js";

assert.equal(DEFAULT_SETTINGS.global.integration.allowExternalAutomation, false);
assert.equal(DEFAULT_SETTINGS.global.integration.allowExecutableInstall, false);

const base = {
  global: {
    unmanagedPolicy: "block",
    enforcePrivacyControls: true,
    strictProxyVerification: true,
    blockSpeculative: true,
    disableNetworkPrediction: true,
    webRTCMode: "proxy_only",
    integration: {
      enabled: false,
      trustedExtensionIds: [],
      allowDestructive: false,
      allowDirect: false,
      allowExternalAutomation: false,
      allowExecutableInstall: false
    }
  },
  profiles: {
    personaA: { managed: true, routeId: "__block__", killSwitch: true }
  },
  routes: {
    routeA: {
      id: "routeA", type: "socks", host: "proxy.example", port: 1080,
      username: "secret-user", password: "secret-password"
    }
  },
  scripts: {},
  workflows: {}
};

const proposal = structuredClone(base);
proposal.global.integration.enabled = true;
proposal.global.integration.trustedExtensionIds = ["trusted@example.test"];
proposal.global.integration.allowDestructive = true;
proposal.global.integration.allowDirect = true;
proposal.global.integration.allowExternalAutomation = true;
proposal.global.integration.allowExecutableInstall = true;
proposal.global.unmanagedPolicy = "direct";
proposal.global.enforcePrivacyControls = false;
proposal.global.strictProxyVerification = false;
proposal.global.blockSpeculative = false;
proposal.global.disableNetworkPrediction = false;
proposal.global.webRTCMode = "unchanged";
proposal.profiles.personaA.routeId = "__direct__";
proposal.profiles.personaA.killSwitch = false;
proposal.profiles.personaA.managed = false;
proposal.profiles.personaA.blockLocalNetwork = false;
proposal.routes.routeA.type = "https";
proposal.routes.routeA.host = "new-proxy.example";
proposal.routes.routeA.port = 8443;
proposal.routes.routeA.username = "changed-user";
proposal.routes.routeA.password = "changed-password";
proposal.routes.routeB = {
  id: "routeB", type: "http", host: "second-proxy.example", port: 8080,
  username: "another-secret", password: "another-password"
};

const delta = securityDelta(base, proposal);
assert.deepEqual(delta.map((item) => item.kind), [
  "integration-enabled",
  "trusted-extension-added",
  "destructive-authority-enabled",
  "direct-authority-enabled",
  "external-automation-authority-enabled",
  "executable-install-authority-enabled",
  "unmanaged-policy-weakened",
  "privacy-enforcement-disabled",
  "strict-proxy-verification-disabled",
  "privacy-control-weakened",
  "privacy-control-weakened",
  "privacy-control-weakened",
  "persona-direct-assigned",
  "kill-switch-disabled",
  "persona-unmanaged-with-direct-policy",
  "privacy-control-weakened",
  "proxy-destination-changed",
  "proxy-destination-added"
]);
assert.match(securityDeltaLine(delta.find((item) => item.kind === "external-automation-authority-enabled")), /run external automations and control Personas/);
assert.match(securityDeltaLine(delta.find((item) => item.kind === "executable-install-authority-enabled")), /install executable userscript code/);
assert.deepEqual(delta.find((item) => item.kind === "trusted-extension-added"), {
  kind: "trusted-extension-added",
  path: 'global.integration.trustedExtensionIds["trusted@example.test"]',
  before: false,
  after: true
});
assert.deepEqual(delta.find((item) => item.kind === "proxy-destination-changed"), {
  kind: "proxy-destination-changed",
  path: 'routes["routeA"].endpoint',
  before: { scheme: "socks", host: "proxy.example", port: 1080 },
  after: { scheme: "https", host: "new-proxy.example", port: 8443 }
});
assert.deepEqual(delta.find((item) => item.kind === "proxy-destination-added"), {
  kind: "proxy-destination-added",
  path: 'routes["routeB"].endpoint',
  before: null,
  after: { scheme: "http", host: "second-proxy.example", port: 8080 }
});
assert.equal(JSON.stringify(delta).includes("secret"), false, "route credentials never appear in security records");

const error = securityAuthorizationError(delta);
assert.equal(error.code, SECURITY_AUTHORIZATION_REQUIRED);
assert.equal(error.name, "SecurityAuthorizationError");
assert.deepEqual(error.delta, delta);

const noWidening = structuredClone(base);
noWidening.global.unmanagedPolicy = "block";
noWidening.profiles.personaA.killSwitch = true;
noWidening.profiles.personaA.routeId = "__block__";
noWidening.routes.routeA.username = "rotation-only";
noWidening.routes.routeA.password = "credential-only";
assert.deepEqual(securityDelta(base, noWidening), [], "credential-only changes do not widen authority");
const disabledRoute = structuredClone(base);
disabledRoute.routes.routeA.enabled = false;
assert.deepEqual(securityDelta(disabledRoute, base).find((item) => item.kind === "proxy-destination-enabled"), {
  kind: "proxy-destination-enabled", path: 'routes["routeA"].endpoint', before: null,
  after: { scheme: "socks", host: "proxy.example", port: 1080 }
});
const previouslyUnmanaged = structuredClone(base);
previouslyUnmanaged.profiles.personaA.managed = false;
previouslyUnmanaged.profiles.personaA.routeId = "__direct__";
const newlyManaged = structuredClone(previouslyUnmanaged);
newlyManaged.profiles.personaA.managed = true;
assert.equal(securityDelta(previouslyUnmanaged, newlyManaged).some((item) => item.kind === "persona-direct-assigned"), true);
const removedManaged = structuredClone(base);
removedManaged.global.unmanagedPolicy = "direct";
const removedProfile = structuredClone(removedManaged);
delete removedProfile.profiles.personaA;
assert.deepEqual(securityDelta(removedManaged, removedProfile).find((item) => item.kind === "persona-unmanaged-with-direct-policy"), {
  kind: "persona-unmanaged-with-direct-policy", path: 'profiles["personaA"].managed', before: true, after: null
});
const directFallback = structuredClone(base);
directFallback.profiles.personaA.routeId = "routeA";
directFallback.profiles.personaA.killSwitch = false;
const disabledFallback = structuredClone(directFallback);
disabledFallback.routes.routeA.enabled = false;
assert.equal(securityDelta(directFallback, disabledFallback).some((item) => item.kind === "proxy-route-direct-fallback"), true);
const deletedFallback = structuredClone(directFallback);
delete deletedFallback.routes.routeA;
assert.equal(securityDelta(directFallback, deletedFallback).some((item) => item.kind === "proxy-route-direct-fallback"), true);
const blankEndpoint = structuredClone(directFallback);
blankEndpoint.routes.routeA.host = "";
assert.equal(securityDelta(directFallback, blankEndpoint).some((item) => item.kind === "proxy-destination-changed"), true);
const protectedFallback = structuredClone(directFallback);
protectedFallback.profiles.personaA.killSwitch = true;
assert.equal(securityDelta(protectedFallback, { ...protectedFallback, routes: {} }).some((item) => item.kind === "proxy-route-direct-fallback"), false);
const strictRtc = structuredClone(base);
strictRtc.global.webRTCMode = "disabled";
assert.equal(securityDelta(strictRtc, base).some((item) => item.path === "global.webRTCMode"), true);
const trustedBase = structuredClone(base);
trustedBase.global.integration.trustedExtensionIds = ["removed@example.test"];
assert.deepEqual(
  securityDelta(trustedBase, base),
  [],
  "removing an already trusted extension does not widen authority"
);
const authoritiesRevoked = structuredClone(base);
authoritiesRevoked.global.integration.allowExternalAutomation = true;
authoritiesRevoked.global.integration.allowExecutableInstall = true;
assert.deepEqual(securityDelta(authoritiesRevoked, base), [], "revoking either new authority does not require approval");

const normalizedDelta = securityDelta(
  { global: { unmanagedPolicy: "block" }, profiles: {}, routes: {} },
  { global: { unmanagedPolicy: "invalid" }, profiles: {}, routes: {} }
);
assert.deepEqual(normalizedDelta.map((item) => [item.before, item.after]), [["block", "direct"]], "invalid settings normalize before comparison");
const webRtcDelta = securityDelta(
  { global: { webRTCMode: "proxy_only" }, profiles: {}, routes: {} },
  { global: { webRTCMode: "disabled" }, profiles: {}, routes: {} }
);
assert.deepEqual(webRtcDelta, [], "moving from proxy-only to disabled WebRTC is stricter");
for (const key of ["blockSpeculative", "disableNetworkPrediction"]) {
  const malformedWeakening = structuredClone(base);
  malformedWeakening.global[key] = null;
  assert.equal(securityDelta(base, malformedWeakening).some((item) => item.path === `global.${key}`), true,
    `null ${key} must not disable a runtime privacy control without review`);
}

console.log("security delta tests passed");
