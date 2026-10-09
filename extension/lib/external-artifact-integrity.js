import { normalizeScript } from "./storage.js";
import { parseUserscriptMetadata } from "./userscripts.js";

const SOURCE_METADATA_FIELDS = Object.freeze([
  "name", "namespace", "version", "description", "author", "homepageURL", "supportURL",
  "updateURL", "downloadURL", "icon", "matches", "hostScopeDeclared", "excludeMatches",
  "includes", "excludes", "runAt", "allFrames", "injectInto", "world", "grants", "requires", "sourceURL",
  "resources", "connects", "tags", "unwrap", "compatibility", "metaBlock"
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function isSourceSafe(parsed) {
  if (parsed.requires.length || parsed.updateURL || parsed.downloadURL || parsed.compatibility?.compatible !== true) return false;
  // Only data URLs are self-contained. Relative and protocol-relative resources
  // resolve against the active page and would make the artifact network-dependent.
  return Object.values(parsed.resources || {}).every((value) => /^data:/i.test(String(value).trim()));
}

export function validateExternalArtifactIdentity(script, label = "External userscript") {
  const artifact = script?.externalArtifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) ||
      typeof artifact.artifactId !== "string" || !artifact.artifactId.trim() || artifact.artifactId.length > 512 ||
      typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256) ||
      typeof artifact.ownerKey !== "string" || !/^[a-f0-9]{64}$/.test(artifact.ownerKey) ||
      (Object.hasOwn(artifact, "ownershipVerified") && typeof artifact.ownershipVerified !== "boolean") ||
      !artifact.provenance || typeof artifact.provenance !== "object" || Array.isArray(artifact.provenance) ||
      typeof artifact.provenance.packageId !== "string" || !artifact.provenance.packageId.trim() || artifact.provenance.packageId.length > 512 ||
      typeof artifact.provenance.packageVersion !== "string" || !artifact.provenance.packageVersion.trim() || artifact.provenance.packageVersion.length > 128 ||
      typeof artifact.provenance.component !== "string" || !artifact.provenance.component.trim() || artifact.provenance.component.length > 512 ||
      typeof artifact.installedAt !== "string" || !Number.isFinite(Date.parse(artifact.installedAt))) {
    throw new Error(`${label} identity metadata is invalid`);
  }
  if (script.autoRun !== false) throw new Error(`${label} must remain workflow-only`);
  if (typeof script.enabled !== "boolean") throw new Error(`${label} enabled state must be boolean`);
  return artifact;
}

export function externalArtifactIdentityKey(value) {
  const artifact = value?.externalArtifact || value;
  return JSON.stringify([
    artifact?.artifactId,
    String(artifact?.sha256 || "").toLowerCase(),
    artifact?.ownerKey,
    artifact?.provenance?.packageId,
    artifact?.provenance?.packageVersion,
    artifact?.provenance?.component
  ]);
}

export function externalArtifactMetadataMatchesSource(script, source = script?.code) {
  let artifact;
  try { artifact = validateExternalArtifactIdentity(script); }
  catch { return false; }
  if (typeof source !== "string") return false;

  const parsed = parseUserscriptMetadata(source, artifact.artifactId.slice(0, 200));
  if (!isSourceSafe(parsed)) return false;

  const id = String(script?.id || "");
  const expected = normalizeScript({
    ...parsed,
    id,
    code: source,
    enabled: script?.enabled,
    autoRun: false,
    profileIds: script?.profileIds,
    externalArtifact: script.externalArtifact
  }, id);
  const stored = normalizeScript({ ...script, code: source }, id);
  return SOURCE_METADATA_FIELDS.every((field) =>
    JSON.stringify(stable(stored[field])) === JSON.stringify(stable(expected[field]))
  );
}

export function assertExternalArtifactMetadataMatchesSource(script, source = script?.code) {
  if (!externalArtifactMetadataMatchesSource(script, source)) {
    const artifactId = script?.externalArtifact?.artifactId || "unknown";
    throw new Error(`External userscript ${artifactId} metadata does not match its safe source`);
  }
  return true;
}
