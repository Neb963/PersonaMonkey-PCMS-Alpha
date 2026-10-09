import { PERSONA_PACKAGE_LIMITS } from "./package-limits.js";

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value || []);
}

function boundedTransferBuffer(input) {
  const bytes = asBytes(input);
  if (bytes.byteLength > PERSONA_PACKAGE_LIMITS.maxCompressedBytes) {
    throw new Error("Persona package is too large");
  }
  // Copy only the already-bounded compressed input so transferring ownership to
  // the inspector cannot detach a caller-owned buffer.
  return bytes.slice().buffer;
}

export function createPackageInspector({
  WorkerCtor = globalThis.Worker,
  runtime = globalThis.browser?.runtime
} = {}) {
  async function inspectPersonaPackage(input) {
    // Keep unsupported worker environments local to the package operation so
    // extension startup can still register routing listeners and stay usable.
    if (typeof WorkerCtor !== "function" || typeof runtime?.getURL !== "function") {
      throw new Error("Package inspection worker is unavailable");
    }
    const buffer = boundedTransferBuffer(input);
    return new Promise((resolve, reject) => {
      const worker = new WorkerCtor(runtime.getURL("workers/package-inspector.js"), { type: "module" });
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch {}
        callback(value);
      };
      worker.onmessage = (event) => {
        const result = event?.data;
        if (result?.ok === true) finish(resolve, result.preview);
        else finish(reject, new Error(String(result?.error || "Persona package inspection failed")));
      };
      worker.onerror = () => finish(reject, new Error("Persona package inspection worker failed"));
      try {
        worker.postMessage({ type: "inspect-persona-package", buffer }, [buffer]);
      } catch (error) {
        finish(reject, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return Object.freeze({ inspectPersonaPackage });
}
