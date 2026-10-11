// In-process Persona Broker endpoint (pcms.persona-broker.internal-endpoint/v1).
//
// PersonaMonkey's background registers its Integration-v1 dispatcher here. The
// background-hosted PCMS Core reaches it through this endpoint instead of
// runtime.sendMessage. Requests and responses are structured-cloned so the
// in-process path carries exactly what the message transport would carry. PCMS
// never receives PersonaMonkey service objects through this module.

export const PCMS_INTERNAL_BROKER_ENDPOINT_CONTRACT = "pcms.persona-broker.internal-endpoint/v1";
/** Additive internal-only typed backup capability. Not an Integration-v1 command.
 * It cannot be reached by runtime.sendMessage or an external extension.
 * PersonaMonkey remains the only execution/state mutation authority. */
export const PCMS_INTERNAL_BACKUP_ENDPOINT_CONTRACT = "pcms.persona-broker.backup/v1";
const BACKUP_MAX_BYTES=128*1024*1024;
function validateBackupRequest(raw) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw)!==Object.prototype || raw.version!==1 ||
      !['export','previewImport','commitImport'].includes(raw.command))
    throw new TypeError('Invalid typed PersonaMonkey backup request');
  const keys=Object.keys(raw).sort().join(',');
  const expected={
    export:'command,consent,version',
    previewImport:'bytes,command,consent,holdId,version',
    commitImport:'authorizationId,command,consent,holdId,version'
  }[raw.command];
  if(keys!==expected || raw.consent!=='RESTORE UNENCRYPTED BACKUP' && raw.consent!=='EXPORT UNENCRYPTED BACKUP')
    throw new TypeError('Unapproved backup request');
  if(raw.command==='export' && raw.consent!=='EXPORT UNENCRYPTED BACKUP')throw new TypeError('Export consent required');
  if(raw.command!=='export' && raw.consent!=='RESTORE UNENCRYPTED BACKUP')throw new TypeError('Restore consent required');
  if(raw.command==='previewImport' && (!(raw.bytes instanceof Uint8Array) ||
    !raw.bytes.length || raw.bytes.byteLength>BACKUP_MAX_BYTES))
    throw new TypeError('Invalid backup bytes');
  if(raw.command!=='export' && (typeof raw.holdId!=='string' ||
     !/^[a-zA-Z0-9_-]{8,128}$/.test(raw.holdId)))throw new TypeError('Invalid restore hold');
  if(raw.command==='commitImport' && (typeof raw.authorizationId!=='string' ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(raw.authorizationId)))throw new TypeError('Invalid import authorization');
  return raw;
}
export const PCMS_INTERNAL_BROKER_EVENTS_PORT_NAME = "PCMS_PERSONA_BROKER_EVENTS";
export const PCMS_INTERNAL_BROKER_INTEGRATION_EVENTS_PORT = "PERSONAMONKEY_INTEGRATION_EVENTS";

function cloneData(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sanitizedError(error) {
  // Mirrors what crosses runtime.sendMessage: a message, never a stack or object graph.
  const message = typeof error?.message === "string" && error.message.length <= 512
    ? error.message
    : "PCMS internal Persona Broker request failed";
  return new Error(message);
}

function validateHandler(handler) {
  if (!handler || typeof handler !== "object"
      || typeof handler.ready !== "function"
      || typeof handler.handleRequest !== "function"
      || typeof handler.attachEvents !== "function") {
    throw new TypeError("PCMS internal Broker handler is invalid");
  }
  return Object.freeze({
    ready: handler.ready,
    handleRequest: handler.handleRequest,
    attachEvents: handler.attachEvents,
    handleBackup: typeof handler.handleBackup === 'function' ? handler.handleBackup : null
  });
}

function createInProcessEventPort(onEvent) {
  const disconnectListeners = new Set();
  let closed = false;
  const noop = Object.freeze({ addListener() {}, removeListener() {}, hasListener() { return false; } });
  const port = Object.freeze({
    name: PCMS_INTERNAL_BROKER_EVENTS_PORT_NAME,
    onMessage: noop,
    onDisconnect: Object.freeze({
      addListener(listener) { if (typeof listener === "function") disconnectListeners.add(listener); },
      removeListener(listener) { disconnectListeners.delete(listener); },
      hasListener(listener) { return disconnectListeners.has(listener); }
    }),
    postMessage(message) {
      if (closed) return;
      let event;
      try { event = cloneData(message); } catch { return; }
      try { onEvent(event); } catch {}
    },
    // Called by the PersonaMonkey side: stop delivery. As with a real port, the
    // side that disconnects is not told about its own disconnect.
    disconnect() { closed = true; }
  });
  return Object.freeze({
    port,
    // Called by the PCMS side: notify PersonaMonkey, as a remote port disconnect would.
    close() {
      if (closed) return;
      closed = true;
      for (const listener of [...disconnectListeners]) {
        try { listener(port); } catch {}
      }
      disconnectListeners.clear();
    },
    get closed() { return closed; }
  });
}

export function createPcmsInternalBrokerEndpointRegistry() {
  let handler = null;
  let resolveRegistered;
  const registered = new Promise((resolve) => { resolveRegistered = resolve; });

  function register(rawHandler) {
    if (handler) throw new Error("PCMS internal Broker handler is already registered");
    handler = validateHandler(rawHandler);
    resolveRegistered(handler);
    return true;
  }

  async function readyHandler() {
    const current = await registered;
    await current.ready();
    return current;
  }

  function createEndpoint() {
    return Object.freeze({
      contract: PCMS_INTERNAL_BROKER_ENDPOINT_CONTRACT,
      async send(envelope) {
        const current = await readyHandler();
        let request;
        try { request = cloneData(envelope); } catch { throw new TypeError("PCMS internal Broker request is not cloneable"); }
        let response;
        try { response = await current.handleRequest(request); }
        catch (error) { throw sanitizedError(error); }
        return cloneData(response);
      },
      async backup(request) {
        const parsed=validateBackupRequest(cloneData(request));
        const current=await readyHandler();
        if(typeof current.handleBackup!=='function')throw new Error('PersonaMonkey typed backup unsupported');
        try {return cloneData(await current.handleBackup(parsed));}
        catch(error){throw sanitizedError(error);}
      },
      openEvents(portName, onEvent) {
        if (portName !== PCMS_INTERNAL_BROKER_INTEGRATION_EVENTS_PORT || typeof onEvent !== "function") {
          throw new TypeError("PCMS internal Broker event request is invalid");
        }
        const connection = createInProcessEventPort(onEvent);
        void readyHandler()
          .then((current) => (connection.closed ? false : current.attachEvents(connection.port)))
          .catch(() => connection.close());
        return Object.freeze({ disconnect() { connection.close(); } });
      }
    });
  }

  return Object.freeze({
    register,
    createEndpoint,
    isRegistered() { return handler !== null; }
  });
}

// One registry per background context. background.js and the PCMS background
// entry import this same module URL and therefore share it.
const defaultRegistry = createPcmsInternalBrokerEndpointRegistry();

export function registerPcmsInternalBrokerHandler(handler) {
  return defaultRegistry.register(handler);
}

export function createPcmsInternalBrokerEndpoint() {
  return defaultRegistry.createEndpoint();
}
