import { MAX_PCMS_EVENT_BYTES, PCMS_PROTOCOL_VERSION, sanitizePcmsValue } from "./pcms-protocol.js";

function createBootId() {
  try { return crypto.randomUUID(); }
  catch { return `pcms-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

/** Runtime-local, advisory event stream. Query commands remain authoritative. */
export function createPcmsEventHub({ bootId = createBootId(), getRevision = () => 0, maxPayloadBytes = MAX_PCMS_EVENT_BYTES } = {}) {
  let sequence = 0;
  const subscribers = new Set();

  function emit({ type, entity = "system", entityId = null, data = null, revision } = {}) {
    if (typeof type !== "string" || !type) return null;
    const event = Object.freeze({
      version: PCMS_PROTOCOL_VERSION,
      bootId,
      sequence: ++sequence,
      revision: Number.isFinite(revision) ? revision : Number(getRevision?.() || 0),
      at: new Date().toISOString(),
      type,
      entity: String(entity || "system").slice(0, 64),
      entityId: entityId == null ? null : String(entityId).slice(0, 256),
      data: sanitizePcmsValue(data, { maxBytes: maxPayloadBytes })
    });
    for (const subscriber of [...subscribers]) {
      try { subscriber(event); } catch { /* Subscriber failures must never break a mutation. */ }
    }
    return event;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("PCMS event subscriber must be a function");
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  function attachPort(port) {
    if (!port?.postMessage) throw new TypeError("PCMS event port is invalid");
    const unsubscribe = subscribe((event) => {
      try { port.postMessage(event); } catch { unsubscribe(); }
    });
    const disconnect = () => unsubscribe();
    try { port.onDisconnect?.addListener(disconnect); } catch {}
    return disconnect;
  }

  return Object.freeze({ bootId, emit, subscribe, attachPort, getSequence: () => sequence, subscriberCount: () => subscribers.size });
}
