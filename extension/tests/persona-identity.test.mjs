import assert from "node:assert/strict";
import { normalizeState } from "../lib/storage.js";
import { inspectPersonaIdentities, resolvePersonaUid } from "../lib/persona-identity.js";

const UID_A = "10000000-0000-4000-8000-000000000001";
const UID_B = "10000000-0000-4000-8000-000000000002";
const UID_C = "10000000-0000-4000-8000-000000000003";
const UID_D = "10000000-0000-4000-8000-000000000004";

function sequence(...values) {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error("deterministic UID sequence exhausted");
    return values[index++];
  };
}

const schema2 = {
  schemaVersion: 2,
  global: {},
  profiles: {
    "firefox-container-1": { containerId: "firefox-container-1", managed: true, name: "Managed", routeId: "__block__" },
    compatibility: { containerId: "compatibility", managed: false, name: "Compatibility", routeId: "__block__" }
  },
  routes: {},
  scripts: {},
  workflows: {},
  wireguardImports: []
};
const migrated = normalizeState(schema2, { generatePersonaUid: sequence(UID_A) });
assert.equal(migrated.schemaVersion, 3);
assert.equal(migrated.profiles["firefox-container-1"].personaUid, UID_A);
assert.equal(migrated.profiles.compatibility.personaUid, null, "unmanaged compatibility records do not acquire an identity");

const stable = normalizeState(migrated, {
  generatePersonaUid: () => { throw new Error("stable identities must not be regenerated"); }
});
assert.equal(stable.profiles["firefox-container-1"].personaUid, UID_A);

const duplicateRaw = {
  schemaVersion: 3,
  global: {},
  profiles: {
    a: { containerId: "a", managed: true, personaUid: UID_A, routeId: "__block__" },
    b: { containerId: "b", managed: true, personaUid: UID_A, routeId: "__block__" },
    c: { containerId: "c", managed: true, personaUid: "corrupt", routeId: "__block__" },
    d: { containerId: "d", managed: false, personaUid: UID_A, routeId: "__block__" },
    e: { containerId: "e", managed: false, personaUid: UID_D, routeId: "__block__" }
  },
  routes: {},
  scripts: {},
  workflows: {},
  wireguardImports: []
};
const rawReport = inspectPersonaIdentities(duplicateRaw);
assert.equal(rawReport.ok, false);
assert.equal(rawReport.corrupt.includes("c"), true);
assert.deepEqual(rawReport.duplicates, [{ personaUid: UID_A, cookieStoreIds: ["a", "b"] }]);
assert.equal(resolvePersonaUid(duplicateRaw, UID_A).status, "duplicate");
assert.equal(resolvePersonaUid(duplicateRaw, "not-a-uuid").status, "corrupt");

const repaired = normalizeState(duplicateRaw, { generatePersonaUid: sequence(UID_B, UID_C) });
assert.equal(repaired.profiles.a.personaUid, UID_A, "the first deterministic managed owner keeps a valid UID");
assert.equal(repaired.profiles.b.personaUid, UID_B, "duplicate managed identity is remapped");
assert.equal(repaired.profiles.c.personaUid, UID_C, "corrupt managed identity is repaired");
assert.equal(repaired.profiles.d.personaUid, null, "managed identity wins over a duplicate unmanaged compatibility record");
assert.equal(repaired.profiles.e.personaUid, UID_D, "non-colliding unmanaged metadata is preserved without regeneration");
assert.equal(inspectPersonaIdentities(repaired).ok, true);
const resolved = resolvePersonaUid(repaired, UID_B);
assert.equal(resolved.status, "ok");
assert.equal(resolved.cookieStoreId, "b");
assert.equal(resolved.profile.containerId, "b");
assert.equal(resolvePersonaUid(repaired, "20000000-0000-4000-8000-000000000099").status, "missing");

console.log("persona identity migration and resolution tests passed");
