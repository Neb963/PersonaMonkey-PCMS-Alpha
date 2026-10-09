import { SCHEMA_VERSION } from "./constants.js";
import { paginatePcmsCollection } from "./pcms-pagination.js";
import {
  DEFAULT_PCMS_BATCH_CONCURRENCY,
  MAX_PCMS_BATCH_CONCURRENCY,
  MAX_PCMS_BATCH_PERSONAS,
  PCMS_ERROR_CODES,
  PCMS_PROTOCOL_VERSION,
  isPlainObject,
  makePcmsError,
  sanitizePcmsValue,
  toStructuredError,
  validateRequestEnvelope
} from "./pcms-protocol.js";

const isString = (value) => typeof value === "string" && value.trim().length > 0;
const MAX_PCMS_REPLAY_ENTRIES = 32;
const PCMS_REPLAY_TTL_MS = 5 * 60 * 1000;
// Object-key order is not part of a JSON payload's meaning, but array order is.
function replayPayload(value) {
  if (Array.isArray(value)) return `[${value.map(replayPayload).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${replayPayload(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const fields = (names) => Object.fromEntries(names.split(" ").filter(Boolean).map((name) => [name, "string"]));
const bools = (names) => Object.fromEntries(names.split(" ").filter(Boolean).map((name) => [name, "boolean"]));
const preconditionFields = { expectedRevision: "revision", expectedBootId: "bootId" };
const revisionField = preconditionFields;
const profileFields = {
  ...fields("name routeId notes description status createdAt updatedAt domainMode"),
  ...Object.fromEntries("suspendedRouteId expiresAt archivedAt archivedRouteId lastUsedAt".split(" ").map((name) => [name, "nullableString"])),
  ...bools("managed killSwitch blockLocalNetwork owned provisioned temporary"),
  allowedDomains: "strings", blockedDomains: "strings", scriptIds: "strings",
  provisionedSequence: "nullableNumber", statistics: { opens: "number", clones: "number" }
};
const createFields = {
  ...fields("name color icon description routeId expiresAt"),
  ...bools("temporary allowDirect"), ttlHours: "number", settings: profileFields, profile: profileFields
};
const cloneFields = {
  ...revisionField, ...fields("name color icon"),
  ...bools("allowDirect copyIdentity identity copySettings settings copyRoute route copyScripts userscripts copyWorkflows workflows copyCookies cookies copyStorage storage copySessionState history copyTabs openTabs copyName copyColor copyIcon")
};
const commandDescriptor = ({ params = {}, required = [], capability, mutating = false, batchable = false, destructive = false }) =>
  Object.freeze({ params: Object.freeze(params), required: Object.freeze([...required]), capability, mutating, batchable, destructive });

export const PCMS_COMMAND_DESCRIPTORS = Object.freeze({
  "system.describe": commandDescriptor({ capability: "system" }),
  "system.status": commandDescriptor({ capability: "diagnostics" }),
  "persona.list": commandDescriptor({ params: { options: { includeStorage: "boolean" }, page: "object" }, capability: "personas" }),
  "persona.get": commandDescriptor({ params: { profileId: "id", options: { includeStorage: "boolean" } }, required: ["profileId"], capability: "personas" }),
  "persona.create": commandDescriptor({ params: { ...createFields, input: createFields, options: { ...revisionField, allowDirect: "boolean" }, ...revisionField }, capability: "personas", mutating: true }),
  "persona.open": commandDescriptor({ params: { profileId: "id", url: "string", active: "boolean", ...preconditionFields }, required: ["profileId"], capability: "personas", mutating: true, batchable: true }),
  "persona.updateIdentity": commandDescriptor({ params: { profileId: "id", changes: { ...fields("name color icon description") }, options: revisionField, ...revisionField }, required: ["profileId", "changes"], capability: "personas", mutating: true }),
  "persona.clone": commandDescriptor({ params: { profileId: "id", options: cloneFields, ...revisionField }, required: ["profileId"], capability: "personas", mutating: true }),
  "persona.archive": commandDescriptor({ params: { profileId: "id", options: revisionField, ...revisionField }, required: ["profileId"], capability: "personas", mutating: true }),
  "persona.destroy": commandDescriptor({ params: { profileId: "id", options: revisionField, ...revisionField, confirm: "boolean" }, required: ["profileId"], capability: "personas", mutating: true, destructive: true }),
  "storage.inspect": commandDescriptor({ params: { profileId: "id" }, required: ["profileId"], capability: "persona-storage" }),
  "storage.clearCookies": commandDescriptor({ params: { profileId: "id", options: revisionField, ...revisionField, confirm: "boolean" }, required: ["profileId"], capability: "persona-storage", mutating: true, destructive: true }),
  "storage.clearSiteData": commandDescriptor({ params: { profileId: "id", options: revisionField, ...revisionField, confirm: "boolean" }, required: ["profileId"], capability: "persona-storage", mutating: true, destructive: true }),
  "storage.fullWipe": commandDescriptor({ params: { profileId: "id", options: revisionField, ...revisionField, confirm: "boolean" }, required: ["profileId"], capability: "persona-storage", mutating: true, destructive: true }),
  "route.list": commandDescriptor({ params: { options: { includeVirtual: "boolean" }, page: "object" }, capability: "routes" }),
  "route.get": commandDescriptor({ params: { routeId: "id" }, required: ["routeId"], capability: "routes" }),
  "route.assign": commandDescriptor({ params: { profileId: "id", routeId: "id", options: { ...revisionField, allowDirect: "boolean" }, ...revisionField }, required: ["profileId", "routeId"], capability: "routes", mutating: true, batchable: true }),
  "route.test": commandDescriptor({ params: { profileId: "id" }, required: ["profileId"], capability: "routes", batchable: true }),
  "userscript.list": commandDescriptor({ params: { page: "object" }, capability: "userscripts" }),
  "userscript.get": commandDescriptor({ params: { scriptId: "id" }, required: ["scriptId"], capability: "userscripts" }),
  "userscript.assign": commandDescriptor({ params: { scriptId: "id", profileId: "id", ...preconditionFields }, required: ["scriptId", "profileId"], capability: "userscripts", mutating: true }),
  "userscript.unassign": commandDescriptor({ params: { scriptId: "id", profileId: "id", ...preconditionFields }, required: ["scriptId", "profileId"], capability: "userscripts", mutating: true }),
  "workflow.list": commandDescriptor({ params: { page: "object" }, capability: "workflows" }),
  "workflow.get": commandDescriptor({ params: { workflowId: "id" }, required: ["workflowId"], capability: "workflows" }),
  "workflow.create": commandDescriptor({ params: { workflow: "object", ...preconditionFields }, required: ["workflow"], capability: "workflows", mutating: true }),
  "workflow.update": commandDescriptor({ params: { workflowId: "id", workflow: "object", ...preconditionFields }, required: ["workflowId", "workflow"], capability: "workflows", mutating: true }),
  "workflow.delete": commandDescriptor({ params: { workflowId: "id", confirm: "boolean", ...preconditionFields }, required: ["workflowId", "confirm"], capability: "workflows", mutating: true, destructive: true }),
  "workflow.run": commandDescriptor({ params: { workflowId: "id", ...preconditionFields }, required: ["workflowId"], capability: "workflows", mutating: true }),
  "workflow.jobs.list": commandDescriptor({ params: { options: {}, page: "object" }, capability: "workflow-jobs" }),
  "workflow.jobs.get": commandDescriptor({ params: { jobId: "id" }, required: ["jobId"], capability: "workflow-jobs" }),
  "workflow.jobs.stop": commandDescriptor({ params: { jobId: "id", ...preconditionFields }, required: ["jobId"], capability: "workflow-jobs", mutating: true }),
  "workflow.jobs.clearFinished": commandDescriptor({ params: { confirm: "boolean", ...preconditionFields }, capability: "workflow-jobs", mutating: true, destructive: true }),
  "batch.execute": commandDescriptor({ params: { command: "id", personaIds: "ids", params: "object", concurrency: "number", failurePolicy: "string", ...preconditionFields }, required: ["command", "personaIds"], capability: "batch", mutating: true })
});

export function listPcmsCommandDescriptors() {
  return Object.entries(PCMS_COMMAND_DESCRIPTORS).map(([command, descriptor]) => Object.freeze({ command, ...descriptor }));
}
function validateFields(value, schema, path) {
  if (!isPlainObject(value)) throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, `${path} must be an object`);
  for (const [key, child] of Object.entries(value)) {
    if (!Object.hasOwn(schema, key)) throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, `${path}.${key} is not supported`);
    const kind = schema[key];
    const valid = typeof kind === "object" ? isPlainObject(child)
      : kind === "id" ? isString(child) && child.length <= 256
      : kind === "ids" ? Array.isArray(child) && child.every((id) => isString(id) && id.length <= 256)
      : kind === "strings" ? Array.isArray(child) && child.every((item) => typeof item === "string")
      : kind === "revision" ? Number.isInteger(child) && child >= 0
      : kind === "bootId" ? isString(child) && child.length <= 256
      : kind === "nullableString" ? child === null || typeof child === "string"
      : kind === "nullableNumber" ? child === null || (typeof child === "number" && Number.isFinite(child))
      : kind === "object" ? isPlainObject(child)
      : typeof child === kind && (kind !== "number" || Number.isFinite(child));
    if (!valid) throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, `${path}.${key} has an invalid type`);
    if (typeof kind === "object") validateFields(child, kind, `${path}.${key}`);
  }
}
function validateCommandParams(command, params) {
  const descriptor = PCMS_COMMAND_DESCRIPTORS[command];
  validateFields(params, descriptor.params, "params");
  for (const key of descriptor.required) {
    if (!Object.hasOwn(params, key)) throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, `params.${key} is required`);
  }
  if (command === "persona.create" && Object.hasOwn(params, "input") && Object.keys(createFields).some((key) => Object.hasOwn(params, key))) {
    throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "persona.create cannot mix input with top-level identity fields");
  }
}
const asObject = (value, label) => {
  if (!isPlainObject(value)) throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, `${label} must be an object`);
  return value;
};
const optionalObject = (params, key) => {
  if (!Object.hasOwn(params, key)) return {};
  return asObject(params[key], key);
};
const asId = (value, label) => {
  if (!isString(value) || value.length > 256) throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, `${label} must be a non-empty identifier`);
  return value;
};
const asOptionalExpectedRevision = (params) => {
  if (params.expectedRevision == null) return undefined;
  if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 0) {
    throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "expectedRevision must be a non-negative integer");
  }
  return params.expectedRevision;
};
const asOptionalExpectedBootId = (params) => {
  if (params.expectedBootId == null) return undefined;
  if (!isString(params.expectedBootId) || params.expectedBootId.length > 256) {
    throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "expectedBootId must be a non-empty identifier");
  }
  return params.expectedBootId;
};

function facadeService(facade, name) { return facade?.[name] || null; }

function unavailable(capability) {
  throw makePcmsError(PCMS_ERROR_CODES.CAPABILITY_UNAVAILABLE, `${capability} is unavailable`);
}

function requireMethod(facade, serviceName, method) {
  const service = facadeService(facade, serviceName);
  if (typeof service?.[method] !== "function") unavailable(serviceName);
  return service[method].bind(service);
}

function optionsWithPrecondition(options, precondition = {}) {
  const out = { ...options };
  if (precondition.expectedRevision !== undefined) out.expectedRevision = precondition.expectedRevision;
  if (precondition.expectedBootId !== undefined) out.expectedBootId = precondition.expectedBootId;
  return out;
}

function noParams(params) {
  if (Object.keys(params).length) throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "This command does not accept parameters");
}

function personaCreateInput(params) {
  if (Object.hasOwn(params, "input")) return optionalObject(params, "input");
  const allowed = ["name", "color", "icon", "description", "routeId", "temporary", "ttlHours", "expiresAt", "allowDirect", "settings", "profile"];
  return Object.fromEntries(allowed.filter((key) => Object.hasOwn(params, key)).map((key) => [key, params[key]]));
}

function count(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.floor(number))) : 0;
}

function publicPersona(persona) {
  if (!isPlainObject(persona)) return null;
  const keys = ["id", "personaUid", "cookieStoreId", "name", "icon", "iconUrl", "color", "colorCode", "managed", "owned", "description",
    "createdAt", "lastUsedAt", "expiresAt", "archivedAt", "status", "statistics", "activeTabs", "cookies",
    "storage", "health", "protection"];
  const result = Object.fromEntries(keys.filter((key) => Object.hasOwn(persona, key)).map((key) => [key, persona[key]]));
  if (isPlainObject(result.health)) {
    const healthFields = ["status", "reason", "routeId", "routeName", "protected", "proxy", "dns", "exitIp", "exitCountry", "checkedAt", "ageMs"];
    result.health = Object.fromEntries(healthFields.filter((key) => Object.hasOwn(result.health, key)).map((key) => [key, result.health[key]]));
  }
  return result;
}

function publicUserscript(script) {
  if (!script) return null;
  return {
    id: String(script.id || ""),
    name: String(script.name || ""),
    namespace: String(script.namespace || ""),
    version: String(script.version || ""),
    enabled: script.enabled !== false,
    matches: Array.isArray(script.matches) ? script.matches : [],
    includeMatches: Array.isArray(script.includeMatches) ? script.includeMatches : [],
    excludeMatches: Array.isArray(script.excludeMatches) ? script.excludeMatches : [],
    excludes: Array.isArray(script.excludes) ? script.excludes : [],
    runAt: String(script.runAt || "document_idle"),
    world: String(script.world || "USER_SCRIPT"),
    grants: Array.isArray(script.grants) ? script.grants : [],
    connects: Array.isArray(script.connects) ? script.connects : [],
    compatibility: isPlainObject(script.compatibility) ? {
      compatible: script.compatibility.compatible === true,
      supported: Array.isArray(script.compatibility.supported) ? script.compatibility.supported : [],
      unsupported: Array.isArray(script.compatibility.unsupported) ? script.compatibility.unsupported : []
    } : { compatible: false, supported: [], unsupported: [] },
    assignedProfileIds: Array.isArray(script.assignedProfileIds) ? script.assignedProfileIds : []
  };
}

function publicWorkflow(workflow) {
  if (!workflow) return null;
  return {
    id: String(workflow.id || ""),
    name: String(workflow.name || ""),
    enabled: workflow.enabled !== false,
    createdAt: workflow.createdAt || null,
    updatedAt: workflow.updatedAt || null,
    steps: (Array.isArray(workflow.steps) ? workflow.steps : []).map((step, index) => ({
      id: String(step?.id || `step-${index + 1}`),
      profileId: String(step?.profileId || ""),
      urlCount: Array.isArray(step?.urls) ? step.urls.length : 0,
      scriptIds: Array.isArray(step?.scriptIds) ? step.scriptIds.map((id) => String(id)) : [],
      concurrency: count(step?.concurrency, 200),
      completion: step?.completion ? {
        mode: String(step.completion.mode || "load"),
        timeoutMs: count(step.completion.timeoutMs, 3_600_000)
      } : null,
      retries: count(step?.retries, 100),
      retryDelayMs: count(step?.retryDelayMs, 600_000),
      closeTabs: step?.closeTabs !== false,
      stopOnError: step?.stopOnError !== false
    }))
  };
}

function commandEvent(command, params, result) {
  const profileId = params.profileId || params.personaId || result?.profile?.containerId || result?.id || null;
  switch (command) {
    case "persona.clone": {
      const createdId = result?.profile?.containerId || result?.containerId || result?.id || null;
      return { type: "persona.changed", entity: "persona", entityId: createdId, data: { id: createdId, sourceProfileId: params.profileId } };
    }
    case "persona.create": case "persona.open": case "persona.updateIdentity": case "persona.archive":
      return { type: "persona.changed", entity: "persona", entityId: profileId, data: { id: profileId } };
    case "persona.destroy": return { type: "persona.removed", entity: "persona", entityId: profileId, data: { id: profileId } };
    case "storage.clearCookies": case "storage.clearSiteData":
      return { type: "persona.changed", entity: "persona", entityId: profileId, data: { storageChanged: true } };
    case "storage.fullWipe": {
      const currentId = result?.newCookieStoreId || result?.profile?.containerId || profileId;
      return {
        type: "persona.changed",
        entity: "persona",
        entityId: currentId,
        data: {
          id: currentId,
          previousProfileId: result?.oldCookieStoreId || profileId,
          personaUid: result?.personaUid || null,
          storageChanged: true
        }
      };
    }
    case "route.assign": return { type: "route.assignment.changed", entity: "persona", entityId: profileId, data: { routeId: params.routeId } };
    case "route.test": return { type: "route.test.completed", entity: "persona", entityId: profileId, data: result };
    case "userscript.assign": case "userscript.unassign":
      return {
        type: "userscript.assignment.changed",
        entity: "userscript",
        entityId: params.scriptId,
        data: { scriptId: params.scriptId, profileId: params.profileId, assigned: command === "userscript.assign" }
      };
    case "workflow.create": case "workflow.update":
      return { type: "workflow.changed", entity: "workflow", entityId: result?.id || params.workflowId || null, data: { id: result?.id || params.workflowId || null } };
    case "workflow.delete":
      return { type: "workflow.removed", entity: "workflow", entityId: params.workflowId, data: { id: params.workflowId } };
    case "workflow.run": return { type: "workflow.job.changed", entity: "workflow-job", entityId: result?.id || result?.job?.id || null, data: result };
    case "workflow.jobs.stop": return { type: "workflow.job.changed", entity: "workflow-job", entityId: params.jobId, data: result };
    default: return null;
  }
}

/**
 * Creates a command registry plus a dispatcher. The facade is injected so the
 * protocol remains a consumer of Persona OS rather than a Firefox API layer.
 */
export function createPcmsControlPlane({
  personaApi,
  stateManager,
  eventHub,
  getRevision = () => stateManager?.getRevision?.() ?? 0,
  bootId = eventHub?.bootId || "pcms-uninitialized",
  product = "PersonaMonkey Route Manager",
  productVersion = "1.2.0",
  personaApiVersion = "0.7",
  stateSchemaVersion = SCHEMA_VERSION,
  capabilities: capabilityOverrides,
  runWorkflowAdmission = null,
  mutationFence = async (_command, _params, operation) => operation(),
  replayNow = Date.now
} = {}) {
  if (!personaApi) throw new Error("PCMS control plane requires the Persona API facade");

  const registry = new Map();
  const replay = new Map();
  const pruneReplay = (now) => {
    for (const [requestId, entry] of replay) {
      // In-flight work cannot expire: a retry must join it even past the TTL.
      if (entry.completedAt !== null && now - entry.completedAt >= PCMS_REPLAY_TTL_MS) replay.delete(requestId);
    }
  };
  // Validation and discovery must share one descriptor so capability/shape metadata cannot drift.
  const add = (command, handler) => {
    const descriptor = PCMS_COMMAND_DESCRIPTORS[command];
    if (!descriptor) throw new Error(`Missing management command descriptor: ${command}`);
    const { capability, mutating, batchable, destructive } = descriptor;
    registry.set(command, Object.freeze({ command, capability, mutating, batchable, destructive, handler }));
  };
  const revision = async () => Number(await getRevision?.()) || 0;
  const pageList = async (rows, params, command) => paginatePcmsCollection(rows, {
    page: params.page, command, bootId, revision: await revision()
  });
  const directPrecondition = (params) => ({
    expectedRevision: asOptionalExpectedRevision(params),
    expectedBootId: asOptionalExpectedBootId(params)
  });
  const effectivePrecondition = (params) => {
    const nested = isPlainObject(params?.options) ? params.options : {};
    return {
      expectedRevision: params?.expectedRevision ?? nested.expectedRevision,
      expectedBootId: params?.expectedBootId ?? nested.expectedBootId
    };
  };
  const assertPrecondition = async (params) => {
    const expectation = effectivePrecondition(params);
    if (expectation.expectedRevision === undefined && expectation.expectedBootId === undefined) return;
    const actualRevision = await revision();
    const actualBootId = stateManager?.getBootId?.() || bootId;
    const revisionMismatch = expectation.expectedRevision !== undefined && expectation.expectedRevision !== actualRevision;
    const bootMismatch = expectation.expectedBootId !== undefined && expectation.expectedBootId !== actualBootId;
    if (revisionMismatch || bootMismatch) {
      throw makePcmsError(PCMS_ERROR_CODES.STATE_CONFLICT, "State revision conflict", {
        retryable: true,
        details: {
          expectedRevision: expectation.expectedRevision ?? null,
          actualRevision,
          expectedBootId: expectation.expectedBootId ?? null,
          actualBootId
        }
      });
    }
  };
  const emit = async (command, params, result) => {
    const event = commandEvent(command, params, result);
    if (event) eventHub?.emit({ ...event, revision: await revision() });
  };

  const availableCapabilities = () => {
    const available = ["batch", "events"];
    if (facadeService(personaApi, "PersonaManager")) available.push("personas");
    if (facadeService(personaApi, "StorageManager")) available.push("persona-storage");
    if (facadeService(personaApi, "RouteManager")) available.push("routes");
    if (facadeService(personaApi, "UserscriptManager")) available.push("userscripts");
    if (facadeService(personaApi, "WorkflowRunner")) {
      available.push("workflows");
      if (typeof facadeService(personaApi, "WorkflowRunner")?.listJobs === "function") available.push("workflow-jobs");
    }
    if (facadeService(personaApi, "Diagnostics")) available.push("diagnostics");
    return available;
  };

  const supportedCapabilities = () => {
    const available = availableCapabilities();
    const declaredCapabilities = Array.isArray(capabilityOverrides)
      ? capabilityOverrides
      : (Array.isArray(personaApi.pcmsCapabilities) ? personaApi.pcmsCapabilities : null);
    return declaredCapabilities ? available.filter((name) => declaredCapabilities.includes(name)) : available;
  };

  add("system.describe", async (params) => {
    noParams(params);
    return {
      product,
      productVersion,
      protocolVersion: PCMS_PROTOCOL_VERSION,
      personaApiVersion,
      stateSchemaVersion,
      bootId,
      revision: await revision(),
      capabilities: supportedCapabilities()
    };
  });
  add("system.status", async (params) => {
    noParams(params);
    const diagnostics = facadeService(personaApi, "Diagnostics");
    if (!diagnostics) unavailable("Diagnostics");
    if (typeof diagnostics.getSystemStatus === "function") return diagnostics.getSystemStatus();
    if (typeof diagnostics.getStatus === "function") return diagnostics.getStatus();
    unavailable("Diagnostics");
  });

  add("persona.list", async (params) => pageList(
    (await requireMethod(personaApi, "PersonaManager", "list")(optionalObject(params, "options"))).map(publicPersona), params, "persona.list"));
  add("persona.get", async (params) => {
    const result = await requireMethod(personaApi, "PersonaManager", "get")(asId(params.profileId, "profileId"), optionalObject(params, "options"));
    if (!result) throw makePcmsError(PCMS_ERROR_CODES.PERSONA_NOT_FOUND, "Managed persona not found");
    return publicPersona(result);
  });
  add("persona.create", async (params) =>
    requireMethod(personaApi, "PersonaManager", "create")(personaCreateInput(params), optionsWithPrecondition(optionalObject(params, "options"), directPrecondition(params))));
  add("persona.open", async (params) => {
    if (params.url != null && typeof params.url !== "string") throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "url must be a string");
    if (params.active != null && typeof params.active !== "boolean") throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "active must be a boolean");
    return requireMethod(personaApi, "PersonaManager", "open")(
      asId(params.profileId, "profileId"),
      params.url,
      params.active !== false,
      directPrecondition(params)
    );
  });
  add("persona.updateIdentity", async (params) =>
    requireMethod(personaApi, "PersonaManager", "updateIdentity")(asId(params.profileId, "profileId"), asObject(params.changes, "changes"), optionsWithPrecondition(optionalObject(params, "options"), directPrecondition(params))));
  add("persona.clone", async (params) =>
    requireMethod(personaApi, "PersonaManager", "clone")(asId(params.profileId, "profileId"), optionsWithPrecondition(optionalObject(params, "options"), directPrecondition(params))));
  add("persona.archive", async (params) =>
    requireMethod(personaApi, "PersonaManager", "archive")(asId(params.profileId, "profileId"), optionsWithPrecondition(optionalObject(params, "options"), directPrecondition(params))));
  add("persona.destroy", async (params) =>
    requireMethod(personaApi, "PersonaManager", "destroy")(asId(params.profileId, "profileId"), optionsWithPrecondition(optionalObject(params, "options"), directPrecondition(params))));

  add("storage.inspect", async (params) =>
    requireMethod(personaApi, "StorageManager", "inspect")(asId(params.profileId, "profileId")));
  add("storage.clearCookies", async (params) =>
    requireMethod(personaApi, "StorageManager", "clearCookies")(asId(params.profileId, "profileId"), optionsWithPrecondition(optionalObject(params, "options"), directPrecondition(params))));
  add("storage.clearSiteData", async (params) =>
    requireMethod(personaApi, "StorageManager", "clearSiteData")(asId(params.profileId, "profileId"), optionsWithPrecondition(optionalObject(params, "options"), directPrecondition(params))));
  add("storage.fullWipe", async (params) =>
    requireMethod(personaApi, "StorageManager", "fullWipe")(asId(params.profileId, "profileId"), optionsWithPrecondition(optionalObject(params, "options"), directPrecondition(params))));

  add("route.list", async (params) => pageList(
    await requireMethod(personaApi, "RouteManager", "list")(optionalObject(params, "options")), params, "route.list"));
  add("route.get", async (params) => {
    const result = await requireMethod(personaApi, "RouteManager", "get")(asId(params.routeId, "routeId"));
    if (!result) throw makePcmsError(PCMS_ERROR_CODES.ROUTE_NOT_FOUND, "Route not found");
    return result;
  });
  add("route.assign", async (params) =>
    requireMethod(personaApi, "RouteManager", "assign")(asId(params.profileId, "profileId"), asId(params.routeId, "routeId"), optionsWithPrecondition(optionalObject(params, "options"), directPrecondition(params))));
  add("route.test", async (params) =>
    requireMethod(personaApi, "RouteManager", "test")(asId(params.profileId, "profileId")));

  add("userscript.list", async (params) => {
    const scripts = await requireMethod(personaApi, "UserscriptManager", "list")();
    return pageList((Array.isArray(scripts) ? scripts : []).map(publicUserscript), params, "userscript.list");
  });
  add("userscript.get", async (params) => {
    const script = await requireMethod(personaApi, "UserscriptManager", "get")(asId(params.scriptId, "scriptId"));
    if (!script) throw makePcmsError(PCMS_ERROR_CODES.USERSCRIPT_NOT_FOUND, "Userscript not found");
    return publicUserscript(script);
  });
  add("userscript.assign", async (params) =>
    publicUserscript(await requireMethod(personaApi, "UserscriptManager", "assign")(
      asId(params.scriptId, "scriptId"),
      asId(params.profileId, "profileId"),
      directPrecondition(params)
    )));
  add("userscript.unassign", async (params) =>
    publicUserscript(await requireMethod(personaApi, "UserscriptManager", "unassign")(
      asId(params.scriptId, "scriptId"),
      asId(params.profileId, "profileId"),
      directPrecondition(params)
    )));

  add("workflow.list", async (params) => {
    const workflows = await requireMethod(personaApi, "WorkflowRunner", "list")();
    return pageList((Array.isArray(workflows) ? workflows : []).map(publicWorkflow), params, "workflow.list");
  });
  add("workflow.get", async (params) => {
    const result = await requireMethod(personaApi, "WorkflowRunner", "get")(asId(params.workflowId, "workflowId"));
    if (!result) throw makePcmsError(PCMS_ERROR_CODES.WORKFLOW_NOT_FOUND, "Workflow not found");
    return publicWorkflow(result);
  });
  add("workflow.create", async (params) =>
    publicWorkflow(await requireMethod(personaApi, "WorkflowRunner", "create")(
      asObject(params.workflow, "workflow"),
      directPrecondition(params)
    )));
  add("workflow.update", async (params) => {
      const workflowId = asId(params.workflowId, "workflowId");
      const input = asObject(params.workflow, "workflow");
      const existing = await requireMethod(personaApi, "WorkflowRunner", "get")(workflowId);
      if (!existing) throw makePcmsError(PCMS_ERROR_CODES.WORKFLOW_NOT_FOUND, "Workflow not found");
      const byStepId = new Map((existing.steps || []).map((step) => [step.id, step]));
      const steps = Array.isArray(input.steps) ? input.steps.map((step) => {
        if (!isPlainObject(step)) throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "Workflow step must be an object");
        const previous = byStepId.get(step.id);
        if (!Array.isArray(step.urls)) {
          // A management projection omits URL secrets; reuse the validated stored value only for the same step.
          if (!previous || (step.urlCount != null && step.urlCount !== previous.urls?.length)) {
            throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "Omitted step URLs require a matching existing step and URL count");
          }
        }
        const { urlCount, ...fields } = step;
        return { ...previous, ...fields, urls: Array.isArray(step.urls) ? step.urls : previous.urls,
          completion: step.completion === null ? null : { ...previous?.completion, ...step.completion } };
      }) : existing.steps;
      return publicWorkflow(await requireMethod(personaApi, "WorkflowRunner", "update")(
        workflowId, { ...existing, ...input, steps }, directPrecondition(params)));
  });
  add("workflow.delete", async (params) =>
    requireMethod(personaApi, "WorkflowRunner", "delete")(
      asId(params.workflowId, "workflowId"),
      directPrecondition(params)
    ));
  add("workflow.run", async (params) => {
    // Workflow starts must pass through PersonaMonkey's lease-aware admission
    // path. A missing callback fails closed instead of falling back to run().
    if (typeof runWorkflowAdmission !== "function") unavailable("Workflow run admission");
    return runWorkflowAdmission(asId(params.workflowId, "workflowId"));
  });
  add("workflow.jobs.list", async (params) => pageList(
    await requireMethod(personaApi, "WorkflowRunner", "listJobs")(optionalObject(params, "options")), params, "workflow.jobs.list"));
  add("workflow.jobs.get", async (params) => {
    const result = await requireMethod(personaApi, "WorkflowRunner", "getJob")(asId(params.jobId, "jobId"));
    if (!result) throw makePcmsError(PCMS_ERROR_CODES.JOB_NOT_FOUND, "Workflow job not found");
    return result;
  });
  add("workflow.jobs.stop", async (params) =>
    requireMethod(personaApi, "WorkflowRunner", "stopJob")(asId(params.jobId, "jobId")));
  add("workflow.jobs.clearFinished", async () =>
    requireMethod(personaApi, "WorkflowRunner", "clearFinishedJobs")());

  async function executeCommand(command, params, { batch = false } = {}) {
    const entry = registry.get(command);
    if (!entry) throw makePcmsError(PCMS_ERROR_CODES.UNKNOWN_COMMAND, "Unknown PCMS command");
    if (entry.capability !== "system" && !supportedCapabilities().includes(entry.capability)) unavailable(entry.capability);
    if (batch && !entry.batchable) throw makePcmsError(PCMS_ERROR_CODES.BATCH_COMMAND_NOT_ALLOWED, "This command is not allowed in a batch");
    validateCommandParams(command, params);
    if (entry.mutating) await assertPrecondition(params);
    if (entry.destructive && params.confirm !== true) {
      throw makePcmsError(PCMS_ERROR_CODES.DESTRUCTIVE_CONFIRMATION_REQUIRED, "This operation requires explicit confirmation");
    }
    const result = entry.mutating && command !== "workflow.run" && command !== "batch.execute"
      ? await mutationFence(command, params, () => entry.handler(params))
      : await entry.handler(params);
    await emit(command, params, result);
    return result;
  }

  async function executeBatch(params) {
    const command = asId(params.command, "command");
    const entry = registry.get(command);
    if (!entry || !entry.batchable || entry.destructive) {
      throw makePcmsError(PCMS_ERROR_CODES.BATCH_COMMAND_NOT_ALLOWED, "This command is not allowed in a batch");
    }
    if (!Array.isArray(params.personaIds) || !params.personaIds.length) {
      throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "personaIds must be a non-empty array");
    }
    const personaIds = [...new Set(params.personaIds.map((value) => asId(value, "personaId")))];
    if (personaIds.length > MAX_PCMS_BATCH_PERSONAS) {
      throw makePcmsError(PCMS_ERROR_CODES.BATCH_LIMIT_EXCEEDED, `A batch may contain at most ${MAX_PCMS_BATCH_PERSONAS} personas`);
    }
    const concurrency = params.concurrency == null ? DEFAULT_PCMS_BATCH_CONCURRENCY : Number(params.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_PCMS_BATCH_CONCURRENCY) {
      throw makePcmsError(PCMS_ERROR_CODES.BATCH_LIMIT_EXCEEDED, `Batch concurrency must be between 1 and ${MAX_PCMS_BATCH_CONCURRENCY}`);
    }
    const failurePolicy = params.failurePolicy || "continue";
    if (!new Set(["continue", "failFast"]).has(failurePolicy)) {
      throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "failurePolicy must be continue or failFast");
    }
    const sharedParams = optionalObject(params, "params");
    if (Object.hasOwn(sharedParams, "profileId")) {
      throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "Batch profileId comes from personaIds");
    }
    const nestedOptions = isPlainObject(sharedParams.options) ? sharedParams.options : {};
    if (Object.hasOwn(sharedParams, "expectedRevision") || Object.hasOwn(sharedParams, "expectedBootId") ||
        Object.hasOwn(nestedOptions, "expectedRevision") || Object.hasOwn(nestedOptions, "expectedBootId")) {
      throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "Batch preconditions belong on batch.execute");
    }
    validateCommandParams(command, { ...sharedParams, profileId: personaIds[0] });
    const rows = new Array(personaIds.length);
    let cursor = 0;
    let stopped = false;
    const worker = async () => {
      while (true) {
        if (stopped) return;
        const index = cursor++;
        if (index >= personaIds.length) return;
        const personaId = personaIds[index];
        const itemParams = { ...sharedParams, profileId: personaId };
        try {
          const result = await executeCommand(command, itemParams, { batch: true });
          try {
            rows[index] = { personaId, ok: true, result: sanitizePcmsValue(result, { maxBytes: 4096, maxDepth: 16, strict: true }) };
          } catch (error) {
            // The handler returned successfully; make that side effect observable even when its projection is too large.
            rows[index] = { personaId, ok: false, applied: true, error: toStructuredError(error) };
          }
        } catch (error) {
          rows[index] = { personaId, ok: false, applied: false, error: toStructuredError(error) };
          if (failurePolicy === "failFast") stopped = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, personaIds.length) }, worker));
    for (let index = 0; index < rows.length; index += 1) {
      if (!rows[index]) rows[index] = {
        personaId: personaIds[index], ok: false,
        error: { code: PCMS_ERROR_CODES.BATCH_CANCELLED, message: "Batch item was not started after an earlier failure", retryable: false, details: null }
      };
    }
    const result = { command, results: rows };
    eventHub?.emit({ type: "pcms.batch.completed", entity: "batch", entityId: null, data: { command, total: rows.length, failed: rows.filter((row) => !row.ok).length }, revision: await revision() });
    return result;
  }
  add("batch.execute", executeBatch);

  async function handleRequest(rawRequest) {
    let requestId = isPlainObject(rawRequest) && typeof rawRequest.requestId === "string" ? rawRequest.requestId : null;
    try {
      const request = validateRequestEnvelope(rawRequest);
      requestId = request.requestId;
      const now = replayNow();
      pruneReplay(now);
      const respond = async () => {
        try {
          const result = await executeCommand(request.command, request.params);
          return { version: PCMS_PROTOCOL_VERSION, requestId, ok: true, bootId, revision: await revision(),
            result: sanitizePcmsValue(result, { maxBytes: request.command === "batch.execute" ? 2 * 1024 * 1024 : 256 * 1024, maxDepth: 16, strict: true }) };
        } catch (error) {
          return { version: PCMS_PROTOCOL_VERSION, requestId, ok: false, bootId, revision: await revision(), error: toStructuredError(error) };
        }
      };
      if (!registry.get(request.command)?.mutating) return await respond();

      const payload = replayPayload([request.command, request.params]);
      const previous = replay.get(requestId);
      if (previous) {
        if (previous.payload !== payload) {
          throw makePcmsError(PCMS_ERROR_CODES.REQUEST_ID_CONFLICT, "requestId was already used for another mutation");
        }
        return await previous.response;
      }
      // Refuse admission rather than evicting live IDs: early eviction could
      // execute a destructive retry twice within the promised replay window.
      if (replay.size >= MAX_PCMS_REPLAY_ENTRIES) {
        throw makePcmsError(PCMS_ERROR_CODES.REPLAY_CAPACITY, "Mutation replay capacity is exhausted", { retryable: true });
      }
      const entry = { payload, response: null, completedAt: null };
      replay.set(requestId, entry);
      entry.response = Promise.resolve().then(respond).then((response) => {
        entry.completedAt = replayNow();
        return response;
      });
      return await entry.response;
    } catch (error) {
      return { version: PCMS_PROTOCOL_VERSION, requestId, ok: false, bootId, revision: await revision(), error: toStructuredError(error) };
    }
  }

  return Object.freeze({
    bootId,
    handleRequest,
    executeCommand,
    getCommand: (command) => registry.get(command) || null,
    listCommands: () => [...registry.values()].map(({ handler, ...metadata }) => metadata)
  });
}
