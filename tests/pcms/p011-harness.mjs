import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";

import { createModulePackageRegistry, MODULE_CANDIDATE_STATES } from "../../extension/pcms/modules/registry.js";
import { PCMS_MODULE_ARCHIVE_FORMAT, encodeModuleArchive } from "../../extension/pcms/modules/package.js";
import { installSandboxControllerRuntime } from "../../extension/pcms/sandbox/controller-runtime.js";
import { createSandboxControllerHost } from "../../extension/pcms/runtime/sandbox-host.js";

export function makeStorage(shared = { namespaces:new Map() }) {
  const clone = (value) => structuredClone(value);
  function rowsFor(namespace) {
    let rows = shared.namespaces.get(namespace);
    if (!rows) {
      rows = new Map();
      shared.namespaces.set(namespace, rows);
    }
    return rows;
  }
  return {
    shared,
    namespace(namespace) {
      const rows = rowsFor(namespace);
      return {
        async get(key) {
          const row = rows.get(key);
          return row ? clone(row) : null;
        },
        async compareAndSwap(key, { expectedRevision, value }) {
          const row = rows.get(key);
          const current = row?.revision || 0;
          if (current !== expectedRevision) {
            const error = new Error("cas");
            error.code = "PCMS_STORAGE_CAS_MISMATCH";
            error.currentRevision = current;
            throw error;
          }
          const next = {
            key,
            revision:current + 1,
            updatedAt:"storage-clock",
            value:clone(value)
          };
          rows.set(key, next);
          return clone(next);
        },
        async list() {
          return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)).map(clone);
        }
      };
    }
  };
}

export function moduleArchive({
  moduleId = "demo.module",
  version = "1.0.0",
  capabilities = [],
  source
}) {
  return encodeModuleArchive({
    format:PCMS_MODULE_ARCHIVE_FORMAT,
    manifest:{
      schemaVersion:1,
      moduleId,
      version,
      controller:"controller.js",
      authority:{ capabilities }
    },
    files:{ "controller.js":source }
  });
}

export async function admit(registry, archiveBytes) {
  const parsed = new TextDecoder().decode(archiveBytes);
  const moduleId = JSON.parse(parsed).manifest.moduleId;
  const current = await registry.getModule(moduleId);
  let row = await registry.stageCandidate(archiveBytes, { expectedModuleRevision:current?.revision || 0 });
  if (row.value.candidate.state === MODULE_CANDIDATE_STATES.AWAITING_APPROVAL) {
    row = await registry.approveCandidate(moduleId, row.value.candidate.packageHash, {
      expectedModuleRevision:row.revision
    });
  }
  return registry.admitCandidate(moduleId, row.value.candidate.packageHash, {
    expectedModuleRevision:row.revision
  });
}

function makeWindow(origin = "moz-extension://pcms-p011-test") {
  const listeners = new Map();
  const parent = {};
  return {
    parent,
    location:{ origin },
    addEventListener(type, listener) {
      const set = listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    }
  };
}

export function makeSandboxFactories() {
  let sequence = 0;
  const childRuntimes = [];
  const hosts = [];
  return {
    childRuntimes,
    hosts,
    frameFactory() {
      const windowRef = makeWindow();
      const child = installSandboxControllerRuntime({ windowRef, capabilityTimeoutMs:750 });
      childRuntimes.push(child);
      return {
        contentWindow:{
          postMessage(data, targetOrigin, ports) {
            assert.equal(targetOrigin, "*");
            windowRef.emit("message", {
              source:windowRef.parent,
              origin:windowRef.location.origin,
              data,
              ports
            });
          }
        }
      };
    },
    sandboxHostFactory(options) {
      const host = createSandboxControllerHost({
        ...options,
        messageChannelFactory:() => new MessageChannel(),
        sessionIdFactory:() => "session-p011-" + (++sequence),
        timeoutMs:750
      });
      hosts.push(host);
      return host;
    },
    async dispose() {
      for (const host of hosts) {
        try { await host.dispose(); } catch {}
      }
      for (const child of childRuntimes) child.dispose();
    }
  };
}

export function makeRegistry(storage) {
  return createModulePackageRegistry({
    storageBroker:storage,
    clock:() => "2026-10-05T02:00:00Z"
  });
}
