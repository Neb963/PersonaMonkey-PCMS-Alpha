import { createIndexedDbStorageBackend } from "./indexeddb-backend.js";
import { STORAGE_ERROR_CODES, storageError } from "./errors.js";

const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/;
const MAX_KEY_LENGTH = 512;
const MAX_DEPTH = 32;
const MAX_NODES = 100000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function validateNamespace(namespace) {
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    throw storageError(STORAGE_ERROR_CODES.INVALID_NAMESPACE, "PCMS storage namespace is invalid");
  }
  return namespace;
}

function validateKey(key) {
  if (typeof key !== "string" || key.length < 1 || key.length > MAX_KEY_LENGTH || key.includes("\u0000")) {
    throw storageError(STORAGE_ERROR_CODES.INVALID_KEY, "PCMS storage key is invalid");
  }
  return key;
}

function clonePlainValue(input) {
  let nodes = 0;
  const seen = new WeakSet();

  function clone(value, depth) {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage value exceeds structural limits");
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") {
      throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage value must contain data only");
    }
    if (seen.has(value)) {
      throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage value must not contain cycles");
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > MAX_NODES) {
          throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage array exceeds structural limits");
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const output = new Array(value.length);
        for (const key of Reflect.ownKeys(descriptors)) {
          if (key === "length") continue;
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
            throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage array contains an unsafe property");
          }
          const index = Number(key);
          const descriptor = descriptors[key];
          if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || !("value" in descriptor)) {
            throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage array contains an unsafe property");
          }
          output[index] = clone(descriptor.value, depth + 1);
        }
        return output;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage value must use plain objects");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const output = Object.create(null);
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        if (typeof key !== "string" || FORBIDDEN_KEYS.has(key) || !("value" in descriptor)) {
          throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage value contains an unsafe property");
        }
        output[key] = clone(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }

  return clone(input, 0);
}

function publicRecord(record) {
  if (!record) return null;
  return Object.freeze({
    key: record.key,
    revision: record.revision,
    updatedAt: record.updatedAt,
    value: clonePlainValue(record.value)
  });
}

function validateExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw storageError(STORAGE_ERROR_CODES.CAS_MISMATCH, "PCMS storage expected revision must be a non-negative integer");
  }
  return value;
}

export function createPcmsStorageBroker({
  backend = createIndexedDbStorageBackend(),
  clock = () => new Date().toISOString()
} = {}) {
  let open = false;

  async function ensureOpen() {
    if (!open) {
      await backend.open();
      open = true;
    }
  }

  async function read(namespace, key) {
    await ensureOpen();
    return publicRecord(await backend.get(namespace, key));
  }

  function namespaceStore(rawNamespace) {
    const namespace = validateNamespace(rawNamespace);
    return Object.freeze({
      namespace,
      async get(rawKey) {
        const key = validateKey(rawKey);
        return read(namespace, key);
      },
      async compareAndSwap(rawKey, { expectedRevision, value }) {
        const key = validateKey(rawKey);
        const revision = validateExpectedRevision(expectedRevision);
        const safeValue = clonePlainValue(value);
        await ensureOpen();
        const record = await backend.compareAndSwap(namespace, key, revision, safeValue, clock());
        return publicRecord(record);
      },
      async deleteCompareAndSwap(rawKey, { expectedRevision }) {
        const key = validateKey(rawKey);
        const revision = validateExpectedRevision(expectedRevision);
        await ensureOpen();
        return Object.freeze(await backend.deleteCompareAndSwap(namespace, key, revision));
      },
      async list() {
        await ensureOpen();
        const records = await backend.listNamespace(namespace);
        return Object.freeze(records.map(publicRecord));
      }
    });
  }


  function normalizeAdminRecords(records) {
    if (!Array.isArray(records) || Object.getPrototypeOf(records) !== Array.prototype || records.length > MAX_NODES) {
      throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage snapshot record list is invalid");
    }
    const output = [];
    const identities = new Set();
    for (let index = 0; index < records.length; index += 1) {
      if (!Object.hasOwn(records, index)) {
        throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage snapshot record list is sparse");
      }
      const raw = records[index];
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype
          || Object.getOwnPropertySymbols(raw).length) {
        throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage snapshot record is invalid");
      }
      const descriptors = Object.getOwnPropertyDescriptors(raw);
      const names = ["namespace", "key", "revision", "updatedAt", "value"];
      if (Object.keys(descriptors).length !== names.length
          || !names.every((name) => Object.hasOwn(descriptors, name)
            && descriptors[name].enumerable
            && Object.hasOwn(descriptors[name], "value"))) {
        throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage snapshot record shape is invalid");
      }
      const namespace = validateNamespace(descriptors.namespace.value);
      const key = validateKey(descriptors.key.value);
      const revision = descriptors.revision.value;
      const updatedAt = descriptors.updatedAt.value;
      if (!Number.isSafeInteger(revision) || revision < 1
          || typeof updatedAt !== "string" || updatedAt.length < 1 || updatedAt.length > 64
          || Number.isNaN(Date.parse(updatedAt))) {
        throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage snapshot metadata is invalid");
      }
      const identity = namespace + "\u0000" + key;
      if (identities.has(identity)) {
        throw storageError(STORAGE_ERROR_CODES.INVALID_VALUE, "PCMS storage snapshot contains duplicate record identity");
      }
      identities.add(identity);
      output.push(Object.freeze({
        namespace,
        key,
        revision,
        updatedAt,
        value: clonePlainValue(descriptors.value.value)
      }));
    }
    output.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
    return Object.freeze(output);
  }

  const admin = Object.freeze({
    validateRecords: normalizeAdminRecords,
    async snapshotRecords() {
      await ensureOpen();
      if (typeof backend.listAllRecords !== "function") {
        throw storageError(STORAGE_ERROR_CODES.UNAVAILABLE, "PCMS storage backend does not support snapshots");
      }
      const raw = await backend.listAllRecords();
      return normalizeAdminRecords(raw.map((record) => ({
        namespace:record.namespace,
        key:record.key,
        revision:record.revision,
        updatedAt:record.updatedAt,
        value:record.value
      })));
    },
    async replaceAllRecords(records) {
      const safe = normalizeAdminRecords(records);
      await ensureOpen();
      if (typeof backend.replaceAllRecords !== "function") {
        throw storageError(STORAGE_ERROR_CODES.UNAVAILABLE, "PCMS storage backend does not support restore replacement");
      }
      return backend.replaceAllRecords(safe);
    }
  });

  return Object.freeze({
    async open() {
      await ensureOpen();
    },
    close() {
      backend.close();
      open = false;
    },
    namespace: namespaceStore,
    admin
  });
}
