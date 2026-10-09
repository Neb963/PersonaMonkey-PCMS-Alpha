import {
  BLOCK_ROUTE_ID,
  DIRECT_ROUTE_ID,
  BLACKHOLE_PROXY,
  MULLVAD_SOCKS_API,
  MULLVAD_CHECK_URL
} from "./lib/constants.js";
import { normalizeState, normalizeRoute, redactSecrets } from "./lib/storage.js";
import { securityAuthorizationError } from "./lib/security-delta.js";
import { routeDecision, buildProxyInfo, proxyInfoMatches, directInfoIsDirect, isExtensionOrigin } from "./lib/policy.js";
import {
  getNativeStatus,
  ensureTunnel,
  stopTunnel,
  restartTunnel,
  listEntries as listNativeEntries,
  setEntry as setNativeEntry,
  prepareExit,
  releaseExit
} from "./lib/mullvad-native.js";
import {
  configureGMCompat,
  getMenuCommandsForTab,
  runMenuCommand,
  clearMenuCommandsForTab,
  invalidateDependencyCache,
  exportUserscriptData,
  importUserscriptData
} from "./lib/gm-compat.js";
import {
  configureOrchestrator,
  runWorkflow,
  stopJob,
  listJobs,
  listActiveProfileIds,
  getJob,
  clearFinishedJobs,
  remapAutomationProfileReferences,
  getAutomationTabPolicy,
  clearAutomationTab,
  handleAutomationSignal,
  handlePageAutomationSignal,
  runExternalExecution,
  listExternalExecutions,
  getExternalExecution,
  findExternalExecutionByOperation,
  getExternalExecutionResult,
  stopExternalExecution,
  acknowledgeExternalExecution,
  focusExternalExecution,
  getExternalExecutionContext,
  replaceJobsTrusted
} from "./lib/orchestrator.js";
import { createStateManager } from "./lib/state-manager.js";
import { createPrivacyController } from "./lib/privacy.js";
import { createPersonaManager } from "./lib/personas.js";
import { createPersonaCookieService } from "./lib/persona-cookies.js";
import { createPersonaStorageService } from "./lib/persona-storage.js";
import { createPersonaPlatform } from "./lib/persona-platform.js";
import { createPackageInspector } from "./lib/package-inspector-client.js";
import { currentRouteTest, routeTestContext, routeVerificationContext } from "./lib/persona-intelligence.js";
import { createPersonaApi } from "./lib/persona-api.js";
import { createMullvadRuntime } from "./lib/mullvad-runtime.js";
import { createUserscriptRuntime } from "./lib/userscript-runtime.js";
import { createPcmsControlPlane } from "./lib/pcms-control-plane.js";
import { createPcmsEventHub } from "./lib/pcms-events.js";
import { PCMS_EVENTS_PORT, PCMS_REQUEST_TYPE } from "./lib/pcms-protocol.js";
import { createIntegrationOperationStore, createManagementIntegration } from "./lib/management-integration.js";
import { normalizeIntegrationPolicy } from "./lib/management-integration-protocol.js";
import { installRoutingHandlers } from "./lib/routing-gate.js";

const extensionBaseUrl = browser.runtime.getURL("");
let initPromise = null;
let lastRoutingFailureEventAt = 0;
const securityState = {
  ready: false,
  privacySafe: false,
  networkPredictionSafe: false,
  webRTCSafe: false,
  proxyControl: "unknown",
  lastProxyError: null,
  lastBlock: null,
  initializedAt: null
};
const routeTestRequests = new Map();
const routeTestTargetLocks = new Map();
const pendingIntegrationPolicyPreviews = new Map();
const pendingStatePreviewStates = new Map();
const MULLVAD_DNS_LEAK_SUFFIX = ".dnsleak.am.i.mullvad.net";
const MULLVAD_IPV4_CHECK_URL = "https://ipv4.am.i.mullvad.net/json";
const ROUTE_TEST_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nowIso() { return new Date().toISOString(); }

function canonicalNetworkUrl(value) {
  try { return new URL(String(value || "")).href; }
  catch { return String(value || ""); }
}

function isMullvadDnsLeakProbeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:"
      || parsed.port !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || !parsed.hostname.endsWith(MULLVAD_DNS_LEAK_SUFFIX)) {
      return false;
    }
    const label = parsed.hostname.slice(0, -MULLVAD_DNS_LEAK_SUFFIX.length);
    return ROUTE_TEST_UUID_RE.test(label);
  } catch {
    return false;
  }
}

function isRouteTestFetchUrl(value) {
  const target = canonicalNetworkUrl(value);
  return target === canonicalNetworkUrl(MULLVAD_CHECK_URL)
    || target === canonicalNetworkUrl(MULLVAD_IPV4_CHECK_URL)
    || isMullvadDnsLeakProbeUrl(target);
}

function getRouteTestRequestOverride(value) {
  const key = canonicalNetworkUrl(value);
  const entry = routeTestRequests.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    routeTestRequests.delete(key);
    return null;
  }
  return entry;
}

async function withRouteTestTargetLock(target, task) {
  const previous = routeTestTargetLocks.get(target) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  routeTestTargetLocks.set(target, gate);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (routeTestTargetLocks.get(target) === gate) routeTestTargetLocks.delete(target);
  }
}

async function fetchJsonThroughRouteTest(profileId, effectiveRoute, url, timeoutMs = 15000) {
  const target = canonicalNetworkUrl(url);
  if (!isRouteTestFetchUrl(target)) throw new Error("Invalid route-test target");

  return withRouteTestTargetLock(target, async () => {
    const override = {
      profileId,
      mode: effectiveRoute ? "proxy" : "direct",
      route: effectiveRoute || null,
      expiresAt: Date.now() + Math.max(5000, timeoutMs + 5000)
    };
    routeTestRequests.set(target, override);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Route check HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Route check timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      if (routeTestRequests.get(target) === override) routeTestRequests.delete(target);
    }
  });
}
function isTrustedExtensionPageSender(sender) {
  const senderUrl = String(sender?.url || "");
  return sender?.id === browser.runtime.id && senderUrl.startsWith(extensionBaseUrl);
}
function isSecurityReviewSender(sender) {
  if (!isTrustedExtensionPageSender(sender)) return false;
  try { return new URL(sender.url).pathname === "/options/options.html"; }
  catch { return false; }
}

const stateManager = createStateManager();
const { getState, setState, mutate } = stateManager;
const routeTests = new Map();
const routeTestGenerations = new Map();
const routeContexts = new Map();
function healthSecurity(state) {
  return {
    ready: securityState.ready,
    privacySafe: securityState.privacySafe,
    privacyRequired: state.global.enforcePrivacyControls,
    proxyControl: securityState.proxyControl,
    strictProxyVerification: state.global.strictProxyVerification
  };
}
function currentTest(state, profileId) {
  const profile = state.profiles[profileId];
  return currentRouteTest(profile, state.routes[profile?.routeId], healthSecurity(state), routeTests.get(profileId));
}
function invalidateRouteTests(state) {
  const next = new Map();
  for (const [id, profile] of Object.entries(state.profiles)) {
    const context = routeTestContext(profile, state.routes[profile.routeId], healthSecurity(state));
    if (context) next.set(id, context);
  }
  for (const id of new Set([...routeContexts.keys(), ...next.keys()])) {
    if (routeContexts.has(id) && routeContexts.get(id) !== next.get(id)) {
      routeTestGenerations.set(id, (routeTestGenerations.get(id) || 0) + 1);
    }
  }
  routeContexts.clear();
  for (const [id, context] of next) routeContexts.set(id, context);
  for (const profileId of routeTests.keys()) {
    if (!currentTest(state, profileId)) {
      routeTests.delete(profileId);
    }
  }
}
const pcmsEvents = createPcmsEventHub({
  bootId: stateManager.getBootId(),
  getRevision: () => stateManager.getRevision()
});
const privacyController = createPrivacyController({ getState, securityState });
async function applyPrivacy() {
  await privacyController.apply();
  // Invalid controls revoke evidence even if they recover before the next UI read.
  if (securityState.ready === false || securityState.privacySafe === false ||
      ["controlled_by_other_extensions", "not_controllable"].includes(securityState.proxyControl)) {
    for (const id of routeContexts.keys()) routeTestGenerations.set(id, (routeTestGenerations.get(id) || 0) + 1);
    routeTests.clear();
  } else invalidateRouteTests(await getState());
}
stateManager.setAfterSetHook(applyPrivacy);
stateManager.subscribe((state) => invalidateRouteTests(state));
stateManager.subscribe((_state, metadata) => pcmsEvents.emit({
  type: "state.changed",
  entity: "state",
  data: { source: metadata.source },
  revision: metadata.revision
}));
const assertPersona = async (profileId) => {
  const profile = (await getState()).profiles[profileId];
  if (!profile?.managed) throw new Error("Managed persona not found");
  return profile;
};
const cookieService = createPersonaCookieService({ assertPersona });
const personaManager = createPersonaManager({
  getState,
  setState,
  mutate,
  cookieService,
  remapAutomationHistory: remapAutomationProfileReferences,
  onRotationEvent: (rotation) => pcmsEvents.emit({
    type: "persona.container.rotated",
    entity: "persona",
    entityId: rotation.personaUid,
    data: {
      personaUid: rotation.personaUid,
      oldCookieStoreId: rotation.oldCookieStoreId,
      newCookieStoreId: rotation.newCookieStoreId,
      operationId: rotation.operationId,
      ...(rotation.correlationOperationId
        ? { correlationOperationId: rotation.correlationOperationId }
        : {})
    },
    revision: rotation.revision
  })
});
const storageService = createPersonaStorageService({ cookieService, assertPersona });
const mullvadRuntime = createMullvadRuntime({
  getState,
  operations: {
    getStatus: getNativeStatus,
    prepareExit,
    stopTunnel
  }
});
const userscriptRuntime = createUserscriptRuntime({
  getState,
  getAutomationTabPolicy,
  handleAutomationSignal,
  ensureInitialized: () => initialize()
});

async function initialize() {
  if (initPromise) return initPromise;
  const attempt = (async () => {
    await stateManager.initialize();
    // Finish any journaled container rotation before destructive Persona
    // operations or automation can observe a partially-cut-over identity.
    await personaManager.reconcileRotations();
    invalidateRouteTests(await getState());
    configureGMCompat({
      getState,
      onAutomationSignal: handleAutomationSignal,
      onAutomationInput: (details) => managementIntegration.handleUserscriptInput(details)
    });
    await configureOrchestrator({
      getState,
      ensureProfileReady,
      onJobEvent: (event) => pcmsEvents.emit(event)
    });
    await applyPrivacy();
    securityState.ready = true;
    securityState.initializedAt = nowIso();
    invalidateRouteTests(await getState());
  })().catch((error) => {
    securityState.ready = false;
    securityState.privacySafe = false;
    securityState.initializedAt = null;
    // Never print the storage/native exception: it can include route secrets.
    console.error("Initialization failed; routing remains blocked");
    throw error;
  });
  initPromise = attempt;
  // Share one in-flight generation, but let the next request retry after
  // rejection. The state manager has its own separately retryable init gate.
  void attempt.catch(() => {
    if (initPromise === attempt) initPromise = null;
  });
  return attempt;
}

async function ensureProfileReady(profileId) {
  const state = await getState();
  const profile = state.profiles[profileId];
  if (!profile || !profile.managed) throw new Error("Managed persona not found");
  if (profile.rotationRole || profile.rotationOperationId) throw new Error(`${profile.name}: container rotation is in progress`);
  if (profile.routeId === BLOCK_ROUTE_ID) throw new Error(`${profile.name}: network route is Block`);
  // Direct has no proxy privacy boundary to protect; safety gates apply to
  // protected proxy routing, while Direct still remains an explicit choice.
  if (profile.routeId !== DIRECT_ROUTE_ID && state.global.enforcePrivacyControls && !securityState.privacySafe) {
    throw new Error(`${profile.name}: browser privacy controls are not in a safe state`);
  }
  if (profile.routeId === DIRECT_ROUTE_ID) return { profile, route: null, mode: "direct" };
  const route = state.routes[profile.routeId];
  if (!route || route.enabled === false) throw new Error(`${profile.name}: assigned route is missing or disabled`);
  const effective = await mullvadRuntime.resolve(route);
  if (!effective) throw new Error(`${profile.name}: ${route.provider === "mullvad" ? "Mullvad bridge/exit is unavailable" : "proxy route is unavailable"}`);
  return { profile, route: effective, mode: "proxy" };
}

async function handleProxyRequest(details) {
  await initialize();
  const state = await getState();

  const extensionRequest = isExtensionOrigin(details, extensionBaseUrl);
  const routeTestRequest = extensionRequest ? getRouteTestRequestOverride(details.url) : null;
  if (routeTestRequest) {
    if (routeTestRequest.mode === "proxy") {
      return buildProxyInfo(routeTestRequest.route, routeTestRequest.profileId || `route-test-${details.tabId}`);
    }
    return { type: "direct" };
  }

  if (extensionRequest) {
    // Route verification requests generated by PersonaMonkey must never silently
    // fall through to the host network. An active override is required.
    if (isRouteTestFetchUrl(details.url)) {
      return [{ ...BLACKHOLE_PROXY, connectionIsolationKey: "route-test-unbound" }, null];
    }
    return { type: "direct" };
  }
  if (state.global.blockSpeculative && details.type === "speculative") {
    return [{ ...BLACKHOLE_PROXY }, null];
  }

  const decision = routeDecision(state, details);
  if (decision.mode === "block") {
    return [{ ...BLACKHOLE_PROXY, connectionIsolationKey: details.cookieStoreId || "blocked" }, null];
  }
  if (decision.mode === "proxy") {
    const effectiveRoute = await mullvadRuntime.resolve(decision.route);
    if (!effectiveRoute) {
      return [{ ...BLACKHOLE_PROXY, connectionIsolationKey: details.cookieStoreId || "mullvad-unavailable" }, null];
    }
    return buildProxyInfo(effectiveRoute, details.cookieStoreId || `tab-${details.tabId}`);
  }
  return { type: "direct" };
}

function recordBlock(details, reason) {
  securityState.lastBlock = {
    at: nowIso(),
    reason,
    tabId: details.tabId,
    cookieStoreId: details.cookieStoreId || null,
    url: String(details.url || "").slice(0, 500)
  };
}

async function handleBeforeRequest(details) {
  await initialize();
  const state = await getState();

  const extensionRequest = isExtensionOrigin(details, extensionBaseUrl);
  const routeTestRequest = extensionRequest ? getRouteTestRequestOverride(details.url) : null;
  if (routeTestRequest) {
    if (routeTestRequest.mode === "proxy" && state.global.enforcePrivacyControls && !securityState.privacySafe) {
      recordBlock(details, "privacy-controls-unsafe");
      return { cancel: true };
    }
    if (state.global.strictProxyVerification) {
      const matches = routeTestRequest.mode === "proxy"
        ? proxyInfoMatches(details.proxyInfo, routeTestRequest.route)
        : directInfoIsDirect(details.proxyInfo);
      if (!matches) {
        recordBlock(details, "route-test-proxy-verification-failed");
        return { cancel: true };
      }
    }
    return {};
  }

  if (extensionRequest) {
    if (isRouteTestFetchUrl(details.url)) {
      recordBlock(details, "route-test-request-unbound");
      return { cancel: true };
    }
    return {};
  }
  if (state.global.blockSpeculative && details.type === "speculative") {
    recordBlock(details, "speculative-request");
    return { cancel: true };
  }

  const decision = routeDecision(state, details);
  if (decision.mode === "block") {
    recordBlock(details, decision.reason);
    return { cancel: true };
  }

  if (decision.mode === "proxy") {
    if (state.global.enforcePrivacyControls && !securityState.privacySafe) {
      recordBlock(details, "privacy-controls-unsafe");
      return { cancel: true };
    }
    const effectiveRoute = await mullvadRuntime.resolve(decision.route);
    if (!effectiveRoute) {
      recordBlock(details, decision.route?.provider === "mullvad" ? "mullvad-local-service-unavailable" : "route-unavailable");
      return { cancel: true };
    }
    if (state.global.strictProxyVerification && !proxyInfoMatches(details.proxyInfo, effectiveRoute)) {
      recordBlock(details, "proxy-verification-failed");
      return { cancel: true };
    }
  } else if (decision.mode === "direct" && state.global.strictProxyVerification && !directInfoIsDirect(details.proxyInfo)) {
    recordBlock(details, "direct-route-was-proxied");
    return { cancel: true };
  }

  return {};
}

async function fetchMullvadRelays() {
  const response = await fetch(MULLVAD_SOCKS_API, { cache: "no-store" });
  if (!response.ok) throw new Error(`Mullvad proxy API returned HTTP ${response.status}`);
  const data = await response.json();
  return data
    .filter((r) => r && r.online && r.ipv4_address && r.port)
    .map((r) => ({
      hostname: String(r.hostname || ""),
      ipv4_address: String(r.ipv4_address),
      ipv6_address: String(r.ipv6_address || ""),
      port: Number(r.port || 1080),
      country: String(r.location?.country || ""),
      countryCode: String(r.location?.country_code || r.location?.countryCode || ""),
      city: String(r.location?.city || ""),
      code: String(r.location?.code || "")
    }))
    .sort((a, b) => `${a.country} ${a.city} ${a.hostname}`.localeCompare(`${b.country} ${b.city} ${b.hostname}`));
}

const pendingMullvadRoutes = new Map();
async function createMullvadRoute(relay, authorizationId = null) {
  if (authorizationId) {
    const id = pendingMullvadRoutes.get(authorizationId);
    if (!id) throw new Error("Route preview is missing or expired");
    const committed = await stateManager.commitPreview(authorizationId);
    pendingMullvadRoutes.delete(authorizationId);
    return { route: committed.state.routes[id], state: committed.state };
  }
  const state = await getState();
  const id = `mullvad-${crypto.randomUUID().slice(0, 8)}`;
  state.routes[id] = normalizeRoute({
    id,
    name: `Mullvad ${relay.country || ""}${relay.city ? ` / ${relay.city}` : ""}`.trim(),
    provider: "mullvad",
    type: "socks",
    host: relay.ipv4_address,
    port: relay.port || 1080,
    proxyDNS: true,
    country: relay.country || "",
    city: relay.city || "",
    server: relay.hostname || ""
  }, id);
  const preview = await stateManager.previewState(state, { requireMetadata: true });
  pendingMullvadRoutes.set(preview.previewId, id);
  if (pendingMullvadRoutes.size > 32) pendingMullvadRoutes.delete(pendingMullvadRoutes.keys().next().value);
  return preview;
}

async function getSnapshot() {
  await initialize();
  return {
    state: await getState(),
    containers: await personaManager.listContainers(),
    security: { ...securityState },
    mullvadNative: await mullvadRuntime.refreshStatus(),
    userScriptsGranted: await userscriptRuntime.hasPermission()
  };
}

async function getActiveContext() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const state = await getState();
  if (!tab) return { tab: null, profile: null, container: null, route: null, routeTest: null, security: { ...securityState } };
  const profile = state.profiles[tab.cookieStoreId] || null;
  let container = null;
  if (profile) {
    try { container = await browser.contextualIdentities.get(tab.cookieStoreId); } catch {}
  }
  let route = null;
  if (profile?.routeId && ![BLOCK_ROUTE_ID, DIRECT_ROUTE_ID].includes(profile.routeId)) route = state.routes[profile.routeId] || null;
  if (route?.provider === "mullvad") await mullvadRuntime.refreshStatus();
  return {
    tab: { id: tab.id, url: tab.url, title: tab.title, cookieStoreId: tab.cookieStoreId },
    profile,
    container,
    route,
    routeTest: currentTest(state, tab.cookieStoreId),
    security: { ...securityState },
    mullvadNative: mullvadRuntime.getStatus(),
    menuCommands: getMenuCommandsForTab(tab.id),
    automation: { jobs: (await listJobs(10)).filter((job) => ["queued", "preparing", "running", "stopping"].includes(job.state)) }
  };
}

async function performProfileTest(profileId) {
  const state = await getState();
  const profile = state.profiles[profileId];
  if (!profile || !profile.managed) throw new Error("Profile is not managed");
  if (profile.routeId === BLOCK_ROUTE_ID) throw new Error("Profile is intentionally blocked; assign a route first");
  const direct = profile.routeId === DIRECT_ROUTE_ID;
  if (!direct && state.global.enforcePrivacyControls && !securityState.privacySafe) {
    return { ok: false, error: "Browser privacy controls are not in a safe state" };
  }

  const route = direct ? null : state.routes[profile.routeId];
  if (!direct && (!route || route.enabled === false)) {
    return { ok: false, error: "Assigned route is missing or disabled" };
  }

  let effectiveRoute = route;
  if (route) {
    effectiveRoute = await mullvadRuntime.resolve(route);
    if (!effectiveRoute) {
      return {
        ok: false,
        error: route.provider === "mullvad"
          ? (mullvadRuntime.getStatus().error || "Local Mullvad bridge is not ready")
          : "Proxy route is unavailable"
      };
    }
  }

  let data = {};
  let primaryConnectionError = null;
  try {
    // Mullvad's Firefox extension uses the dedicated IPv4 JSON endpoint for
    // exit verification, including the mullvad_exit_ip signal.
    data = await fetchJsonThroughRouteTest(profileId, effectiveRoute, MULLVAD_IPV4_CHECK_URL, 15000);
  } catch (error) {
    primaryConnectionError = String(error?.message || error);
    try {
      data = await fetchJsonThroughRouteTest(profileId, effectiveRoute, MULLVAD_CHECK_URL, 15000);
    } catch (fallbackError) {
      return {
        ok: false,
        error: `Connection check failed: ${String(fallbackError?.message || fallbackError)}`,
        connectionCheckError: primaryConnectionError,
        mullvadNative: mullvadRuntime.getStatus()
      };
    }
  }

  if (!data || typeof data !== "object" || Array.isArray(data) || !String(data.ip || "").trim()) {
    return {
      ok: false,
      error: "Connection check returned no exit IP",
      connectionCheckError: primaryConnectionError,
      mullvadNative: mullvadRuntime.getStatus()
    };
  }

  let dns = { checked: false, leaking: null, servers: [], error: null };
  try {
    // Mullvad's own Firefox extension performs its DNS leak checks from
    // extension context. Bind only these randomized requests to the Persona's
    // effective route, avoiding page-navigation DNS pre-resolution entirely.
    const rawServers = [];
    const usedTargets = new Set();
    for (let i = 0; i < 3; i++) {
      let target;
      do {
        target = `https://${crypto.randomUUID()}.dnsleak.am.i.mullvad.net/`;
      } while (usedTargets.has(target) || routeTestRequests.has(target));
      usedTargets.add(target);

      const body = await fetchJsonThroughRouteTest(profileId, effectiveRoute, target, 15000);
      if (Array.isArray(body)) rawServers.push(...body);
      else if (body && typeof body === "object") rawServers.push(body);
    }

    const leaking = route?.provider === "mullvad"
      ? rawServers.some((server) => server?.mullvad_dns !== true)
      : null;
    const byIp = new Map();
    for (const server of rawServers) if (server?.ip && !byIp.has(server.ip)) byIp.set(server.ip, server);
    const servers = [...byIp.values()];
    if (!servers.length) throw new Error("DNS check returned no resolver observations");
    dns = {
      checked: true,
      leaking,
      servers,
      error: null
    };
  } catch (dnsError) {
    dns = { checked: false, leaking: null, servers: [], error: String(dnsError?.message || dnsError) };
  }

  const exitVerified = route?.provider !== "mullvad" || data.mullvad_exit_ip === true;
  const dnsVerified = dns.checked === true
    && (route?.provider !== "mullvad" || dns.leaking === false);

  let verificationError = null;
  if (!exitVerified) verificationError = "Connection did not use a Mullvad exit";
  else if (!dnsVerified) {
    verificationError = dns.checked === true && dns.leaking === true
      ? "DNS leak detected"
      : (dns.error || "DNS verification incomplete");
  }

  return {
    ok: exitVerified && dnsVerified,
    data,
    dns,
    error: verificationError,
    connectionCheckError: primaryConnectionError,
    mullvadNative: mullvadRuntime.getStatus()
  };
}

async function testProfile(profileId) {
  const before = await getState();
  const profile = before.profiles[profileId];
  const beforeSecurity = healthSecurity(before);
  const route = before.routes[profile?.routeId];
  const context = routeTestContext(profile, route, beforeSecurity);
  const verificationContext = routeVerificationContext(profile, route, beforeSecurity);
  const generation = routeTestGenerations.get(profileId) || 0;
  const result = await performProfileTest(profileId);
  const cached = { ...result, checkedAt: nowIso() };
  const after = await getState();
  const afterProfile = after.profiles[profileId];
  const afterSecurity = healthSecurity(after);
  const unchanged = verificationContext
    && verificationContext === routeVerificationContext(afterProfile, after.routes[afterProfile?.routeId], afterSecurity)
    && generation === (routeTestGenerations.get(profileId) || 0);
  if (unchanged) {
    // Only protected routes contribute cached health evidence. Direct tests
    // still use the verification context above so legitimate success is not
    // mistaken for a route change.
    if (context) routeTests.set(profileId, { context, result: cached });
  } else if (result.ok) {
    return { ok: false, error: "Route or protection changed during verification", checkedAt: cached.checkedAt };
  }
  return cached;
}

const packageInspector = createPackageInspector();
const personaPlatform = createPersonaPlatform({
  getState,
  setState,
  mutate,
  personaManager,
  cookieService,
  storageService,
  securityState,
  getRouteTest: async (profileId) => routeTests.get(profileId) || null,
  runRouteTest: testProfile,
  inspectPackage: packageInspector.inspectPersonaPackage,
  appVersion: browser.runtime.getManifest().version
});

async function getPcmsSystemStatus() {
  const [personas, jobs] = await Promise.all([
    personaPlatform.list(),
    listJobs(200)
  ]);
  const runningJobs = jobs.filter((job) => ["queued", "preparing", "running", "stopping"].includes(job.state));
  const routeHealth = { healthy: 0, blocked: 0, degraded: 0, unknown: 0 };
  for (const persona of personas) {
    const status = String(persona.health?.status || persona.protection || "unknown").toLowerCase();
    if (status.includes("block")) routeHealth.blocked += 1;
    else if (status.includes("healthy") || status.includes("ready") || status.includes("protected")) routeHealth.healthy += 1;
    else if (status.includes("fail") || status.includes("degrad") || status.includes("unsafe") || status.includes("error")) routeHealth.degraded += 1;
    else routeHealth.unknown += 1;
  }
  return {
    security: {
      ready: securityState.ready,
      privacySafe: securityState.privacySafe,
      networkPredictionSafe: securityState.networkPredictionSafe,
      webRTCSafe: securityState.webRTCSafe,
      proxyControl: securityState.proxyControl,
      initializedAt: securityState.initializedAt
    },
    managedPersonaCount: personas.length,
    routeHealth,
    runningWorkflowJobCount: runningJobs.length,
    eventSequence: pcmsEvents.getSequence()
  };
}

const personaApi = createPersonaApi({
  personaManager: personaPlatform,
  routeManager: personaPlatform,
  userscriptManager: personaPlatform,
  workflowRunner: {
    list: personaPlatform.listWorkflows,
    get: personaPlatform.getWorkflow,
    create: personaPlatform.createWorkflow,
    update: personaPlatform.updateWorkflow,
    delete: personaPlatform.deleteWorkflow,
    run: runWorkflow,
    listJobs: (options = 50) => listJobs(typeof options === "number" ? options : options.limit || 50),
    listActiveProfileIds,
    getJob,
    stopJob,
    clearFinishedJobs,
    runExternalExecution,
    listExternalExecutions,
    getExternalExecution,
    findExternalExecutionByOperation,
    getExternalExecutionResult,
    stopExternalExecution,
    acknowledgeExternalExecution,
    focusExternalExecution,
    getExternalExecutionContext
  },
  diagnostics: { getSystemStatus: getPcmsSystemStatus, getStatus: getSnapshot }
});

function personaUidsForProfiles(sourceState, profileIds = []) {
  const wanted = new Set(profileIds.filter(Boolean).map(String));
  return [...new Set(Object.values(sourceState?.profiles || {})
    .filter((profile) => profile?.managed && profile.personaUid
      && (wanted.has(String(profile.containerId)) || wanted.has(String(profile.personaUid))))
    .map((profile) => String(profile.personaUid).toLowerCase()))].sort();
}

function pcmsTargetIds(command, params = {}, sourceState = {}) {
  const ids = new Set();
  for (const key of ["profileId", "personaId", "sourceProfileId"]) if (params[key]) ids.add(String(params[key]));
  if (command === "batch.execute") for (const id of params.personaIds || []) ids.add(String(id));
  if (command === "workflow.run") {
    for (const step of sourceState.workflows?.[params.workflowId]?.steps || []) if (step.profileId) ids.add(String(step.profileId));
  }
  return [...ids];
}

async function fencePcmsMutation(command, params, operation) {
  if (command === "workflow.run") return operation(); // runWorkflowAdmission performs exact-target admission.
  return managementIntegration.withLocalMutationFence({
    targetPersonaUids: (sourceState) => personaUidsForProfiles(sourceState, pcmsTargetIds(command, params, sourceState)),
    mode: "block"
  }, operation);
}

const pcmsControlPlane = createPcmsControlPlane({
  personaApi,
  stateManager,
  eventHub: pcmsEvents,
  getRevision: () => stateManager.getRevision(),
  bootId: stateManager.getBootId(),
  productVersion: browser.runtime.getManifest().version,
  mutationFence: fencePcmsMutation,
  runWorkflowAdmission: (workflowId) => managementIntegration.runLocalWorkflow(workflowId),
  capabilities: [
    "personas", "persona-storage", "routes", "userscripts", "workflows",
    "workflow-jobs", "batch", "events", "diagnostics"
  ]
});

const managementIntegration = createManagementIntegration({
  personaApi,
  stateManager,
  sourceEventHub: pcmsEvents,
  operationStore: createIntegrationOperationStore(browser.storage.local),
  productVersion: browser.runtime.getManifest().version,
  managementProtocolVersion: 1,
  selfExtensionId: browser.runtime.id,
  getExternalRuntimeAvailability: async () => ({
    userScriptsPermission: await userscriptRuntime.hasPermission(),
    userScriptsExecute: typeof browser.userScripts?.execute === "function",
    tabOwnership: typeof browser.sessions?.setTabValue === "function"
      && typeof browser.sessions?.getTabValue === "function"
      && typeof browser.tabs?.update === "function"
  })
});

function localMutationFence(profileIds, operation, mode = "block", options = {}) {
  return managementIntegration.withLocalMutationFence({
    targetPersonaUids: typeof profileIds === "function"
      ? profileIds
      : (sourceState) => personaUidsForProfiles(sourceState, Array.isArray(profileIds) ? profileIds : [profileIds]),
    mode,
    ...options
  }, operation);
}

function allPersonaUids(sourceState) {
  return personaUidsForProfiles(sourceState, Object.values(sourceState?.profiles || {})
    .filter((profile) => profile?.managed).map((profile) => profile.containerId));
}

function expiredTemporaryPersonaUids(sourceState, at = Date.now()) {
  return Object.values(sourceState?.profiles || {})
    .filter((profile) => profile?.managed && !profile.rotationRole && !profile.rotationOperationId
      && profile.status === "temporary" && profile.expiresAt && Date.parse(profile.expiresAt) <= at)
    .map((profile) => String(profile.personaUid || "").trim().toLowerCase())
    .filter(Boolean);
}

function authorizedAutomationSenders(value) {
  const policy = normalizeIntegrationPolicy(value);
  return policy.enabled && policy.allowExternalAutomation ? policy.trustedExtensionIds : [];
}

function revokedAutomationSenders(before, after) {
  const next = new Set(authorizedAutomationSenders(after));
  return authorizedAutomationSenders(before).filter((senderId) => !next.has(senderId));
}

function directAuthorityRevokedSenders(before, after) {
  const previous = normalizeIntegrationPolicy(before);
  const next = normalizeIntegrationPolicy(after);
  if (previous.allowDirect !== true || next.allowDirect === true) return [];
  const stillAuthorized = new Set(authorizedAutomationSenders(next));
  return authorizedAutomationSenders(previous).filter((senderId) => stillAuthorized.has(senderId));
}

function stateMutationTargets(candidateState) {
  return (sourceState) => {
    const before = sourceState || {};
    const after = candidateState || {};
    const ids = new Set();
    const beforeProfiles = before.profiles || {};
    const afterProfiles = after.profiles || {};
    for (const id of new Set([...Object.keys(beforeProfiles), ...Object.keys(afterProfiles)])) {
      if (JSON.stringify(beforeProfiles[id] || null) !== JSON.stringify(afterProfiles[id] || null)) ids.add(id);
    }
    const changedRoutes = new Set();
    for (const id of new Set([...Object.keys(before.routes || {}), ...Object.keys(after.routes || {})])) {
      if (JSON.stringify(before.routes?.[id] || null) !== JSON.stringify(after.routes?.[id] || null)) changedRoutes.add(id);
    }
    if (changedRoutes.size) {
      for (const profile of [...Object.values(beforeProfiles), ...Object.values(afterProfiles)]) {
        if (profile?.routeId && changedRoutes.has(profile.routeId)) ids.add(profile.containerId);
      }
    }
    const beforeScripts = before.scripts || {};
    const afterScripts = after.scripts || {};
    for (const id of new Set([...Object.keys(beforeScripts), ...Object.keys(afterScripts)])) {
      if (JSON.stringify(beforeScripts[id] || null) === JSON.stringify(afterScripts[id] || null)) continue;
      for (const profile of [...Object.values(beforeProfiles), ...Object.values(afterProfiles)]) {
        if ((profile?.scriptIds || []).includes(id)) ids.add(profile.containerId);
      }
      for (const script of [beforeScripts[id], afterScripts[id]]) {
        for (const profileId of script?.profileIds || []) ids.add(profileId);
      }
    }
    if (JSON.stringify(before.global?.privacy || null) !== JSON.stringify(after.global?.privacy || null)
        || ["unmanagedPolicy", "blockSpeculative", "strictProxyVerification", "enforcePrivacyControls",
          "disableNetworkPrediction", "webRTCMode", "autoReloadOnRouteChange"].some((key) => before.global?.[key] !== after.global?.[key])) {
      for (const profile of [...Object.values(beforeProfiles), ...Object.values(afterProfiles)]) {
        if (profile?.managed) ids.add(profile.containerId);
      }
    }
    return personaUidsForProfiles(before, [...ids]);
  };
}

async function callPersonaApi(namespace, method, args = []) {
  const service = personaApi[namespace];
  if (!service || !Object.hasOwn(service, method) || typeof service[method] !== "function") {
    throw new Error("Unknown Persona API method");
  }
  return service[method](...(Array.isArray(args) ? args : []));
}

async function exportState(includeSecrets) {
  const state = await getState();
  const payload = includeSecrets ? normalizeState(state) : redactSecrets(state);
  return {
    format: "persona-route-manager",
    version: 2,
    exportedAt: nowIso(),
    secretsIncluded: Boolean(includeSecrets),
    state: payload,
    userscriptData: await exportUserscriptData()
  };
}

const pendingLegacyImports = new Map();

async function importState(payload, mode = "replace", authorizationId = null) {
  if (authorizationId) {
    const pending = pendingLegacyImports.get(authorizationId);
    if (!pending) throw new Error("Legacy import preview is missing or expired");
    await stateManager.commitPreview(authorizationId);
    pendingLegacyImports.delete(authorizationId);
    if (pending.userscriptData) await importUserscriptData(pending.userscriptData, pending.mode);
    return getSnapshot();
  }
  if (!payload || payload.format !== "persona-route-manager" || !payload.state) {
    throw new Error("Not a Persona Route Manager export");
  }
  if (!["merge", "replace"].includes(mode)) throw new Error("Invalid import mode");
  const current = await getState();
  const incoming = normalizeState(payload.state);
  if (mode === "merge") {
    incoming.profiles = { ...current.profiles, ...incoming.profiles };
    incoming.routes = { ...current.routes, ...incoming.routes };
    incoming.scripts = { ...current.scripts, ...incoming.scripts };
    incoming.workflows = { ...current.workflows, ...incoming.workflows };
    incoming.wireguardImports = [...current.wireguardImports, ...incoming.wireguardImports];
    incoming.global = { ...current.global, ...incoming.global };
  }
  // Portable data cannot import Integration API authority. The remaining
  // security delta is reviewed as one revision-bound service transaction.
  incoming.global.integration = current.global.integration;
  incoming.__stateMeta = current.__stateMeta;
  const preview = await stateManager.previewState(incoming, { requireMetadata: true });
  pendingLegacyImports.set(preview.previewId, { userscriptData: payload.userscriptData, mode });
  if (pendingLegacyImports.size > 32) pendingLegacyImports.delete(pendingLegacyImports.keys().next().value);
  return preview;
}

installRoutingHandlers({
  onProxyRequest: handleProxyRequest,
  onBeforeRequest: handleBeforeRequest,
  onFailure: (failure) => {
    securityState.lastBlock = { at: failure.at, reason: failure.reason, tabId: null, cookieStoreId: null };
    // A burst of blocked requests is represented by one bounded, secret-safe
    // event per minute, while the latest failure remains available in status.
    const now = Date.now();
    if (now - lastRoutingFailureEventAt < 60000) return;
    lastRoutingFailureEventAt = now;
    pcmsEvents.emit({
      type: "routing.guard.blocked",
      entity: "system",
      data: { reason: failure.reason, blockedCount: failure.count }
    });
  }
});

browser.proxy.onError.addListener((error) => {
  securityState.lastProxyError = { at: nowIso(), message: String(error?.message || error?.error || error) };
  // A daemon restart or crashed local forwarder can leave an otherwise-fresh
  // localhost proxy entry cached for a few seconds. Any proxy error revokes
  // that cache immediately so the next protected request rechecks native state
  // and prepares a fresh authenticated exit instead of waiting for the TTL.
  mullvadRuntime.clear();
  for (const id of routeContexts.keys()) routeTestGenerations.set(id, (routeTestGenerations.get(id) || 0) + 1);
  routeTests.clear();
});

browser.webNavigation.onCommitted.addListener((details) => {
  void userscriptRuntime.injectForContext(details, "document_start");
});
browser.webNavigation.onDOMContentLoaded.addListener((details) => {
  void userscriptRuntime.injectForContext(details, "document_end");
});
browser.webNavigation.onCompleted.addListener((details) => {
  void userscriptRuntime.injectForContext(details, "document_idle");
});

browser.tabs.onRemoved?.addListener((tabId) => {
  clearMenuCommandsForTab(tabId);
  clearAutomationTab(tabId);
});
browser.tabs.onActivated?.addListener(async ({ tabId }) => {
  try {
    await initialize();
    const tab = await browser.tabs.get(tabId);
    if (tab?.cookieStoreId) await personaManager.touch(tab.cookieStoreId);
  } catch {}
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.state?.newValue) {
    void stateManager.acceptStorageState(changes.state.newValue).catch((error) => {
      console.error("Unable to apply storage change", error);
    });
  }
});

for (const key of ["networkPredictionEnabled", "peerConnectionEnabled", "webRTCIPHandlingPolicy"]) {
  try {
    browser.privacy.network[key].onChange.addListener(() => { void applyPrivacy(); });
  } catch {}
}
try { browser.proxy.settings.onChange.addListener(() => { void applyPrivacy(); }); } catch {}

browser.contextualIdentities.onRemoved.addListener((change) => { void personaManager.handleRemoved(change); });
browser.contextualIdentities.onUpdated.addListener((change) => { void personaManager.handleUpdated(change); });

browser.runtime.onConnect?.addListener((port) => {
  if (port?.name === PCMS_EVENTS_PORT && isTrustedExtensionPageSender(port.sender)) {
    pcmsEvents.attachPort(port);
  }
});

browser.runtime.onConnectExternal?.addListener((port) => {
  void initialize()
    .then(() => managementIntegration.attachExternalPort(port))
    .catch(() => {
      try { port?.disconnect?.(); } catch {}
    });
});

browser.runtime.onMessageExternal?.addListener(async (message, sender) => {
  try {
    await initialize();
  } catch (error) {
    // Initialization failures still cross the external boundary as bounded,
    // secret-safe Integration API errors rather than raw rejected promises.
    return managementIntegration.failureResponse(message, error);
  }
  // External traffic has a separate validator/dispatcher. Never forward it to
  // the legacy same-extension message switch below.
  return managementIntegration.handleExternalRequest(message, sender);
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  await initialize();

  // Content scripts receive only these two narrow, purpose-built signals.
  if (message?.type === "US_STAGE") {
    if (sender?.id !== browser.runtime.id || !sender?.tab?.id) return false;
    const stage = ["document_start", "document_end", "document_idle"].includes(message.stage)
      ? message.stage
      : "document_idle";
    await userscriptRuntime.injectForContext({
      tab: sender.tab,
      tabId: sender.tab.id,
      frameId: sender.frameId || 0,
      documentId: sender.documentId,
      // A content script may supply an arbitrary message.url. Browser sender
      // metadata is authoritative for the document receiving the injection.
      url: sender.url || sender.tab.url
    }, stage);
    return true;
  }
  if (message?.type === "AUTOMATION_PAGE_SIGNAL") {
    if (sender?.id !== browser.runtime.id || !sender?.tab?.id) return false;
    return handlePageAutomationSignal(sender, message);
  }

  if (!isTrustedExtensionPageSender(sender)) {
    throw new Error("Privileged extension message rejected");
  }
  if (message?.type === PCMS_REQUEST_TYPE) return pcmsControlPlane.handleRequest(message);
  switch (message?.type) {
    case "GET_EXTERNAL_AUTOMATION_CONTROL_LEASES":
      return { leases: await managementIntegration.listControlLeases() };
    case "OVERRIDE_EXTERNAL_PERSONA_CONTROL":
      return managementIntegration.overrideControlLocally(message.personaUid, message.leaseId);
    case "GET_INTEGRATION_POLICY": {
      const state = await getState();
      return { policy: normalizeIntegrationPolicy(state.global?.integration) };
    }
    case "PREVIEW_INTEGRATION_POLICY": {
      const candidate = await getState();
      const policy = normalizeIntegrationPolicy(message.policy);
      candidate.global.integration = policy;
      const preview = await stateManager.previewState(candidate, { requireMetadata: true });
      pendingStatePreviewStates.set(preview.previewId, candidate);
      pendingIntegrationPolicyPreviews.set(preview.previewId, { policy, expiresAt: Date.now() + 2 * 60 * 1000 });
      for (const [id, entry] of pendingIntegrationPolicyPreviews) {
        if (entry.expiresAt <= Date.now() || pendingIntegrationPolicyPreviews.size > 32) {
          pendingIntegrationPolicyPreviews.delete(id);
          pendingStatePreviewStates.delete(id);
        }
      }
      return preview;
    }
    case "UPDATE_INTEGRATION_POLICY": {
      const policy = normalizeIntegrationPolicy(message.policy);
      let committedPolicy = policy;
      if (message.authorizationId) {
        const preview = pendingIntegrationPolicyPreviews.get(message.authorizationId);
        if (!preview || preview.expiresAt <= Date.now()) throw new Error("Integration policy preview is missing or expired");
        if (JSON.stringify(preview.policy) !== JSON.stringify(policy)) {
          throw new Error("Integration policy changed after preview; review and approve the updated policy");
        }
        committedPolicy = preview.policy;
      }
      const current = await getState();
      const previousPolicy = normalizeIntegrationPolicy(current.global?.integration);
      const policyChanged = JSON.stringify(previousPolicy) !== JSON.stringify(committedPolicy);
      if (policyChanged && !message.authorizationId) {
        const candidate = structuredClone(current);
        candidate.global ||= {};
        candidate.global.integration = committedPolicy;
        const preview = await stateManager.previewState(candidate, { requireMetadata: true });
        if (preview.delta.length) throw securityAuthorizationError(preview.delta);
      }
      const revokeSenderIds = revokedAutomationSenders(previousPolicy, committedPolicy);
      const revokeDirectSenderIds = directAuthorityRevokedSenders(previousPolicy, committedPolicy);
      const committed = await localMutationFence(allPersonaUids, async () => {
        const result = message.authorizationId
        ? stateManager.commitPreview(message.authorizationId)
        : mutate((draft) => {
          draft.global ||= {};
          draft.global.integration = committedPolicy;
          return committedPolicy;
        });
        return result;
      }, "system-revoke", { revokeSenderIds, revokeDirectSenderIds });
      if (message.authorizationId) {
        pendingIntegrationPolicyPreviews.delete(message.authorizationId);
        pendingStatePreviewStates.delete(message.authorizationId);
      }
      return {
        policy: committed.state.global.integration,
        bootId: committed.bootId,
        revision: committed.revision
      };
    }
    case "GET_SNAPSHOT": return getSnapshot();
    case "GET_ACTIVE_CONTEXT": return getActiveContext();
    case "RUN_WORKFLOW": {
      if (!isSecurityReviewSender(sender)) throw new Error("Workflow runs must originate from PersonaMonkey settings");
      return { job: await managementIntegration.runLocalWorkflow(message.workflowId, message.overrideConfirmation) };
    }
    case "LIST_AUTOMATION_JOBS": return { jobs: await listJobs(message.limit || 50) };
    case "STOP_AUTOMATION_JOB": return { job: await stopJob(message.jobId) };
    case "CLEAR_AUTOMATION_JOBS": return { jobs: await clearFinishedJobs() };
    case "IMPORT_AUTOMATION_HISTORY": {
      if (!isSecurityReviewSender(sender)) throw new Error("Automation history import is restricted to local PersonaMonkey settings");
      const imported = Array.isArray(message.jobs) ? message.jobs : Object.values(message.jobs || {});
      if (imported.length > 500) throw new Error("Automation history import exceeds the 500 job limit");
      // External owner records are private and can only be created by the trusted
      // Integration API admission path, never by a portable/local history import.
      return { jobs: await replaceJobsTrusted(imported.filter((job) => job && typeof job === "object" && !job.externalOwner)) };
    }
    case "RUN_GM_MENU": return { ok: runMenuCommand(message.tabId, message.scriptId, message.commandId) };
    case "SAVE_STATE": {
      for (const id of Object.keys(message.state?.scripts || {})) invalidateDependencyCache(id);
      const current = await getState();
      const previousPolicy = normalizeIntegrationPolicy(current.global?.integration);
      const candidatePolicy = normalizeIntegrationPolicy(message.state?.global?.integration);
      const policyChanged = JSON.stringify(previousPolicy) !== JSON.stringify(candidatePolicy);
      if (policyChanged && message.authorizationId) {
        const approvedState = pendingStatePreviewStates.get(message.authorizationId);
        if (!approvedState || JSON.stringify(approvedState.global?.integration || {}) !== JSON.stringify(message.state?.global?.integration || {})) {
          throw new Error("Integration policy state changed after preview; review and approve the updated policy");
        }
      }
      if (policyChanged && !message.authorizationId) {
        const preview = await stateManager.previewState(message.state, { requireMetadata: true });
        if (preview.delta.length) throw securityAuthorizationError(preview.delta);
      }
      return localMutationFence(policyChanged ? allPersonaUids : stateMutationTargets(message.state), async () => ({
        state: await setState(message.state, { requireMetadata: true, authorizationId: message.authorizationId }),
        containers: await personaManager.listContainers(),
        security: { ...securityState }
      }), policyChanged ? "system-revoke" : "block", policyChanged
        ? {
          revokeSenderIds: revokedAutomationSenders(previousPolicy, candidatePolicy),
          revokeDirectSenderIds: directAuthorityRevokedSenders(previousPolicy, candidatePolicy),
          blockPersonaUids: stateMutationTargets(message.state)
        }
        : {});
    }
    case "PREVIEW_STATE_CHANGE": {
      const preview = await stateManager.previewState(message.state, { requireMetadata: true });
      pendingStatePreviewStates.set(preview.previewId, structuredClone(message.state));
      while (pendingStatePreviewStates.size > 32) pendingStatePreviewStates.delete(pendingStatePreviewStates.keys().next().value);
      return preview;
    }
    case "AUTHORIZE_SECURITY_PREVIEW":
      if (!isSecurityReviewSender(sender)) throw securityAuthorizationError([]);
      return stateManager.authorizePreview(message.previewId, message.approvedDelta);
    case "COMMIT_STATE_PREVIEW": {
      if (!isSecurityReviewSender(sender)) throw securityAuthorizationError([]);
      const current = await getState();
      const candidate = pendingStatePreviewStates.get(message.authorizationId);
      const previousPolicy = normalizeIntegrationPolicy(current.global?.integration);
      const candidatePolicy = candidate ? normalizeIntegrationPolicy(candidate.global?.integration) : previousPolicy;
      const revokeSenderIds = revokedAutomationSenders(previousPolicy, candidatePolicy);
      const revokeDirectSenderIds = directAuthorityRevokedSenders(previousPolicy, candidatePolicy);
      const policyChanged = JSON.stringify(previousPolicy) !== JSON.stringify(candidatePolicy);
      const committed = await localMutationFence(candidate
        ? (sourceState) => policyChanged ? allPersonaUids(sourceState) : stateMutationTargets(candidate)(sourceState)
        : allPersonaUids, () => stateManager.commitPreview(message.authorizationId),
      policyChanged ? "system-revoke" : "block", policyChanged
        ? { revokeSenderIds, revokeDirectSenderIds, blockPersonaUids: candidate ? stateMutationTargets(candidate) : allPersonaUids }
        : {});
      pendingStatePreviewStates.delete(message.authorizationId);
      pendingIntegrationPolicyPreviews.delete(message.authorizationId);
      return { state: committed.state, containers: await personaManager.listContainers(), security: { ...securityState } };
    }
    case "ENSURE_PROFILES": return localMutationFence(allPersonaUids, () => personaManager.ensureProfiles(message.count, message.prefix));
    case "LIST_PERSONAS": return { personas: await personaPlatform.list({ includeStorage: message.includeStorage === true }) };
    case "GET_PERSONA": return { persona: await personaPlatform.get(message.profileId, { includeStorage: message.includeStorage === true }) };
    case "CREATE_PERSONA": return localMutationFence([], () => personaPlatform.create(message.input || {}));
    case "OPEN_PERSONA": return localMutationFence(message.profileId, async () => ({ tab: await personaPlatform.open(message.profileId, message.url, message.active !== false) }));
    case "DUPLICATE_PERSONA": return localMutationFence(message.profileId, () => personaPlatform.clone(message.profileId, message.options || {}));
    case "ARCHIVE_PERSONA": return localMutationFence(message.profileId, () => personaPlatform.archive(message.profileId));
    case "DELETE_PERSONA": return localMutationFence(message.profileId, async () => ({ removed: await personaPlatform.remove(message.profileId) }));
    case "UPDATE_PERSONA_IDENTITY": return localMutationFence(message.profileId, () => personaPlatform.updateIdentity(message.profileId, message.changes || {}));
    case "GET_PERSONA_STORAGE": return { storage: await personaPlatform.storage(message.profileId) };
    case "PERSONA_COOKIES_LIST": return cookieService.list(message.profileId);
    case "PERSONA_COOKIES_SET": return localMutationFence(message.profileId, () => cookieService.set(message.profileId, message.cookie, message.original || null));
    case "PERSONA_COOKIES_REMOVE": return localMutationFence(message.profileId, () => cookieService.remove(message.profileId, message.cookie));
    case "PERSONA_COOKIES_CLEAR": return localMutationFence(message.profileId, () => cookieService.clear(message.profileId, message.options || {}));
    case "PERSONA_COOKIES_IMPORT": return localMutationFence(message.profileId, () => cookieService.importRecords(message.profileId, message.records || [], message.mode || "merge"));
    case "CLEAR_PERSONA_STORAGE": return localMutationFence(message.profileId, () => personaPlatform.clearStorage(message.profileId, message.scope || "cookies"));
    case "FULL_WIPE_PERSONA": return localMutationFence(message.profileId, () => personaPlatform.fullWipe(message.profileId));
    case "EXPORT_PERSONA_PACKAGE": return {
      bytes: await personaPlatform.export(message.profileId, message.include || {})
    };
    case "INSPECT_PERSONA_PACKAGE": return {
      preview: await personaPlatform.inspectImport(new Uint8Array(message.bytes || []))
    };
    case "IMPORT_PERSONA_PACKAGE": return localMutationFence(allPersonaUids, () => personaPlatform.import(new Uint8Array(message.bytes || []), message.options || {}));
    case "PERSONA_API": {
      if (message.namespace === "WorkflowRunner" && message.method === "run") {
        const [workflowId] = Array.isArray(message.args) ? message.args : [];
        return managementIntegration.runLocalWorkflow(String(workflowId || ""));
      }
      const readonly = new Set(["list", "get", "storage", "inspect", "test", "listWorkflows", "getWorkflow", "listJobs", "getJob", "listUserscripts", "getUserscript", "getSystemStatus", "getStatus", "getRouteStatus", "getPersonaStatus"]);
      if (readonly.has(message.method)) return callPersonaApi(message.namespace, message.method, message.args);
      const args = Array.isArray(message.args) ? message.args : [];
      const target = message.namespace === "UserscriptManager" && ["assign", "unassign"].includes(message.method) ? args[1] : args[0];
      const targetIds = typeof target === "string" ? [target] : [];
      return localMutationFence((sourceState) => {
        const resolved = personaUidsForProfiles(sourceState, targetIds);
        return resolved.length ? resolved : allPersonaUids(sourceState);
      }, () => callPersonaApi(message.namespace, message.method, args));
    }
    case "FETCH_MULLVAD_RELAYS": return { relays: await fetchMullvadRelays() };
    case "CREATE_MULLVAD_ROUTE": return message.authorizationId
      ? localMutationFence(allPersonaUids, () => createMullvadRoute(message.relay, message.authorizationId))
      : createMullvadRoute(message.relay, null);
    case "UPDATE_PROFILE_ROUTE": return localMutationFence(message.profileId, async () => ({
      profile: (await personaPlatform.assignRoute(message.profileId, message.routeId, { allowDirect: message.allowDirect === true })).profile,
      state: await getState()
    }));
    case "TEST_PROFILE": return testProfile(message.profileId);
    case "EXPORT_STATE": return exportState(Boolean(message.includeSecrets));
    case "IMPORT_STATE": return localMutationFence(message.authorizationId ? allPersonaUids : [], () => importState(message.payload, message.mode || "replace", message.authorizationId));
    case "REFRESH_SECURITY":
      await applyPrivacy();
      return { security: { ...securityState } };
    case "MULLVAD_STATUS": return { status: await mullvadRuntime.refreshStatus() };
    case "MULLVAD_ENSURE": return localMutationFence(allPersonaUids, async () => {
      const result = await ensureTunnel();
      mullvadRuntime.clear();
      const status = mullvadRuntime.setStatus({
        installed: true,
        ...result,
        error: result.ok === false ? result.error : null
      });
      return { status };
    });
    case "MULLVAD_STOP": return localMutationFence(allPersonaUids, async () => {
      const result = await stopTunnel();
      mullvadRuntime.clear();
      const status = mullvadRuntime.setStatus({ installed: true, ...result, error: null });
      return { status };
    });
    case "MULLVAD_RESTART": return localMutationFence(allPersonaUids, async () => {
      const result = await restartTunnel();
      mullvadRuntime.clear();
      const status = mullvadRuntime.setStatus({
        installed: true,
        ...result,
        error: result.ok === false ? result.error : null
      });
      return { status };
    });
    case "MULLVAD_LIST_ENTRIES": return listNativeEntries();
    case "MULLVAD_SET_ENTRY": return localMutationFence(allPersonaUids, async () => {
      const result = await setNativeEntry(message.entryId, message.start !== false);
      mullvadRuntime.clear();
      const status = mullvadRuntime.setStatus({
        installed: true,
        ...result,
        error: result.ok === false ? result.error : null
      });
      return { status };
    });
    case "MULLVAD_RELEASE_ROUTE": return localMutationFence((sourceState) => personaUidsForProfiles(sourceState,
      Object.values(sourceState.profiles || {}).filter((profile) => profile?.routeId === message.routeId).map((profile) => profile.containerId)), async () => {
      mullvadRuntime.drop(message.routeId);
      return releaseExit(message.routeId);
    });
    default: throw new Error(`Unknown message type: ${message?.type}`);
  }
});

browser.runtime.onInstalled.addListener(() => { void initialize().catch(() => {}); });
try {
  browser.alarms.create("persona-mullvad-idle", { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "persona-mullvad-idle") {
      void mullvadRuntime.maybeStopIdle();
      const cleanupAt = Date.now();
      // Expiration is a local Persona mutation. Defer it while any target
      // Persona is under external control instead of mutating first and
      // reconciling the lease afterward.
      void localMutationFence(
        (sourceState) => expiredTemporaryPersonaUids(sourceState, cleanupAt),
        () => personaPlatform.cleanupExpired(cleanupAt)
      ).catch(() => {});
    }
  });
} catch {}
void initialize().catch(() => {});
