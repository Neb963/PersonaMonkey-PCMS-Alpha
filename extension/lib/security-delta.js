import { DIRECT_ROUTE_ID } from "./constants.js";
import { normalizeState } from "./storage.js";

export const SECURITY_AUTHORIZATION_REQUIRED = "SECURITY_AUTHORIZATION_REQUIRED";

const pathKey = (value) => JSON.stringify(String(value));

function endpoint(route) {
  if (!route || typeof route !== "object") return null;
  return {
    scheme: String(route.type || ""),
    host: String(route.host || ""),
    port: Number(route.port) || null
  };
}

function hasDestination(value) {
  return Boolean(value?.host && value?.port);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Return normalized, safe records for state changes that widen authority,
 * weaken a fail-closed/privacy control, or introduce/change a proxy endpoint.
 * Route credentials and unrelated route metadata are never included.
 */
export function securityDelta(current, proposed) {
  const before = normalizeState(current);
  const after = normalizeState(proposed);
  const delta = [];
  const add = (kind, path, oldValue, newValue) => {
    delta.push({ kind, path, before: oldValue, after: newValue });
  };

  const beforeIntegration = before.global.integration;
  const afterIntegration = after.global.integration;
  if (!beforeIntegration.enabled && afterIntegration.enabled) {
    add("integration-enabled", "global.integration.enabled", false, true);
  }
  const trustedBefore = new Set(beforeIntegration.trustedExtensionIds);
  for (const id of afterIntegration.trustedExtensionIds) {
    if (!trustedBefore.has(id)) {
      add("trusted-extension-added", `global.integration.trustedExtensionIds[${pathKey(id)}]`, false, true);
    }
  }
  if (!beforeIntegration.allowDestructive && afterIntegration.allowDestructive) {
    add("destructive-authority-enabled", "global.integration.allowDestructive", false, true);
  }
  if (!beforeIntegration.allowDirect && afterIntegration.allowDirect) {
    add("direct-authority-enabled", "global.integration.allowDirect", false, true);
  }
  if (!beforeIntegration.allowExternalAutomation && afterIntegration.allowExternalAutomation) {
    add("external-automation-authority-enabled", "global.integration.allowExternalAutomation", false, true);
  }
  if (!beforeIntegration.allowExecutableInstall && afterIntegration.allowExecutableInstall) {
    add("executable-install-authority-enabled", "global.integration.allowExecutableInstall", false, true);
  }

  if (before.global.unmanagedPolicy === "block" && after.global.unmanagedPolicy === "direct") {
    add("unmanaged-policy-weakened", "global.unmanagedPolicy", "block", "direct");
  }
  if (before.global.enforcePrivacyControls && !after.global.enforcePrivacyControls) {
    add("privacy-enforcement-disabled", "global.enforcePrivacyControls", true, false);
  }
  if (before.global.strictProxyVerification && !after.global.strictProxyVerification) {
    add("strict-proxy-verification-disabled", "global.strictProxyVerification", true, false);
  }
  for (const key of ["blockSpeculative", "disableNetworkPrediction"]) {
    if (Boolean(before.global[key]) && !after.global[key]) {
      add("privacy-control-weakened", `global.${key}`, before.global[key], after.global[key]);
    }
  }
  const webRTCStrength = { unchanged: 0, proxy_only: 1, disabled: 2 };
  if (webRTCStrength[before.global.webRTCMode] > webRTCStrength[after.global.webRTCMode]) {
    add("privacy-control-weakened", "global.webRTCMode", before.global.webRTCMode, after.global.webRTCMode);
  }

  const profileIds = new Set([...Object.keys(before.profiles), ...Object.keys(after.profiles)]);
  for (const id of profileIds) {
    const oldProfile = before.profiles[id];
    const newProfile = after.profiles[id];
    const path = `profiles[${pathKey(id)}]`;
    if (newProfile?.routeId === DIRECT_ROUTE_ID &&
        (oldProfile?.routeId !== DIRECT_ROUTE_ID || (oldProfile?.managed !== true && newProfile?.managed === true))) {
      add("persona-direct-assigned", `${path}.routeId`, oldProfile?.routeId ?? null, DIRECT_ROUTE_ID);
    }
    if (oldProfile?.killSwitch !== false && newProfile?.killSwitch === false) {
      add("kill-switch-disabled", `${path}.killSwitch`, true, false);
    }
    if (after.global.unmanagedPolicy === "direct" && oldProfile?.managed === true && newProfile?.managed !== true) {
      add("persona-unmanaged-with-direct-policy", `${path}.managed`, true, newProfile?.managed ?? null);
    }
    if (oldProfile?.blockLocalNetwork === true && newProfile?.blockLocalNetwork === false) {
      add("privacy-control-weakened", `${path}.blockLocalNetwork`, true, false);
    }
  }

  const routeIds = new Set([...Object.keys(before.routes), ...Object.keys(after.routes)]);
  for (const id of routeIds) {
    const oldRoute = before.routes[id];
    const newRoute = after.routes[id];
    const oldEndpoint = endpoint(oldRoute);
    const newEndpoint = endpoint(newRoute);
    if (oldRoute?.enabled !== false && (!newRoute || newRoute.enabled === false) &&
        Object.values(after.profiles).some((profile) => profile.managed === true &&
          profile.killSwitch === false && profile.routeId === id)) {
      add("proxy-route-direct-fallback", `routes[${pathKey(id)}].enabled`, true, newRoute ? false : null);
    }
    if (oldRoute?.type === "socks" && newRoute?.type === "socks"
        && oldRoute.proxyDNS === true && newRoute.proxyDNS === false) {
      // Disabling SOCKS proxy DNS moves hostname resolution onto the local network.
      add("privacy-control-weakened", `routes[${pathKey(id)}].proxyDNS`, true, false);
    }
    if (!oldRoute) {
      if (hasDestination(newEndpoint)) add("proxy-destination-added", `routes[${pathKey(id)}].endpoint`, null, newEndpoint);
    } else if (newRoute && !sameValue(oldEndpoint, newEndpoint)) {
      add("proxy-destination-changed", `routes[${pathKey(id)}].endpoint`, oldEndpoint, newEndpoint);
    } else if (newRoute && oldRoute.enabled === false && newRoute.enabled !== false && hasDestination(newEndpoint)) {
      add("proxy-destination-enabled", `routes[${pathKey(id)}].endpoint`, null, newEndpoint);
    }
  }

  return delta;
}

export function securityAuthorizationError(delta) {
  const error = new Error("Security-sensitive state changes require explicit authorization");
  error.name = "SecurityAuthorizationError";
  error.code = SECURITY_AUTHORIZATION_REQUIRED;
  error.delta = Array.isArray(delta)
    ? delta.map(({ kind, path, before, after }) => ({ kind, path, before, after }))
    : [];
  return error;
}
