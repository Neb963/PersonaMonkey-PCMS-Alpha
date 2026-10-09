import { SECRET_ERROR_CODES, normalizeSecretError, secretError } from "./errors.js";
import { assertSecretRef, createSecretRef, secretRefDiagnostic } from "./secret-ref.js";
import { assertSecretValue } from "./protocol.js";

export function createSecretStore({
  backend,
  randomUUID = () => globalThis.crypto?.randomUUID?.()
} = {}) {
  let backendValid = false;
  try {
    backendValid = Boolean(backend)
      && typeof backend.put === "function"
      && typeof backend.get === "function"
      && typeof backend.delete === "function"
      && typeof backend.probe === "function";
  } catch {}
  if (!backendValid) throw secretError(SECRET_ERROR_CODES.UNAVAILABLE);

  let closed = false;

  function ensureOpen() {
    if (closed) throw secretError(SECRET_ERROR_CODES.CLOSED);
  }

  async function safe(operation) {
    ensureOpen();
    try {
      return await operation();
    } catch (error) {
      throw normalizeSecretError(error);
    }
  }

  async function safeMutation(operation, secretRef, action) {
    ensureOpen();
    try {
      return await action();
    } catch (error) {
      const normalized = normalizeSecretError(error);
      if (normalized.code === SECRET_ERROR_CODES.TIMEOUT
          || normalized.code === SECRET_ERROR_CODES.UNAVAILABLE
          || normalized.code === SECRET_ERROR_CODES.PROTOCOL) {
        throw secretError(SECRET_ERROR_CODES.UNCERTAIN, { secretRef, operation });
      }
      throw normalized;
    }
  }

  return Object.freeze({
    async probe() {
      return safe(async () => {
        const result = await backend.probe();
        return Object.freeze({ ready: result?.ready === true });
      });
    },

    async create(value) {
      ensureOpen();
      const secret = assertSecretValue(value);
      const ref = createSecretRef({ randomUUID });
      await safeMutation("create", ref, () => backend.put(ref, secret));
      return ref;
    },

    async replace(secretRef, value) {
      const ref = assertSecretRef(secretRef);
      const secret = assertSecretValue(value);
      await safeMutation("replace", ref, () => backend.put(ref, secret));
      return ref;
    },

    async resolveForPrivilegedUse(secretRef) {
      const ref = assertSecretRef(secretRef);
      return safe(async () => assertSecretValue(await backend.get(ref)));
    },

    async delete(secretRef) {
      const ref = assertSecretRef(secretRef);
      return safeMutation("delete", ref, async () => {
        const result = await backend.delete(ref);
        return Object.freeze({ deleted: result?.deleted === true });
      });
    },

    describeRef(secretRef) {
      ensureOpen();
      return Object.freeze({ ref: secretRefDiagnostic(secretRef) });
    },

    close() {
      if (closed) return;
      closed = true;
      try { backend.close?.(); } catch {}
    }
  });
}
