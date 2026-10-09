const HOST_NAME = "com.persona.mullvad_router";
let port = null;
let seq = 1;
const pending = new Map();
let lastDisconnectError = null;

function closePort() {
  if (port) {
    try { port.disconnect(); } catch {}
  }
  port = null;
}

function ensurePort() {
  if (port) return port;
  if (!browser.runtime?.connectNative) throw new Error("Native Messaging API is unavailable");
  const p = browser.runtime.connectNative(HOST_NAME);
  port = p;
  lastDisconnectError = null;
  p.onMessage.addListener((msg) => {
    const id = msg?.id;
    if (id == null) return;
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timer);
    if (msg.ok === false) item.reject(new Error(msg.error || "Local Mullvad service failed"));
    else item.resolve(msg);
  });
  p.onDisconnect.addListener(() => {
    const err = browser.runtime.lastError?.message || "Native host disconnected";
    lastDisconnectError = err;
    if (port === p) port = null;
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(err));
      pending.delete(id);
    }
  });
  return p;
}

export function nativeRequest(command, payload = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = ensurePort(); }
    catch (error) { reject(error); return; }
    const id = seq++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Local Mullvad service timed out during ${command}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { p.postMessage({ id, command, ...payload }); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      closePort();
      reject(error);
    }
  });
}

function dedicatedNativeRequest(command, payload = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      if (!browser.runtime?.connectNative) throw new Error("Native Messaging API is unavailable");
      p = browser.runtime.connectNative(HOST_NAME);
    } catch (error) {
      reject(error);
      return;
    }

    const id = seq++;
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      p.onMessage.removeListener?.(onMessage);
      p.onDisconnect.removeListener?.(onDisconnect);
      try { p.disconnect(); } catch {}
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onMessage = (msg) => {
      if (msg?.id !== id) return;
      if (msg.ok === false) finish(reject, new Error(msg.error || "Local Mullvad service failed"));
      else finish(resolve, msg);
    };
    const onDisconnect = () => {
      const err = browser.runtime.lastError?.message || "Native host disconnected";
      finish(reject, new Error(err));
    };
    p.onMessage.addListener(onMessage);
    p.onDisconnect.addListener(onDisconnect);
    timer = setTimeout(() => finish(reject, new Error(`Local Mullvad service timed out during ${command}`)), timeoutMs);
    try { p.postMessage({ id, command, ...payload }); }
    catch (error) { finish(reject, error); }
  });
}

export async function getNativeStatus() {
  try {
    const status = await nativeRequest("status", {}, 6000);
    return { installed: true, ...status, error: null };
  } catch (error) {
    return { installed: false, ready: false, error: String(error?.message || error), lastDisconnectError };
  }
}

export function ensureTunnel() { return nativeRequest("ensure_up"); }
export function stopTunnel() { return nativeRequest("stop"); }
export function restartTunnel() { return nativeRequest("restart"); }
export function listEntries() { return nativeRequest("list_entries", {}, 6000); }
export function setEntry(entryId, start = true) { return nativeRequest("set_entry", { entry_id: entryId, start }); }
export function prepareExit(route, start = true, forwarderToken) {
  return nativeRequest("prepare_exit", {
    route_id: route.id,
    relay_ip: route.host,
    relay_port: Number(route.port || 1080),
    start,
    forwarder_token: forwarderToken
  });
}
export function releaseExit(routeId) { return nativeRequest("release_exit", { route_id: routeId }, 6000); }
export async function fetchViaExit(route, request, timeoutMs = 90000, signal = null) {
  if (signal?.aborted) throw new Error("Mullvad request aborted");
  const requestId = crypto.randomUUID();
  const cancel = () => {
    void dedicatedNativeRequest("cancel_fetch", { request_id: requestId }, 10000).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await dedicatedNativeRequest("fetch_exit", {
      route_id: route.id,
      relay_ip: route._relayHost || route.host,
      relay_port: Number(route._relayPort || route.port || 1080),
      request: { ...request, request_id: requestId }
    }, timeoutMs);
    if (signal?.aborted) throw new Error("Mullvad request aborted");
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
