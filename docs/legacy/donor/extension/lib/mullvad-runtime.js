const FORWARDER_TOKEN_TTL_MS = 60 * 60 * 1000;
// Native bridge 0.3.0 introduced the token-authenticated local SOCKS contract
// that this extension sends to prepare_exit.
export const MINIMUM_NATIVE_BRIDGE_VERSION = "0.3.0";

function parseNativeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ""));
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isNativeBridgeVersionSupported(value) {
  const actual = parseNativeVersion(value);
  const minimum = parseNativeVersion(MINIMUM_NATIVE_BRIDGE_VERSION);
  if (!actual || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function normalizeNativeStatus(value) {
  const normalized = { ...value };
  normalized.minimum_supported_version = MINIMUM_NATIVE_BRIDGE_VERSION;
  normalized.compatible = isNativeBridgeVersionSupported(normalized.version);
  if (normalized.installed !== false && !normalized.compatible) {
    const version = String(normalized.version || "unknown");
    normalized.ready = false;
    normalized.error = `Local Mullvad bridge ${version} is incompatible; authenticated exits require ${MINIMUM_NATIVE_BRIDGE_VERSION} or newer`;
  }
  return normalized;
}

export function createMullvadRuntime({ getState, browserApi = browser, operations, now = () => Date.now() } = {}) {
  if (!getState) throw new Error("Mullvad runtime requires getState");
  if (!operations?.prepareExit || !operations?.getStatus || !operations?.stopTunnel) {
    throw new Error("Mullvad runtime requires routing operations");
  }

  const routes = new Map();
  const inFlight = new Map();
  const routeGenerations = new Map();
  let lifecycleGeneration = 0;
  let status = { installed: false, ready: false, error: "Not checked" };
  let lastUseAt = now();
  let idleMarkerCleared = false;
  const IDLE_SINCE_KEY = "personaMullvadIdleSince";

  async function readIdleSince() {
    const storage = browserApi.storage?.local;
    if (!storage?.get) return lastUseAt;
    try {
      const stored = await storage.get(IDLE_SINCE_KEY);
      const value = Number(stored?.[IDLE_SINCE_KEY]);
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return lastUseAt;
    }
  }

  async function writeIdleSince(value) {
    const storage = browserApi.storage?.local;
    if (!storage) return;
    try {
      if (value == null) await storage.remove?.(IDLE_SINCE_KEY);
      else await storage.set?.({ [IDLE_SINCE_KEY]: value });
    } catch {}
  }

  async function markUsed() {
    lastUseAt = now();
    if (idleMarkerCleared) return;
    await writeIdleSince(null);
    idleMarkerCleared = true;
  }

  function createForwarderToken() {
    if (!globalThis.crypto?.getRandomValues) throw new Error("Secure randomness is unavailable for the Mullvad forwarder");
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function materialize(route, prepared, forwarderToken) {
    return {
      ...route,
      host: prepared.local_host || "127.0.0.1",
      port: Number(prepared.local_port),
      type: "socks",
      proxyDNS: true,
      username: "persona",
      password: forwarderToken,
      _relayHost: route.host,
      _relayPort: route.port
    };
  }

  async function refreshStatus() {
    status = normalizeNativeStatus(await operations.getStatus());
    return status;
  }

  async function resolve(route) {
    if (!route || route.provider !== "mullvad") return route;
    const state = await getState();
    const cfg = state.global.mullvadNative || {};
    if (cfg.enabled === false) return null;

    await markUsed();
    const cached = routes.get(route.id);
    if (cached && now() - cached.at < 8000) {
      if (status.compatible === false) {
        routes.delete(route.id);
        return null;
      }
      return cached.route;
    }
    if (inFlight.has(route.id)) return inFlight.get(route.id);

    const startedLifecycleGeneration = lifecycleGeneration;
    const startedRouteGeneration = routeGenerations.get(route.id) || 0;
    const pending = (async () => {
      try {
        const bridgeStatus = await refreshStatus();
        if (bridgeStatus.installed !== true || bridgeStatus.compatible !== true) return null;
        const cachedTokenIsFresh = cached
          && cached.route?.password
          && now() - cached.tokenCreatedAt < FORWARDER_TOKEN_TTL_MS;
        let forwarderToken = cachedTokenIsFresh ? cached.route.password : createForwarderToken();
        let tokenCreatedAt = cachedTokenIsFresh ? cached.tokenCreatedAt : now();
        let prepared;
        try {
          prepared = await operations.prepareExit(route, cfg.autoStart !== false, forwarderToken);
        } catch (error) {
          // Another runtime generation may have rotated this still-locally-fresh
          // credential after a timed-out native call. Retry only this explicit
          // retired-token condition, once, with fresh entropy. All other native
          // failures remain fail-closed.
          if (!cachedTokenIsFresh || !/forwarder token has expired/i.test(String(error?.message || error))) throw error;
          forwarderToken = createForwarderToken();
          tokenCreatedAt = now();
          prepared = await operations.prepareExit(route, cfg.autoStart !== false, forwarderToken);
        }
        if (startedLifecycleGeneration !== lifecycleGeneration
          || startedRouteGeneration !== (routeGenerations.get(route.id) || 0)) {
          // A stop/restart/release can race an in-flight native request. Revoke
          // that late forwarder before allowing any stale proxy info to escape.
          try { await operations.releaseExit?.(route.id); } catch {}
          return null;
        }
        const effective = materialize(route, prepared, forwarderToken);
        routes.set(route.id, { route: effective, at: now(), tokenCreatedAt });
        status = {
          ...status,
          installed: true,
          ready: true,
          error: null,
          selected_entry: prepared.selected_entry || status.selected_entry
        };
        return effective;
      } catch (error) {
        routes.delete(route.id);
        // The native host may have created the forwarder before its reply was
        // lost. Release it on failure so no credential is left orphaned.
        try { await operations.releaseExit?.(route.id); } catch {}
        const message = String(error?.message || error);
        status = {
          ...status,
          installed: !/(host|not found|disconnected)/i.test(message),
          ready: false,
          error: message
        };
        return null;
      } finally {
        inFlight.delete(route.id);
      }
    })();
    inFlight.set(route.id, pending);
    return pending;
  }

  async function maybeStopIdle() {
    const state = await getState();
    const cfg = state.global.mullvadNative || {};
    const minutes = Number(cfg.autoStopMinutes || 0);
    if (cfg.enabled === false || minutes <= 0) {
      await writeIdleSince(null);
      idleMarkerCleared = true;
      return false;
    }

    const tabs = await browserApi.tabs.query({});
    const active = tabs.some((tab) => {
      const profile = state.profiles[tab.cookieStoreId];
      const route = profile && state.routes[profile.routeId];
      return profile?.managed && route?.provider === "mullvad";
    });
    if (active) {
      await markUsed();
      return false;
    }

    let idleSince = await readIdleSince();
    if (idleSince == null) {
      idleSince = lastUseAt;
      await writeIdleSince(idleSince);
      idleMarkerCleared = false;
    }
    if (now() - idleSince < minutes * 60000) return false;

    try {
      await operations.stopTunnel();
      routes.clear();
      await writeIdleSince(null);
      idleMarkerCleared = true;
      lastUseAt = now();
      await refreshStatus();
      return true;
    } catch {
      return false;
    }
  }

  function clear() {
    lifecycleGeneration += 1;
    routes.clear();
  }
  function drop(routeId) {
    routeGenerations.set(routeId, (routeGenerations.get(routeId) || 0) + 1);
    routes.delete(routeId);
  }
  function setStatus(next) { status = normalizeNativeStatus(next); return status; }
  function getStatus() { return { ...status }; }

  return { resolve, refreshStatus, maybeStopIdle, clear, drop, setStatus, getStatus };
}
