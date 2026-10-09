import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID, MAX_WORKFLOW_STEP_TIMEOUT_MS } from "./constants.js";
import { normalizeScript, normalizeWorkflow } from "./storage.js";
import { analyzeGrants, makeScriptId, parseUserscriptMetadata, shouldUseMainWorld } from "./userscripts.js";
import { MAX_WORKFLOW_TASKS, validateWorkflowForRun } from "./workflow-model.js";
import { WORKFLOW_PACKAGE_LIMITS } from "./package-limits.js";
import { createStoredZip, decodeZipText, readZip } from "./zip.js";

export const WORKFLOW_PACKAGE_FORMAT = "personamonkey.workflow-package";
export const WORKFLOW_PACKAGE_VERSION = 1;

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const FILE_PATTERN = /^userscripts\/(?!(?:\.{1,2}\/|.*\/\.{1,2}\/))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.user\.js$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROUTE_REQUIREMENTS = ["any", "networked", "protected", "direct"];
const COMPLETION_MODES = ["load", "delay", "selector", "signal"];

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function slug(value, fallback = "item") {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function routeRequirementForProfile(profile, state) {
  if (!profile || profile.routeId === BLOCK_ROUTE_ID) return "networked";
  if (profile.routeId === DIRECT_ROUTE_ID) return "direct";
  return state.routes?.[profile.routeId] ? "protected" : "networked";
}

export function personaMatchesRequirement(profile, state, requirement = "any") {
  if (!profile?.managed) return false;
  if (profile.routeId === BLOCK_ROUTE_ID) return false;
  if (requirement === "direct") return profile.routeId === DIRECT_ROUTE_ID;
  if (requirement === "protected") return Boolean(profile.routeId && profile.routeId !== DIRECT_ROUTE_ID && state.routes?.[profile.routeId]?.enabled !== false && state.routes?.[profile.routeId]);
  if (requirement === "any" || requirement === "networked") return profile.routeId === DIRECT_ROUTE_ID || Boolean(state.routes?.[profile.routeId]?.enabled !== false && state.routes?.[profile.routeId]);
  return false;
}

function normalizePackageCompletion(value = {}) {
  const mode = ["load", "delay", "selector", "signal"].includes(value.mode) ? value.mode : "load";
  const timeoutMs = Math.max(1000, Math.min(MAX_WORKFLOW_STEP_TIMEOUT_MS, Number(value.timeoutMs) || 60000));
  return { mode, value: String(value.value || "").slice(0, 4096), timeoutMs };
}

export function validateWorkflowPackageManifest(manifest = {}, files = new Map()) {
  const errors = [];
  const object = (value, path, required, allowed) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
      return false;
    }
    for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${path}.${key} is not allowed`);
    return true;
  };
  const string = (value, path, min, max, pattern) => {
    if (typeof value !== "string" || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
      errors.push(`${path} must be a string of ${min}–${max} characters${pattern ? " in the required format" : ""}`);
      return false;
    }
    return true;
  };
  const optionalString = (value, path, max, pattern) => {
    if (value !== undefined) string(value, path, 0, max, pattern);
  };
  const integer = (value, path, min, max) => {
    if (!Number.isInteger(value) || value < min || value > max) errors.push(`${path} must be an integer between ${min} and ${max}`);
  };
  const optionalBoolean = (value, path) => {
    if (value !== undefined && typeof value !== "boolean") errors.push(`${path} must be a boolean`);
  };
  const array = (value, path, min, max) => {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return [];
    }
    if (value.length < min || value.length > max) errors.push(`${path} must contain ${min}–${max} items`);
    return value;
  };

  if (!object(manifest, "manifest", ["format", "formatVersion", "package", "personas", "scripts", "workflow"], ["format", "formatVersion", "package", "personas", "scripts", "workflow"])) return errors;
  if (manifest.format !== WORKFLOW_PACKAGE_FORMAT) errors.push(`format must be ${WORKFLOW_PACKAGE_FORMAT}`);
  if (manifest.formatVersion !== WORKFLOW_PACKAGE_VERSION) errors.push(`formatVersion must be ${WORKFLOW_PACKAGE_VERSION}`);
  if (object(manifest.package, "package", ["id", "name"], ["id", "name", "description", "author", "createdAt"])) {
    string(manifest.package.id, "package.id", 1, 200, KEY_PATTERN);
    string(manifest.package.name, "package.name", 1, 200);
    optionalString(manifest.package.description, "package.description", 4000);
    optionalString(manifest.package.author, "package.author", 500);
    optionalString(manifest.package.createdAt, "package.createdAt", 100);
  }

  const personas = array(manifest.personas, "personas", 0, 50);
  const personaKeys = new Set();
  for (const [index, persona] of personas.entries()) {
    const path = `personas[${index}]`;
    if (!object(persona, path, ["key", "label"], ["key", "label", "description", "routeRequirement", "sourceHint"])) continue;
    if (string(persona.key, `${path}.key`, 1, 100, KEY_PATTERN)) {
      if (personaKeys.has(persona.key)) errors.push(`${path}.key is a duplicate persona key: ${persona.key}`);
      personaKeys.add(persona.key);
    }
    string(persona.label, `${path}.label`, 1, 200);
    optionalString(persona.description, `${path}.description`, 2000);
    if (persona.routeRequirement !== undefined && !ROUTE_REQUIREMENTS.includes(persona.routeRequirement)) errors.push(`${path}.routeRequirement is invalid`);
    if (persona.sourceHint !== undefined && object(persona.sourceHint, `${path}.sourceHint`, [], ["profileName", "routeName", "routeProvider"])) {
      optionalString(persona.sourceHint.profileName, `${path}.sourceHint.profileName`, 200);
      optionalString(persona.sourceHint.routeName, `${path}.sourceHint.routeName`, 200);
      optionalString(persona.sourceHint.routeProvider, `${path}.sourceHint.routeProvider`, 100);
    }
  }

  const scripts = array(manifest.scripts, "scripts", 0, 100);
  const scriptKeys = new Set();
  for (const [index, script] of scripts.entries()) {
    const path = `scripts[${index}]`;
    if (!object(script, path, ["key", "file", "name"], ["key", "file", "name", "sha256"])) continue;
    if (string(script.key, `${path}.key`, 1, 100, KEY_PATTERN)) {
      if (scriptKeys.has(script.key)) errors.push(`${path}.key is a duplicate script key: ${script.key}`);
      scriptKeys.add(script.key);
    }
    if (string(script.file, `${path}.file`, 1, 500, FILE_PATTERN)) {
      if (files.size && !files.has(script.file)) errors.push(`userscript file is missing: ${script.file}`);
    }
    string(script.name, `${path}.name`, 1, 200);
    if (script.sha256 !== undefined && (typeof script.sha256 !== "string" || !SHA256_PATTERN.test(script.sha256))) errors.push(`${path}.sha256 must be lowercase hexadecimal SHA-256`);
  }

  const workflow = manifest.workflow;
  if (object(workflow, "workflow", ["name", "steps"], ["name", "description", "enabled", "steps"])) {
    string(workflow.name, "workflow.name", 1, 200);
    optionalString(workflow.description, "workflow.description", 4000);
    optionalBoolean(workflow.enabled, "workflow.enabled");
    const steps = array(workflow.steps, "workflow.steps", 1, 200);
    for (const [index, step] of steps.entries()) {
      const path = `workflow.steps[${index}]`;
      if (!object(step, path, ["personaKey", "urls"], ["id", "personaKey", "urls", "concurrency", "scriptKeys", "completion", "retries", "retryDelayMs", "closeTabs", "stopOnError"])) continue;
      optionalString(step.id, `${path}.id`, 100);
      string(step.personaKey, `${path}.personaKey`, 1, 100);
      if (!personaKeys.has(step.personaKey)) errors.push(`${path}.personaKey is unknown`);
      const urls = array(step.urls, `${path}.urls`, 1, 10000);
      for (const [urlIndex, raw] of urls.entries()) {
        if (!string(raw, `${path}.urls[${urlIndex}]`, 1, 4096)) continue;
        try {
          const url = new URL(raw);
          if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad protocol");
        } catch { errors.push(`${path}.urls[${urlIndex}] must be a valid http/https URL`); }
      }
      if (step.concurrency !== undefined) integer(step.concurrency, `${path}.concurrency`, 1, 200);
      if (step.scriptKeys !== undefined) {
        const keys = array(step.scriptKeys, `${path}.scriptKeys`, 0, 100);
        const seen = new Set();
        for (const [keyIndex, scriptKey] of keys.entries()) {
          string(scriptKey, `${path}.scriptKeys[${keyIndex}]`, 1, 100);
          if (seen.has(scriptKey)) errors.push(`${path}.scriptKeys[${keyIndex}] is a duplicate scriptKey`);
          seen.add(scriptKey);
          if (!scriptKeys.has(scriptKey)) errors.push(`${path}.scriptKeys[${keyIndex}] is an unknown scriptKey: ${scriptKey}`);
        }
      }
      if (step.completion !== undefined && object(step.completion, `${path}.completion`, [], ["mode", "value", "timeoutMs"])) {
        if (step.completion.mode !== undefined && !COMPLETION_MODES.includes(step.completion.mode)) errors.push(`${path}.completion.mode is invalid`);
        optionalString(step.completion.value, `${path}.completion.value`, 4096);
        if (step.completion.timeoutMs !== undefined) integer(step.completion.timeoutMs, `${path}.completion.timeoutMs`, 1000, MAX_WORKFLOW_STEP_TIMEOUT_MS);
      }
      const completion = step.completion;
      if (completion?.mode === "delay") {
        const rawDelay = completion.value || "1000";
        const delay = Number(rawDelay);
        if (!Number.isFinite(delay) || delay < 0 || delay > 600000) errors.push(`${path}.completion.value: delay must be between 0 and 600000 ms`);
      }
      if (completion?.mode === "selector" && !(typeof completion.value === "string" && completion.value.trim())) errors.push(`${path}.completion.value: selector completion requires a CSS selector`);
      if (completion?.mode === "signal" && !step.scriptKeys?.length) errors.push(`${path}.scriptKeys: signal completion requires at least one userscript`);
      if (step.retries !== undefined) integer(step.retries, `${path}.retries`, 0, 10);
      if (step.retryDelayMs !== undefined) integer(step.retryDelayMs, `${path}.retryDelayMs`, 0, 600000);
      optionalBoolean(step.closeTabs, `${path}.closeTabs`);
      optionalBoolean(step.stopOnError, `${path}.stopOnError`);
    }
  }
  const taskCount = (Array.isArray(workflow?.steps) ? workflow.steps : []).reduce((count, step) => count + new Set(
    (Array.isArray(step?.urls) ? step.urls : []).map((url) => String(url || "").trim()).filter(Boolean)
  ).size, 0);
  if (taskCount > MAX_WORKFLOW_TASKS) errors.push(`workflow.steps contains ${taskCount} URL tasks; maximum is ${MAX_WORKFLOW_TASKS}`);
  return errors;
}

export async function exportWorkflowPackage(workflow, state) {
  if (!workflow?.steps?.length) throw new Error("Workflow has no steps to export");
  validateWorkflowForRun({ ...workflow, enabled: true }, state);
  const personaIds = [...new Set(workflow.steps.map((step) => step.profileId).filter(Boolean))];
  const personaKeyById = new Map();
  const personas = personaIds.map((profileId, index) => {
    const profile = state.profiles?.[profileId];
    if (!profile?.managed) throw new Error(`Cannot export: managed persona not found for ${profileId}`);
    const key = `persona-${index + 1}`;
    personaKeyById.set(profileId, key);
    const route = state.routes?.[profile.routeId];
    return {
      key,
      label: profile.name || `Persona ${index + 1}`,
      description: "Map this slot to a managed PersonaMonkey persona during import.",
      routeRequirement: routeRequirementForProfile(profile, state),
      sourceHint: {
        profileName: profile.name || "",
        routeName: profile.routeId === DIRECT_ROUTE_ID ? "DIRECT" : profile.routeId === BLOCK_ROUTE_ID ? "BLOCK" : (route?.name || ""),
        routeProvider: route?.provider || (profile.routeId === DIRECT_ROUTE_ID ? "direct" : profile.routeId === BLOCK_ROUTE_ID ? "block" : "")
      }
    };
  });

  const usedScriptIds = [...new Set(workflow.steps.flatMap((step) => step.scriptIds || []))];
  const scriptKeyById = new Map();
  const scripts = [];
  const zipEntries = [];
  for (const [index, scriptId] of usedScriptIds.entries()) {
    const script = state.scripts?.[scriptId];
    if (!script?.code) throw new Error(`Cannot export: userscript ${scriptId} is missing`);
    const key = `script-${index + 1}`;
    const file = `userscripts/${slug(script.name, key)}-${index + 1}.user.js`;
    const codeBytes = new TextEncoder().encode(script.code);
    scriptKeyById.set(scriptId, key);
    scripts.push({ key, file, name: script.name || key, sha256: await sha256Hex(codeBytes) });
    zipEntries.push({ name: file, data: codeBytes });
  }

  const manifest = {
    format: WORKFLOW_PACKAGE_FORMAT,
    formatVersion: WORKFLOW_PACKAGE_VERSION,
    package: {
      id: `${slug(workflow.name, "workflow")}-${crypto.randomUUID().slice(0, 8)}`,
      name: workflow.name,
      description: "Exported from PersonaMonkey Route Manager",
      createdAt: new Date().toISOString()
    },
    personas,
    scripts,
    workflow: {
      name: workflow.name,
      enabled: workflow.enabled !== false,
      steps: workflow.steps.map((step, index) => ({
        id: `step-${index + 1}`,
        personaKey: personaKeyById.get(step.profileId),
        urls: [...(step.urls || [])],
        concurrency: step.concurrency || 1,
        scriptKeys: (step.scriptIds || []).map((scriptId) => scriptKeyById.get(scriptId)).filter(Boolean),
        completion: normalizePackageCompletion(step.completion),
        retries: Number(step.retries || 0),
        retryDelayMs: Number(step.retryDelayMs ?? 1000),
        closeTabs: step.closeTabs !== false,
        stopOnError: step.stopOnError !== false
      }))
    }
  };
  const errors = validateWorkflowPackageManifest(manifest, new Map(zipEntries.map((entry) => [entry.name, entry.data])));
  if (errors.length) throw new Error(`Cannot export workflow package: ${errors.join("; ")}`);
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const bytes = createStoredZip([{ name: "manifest.json", data: manifestBytes }, ...zipEntries], WORKFLOW_PACKAGE_LIMITS);
  return { manifest, bytes, filename: `${slug(workflow.name, "workflow")}.personamonkey.zip` };
}

function candidateBindingsForPersona(persona, state) {
  const profiles = Object.values(state.profiles || {}).filter((profile) => profile?.managed && personaMatchesRequirement(profile, state, persona.routeRequirement || "any"));
  const hint = String(persona?.sourceHint?.profileName || persona?.label || "").toLowerCase();
  profiles.sort((a, b) => {
    const aExact = String(a.name || "").toLowerCase() === hint ? 0 : 1;
    const bExact = String(b.name || "").toLowerCase() === hint ? 0 : 1;
    return aExact - bExact || String(a.name).localeCompare(String(b.name));
  });
  return profiles.map((profile) => ({ id: profile.containerId, name: profile.name, routeId: profile.routeId }));
}

export async function inspectWorkflowPackage(input, state) {
  const files = await readZip(input, WORKFLOW_PACKAGE_LIMITS);
  if (!files.has("manifest.json")) throw new Error("Workflow package is missing manifest.json");
  let manifest;
  try { manifest = JSON.parse(decodeZipText(files.get("manifest.json"))); }
  catch (error) { throw new Error(`Invalid manifest.json: ${error.message || error}`); }
  const structuralErrors = validateWorkflowPackageManifest(manifest, files);
  if (structuralErrors.length) throw new Error(`Invalid workflow package: ${structuralErrors.join("; ")}`);

  const scriptDetails = [];
  for (const scriptEntry of manifest.scripts || []) {
    const bytes = files.get(scriptEntry.file);
    if (scriptEntry.sha256) {
      const actual = await sha256Hex(bytes);
      if (actual !== scriptEntry.sha256) throw new Error(`SHA-256 mismatch for ${scriptEntry.file}`);
    }
    const code = decodeZipText(bytes);
    const metadata = parseUserscriptMetadata(code, scriptEntry.name || scriptEntry.key);
    const compatibility = analyzeGrants(metadata.grants || []);
    if (!compatibility.compatible) throw new Error(`${metadata.name}: unsupported grants: ${compatibility.unsupported.join(", ")}`);
    const identical = Object.values(state.scripts || {}).find((script) => script?.code === code);
    scriptDetails.push({ key: scriptEntry.key, file: scriptEntry.file, code, metadata, compatibility, reuseScriptId: identical?.id || null });
  }

  const metadataByKey = new Map(scriptDetails.map(({ key, metadata }) => [key, metadata]));
  for (const [index, step] of manifest.workflow.steps.entries()) {
    if (step.completion?.mode !== "signal") continue;
    for (const key of step.scriptKeys || []) {
      const metadata = metadataByKey.get(key);
      if (!metadata?.grants?.includes("Persona.signal")) {
        throw new Error(`Step ${index + 1}: signal userscript ${key} must declare @grant Persona.signal`);
      }
      if (shouldUseMainWorld(metadata)) {
        throw new Error(`Step ${index + 1}: signal userscript ${key} runs in MAIN; set @inject-into content or select a USER_SCRIPT-world userscript`);
      }
    }
  }

  const personas = (manifest.personas || []).map((persona) => {
    const candidates = candidateBindingsForPersona(persona, state);
    const exact = candidates.find((candidate) => String(candidate.name || "").toLowerCase() === String(persona?.sourceHint?.profileName || persona.label || "").toLowerCase());
    return { ...persona, candidates, suggestedProfileId: exact?.id || (candidates.length === 1 ? candidates[0].id : "") };
  });
  return { manifest, files, personas, scripts: scriptDetails };
}

function uniqueScriptId(name, scripts) {
  let id;
  do { id = makeScriptId(name); } while (scripts[id]);
  return id;
}

function uniqueWorkflowId(workflows) {
  let id;
  do { id = `workflow-${crypto.randomUUID().slice(0, 8)}`; } while (workflows[id]);
  return id;
}

export function importWorkflowPackage(preview, state, personaBindings = {}) {
  const next = clone(state);
  const manifest = preview?.manifest;
  const errors = validateWorkflowPackageManifest(manifest, preview?.files || new Map());
  if (errors.length) throw new Error(`Invalid workflow package: ${errors.join("; ")}`);

  const profileByPersonaKey = new Map();
  for (const persona of manifest.personas || []) {
    const profileId = String(personaBindings[persona.key] || "");
    const profile = next.profiles?.[profileId];
    if (!profile?.managed) throw new Error(`${persona.label}: choose a managed persona`);
    if (!personaMatchesRequirement(profile, next, persona.routeRequirement || "any")) throw new Error(`${persona.label}: selected persona does not satisfy ${persona.routeRequirement || "any"} routing requirement`);
    profileByPersonaKey.set(persona.key, profileId);
  }

  const scriptIdByKey = new Map();
  const importedScripts = [];
  const reusedScripts = [];
  const scriptDetailByKey = new Map((preview.scripts || []).map((detail) => [detail.key, detail]));
  for (const scriptEntry of manifest.scripts || []) {
    const detail = scriptDetailByKey.get(scriptEntry.key);
    if (!detail) throw new Error(`Missing inspected userscript: ${scriptEntry.key}`);
    const referencedPersonaIds = [...new Set((manifest.workflow.steps || [])
      .filter((step) => (step.scriptKeys || []).includes(scriptEntry.key))
      .map((step) => profileByPersonaKey.get(step.personaKey))
      .filter(Boolean))];
    let localId = detail.reuseScriptId && next.scripts?.[detail.reuseScriptId]?.code === detail.code ? detail.reuseScriptId : null;
    if (localId) {
      const existing = next.scripts[localId];
      next.scripts[localId] = normalizeScript({ ...existing, profileIds: [...new Set([...(existing.profileIds || []), ...referencedPersonaIds])] }, localId);
      reusedScripts.push(localId);
    } else {
      localId = uniqueScriptId(detail.metadata.name || scriptEntry.name || scriptEntry.key, next.scripts || {});
      next.scripts[localId] = normalizeScript({
        id: localId,
        ...detail.metadata,
        code: detail.code,
        enabled: true,
        autoRun: true,
        profileIds: referencedPersonaIds,
        compatibility: detail.compatibility,
        sourceURL: "personamonkey-workflow-package"
      }, localId);
      importedScripts.push(localId);
    }
    scriptIdByKey.set(scriptEntry.key, localId);
  }

  const workflowId = uniqueWorkflowId(next.workflows || {});
  const workflow = normalizeWorkflow({
    id: workflowId,
    name: manifest.workflow.name,
    enabled: manifest.workflow.enabled !== false,
    steps: (manifest.workflow.steps || []).map((step, index) => ({
      id: `step-${crypto.randomUUID().slice(0, 8)}`,
      profileId: profileByPersonaKey.get(step.personaKey) || "",
      urls: [...(step.urls || [])],
      concurrency: Number(step.concurrency || 1),
      scriptIds: (step.scriptKeys || []).map((key) => scriptIdByKey.get(key)).filter(Boolean),
      completion: normalizePackageCompletion(step.completion),
      retries: Number(step.retries || 0),
      retryDelayMs: Number(step.retryDelayMs ?? 1000),
      closeTabs: step.closeTabs !== false,
      stopOnError: step.stopOnError !== false
    }))
  }, workflowId);
  // A disabled package may be imported for later activation, but its mapped
  // steps must still satisfy the same run contract before entering storage.
  validateWorkflowForRun({ ...workflow, enabled: true }, next);
  next.workflows ||= {};
  next.workflows[workflowId] = workflow;
  return { state: next, workflow, importedScripts, reusedScripts };
}
