import { PCMS_EVENTS_PORT, PCMS_PROTOCOL_VERSION, PCMS_REQUEST_TYPE } from "./pcms-protocol.js";

function defaultRequestId() {
  try { return crypto.randomUUID(); }
  catch { return `pcms-client-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateResponse(response, { requestId, protocolVersion }) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw clientError("PCMS_MALFORMED_RESPONSE", "Malformed PCMS response");
  }
  if (response.version !== protocolVersion || response.requestId !== requestId || typeof response.ok !== "boolean") {
    throw clientError("PCMS_MALFORMED_RESPONSE", "Malformed PCMS response");
  }
  if (typeof response.bootId !== "string" || !response.bootId || !Number.isInteger(response.revision) || response.revision < 0) {
    throw clientError("PCMS_MALFORMED_RESPONSE", "Malformed PCMS response");
  }
  if (response.ok) {
    if (!Object.hasOwn(response, "result")) throw clientError("PCMS_MALFORMED_RESPONSE", "Malformed PCMS response");
    return response;
  }
  const remote = response.error;
  if (!remote || typeof remote !== "object" || typeof remote.code !== "string" || typeof remote.message !== "string") {
    throw clientError("PCMS_MALFORMED_RESPONSE", "Malformed PCMS response");
  }
  const error = clientError(remote.code || "PCMS_REQUEST_FAILED", remote.message || "PCMS request failed");
  error.retryable = remote.retryable === true;
  error.details = remote.details ?? null;
  error.bootId = response.bootId;
  error.revision = response.revision;
  throw error;
}

/** Browser-internal PCMS consumer. It intentionally has no browser data APIs. */
export function createPcmsClient({ runtime = globalThis.browser?.runtime, requestIdFactory = defaultRequestId, protocolVersion = PCMS_PROTOCOL_VERSION } = {}) {
  if (!runtime?.sendMessage) throw new Error("PCMS client requires browser.runtime messaging");

  async function request(command, params = {}, { requestId = requestIdFactory() } = {}) {
    let response;
    try {
      response = await runtime.sendMessage({ type: PCMS_REQUEST_TYPE, version: protocolVersion, requestId, command, params });
    } catch {
      throw clientError("PCMS_TRANSPORT_UNAVAILABLE", "PCMS transport unavailable");
    }
    return validateResponse(response, { requestId, protocolVersion });
  }

  async function listAll(command, params = {}, { size = 50 } = {}) {
    const items = [];
    const seen = new Set();
    let cursor = null;
    let bootId = null;
    for (let page = 0; page < 1000; page += 1) {
      const response = await request(command, { ...params, page: { size, ...(cursor ? { cursor } : {}) } });
      const result = response.result;
      if (!result || !Array.isArray(result.items) || typeof result.hasMore !== "boolean" ||
        (result.hasMore && (typeof result.nextCursor !== "string" || !result.nextCursor)) ||
        (!result.hasMore && result.nextCursor !== null) || (bootId && bootId !== response.bootId)) {
        throw clientError("PCMS_MALFORMED_RESPONSE", "Malformed management page response");
      }
      bootId = response.bootId;
      items.push(...result.items);
      if (!result.hasMore) return items;
      if (seen.has(result.nextCursor)) throw clientError("PCMS_MALFORMED_RESPONSE", "Repeated management page cursor");
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw clientError("PCMS_PAGE_LIMIT", "Management collection exceeds the client page limit");
  }

  function connectEvents(onEvent, { onStatus } = {}) {
    if (typeof onEvent !== "function") throw new TypeError("PCMS event listener must be a function");
    if (!runtime.connect) throw new Error("PCMS event ports are unavailable");
    const port = runtime.connect({ name: PCMS_EVENTS_PORT });
    let connected = true;
    const notify = (status) => { try { onStatus?.(status); } catch {} };
    const onMessage = (event) => {
      if (event?.version !== protocolVersion || typeof event?.bootId !== "string" || !event.bootId || !Number.isInteger(event?.sequence) || event.sequence < 1 || typeof event?.type !== "string") return;
      try { onEvent(event); } catch {}
    };
    const onDisconnect = () => {
      if (!connected) return;
      connected = false;
      notify({ connected: false });
    };
    port.onMessage?.addListener(onMessage);
    port.onDisconnect?.addListener(onDisconnect);
    notify({ connected: true });
    return Object.freeze({
      get connected() { return connected; },
      disconnect() {
        if (!connected) return;
        connected = false;
        try { port.onMessage?.removeListener?.(onMessage); } catch {}
        try { port.onDisconnect?.removeListener?.(onDisconnect); } catch {}
        try { port.disconnect?.(); } catch {}
        notify({ connected: false });
      }
    });
  }

  return Object.freeze({
    request,
    listAll,
    describe: () => request("system.describe"),
    status: () => request("system.status"),
    connectEvents
  });
}
