import { EMPTY_MODULE_AUTHORITY, diffModuleAuthority, normalizeModuleAuthority } from "./authority.js";
import { MODULE_ERROR_CODES, moduleError } from "./errors.js";
import { assertModuleId, assertModulePackageHash, canonicalModuleManifest, parseModuleArchive, verifyStoredModulePackage } from "./package.js";

export const MODULE_REGISTRY_NAMESPACE = "core.modules";
export const MODULE_RECORD_SCHEMA_VERSION = 1;
export const MODULE_CANDIDATE_STATES = Object.freeze({
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  READY: "READY"
});

function fail(code, options = {}) {
  throw moduleError(code, options);
}

function moduleKey(moduleId) {
  return "module:" + assertModuleId(moduleId);
}

function packageKey(packageHash) {
  return "package:" + packageHash;
}

function copyPackageRecord(pkg) {
  const files = Object.create(null);
  for (const name of Object.keys(pkg.files)) files[name] = pkg.files[name];
  return {
    schemaVersion: MODULE_RECORD_SCHEMA_VERSION,
    kind: "package",
    packageHash: pkg.packageHash,
    format: pkg.format,
    manifest: canonicalModuleManifest(pkg.manifest),
    files
  };
}

function publicModuleRecord(record) {
  if (!record) return null;
  return Object.freeze({
    revision: record.revision,
    updatedAt: record.updatedAt,
    value: record.value
  });
}

function validateExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(MODULE_ERROR_CODES.REVISION_CONFLICT);
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function assertStoredTimestamp(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  return value;
}

function normalizeAuthorityDelta(value) {
  if (!isPlainObject(value)
      || !hasExactKeys(value, ["added", "removed", "unchanged", "requiresApproval"])
      || typeof value.requiresApproval !== "boolean") fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  let added;
  let removed;
  let unchanged;
  try {
    added = [...normalizeModuleAuthority({ capabilities: value.added }).capabilities];
    removed = [...normalizeModuleAuthority({ capabilities: value.removed }).capabilities];
    unchanged = [...normalizeModuleAuthority({ capabilities: value.unchanged }).capabilities];
  } catch {
    fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  }
  const all = [...added, ...removed, ...unchanged];
  if (new Set(all).size !== all.length || value.requiresApproval !== (added.length > 0)) {
    fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  }
  return { added, removed, unchanged, requiresApproval: value.requiresApproval };
}

function normalizeApproval(value, packageHash, addedCapabilities) {
  if (!isPlainObject(value)
      || !hasExactKeys(value, ["packageHash", "addedCapabilities", "approvedAt"])
      || value.packageHash !== packageHash) fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  let normalized;
  try {
    normalized = [...normalizeModuleAuthority({ capabilities: value.addedCapabilities }).capabilities];
  } catch {
    fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  }
  if (JSON.stringify(normalized) !== JSON.stringify(addedCapabilities)) fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  return { packageHash, addedCapabilities: normalized, approvedAt: assertStoredTimestamp(value.approvedAt) };
}

function normalizeCandidate(value) {
  if (value === null) return null;
  if (!isPlainObject(value)
      || !hasExactKeys(value, ["packageHash", "version", "state", "authorityDelta", "stagedAt", "approval"])) {
    fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  }
  let packageHash;
  try {
    packageHash = assertModulePackageHash(value.packageHash);
  } catch {
    fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  }
  if (typeof value.version !== "string" || value.version.length < 1 || value.version.length > 64) {
    fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  }
  const authorityDelta = normalizeAuthorityDelta(value.authorityDelta);
  const stagedAt = assertStoredTimestamp(value.stagedAt);
  if (value.state === MODULE_CANDIDATE_STATES.AWAITING_APPROVAL) {
    if (!authorityDelta.requiresApproval || value.approval !== null) fail(MODULE_ERROR_CODES.CORRUPT_STATE);
    return { packageHash, version: value.version, state: value.state, authorityDelta, stagedAt, approval: null };
  }
  if (value.state !== MODULE_CANDIDATE_STATES.READY) fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  const approval = authorityDelta.requiresApproval
    ? normalizeApproval(value.approval, packageHash, authorityDelta.added)
    : null;
  if (!authorityDelta.requiresApproval && value.approval !== null) fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  return { packageHash, version: value.version, state: value.state, authorityDelta, stagedAt, approval };
}

function normalizePackageHashOrNull(value) {
  if (value === null) return null;
  try {
    return assertModulePackageHash(value);
  } catch {
    fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  }
}

function normalizeModuleState(record, moduleId) {
  if (!record) {
    return {
      revision: 0,
      value: {
        schemaVersion: MODULE_RECORD_SCHEMA_VERSION,
        kind: "module",
        moduleId,
        activePackageHash: null,
        lastKnownGoodPackageHash: null,
        candidate: null
      }
    };
  }
  const value = record.value;
  if (!Number.isSafeInteger(record.revision) || record.revision < 1
      || !isPlainObject(value)
      || !hasExactKeys(value, ["schemaVersion", "kind", "moduleId", "activePackageHash", "lastKnownGoodPackageHash", "candidate"])
      || value.schemaVersion !== MODULE_RECORD_SCHEMA_VERSION
      || value.kind !== "module"
      || value.moduleId !== moduleId) {
    fail(MODULE_ERROR_CODES.CORRUPT_STATE);
  }
  return {
    revision: record.revision,
    value: {
      schemaVersion: MODULE_RECORD_SCHEMA_VERSION,
      kind: "module",
      moduleId,
      activePackageHash: normalizePackageHashOrNull(value.activePackageHash),
      lastKnownGoodPackageHash: normalizePackageHashOrNull(value.lastKnownGoodPackageHash),
      candidate: normalizeCandidate(value.candidate)
    }
  };
}

function normalizeStoredPackageRecord(record, expectedHash) {
  if (!record?.value || record.value.kind !== "package" || record.value.packageHash !== expectedHash) {
    fail(MODULE_ERROR_CODES.IDENTITY_CONFLICT);
  }
  return record.value;
}

function candidateForPackage(pkg, delta, stagedAt) {
  return {
    packageHash: pkg.packageHash,
    version: pkg.manifest.version,
    state: delta.requiresApproval ? MODULE_CANDIDATE_STATES.AWAITING_APPROVAL : MODULE_CANDIDATE_STATES.READY,
    authorityDelta: {
      added: [...delta.added],
      removed: [...delta.removed],
      unchanged: [...delta.unchanged],
      requiresApproval: delta.requiresApproval
    },
    stagedAt,
    approval: null
  };
}

function mapRevisionConflict(error) {
  if (error?.code === "PCMS_STORAGE_CAS_MISMATCH") {
    fail(MODULE_ERROR_CODES.REVISION_CONFLICT, { currentRevision: error.currentRevision });
  }
  throw error;
}

export function createModulePackageRegistry({
  storageBroker,
  clock = () => new Date().toISOString(),
  parseArchive = parseModuleArchive,
  verifyPackage = verifyStoredModulePackage
} = {}) {
  if (!storageBroker || typeof storageBroker.namespace !== "function") {
    throw new TypeError("Module registry requires a PCMS storage broker");
  }
  if (typeof clock !== "function" || typeof parseArchive !== "function" || typeof verifyPackage !== "function") {
    throw new TypeError("Module registry prerequisites are invalid");
  }
  const store = storageBroker.namespace(MODULE_REGISTRY_NAMESPACE);

  async function readPackage(packageHash) {
    assertModulePackageHash(packageHash);
    const record = await store.get(packageKey(packageHash));
    if (!record) fail(MODULE_ERROR_CODES.PACKAGE_MISSING);
    const value = normalizeStoredPackageRecord(record, packageHash);
    const verified = await verifyPackage(value);
    if (verified.packageHash !== packageHash) fail(MODULE_ERROR_CODES.IDENTITY_CONFLICT);
    return verified;
  }

  async function ensurePackageStored(pkg) {
    const key = packageKey(pkg.packageHash);
    const existing = await store.get(key);
    if (existing) {
      const value = normalizeStoredPackageRecord(existing, pkg.packageHash);
      const verified = await verifyPackage(value);
      if (verified.packageHash !== pkg.packageHash
          || verified.manifest.moduleId !== pkg.manifest.moduleId
          || verified.manifest.version !== pkg.manifest.version) fail(MODULE_ERROR_CODES.IDENTITY_CONFLICT);
      return existing;
    }
    try {
      return await store.compareAndSwap(key, { expectedRevision: 0, value: copyPackageRecord(pkg) });
    } catch (error) {
      if (error?.code !== "PCMS_STORAGE_CAS_MISMATCH") throw error;
      const raced = await store.get(key);
      const value = normalizeStoredPackageRecord(raced, pkg.packageHash);
      const verified = await verifyPackage(value);
      if (verified.packageHash !== pkg.packageHash) fail(MODULE_ERROR_CODES.IDENTITY_CONFLICT);
      return raced;
    }
  }

  async function activeAuthority(state) {
    if (!state.value.activePackageHash) return EMPTY_MODULE_AUTHORITY;
    const activePackage = await readPackage(state.value.activePackageHash);
    if (activePackage.manifest.moduleId !== state.value.moduleId) fail(MODULE_ERROR_CODES.CORRUPT_STATE);
    return activePackage.manifest.authority;
  }

  async function getModule(moduleId) {
    const key = moduleKey(moduleId);
    const record = await store.get(key);
    if (!record) return null;
    const normalized = normalizeModuleState(record, moduleId);
    return Object.freeze({ revision: normalized.revision, updatedAt: record.updatedAt, value: normalized.value });
  }

  async function stageCandidate(archiveBytes, { expectedModuleRevision } = {}) {
    const expectedRevision = validateExpectedRevision(expectedModuleRevision);
    const pkg = await parseArchive(archiveBytes);
    await ensurePackageStored(pkg);

    const key = moduleKey(pkg.manifest.moduleId);
    const currentRecord = await store.get(key);
    const current = normalizeModuleState(currentRecord, pkg.manifest.moduleId);
    if (current.revision !== expectedRevision) fail(MODULE_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    if (current.value.activePackageHash === pkg.packageHash) fail(MODULE_ERROR_CODES.INVALID_TRANSITION);
    if (current.value.candidate) {
      if (current.value.candidate.packageHash === pkg.packageHash) return publicModuleRecord(currentRecord);
      fail(MODULE_ERROR_CODES.CANDIDATE_EXISTS);
    }

    const delta = diffModuleAuthority(await activeAuthority(current), pkg.manifest.authority);
    const next = {
      ...current.value,
      candidate: candidateForPackage(pkg, delta, clock())
    };
    try {
      return publicModuleRecord(await store.compareAndSwap(key, { expectedRevision, value: next }));
    } catch (error) {
      mapRevisionConflict(error);
    }
  }

  async function approveCandidate(moduleId, packageHash, { expectedModuleRevision } = {}) {
    assertModulePackageHash(packageHash);
    const expectedRevision = validateExpectedRevision(expectedModuleRevision);
    const key = moduleKey(moduleId);
    const currentRecord = await store.get(key);
    const current = normalizeModuleState(currentRecord, moduleId);
    if (current.revision !== expectedRevision) fail(MODULE_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    const candidate = current.value.candidate;
    if (!candidate || candidate.packageHash !== packageHash) fail(MODULE_ERROR_CODES.CANDIDATE_MISMATCH);
    if (candidate.state !== MODULE_CANDIDATE_STATES.AWAITING_APPROVAL || !candidate.authorityDelta?.requiresApproval) {
      fail(MODULE_ERROR_CODES.INVALID_TRANSITION);
    }
    await readPackage(packageHash);
    const next = {
      ...current.value,
      candidate: {
        ...candidate,
        state: MODULE_CANDIDATE_STATES.READY,
        approval: {
          packageHash,
          addedCapabilities: [...candidate.authorityDelta.added],
          approvedAt: clock()
        }
      }
    };
    try {
      return publicModuleRecord(await store.compareAndSwap(key, { expectedRevision, value: next }));
    } catch (error) {
      mapRevisionConflict(error);
    }
  }

  async function admitCandidate(moduleId, packageHash, { expectedModuleRevision, preserveLastKnownGood = false } = {}) {
    assertModulePackageHash(packageHash);
    const expectedRevision = validateExpectedRevision(expectedModuleRevision);
    if (typeof preserveLastKnownGood !== "boolean") fail(MODULE_ERROR_CODES.INVALID_TRANSITION);
    const key = moduleKey(moduleId);
    const currentRecord = await store.get(key);
    const current = normalizeModuleState(currentRecord, moduleId);
    if (current.revision !== expectedRevision) fail(MODULE_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    const candidate = current.value.candidate;
    if (!candidate || candidate.packageHash !== packageHash) fail(MODULE_ERROR_CODES.CANDIDATE_MISMATCH);
    if (candidate.state !== MODULE_CANDIDATE_STATES.READY) fail(MODULE_ERROR_CODES.APPROVAL_REQUIRED);
    if (candidate.authorityDelta?.requiresApproval) {
      const approval = candidate.approval;
      if (!approval
          || approval.packageHash !== packageHash
          || JSON.stringify(approval.addedCapabilities) !== JSON.stringify(candidate.authorityDelta.added)) {
        fail(MODULE_ERROR_CODES.APPROVAL_REQUIRED);
      }
    }
    const pkg = await readPackage(packageHash);
    if (pkg.manifest.moduleId !== moduleId) fail(MODULE_ERROR_CODES.CORRUPT_STATE);

    const next = {
      ...current.value,
      activePackageHash: packageHash,
      lastKnownGoodPackageHash: preserveLastKnownGood
        ? current.value.lastKnownGoodPackageHash
        : packageHash,
      candidate: null
    };
    try {
      return publicModuleRecord(await store.compareAndSwap(key, { expectedRevision, value: next }));
    } catch (error) {
      mapRevisionConflict(error);
    }
  }

  async function stageStoredCandidate(moduleId, packageHash, { expectedModuleRevision } = {}) {
    const id=assertModuleId(moduleId);
    const hash=assertModulePackageHash(packageHash);
    const expectedRevision=validateExpectedRevision(expectedModuleRevision);
    const pkg=await readPackage(hash);
    if(pkg.manifest.moduleId!==id) fail(MODULE_ERROR_CODES.IDENTITY_CONFLICT);

    const key=moduleKey(id);
    const currentRecord=await store.get(key);
    const current=normalizeModuleState(currentRecord,id);
    if(current.revision!==expectedRevision) fail(MODULE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.activePackageHash===hash) fail(MODULE_ERROR_CODES.INVALID_TRANSITION);
    if(current.value.candidate){
      if(current.value.candidate.packageHash===hash) return publicModuleRecord(currentRecord);
      fail(MODULE_ERROR_CODES.CANDIDATE_EXISTS);
    }

    const delta=diffModuleAuthority(await activeAuthority(current),pkg.manifest.authority);
    const next={...current.value,candidate:candidateForPackage(pkg,delta,clock())};
    try {
      return publicModuleRecord(await store.compareAndSwap(key,{expectedRevision,value:next}));
    } catch(error) {
      mapRevisionConflict(error);
    }
  }

  async function markActivePackageKnownGood(moduleId, packageHash, { expectedModuleRevision } = {}) {
    const id=assertModuleId(moduleId);
    const hash=assertModulePackageHash(packageHash);
    const expectedRevision=validateExpectedRevision(expectedModuleRevision);
    const key=moduleKey(id);
    const currentRecord=await store.get(key);
    const current=normalizeModuleState(currentRecord,id);
    if(current.revision!==expectedRevision) fail(MODULE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.activePackageHash!==hash || current.value.candidate!==null) fail(MODULE_ERROR_CODES.INVALID_TRANSITION);
    await readPackage(hash);
    if(current.value.lastKnownGoodPackageHash===hash) return publicModuleRecord(currentRecord);
    const next={...current.value,lastKnownGoodPackageHash:hash};
    try {
      return publicModuleRecord(await store.compareAndSwap(key,{expectedRevision,value:next}));
    } catch(error) {
      mapRevisionConflict(error);
    }
  }

  async function rollbackAdmission(moduleId, failedPackageHash, { expectedModuleRevision } = {}) {
    const id=assertModuleId(moduleId);
    const hash=assertModulePackageHash(failedPackageHash);
    const expectedRevision=validateExpectedRevision(expectedModuleRevision);
    const key=moduleKey(id);
    const currentRecord=await store.get(key);
    const current=normalizeModuleState(currentRecord,id);
    if(current.revision!==expectedRevision) fail(MODULE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.activePackageHash!==hash || current.value.candidate!==null) fail(MODULE_ERROR_CODES.INVALID_TRANSITION);
    if(current.value.lastKnownGoodPackageHash) await readPackage(current.value.lastKnownGoodPackageHash);
    const next={
      ...current.value,
      activePackageHash:current.value.lastKnownGoodPackageHash,
      candidate:null
    };
    try {
      return publicModuleRecord(await store.compareAndSwap(key,{expectedRevision,value:next}));
    } catch(error) {
      mapRevisionConflict(error);
    }
  }

  async function deactivateModule(moduleId, { expectedModuleRevision } = {}) {
    const id=assertModuleId(moduleId);
    const expectedRevision=validateExpectedRevision(expectedModuleRevision);
    const key=moduleKey(id);
    const currentRecord=await store.get(key);
    const current=normalizeModuleState(currentRecord,id);
    if(current.revision!==expectedRevision) fail(MODULE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.candidate) fail(MODULE_ERROR_CODES.INVALID_TRANSITION);
    if(current.value.activePackageHash===null) return publicModuleRecord(currentRecord);
    const next={
      ...current.value,
      activePackageHash:null,
      lastKnownGoodPackageHash:current.value.activePackageHash || current.value.lastKnownGoodPackageHash,
      candidate:null
    };
    try {
      return publicModuleRecord(await store.compareAndSwap(key,{expectedRevision,value:next}));
    } catch(error) {
      mapRevisionConflict(error);
    }
  }

  async function listPackagesForModule(moduleId) {
    const id=assertModuleId(moduleId);
    const rows=await store.list();
    const packages=[];
    for(const row of rows) {
      if(typeof row.key!=="string") fail(MODULE_ERROR_CODES.CORRUPT_STATE);
      if(!row.key.startsWith("package:")) continue;
      const hash=row.key.slice("package:".length);
      const value=normalizeStoredPackageRecord(row,hash);
      const pkg=await verifyPackage(value);
      if(pkg.packageHash!==hash) fail(MODULE_ERROR_CODES.IDENTITY_CONFLICT);
      if(pkg.manifest.moduleId===id) packages.push(pkg);
    }
    packages.sort((a,b)=>a.packageHash.localeCompare(b.packageHash));
    return Object.freeze(packages);
  }

  async function deletePackage(packageHash) {
    const hash=assertModulePackageHash(packageHash);
    const rows=await store.list();
    let packageRecord=null;
    for(const row of rows) {
      if(typeof row.key!=="string") fail(MODULE_ERROR_CODES.CORRUPT_STATE);
      if(row.key===packageKey(hash)) packageRecord=row;
      if(!row.key.startsWith("module:")) continue;
      const id=assertModuleId(row.key.slice("module:".length));
      const current=normalizeModuleState(row,id);
      const refs=[
        current.value.activePackageHash,
        current.value.lastKnownGoodPackageHash,
        current.value.candidate?.packageHash || null
      ];
      if(refs.includes(hash)) fail(MODULE_ERROR_CODES.PACKAGE_REFERENCED);
    }
    if(!packageRecord) return Object.freeze({deleted:false});
    normalizeStoredPackageRecord(packageRecord,hash);
    try {
      const result=await store.deleteCompareAndSwap(packageKey(hash),{expectedRevision:packageRecord.revision});
      return Object.freeze({deleted:result.deleted===true});
    } catch(error) {
      mapRevisionConflict(error);
    }
  }

  async function deleteModule(moduleId, { expectedModuleRevision } = {}) {
    const id=assertModuleId(moduleId);
    const expectedRevision=validateExpectedRevision(expectedModuleRevision);
    const key=moduleKey(id);
    const currentRecord=await store.get(key);
    if(!currentRecord) {
      if(expectedRevision!==0) fail(MODULE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:0});
      return Object.freeze({deleted:false});
    }
    const current=normalizeModuleState(currentRecord,id);
    if(current.revision!==expectedRevision) fail(MODULE_ERROR_CODES.REVISION_CONFLICT,{currentRevision:current.revision});
    if(current.value.activePackageHash!==null || current.value.candidate!==null) fail(MODULE_ERROR_CODES.INVALID_TRANSITION);
    try {
      const result=await store.deleteCompareAndSwap(key,{expectedRevision});
      return Object.freeze({deleted:result.deleted===true});
    } catch(error) {
      mapRevisionConflict(error);
    }
  }

  async function rejectCandidate(moduleId, packageHash, { expectedModuleRevision } = {}) {
    assertModulePackageHash(packageHash);
    const expectedRevision = validateExpectedRevision(expectedModuleRevision);
    const key = moduleKey(moduleId);
    const currentRecord = await store.get(key);
    const current = normalizeModuleState(currentRecord, moduleId);
    if (current.revision !== expectedRevision) fail(MODULE_ERROR_CODES.REVISION_CONFLICT, { currentRevision: current.revision });
    const candidate = current.value.candidate;
    if (!candidate || candidate.packageHash !== packageHash) fail(MODULE_ERROR_CODES.CANDIDATE_MISMATCH);
    const next = { ...current.value, candidate: null };
    try {
      return publicModuleRecord(await store.compareAndSwap(key, { expectedRevision, value: next }));
    } catch (error) {
      mapRevisionConflict(error);
    }
  }

  async function listModules() {
    const rows = await store.list();
    const modules = [];
    for (const row of rows) {
      if (typeof row.key !== "string") fail(MODULE_ERROR_CODES.CORRUPT_STATE);
      if (!row.key.startsWith("module:")) continue;
      const id = assertModuleId(row.key.slice("module:".length));
      const normalized = normalizeModuleState(row, id);
      modules.push(Object.freeze({ moduleId: id, revision: normalized.revision, updatedAt: row.updatedAt, value: normalized.value }));
    }
    modules.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
    return Object.freeze(modules);
  }

  return Object.freeze({
    getModule,
    listModules,
    getPackage: readPackage,
    stageCandidate,
    stageStoredCandidate,
    approveCandidate,
    admitCandidate,
    markActivePackageKnownGood,
    rollbackAdmission,
    deactivateModule,
    listPackagesForModule,
    deletePackage,
    deleteModule,
    rejectCandidate
  });
}
