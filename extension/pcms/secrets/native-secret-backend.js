import {
  DEFAULT_SECRET_TIMEOUT_MS,
  SECRET_HOST_NAME,
  makeSecretHostRequest,
  parseSecretHostResponse
} from "./protocol.js";
import { SECRET_ERROR_CODES, normalizeSecretError, secretError } from "./errors.js";
import { assertSecretRef } from "./secret-ref.js";

export function createFirefoxNativeSecretTransport(runtime) {
  if (!runtime || typeof runtime.sendNativeMessage !== "function") {
    throw secretError(SECRET_ERROR_CODES.UNAVAILABLE);
  }
  return Object.freeze(async function sendDedicatedSecretMessage(hostName, request) {
    if (hostName !== SECRET_HOST_NAME) throw secretError(SECRET_ERROR_CODES.PROTOCOL);
    try {
      return await runtime.sendNativeMessage(SECRET_HOST_NAME, request);
    } catch {
      throw secretError(SECRET_ERROR_CODES.UNAVAILABLE);
    }
  });
}

function timeoutPromise(timeoutMs) {
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(secretError(SECRET_ERROR_CODES.TIMEOUT)), timeoutMs);
  });
  return {
    promise,
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
  };
}

export function createNativeSecretBackend({
  sendNativeMessage,
  hostName = SECRET_HOST_NAME,
  randomUUID = () => globalThis.crypto?.randomUUID?.(),
  timeoutMs = DEFAULT_SECRET_TIMEOUT_MS
} = {}) {
  if (typeof sendNativeMessage !== "function") {
    throw secretError(SECRET_ERROR_CODES.UNAVAILABLE);
  }
  if (hostName !== SECRET_HOST_NAME) {
    throw secretError(SECRET_ERROR_CODES.PROTOCOL);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw secretError(SECRET_ERROR_CODES.PROTOCOL);
  }

  let closed = false;

  async function call(op, fields = {}) {
    if (closed) throw secretError(SECRET_ERROR_CODES.CLOSED);
    let id;
    try {
      id = randomUUID();
      const request = makeSecretHostRequest({ id, op, ...fields });
      const timeout = timeoutPromise(timeoutMs);
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => sendNativeMessage(hostName, request)),
          timeout.promise
        ]);
        return parseSecretHostResponse(response, { id: request.id, op });
      } finally {
        timeout.cancel();
      }
    } catch (error) {
      if (error?.code === SECRET_ERROR_CODES.NOT_FOUND
          || error?.code === SECRET_ERROR_CODES.TIMEOUT
          || error?.code === SECRET_ERROR_CODES.PROTOCOL
          || error?.code === SECRET_ERROR_CODES.INVALID_REF
          || error?.code === SECRET_ERROR_CODES.INVALID_VALUE
          || error?.code === SECRET_ERROR_CODES.CLOSED) {
        throw error;
      }
      throw normalizeSecretError(error, SECRET_ERROR_CODES.UNAVAILABLE);
    }
  }

  return Object.freeze({
    kind: "native-secret-host",
    async probe() {
      return call("probe");
    },
    async put(secretRef, value) {
      return call("put", { secretRef: assertSecretRef(secretRef), value });
    },
    async get(secretRef) {
      const result = await call("get", { secretRef: assertSecretRef(secretRef) });
      return result.value;
    },
    async delete(secretRef) {
      return call("delete", { secretRef: assertSecretRef(secretRef) });
    },
    close() {
      closed = true;
    }
  });
}
