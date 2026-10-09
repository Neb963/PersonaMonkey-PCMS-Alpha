export const PERSONA_UID_MAX_LENGTH = 64;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizePersonaUid(value) {
  if (typeof value !== "string") return null;
  const uid = value.trim().toLowerCase();
  if (!uid || uid.length > PERSONA_UID_MAX_LENGTH || !UUID_PATTERN.test(uid)) return null;
  return uid;
}

export function isValidPersonaUid(value) {
  return normalizePersonaUid(value) !== null;
}

export function createPersonaUid(randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  if (typeof randomUUID !== "function") throw new Error("Persona UID generation is unavailable");
  const uid = normalizePersonaUid(randomUUID());
  if (!uid) throw new Error("Persona UID generator returned an invalid UUID");
  return uid;
}

export function allocatePersonaUid(usedValues = [], {
  generatePersonaUid = createPersonaUid,
  maxAttempts = 128
} = {}) {
  const used = usedValues instanceof Set ? usedValues : new Set(usedValues);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const uid = normalizePersonaUid(generatePersonaUid());
    if (!uid) throw new Error("Persona UID generator returned an invalid UUID");
    if (!used.has(uid)) return uid;
  }
  throw new Error("Unable to allocate a unique Persona UID");
}

/**
 * Repair identity in two passes so current managed Personas always take
 * precedence over compatibility records. Unmanaged records never receive a
 * new logical identity merely because state was normalized.
 */
export function repairPersonaUids(profiles = {}, { generatePersonaUid = createPersonaUid } = {}) {
  const used = new Set();
  const entries = Object.entries(profiles || {}).sort(([a], [b]) => a.localeCompare(b));

  const currentManaged = entries.filter(([, value]) => value?.managed !== false && !value?.rotationRole);
  const transitionalManaged = entries.filter(([, value]) => value?.managed !== false && value?.rotationRole);

  for (const [, profile] of currentManaged) {
    let uid = normalizePersonaUid(profile?.personaUid);
    if (!uid || used.has(uid)) uid = allocatePersonaUid(used, { generatePersonaUid });
    profile.personaUid = uid;
    used.add(uid);
  }

  // Rotation source/target records are persisted safety scaffolding, not a
  // second logical Persona. Never synthesize a UID for them during recovery.
  for (const [, profile] of transitionalManaged) profile.personaUid = null;

  for (const [, profile] of entries.filter(([, value]) => value?.managed === false)) {
    const uid = normalizePersonaUid(profile?.personaUid);
    profile.personaUid = uid && !used.has(uid) ? uid : null;
    if (profile.personaUid) used.add(profile.personaUid);
  }
  return profiles;
}

export function inspectPersonaIdentities(state = {}) {
  const missing = [];
  const corrupt = [];
  const byUid = new Map();
  for (const [cookieStoreId, profile] of Object.entries(state.profiles || {})) {
    if (profile?.managed === false || profile?.rotationRole) continue;
    const raw = profile?.personaUid;
    if (raw == null || String(raw).trim() === "") {
      missing.push(cookieStoreId);
      continue;
    }
    const uid = normalizePersonaUid(raw);
    if (!uid) {
      corrupt.push(cookieStoreId);
      continue;
    }
    const owners = byUid.get(uid) || [];
    owners.push(cookieStoreId);
    byUid.set(uid, owners);
  }
  const duplicates = [...byUid.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([personaUid, cookieStoreIds]) => ({ personaUid, cookieStoreIds }));
  return {
    ok: missing.length === 0 && corrupt.length === 0 && duplicates.length === 0,
    missing,
    corrupt,
    duplicates
  };
}

export function resolvePersonaUid(state = {}, value) {
  const personaUid = normalizePersonaUid(value);
  if (!personaUid) {
    return { status: "corrupt", personaUid: null, cookieStoreId: null, profile: null };
  }
  const matches = Object.values(state.profiles || {}).filter((profile) =>
    profile?.managed !== false && !profile?.rotationRole && normalizePersonaUid(profile?.personaUid) === personaUid);
  if (matches.length === 0) {
    return { status: "missing", personaUid, cookieStoreId: null, profile: null };
  }
  if (matches.length > 1) {
    return { status: "duplicate", personaUid, cookieStoreId: null, profile: null };
  }
  const profile = matches[0];
  if (typeof profile.containerId !== "string" || !profile.containerId) {
    return { status: "corrupt", personaUid, cookieStoreId: null, profile: null };
  }
  return { status: "ok", personaUid, cookieStoreId: profile.containerId, profile };
}
