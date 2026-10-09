import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "./constants.js";

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

// Verification is deliberately short lived. A route result is evidence about
// the configuration and protection policy used for that particular test.
export const ROUTE_TEST_MAX_AGE_MS = 15 * 60 * 1000;

function hasProxyControl(security) {
  return ["controllable_by_this_extension", "controlled_by_this_extension"].includes(security.proxyControl);
}

export function routeVerificationContext(profile, route, security = {}) {
  if (!profile?.managed || !profile.containerId) return null;
  const routeId = profile.routeId || BLOCK_ROUTE_ID;
  const virtual = [BLOCK_ROUTE_ID, DIRECT_ROUTE_ID].includes(routeId);
  if (!virtual && (!route || route.enabled === false || routeId !== route.id)) return null;
  return JSON.stringify({
    profileId: profile.containerId,
    routeId,
    route: virtual ? null : route,
    killSwitch: profile.killSwitch !== false,
    blockLocalNetwork: profile.blockLocalNetwork !== false,
    privacyRequired: security.privacyRequired === true,
    privacySafe: security.privacySafe === true,
    ready: security.ready === true,
    proxyControl: security.proxyControl || "unknown",
    strictProxyVerification: security.strictProxyVerification === true
  });
}

export function routeTestContext(profile, route, security = {}) {
  if (!profile?.managed || !profile.containerId || !route || route.enabled === false ||
      profile.routeId !== route.id ||
      [BLOCK_ROUTE_ID, DIRECT_ROUTE_ID].includes(profile.routeId) ||
      security.ready !== true ||
      (security.privacyRequired && security.privacySafe !== true) ||
      !hasProxyControl(security)) return null;
  // This value stays inside the background process. Credentials are included
  // so changing a proxy password cannot reuse an earlier verification.
  return JSON.stringify({
    profileId: profile.containerId,
    routeId: profile.routeId,
    route,
    killSwitch: profile.killSwitch !== false,
    blockLocalNetwork: profile.blockLocalNetwork !== false,
    privacyRequired: security.privacyRequired === true,
    privacySafe: security.privacySafe === true,
    proxyControl: security.proxyControl || "unknown",
    strictProxyVerification: security.strictProxyVerification === true
  });
}

export function currentRouteTest(profile, route, security = {}, entry, now = Date.now()) {
  const context = routeTestContext(profile, route, security);
  const checkedAt = Date.parse(entry?.result?.checkedAt);
  if (!context || !entry || entry.context !== context || !Number.isFinite(checkedAt) ||
      checkedAt > now || now - checkedAt > ROUTE_TEST_MAX_AGE_MS) return null;
  return entry.result;
}

export function cookieStorageBytes(cookies = []) {
  const encoder = new TextEncoder();
  return (Array.isArray(cookies) ? cookies : []).reduce((total, cookie) => total + encoder.encode([
    cookie.name, cookie.value, cookie.domain, cookie.path, cookie.firstPartyDomain,
    cookie.partitionKey?.topLevelSite
  ].filter(Boolean).join("\u0000")).byteLength, 0);
}

export function routeHealthSnapshot(profile, route, security = {}, live = null, now = Date.now()) {
  const routeId = profile?.routeId || BLOCK_ROUTE_ID;
  let status = "unknown";
  let reason = "Route has not been tested";
  let proxy = false;
  let dns = false;

  if (!profile?.managed) {
    status = "unmanaged";
    reason = "Persona is not managed";
  } else if (routeId === BLOCK_ROUTE_ID) {
    status = "blocked";
    reason = "Network route is Block";
  } else if (routeId === DIRECT_ROUTE_ID) {
    status = security.ready ? "direct" : "warning";
    reason = security.ready ? "Direct route configured" : "Protection policy is not ready";
  } else if (!route || route.enabled === false) {
    status = "error";
    reason = "Assigned route is missing or disabled";
  } else if (security.ready !== true || (security.privacyRequired && security.privacySafe !== true) ||
             !hasProxyControl(security)) {
    status = "error";
    reason = "Required browser protection is unavailable";
  } else {
    status = "untested";
    reason = "Configured and fail-closed; run Test to verify the exit";
    proxy = true;
    // Configuration describes intended DNS handling, not observed DNS leak
    // behavior. Leave verification false until the route test has evidence.
  }

  if (status === "untested" && live) {
    // `ok` combines exit verification and DNS verification. Keep the two
    // results separate so a DNS failure does not erase a verified proxy exit.
    const exitEvidenceAvailable = Boolean(live.data?.ip)
      && (route?.provider !== "mullvad" || live.data?.mullvad_exit_ip === true);
    // A public IP response alone does not identify which configured route
    // produced it. Without Firefox's strict proxyInfo check, report it as
    // observed but unverified instead of claiming the selected route was used.
    const proxyUnverified = security.strictProxyVerification !== true && exitEvidenceAvailable;
    proxy = exitEvidenceAvailable && !proxyUnverified;
    // Unknown is not proof of a clean DNS path. Keep this evidence separate
    // from the proxy exit result and only mark DNS verified on an explicit
    // non-leak response.
    dns = live.dns?.checked === true && live.dns?.leaking === false;

    if (live.dns?.checked === true && live.dns?.leaking === true) {
      status = "error";
      reason = !exitEvidenceAvailable
        ? "Route exit not verified; DNS leak detected"
        : proxyUnverified
          ? "DNS leak detected; configured proxy use is unverified"
          : "Exit verified; DNS leak detected";
    } else if (!exitEvidenceAvailable) {
      status = "error";
      reason = live.error || "Route verification failed";
    } else if (proxyUnverified) {
      status = "warning";
      reason = live.dns?.checked !== true
        ? "Configured route use is unverified; DNS check incomplete"
        : live.dns?.leaking !== false
          ? "Configured route use is unverified; DNS leak status is unknown"
          : "Public IP observed; configured route use is unverified because strict proxy verification is disabled";
    } else if (live.dns?.checked !== true) {
      status = "warning";
      reason = live.dns?.error
        ? `Exit verified; DNS check incomplete: ${live.dns.error}`
        : "Exit verified; DNS check incomplete";
    } else if (live.dns?.leaking !== false) {
      status = "warning";
      reason = "Exit verified; DNS leak status is unknown";
    } else {
      status = "healthy";
      reason = "Proxy, DNS, and exit verified";
    }
  }

  return {
    status,
    reason,
    routeId,
    routeName: route?.name || (routeId === BLOCK_ROUTE_ID ? "Block" : routeId === DIRECT_ROUTE_ID ? "Direct" : "Missing route"),
    protected: routeId !== DIRECT_ROUTE_ID && profile?.killSwitch !== false,
    proxy,
    dns,
    exitIp: live?.data?.ip || null,
    exitCountry: live?.data?.country || live?.data?.country_name || route?.country || null,
    checkedAt: live?.checkedAt || null,
    ageMs: live?.checkedAt ? Math.max(0, now - Date.parse(live.checkedAt)) : null
  };
}

export function personaCard(profile, container, { activeTabs = 0, cookies = [], storage = null, health = null } = {}) {
  const identity = container || {};
  return {
    id: profile.containerId,
    personaUid: profile.personaUid || null,
    cookieStoreId: profile.containerId,
    name: identity.name || profile.name,
    icon: identity.icon || "fingerprint",
    iconUrl: identity.iconUrl || null,
    color: identity.color || "blue",
    colorCode: identity.colorCode || null,
    managed: profile.managed !== false,
    owned: profile.owned === true,
    description: profile.description || "",
    createdAt: profile.createdAt || null,
    lastUsedAt: profile.lastUsedAt || null,
    expiresAt: profile.expiresAt || null,
    archivedAt: profile.archivedAt || null,
    status: profile.status || "active",
    statistics: clone(profile.statistics || { opens: 0, clones: 0 }),
    activeTabs: Number(activeTabs) || 0,
    cookies: { count: cookies.length, bytes: cookieStorageBytes(cookies) },
    storage: storage ? clone(storage) : null,
    health: health ? clone(health) : null,
    protection: profile.killSwitch === false ? "relaxed" : "active"
  };
}
