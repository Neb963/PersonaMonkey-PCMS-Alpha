import { DIRECT_ROUTE_ID, MAX_WORKFLOW_STEP_TIMEOUT_MS } from "./constants.js";
import { normalizePersonaUid } from "./persona-identity.js";

export const INTEGRATION_PROTOCOL_VERSION = 1;
export const INTEGRATION_REQUEST_TYPE = "PERSONAMONKEY_INTEGRATION_REQUEST";
export const INTEGRATION_EVENTS_PORT = "PERSONAMONKEY_INTEGRATION_EVENTS";
// A valid workflow may contain 500 HTTP(S) URLs of up to 4096 characters.
export const MAX_INTEGRATION_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_INTEGRATION_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_INTEGRATION_EVENT_BYTES = 32 * 1024;
export const MAX_INTEGRATION_ERROR_BYTES = 4 * 1024;
export const MAX_INTEGRATION_ID_LENGTH = 256;
export const MAX_TRUSTED_EXTENSION_IDS = 16;
export const EXTERNAL_AUTOMATION_LIMITS = Object.freeze({
  maxExternalExecutions: 8,
  maxInputBytes: 4 * 1024 * 1024,
  maxInputChunkBytes: 256 * 1024,
  maxPendingInputs: 8,
  maxPendingSecrets: 8,
  maxInputWaiters: 32,
  maxInputBytesPerSender: 8 * 1024 * 1024,
  maxInputTTL: 10 * 60_000,
  maxSecretBytes: 16 * 1024,
  maxSecretBytesPerSender: 64 * 1024,
  maxContinuationInputBytes: 8 * 1024,
  maxSecretTTL: 5 * 60_000,
  maxExecutionResultBytes: 64 * 1024,
  maxStructuredFailureBytes: 16 * 1024,
  maxControlLeaseTTL: 5 * 60_000,
  controlLeaseRenewalWindow: 60_000,
  maxControlLeases: 128,
  maxControlLeasesPerSender: 16,
  maxExternalArtifacts: 128,
  maxExternalArtifactsPerSender: 16,
  maxExternalArtifactBytes: 128 * 1024 * 1024,
  maxExternalArtifactBytesPerSender: 16 * 1024 * 1024
});

export const INTEGRATION_ERROR_CODES = Object.freeze({
  DISABLED: "INTEGRATION_DISABLED",
  UNAUTHORIZED: "INTEGRATION_UNAUTHORIZED",
  PROTOCOL_UNSUPPORTED: "INTEGRATION_PROTOCOL_UNSUPPORTED",
  BAD_REQUEST: "INTEGRATION_BAD_REQUEST",
  VALIDATION_FAILED: "INTEGRATION_VALIDATION_FAILED",
  UNKNOWN_COMMAND: "INTEGRATION_UNKNOWN_COMMAND",
  CAPABILITY_UNAVAILABLE: "INTEGRATION_CAPABILITY_UNAVAILABLE",
  STATE_CONFLICT: "STATE_CONFLICT",
  PERSONA_NOT_FOUND: "PERSONA_NOT_FOUND",
  PERSONA_UID_CONFLICT: "PERSONA_UID_CONFLICT",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  ROUTE_DISABLED: "ROUTE_DISABLED",
  USERSCRIPT_NOT_FOUND: "USERSCRIPT_NOT_FOUND",
  USERSCRIPT_DISABLED: "USERSCRIPT_DISABLED",
  USERSCRIPT_INCOMPATIBLE: "USERSCRIPT_INCOMPATIBLE",
  ARTIFACT_NOT_FOUND: "USERSCRIPT_ARTIFACT_NOT_FOUND",
  ARTIFACT_CONFLICT: "USERSCRIPT_ARTIFACT_CONFLICT",
  ARTIFACT_MISMATCH: "USERSCRIPT_ARTIFACT_MISMATCH",
  AUTOMATION_NOT_ALLOWED: "INTEGRATION_AUTOMATION_NOT_ALLOWED",
  EXECUTABLE_INSTALL_NOT_ALLOWED: "INTEGRATION_EXECUTABLE_INSTALL_NOT_ALLOWED",
  PERSONA_CONTROL_BUSY: "PERSONA_CONTROL_BUSY",
  PERSONA_CONTROL_LEASE_INVALID: "PERSONA_CONTROL_LEASE_INVALID",
  PERSONA_CONTROL_LEASE_LOST: "PERSONA_CONTROL_LEASE_LOST",
  EXECUTION_NOT_FOUND: "EXECUTION_NOT_FOUND",
  EXECUTION_NOT_OWNED: "EXECUTION_NOT_OWNED",
  EXECUTION_NOT_ACTIVE: "EXECUTION_NOT_ACTIVE",
  INPUT_NOT_FOUND: "INPUT_NOT_FOUND",
  INPUT_EXPIRED: "INPUT_EXPIRED",
  INPUT_CAPACITY: "INPUT_CAPACITY",
  INPUT_SCOPE_DENIED: "INPUT_SCOPE_DENIED",
  INPUT_REQUEST_NOT_ACTIVE: "INPUT_REQUEST_NOT_ACTIVE",
  RESULT_NOT_AVAILABLE: "RESULT_NOT_AVAILABLE",
  RESULT_ALREADY_ACKNOWLEDGED: "RESULT_ALREADY_ACKNOWLEDGED",
  WORKFLOW_NOT_FOUND: "WORKFLOW_NOT_FOUND",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  DIRECT_NOT_ALLOWED: "INTEGRATION_DIRECT_NOT_ALLOWED",
  DESTRUCTIVE_NOT_ALLOWED: "INTEGRATION_DESTRUCTIVE_NOT_ALLOWED",
  OPERATION_CONFLICT: "INTEGRATION_OPERATION_CONFLICT",
  OPERATION_CAPACITY: "INTEGRATION_OPERATION_CAPACITY",
  PAGE_INVALID: "INTEGRATION_PAGE_INVALID",
  PAGE_STALE: "INTEGRATION_PAGE_STALE",
  RESPONSE_TOO_LARGE: "INTEGRATION_RESPONSE_TOO_LARGE",
  INTERNAL_ERROR: "INTEGRATION_INTERNAL_ERROR"
});

const SAFE_MESSAGES = Object.freeze({
  [INTEGRATION_ERROR_CODES.DISABLED]: "PersonaMonkey integration is disabled",
  [INTEGRATION_ERROR_CODES.UNAUTHORIZED]: "External extension is not authorized",
  [INTEGRATION_ERROR_CODES.PROTOCOL_UNSUPPORTED]: "Unsupported PersonaMonkey Integration API version",
  [INTEGRATION_ERROR_CODES.BAD_REQUEST]: "Malformed integration request",
  [INTEGRATION_ERROR_CODES.VALIDATION_FAILED]: "Request validation failed",
  [INTEGRATION_ERROR_CODES.UNKNOWN_COMMAND]: "Unknown integration command",
  [INTEGRATION_ERROR_CODES.CAPABILITY_UNAVAILABLE]: "Requested integration capability is unavailable",
  [INTEGRATION_ERROR_CODES.STATE_CONFLICT]: "State revision conflict",
  [INTEGRATION_ERROR_CODES.PERSONA_NOT_FOUND]: "Managed persona not found",
  [INTEGRATION_ERROR_CODES.PERSONA_UID_CONFLICT]: "Persona UID is already assigned incompatibly",
  [INTEGRATION_ERROR_CODES.ROUTE_NOT_FOUND]: "Route not found",
  [INTEGRATION_ERROR_CODES.ROUTE_DISABLED]: "Route is disabled",
  [INTEGRATION_ERROR_CODES.USERSCRIPT_NOT_FOUND]: "Userscript not found",
  [INTEGRATION_ERROR_CODES.USERSCRIPT_DISABLED]: "Userscript is disabled",
  [INTEGRATION_ERROR_CODES.USERSCRIPT_INCOMPATIBLE]: "Userscript has unsupported grants",
  [INTEGRATION_ERROR_CODES.ARTIFACT_NOT_FOUND]: "External userscript artifact not found",
  [INTEGRATION_ERROR_CODES.ARTIFACT_CONFLICT]: "External artifact identity is already bound to different source bytes",
  [INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH]: "External artifact source hash does not match",
  [INTEGRATION_ERROR_CODES.AUTOMATION_NOT_ALLOWED]: "External Automation authority is not enabled locally",
  [INTEGRATION_ERROR_CODES.EXECUTABLE_INSTALL_NOT_ALLOWED]: "Executable installation authority is not enabled locally",
  [INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY]: "Persona is controlled by another active operation",
  [INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_INVALID]: "Persona control lease is missing, expired, or not owned by this caller",
  [INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST]: "Persona control lease was lost",
  [INTEGRATION_ERROR_CODES.EXECUTION_NOT_FOUND]: "External execution not found",
  [INTEGRATION_ERROR_CODES.EXECUTION_NOT_OWNED]: "External execution is not owned by this caller",
  [INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE]: "External execution is no longer active",
  [INTEGRATION_ERROR_CODES.INPUT_NOT_FOUND]: "Transient input was not found",
  [INTEGRATION_ERROR_CODES.INPUT_EXPIRED]: "Transient input has expired",
  [INTEGRATION_ERROR_CODES.INPUT_CAPACITY]: "Transient input capacity is temporarily exhausted",
  [INTEGRATION_ERROR_CODES.INPUT_SCOPE_DENIED]: "Transient input is not in scope for this script",
  [INTEGRATION_ERROR_CODES.INPUT_REQUEST_NOT_ACTIVE]: "The requested human input is not active",
  [INTEGRATION_ERROR_CODES.RESULT_NOT_AVAILABLE]: "External execution result is not available",
  [INTEGRATION_ERROR_CODES.RESULT_ALREADY_ACKNOWLEDGED]: "External execution result was already acknowledged",
  [INTEGRATION_ERROR_CODES.WORKFLOW_NOT_FOUND]: "Workflow not found",
  [INTEGRATION_ERROR_CODES.JOB_NOT_FOUND]: "Workflow job not found",
  [INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED]: "Direct routing is not authorized",
  [INTEGRATION_ERROR_CODES.DESTRUCTIVE_NOT_ALLOWED]: "Destructive operation is not authorized",
  [INTEGRATION_ERROR_CODES.OPERATION_CONFLICT]: "Operation identifier was already used for a different request",
  [INTEGRATION_ERROR_CODES.OPERATION_CAPACITY]: "Integration operation correlation capacity is temporarily exhausted",
  [INTEGRATION_ERROR_CODES.PAGE_INVALID]: "Invalid integration page request",
  [INTEGRATION_ERROR_CODES.PAGE_STALE]: "Integration page is stale; restart the list",
  [INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE]: "Projected integration value exceeds the response limit",
  [INTEGRATION_ERROR_CODES.INTERNAL_ERROR]: "An internal integration error occurred"
});

export class IntegrationError extends Error {
  constructor(code, message, { retryable = false, details = null } = {}) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.retryable = retryable === true;
    this.details = details;
  }
}

export const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function makeIntegrationError(code, message, options) {
  return new IntegrationError(code, message, options);
}

function field(type, options = {}) { return Object.freeze({ type, ...options }); }
const uid = field("uuid");
const id = field("string", { max: 256, nonempty: true });
const text = (max = 2048) => field("string", { max });
const bool = field("boolean");
const number = field("number");
const httpUrl = field("http-url", { max: 4096 });
const rfc3339 = field("rfc3339", { max: 64 });
const object = (shape = {}, options = {}) => field("object", { shape: Object.freeze(shape), ...options });
const array = (items, options = {}) => field("array", { items, ...options });
const listPageParams = Object.freeze({
  page: object({
    size: field("number", { integer: true, min: 1, max: 100 }),
    cursor: field("string", { max: 1024, nonempty: true })
  })
});

const workflowCompletion = object({
  mode: field("string", { max: 32, values: ["load", "delay", "selector", "signal"] }),
  value: text(4096),
  timeoutMs: field("number", { integer: true, min: 1000, max: MAX_WORKFLOW_STEP_TIMEOUT_MS })
}, { required: ["mode", "timeoutMs"] });

const workflowStep = object({
  id: field("string", { max: 100, nonempty: true }),
  personaUid: uid,
  cookieStoreId: field("string", { max: 256, nullable: true }),
  urls: array(httpUrl, { min: 1, max: 500 }),
  urlCount: field("number", { integer: true, min: 0, max: 500 }),
  concurrency: field("number", { integer: true, min: 1, max: 200 }),
  scriptIds: array(id, { max: 200 }),
  completion: object(workflowCompletion.shape, { ...workflowCompletion, nullable: true }),
  retries: field("number", { integer: true, min: 0, max: 10 }),
  retryDelayMs: field("number", { integer: true, min: 0, max: 600000 }),
  closeTabs: bool,
  stopOnError: bool
}, { required: ["personaUid", "urls"] });

const workflowDefinition = object({
  id: field("string", { max: 256 }),
  name: field("string", { max: 200, nonempty: true }),
  enabled: bool,
  createdAt: field("string", { max: 64, nullable: true }),
  updatedAt: field("string", { max: 64, nullable: true }),
  steps: array(workflowStep, { min: 1, max: 200 })
}, { required: ["name", "enabled", "steps"] });

const personaIdentity = Object.freeze({
  name: field("string", { max: 128, nonempty: true }),
  color: text(64),
  icon: text(64),
  description: text(2048)
});

function descriptor({
  capability,
  params = {},
  required = [],
  mutating = false,
  sideEffecting = false,
  destructive = false,
  directAuthority = false,
  externalAutomation = false,
  executableInstall = false,
  batchable = false,
  retry = null,
  identifiers = {}
}) {
  return Object.freeze({
    capability,
    params: Object.freeze(params),
    required: Object.freeze(required),
    mutating,
    sideEffecting,
    destructive,
    directAuthority,
    externalAutomation,
    executableInstall,
    batchable,
    retry: retry || ((mutating || sideEffecting) ? "requery-after-ambiguous-failure" : "safe-to-retry"),
    identifiers: Object.freeze(identifiers)
  });
}

export const INTEGRATION_COMMAND_DESCRIPTORS = Object.freeze({
  "system.describe": descriptor({ capability: "system" }),
  "system.status": descriptor({ capability: "diagnostics" }),
  "persona.list": descriptor({ capability: "personas", params: listPageParams }),
  "persona.get": descriptor({ capability: "personas", params: { personaUid: uid }, required: ["personaUid"], identifiers: { personaUid: "durable-persona-uid" } }),
  "persona.create": descriptor({
    capability: "personas",
    params: {
      personaUid: uid,
      ...personaIdentity,
      routeId: id,
      temporary: bool,
      ttlHours: field("number", { min: 1, max: 24 * 30 }),
      expiresAt: rfc3339,
      allowDirect: bool
    },
    mutating: true, sideEffecting: true, directAuthority: true,
    retry: "bounded-operation-correlation",
    identifiers: { personaUid: "durable-persona-uid" }
  }),
  "persona.open": descriptor({ capability: "personas", params: { personaUid: uid, url: httpUrl, active: bool, allowDirect: bool }, required: ["personaUid"], sideEffecting: true, directAuthority: true, identifiers: { personaUid: "durable-persona-uid" } }),
  "persona.updateIdentity": descriptor({ capability: "personas", params: { personaUid: uid, changes: object(personaIdentity) }, required: ["personaUid", "changes"], mutating: true, identifiers: { personaUid: "durable-persona-uid" } }),
  "persona.archive": descriptor({ capability: "personas", params: { personaUid: uid }, required: ["personaUid"], mutating: true, identifiers: { personaUid: "durable-persona-uid" } }),
  "persona.destroy": descriptor({ capability: "personas", params: { personaUid: uid, confirm: bool }, required: ["personaUid", "confirm"], mutating: true, destructive: true, identifiers: { personaUid: "durable-persona-uid" } }),
  "storage.inspect": descriptor({ capability: "persona-storage", params: { personaUid: uid }, required: ["personaUid"], identifiers: { personaUid: "durable-persona-uid" } }),
  "storage.clearCookies": descriptor({ capability: "persona-storage", params: { personaUid: uid, confirm: bool }, required: ["personaUid", "confirm"], mutating: true, destructive: true, identifiers: { personaUid: "durable-persona-uid" } }),
  "storage.clearSiteData": descriptor({ capability: "persona-storage", params: { personaUid: uid, confirm: bool }, required: ["personaUid", "confirm"], mutating: true, destructive: true, identifiers: { personaUid: "durable-persona-uid" } }),
  "storage.fullWipe": descriptor({ capability: "persona-storage", params: { personaUid: uid, confirm: bool }, required: ["personaUid", "confirm"], mutating: true, destructive: true, retry: "bounded-operation-correlation", identifiers: { personaUid: "durable-persona-uid" } }),
  "route.list": descriptor({ capability: "routes", params: listPageParams }),
  "route.get": descriptor({ capability: "routes", params: { routeId: id }, required: ["routeId"], identifiers: { routeId: "route-id" } }),
  "route.assign": descriptor({ capability: "routes", params: { personaUid: uid, routeId: id, allowDirect: bool }, required: ["personaUid", "routeId"], mutating: true, directAuthority: true, identifiers: { personaUid: "durable-persona-uid", routeId: "route-id" } }),
  "route.test": descriptor({ capability: "routes", params: { personaUid: uid, allowDirect: bool }, required: ["personaUid"], sideEffecting: true, directAuthority: true, identifiers: { personaUid: "durable-persona-uid" } }),
  "userscript.list": descriptor({ capability: "userscripts", params: listPageParams }),
  "userscript.get": descriptor({ capability: "userscripts", params: { scriptId: id }, required: ["scriptId"], identifiers: { scriptId: "userscript-id" } }),
  "userscript.assign": descriptor({ capability: "userscripts", params: { scriptId: id, personaUid: uid }, required: ["scriptId", "personaUid"], mutating: true, identifiers: { scriptId: "userscript-id", personaUid: "durable-persona-uid" } }),
  "userscript.unassign": descriptor({ capability: "userscripts", params: { scriptId: id, personaUid: uid }, required: ["scriptId", "personaUid"], mutating: true, identifiers: { scriptId: "userscript-id", personaUid: "durable-persona-uid" } }),
  "userscript.artifact.install": descriptor({ capability: "external-executable-install", executableInstall: true, params: {
    artifactId: field("string", { max: 256, nonempty: true }),
    sha256: field("string", { max: 64, nonempty: true }),
    source: text(2 * 1024 * 1024),
    provenance: object({ packageId: field("string", { max: 128, nonempty: true }), packageVersion: field("string", { max: 64, nonempty: true }), component: field("string", { max: 128, nonempty: true }) }, { required: ["packageId", "packageVersion", "component"] })
  }, required: ["artifactId", "sha256", "source", "provenance"], mutating: true, retry: "idempotent-by-artifact-identity", identifiers: { artifactId: "immutable-artifact-id" } }),
  "userscript.artifact.list": descriptor({ capability: "external-executable-install", executableInstall: true, params: listPageParams }),
  "userscript.artifact.get": descriptor({ capability: "external-executable-install", executableInstall: true, params: { artifactId: id }, required: ["artifactId"], identifiers: { artifactId: "immutable-artifact-id" } }),
  "userscript.artifact.assign": descriptor({ capability: "external-executable-install", executableInstall: true, params: { artifactId: id, personaUid: uid }, required: ["artifactId", "personaUid"], mutating: true, identifiers: { artifactId: "immutable-artifact-id", personaUid: "durable-persona-uid" } }),
  "userscript.artifact.unassign": descriptor({ capability: "external-executable-install", executableInstall: true, params: { artifactId: id, personaUid: uid }, required: ["artifactId", "personaUid"], mutating: true, identifiers: { artifactId: "immutable-artifact-id", personaUid: "durable-persona-uid" } }),
  "userscript.artifact.release": descriptor({ capability: "external-executable-install", executableInstall: true, params: { artifactId: id, confirm: bool }, required: ["artifactId", "confirm"], mutating: true, identifiers: { artifactId: "immutable-artifact-id" } }),
  "persona.control.acquire": descriptor({ capability: "external-automation", externalAutomation: true, params: { personaUid: uid, purpose: field("string", { max: 256, nonempty: true }), ttlMs: field("number", { integer: true, min: 10000, max: EXTERNAL_AUTOMATION_LIMITS.maxControlLeaseTTL }) }, required: ["personaUid", "purpose", "ttlMs"], sideEffecting: true, retry: "requery-after-ambiguous-failure", identifiers: { personaUid: "durable-persona-uid" } }),
  "persona.control.renew": descriptor({ capability: "external-automation", externalAutomation: true, params: { leaseId: id, ttlMs: field("number", { integer: true, min: 10000, max: EXTERNAL_AUTOMATION_LIMITS.maxControlLeaseTTL }) }, required: ["leaseId", "ttlMs"], sideEffecting: true }),
  "persona.control.release": descriptor({ capability: "external-automation", externalAutomation: true, params: { leaseId: id }, required: ["leaseId"], sideEffecting: true }),
  "persona.control.get": descriptor({ capability: "external-automation", externalAutomation: true, params: { personaUid: uid }, required: ["personaUid"], identifiers: { personaUid: "durable-persona-uid" } }),
  "execution.input.begin": descriptor({ capability: "external-automation", externalAutomation: true, params: {
    name: field("string", { max: 128, nonempty: true }), mediaType: field("string", { max: 128, nonempty: true }),
    byteLength: field("number", { integer: true, min: 0, max: EXTERNAL_AUTOMATION_LIMITS.maxInputBytes }),
    sha256: field("string", { max: 64, nonempty: true }),
    stepIds: array(field("string", { max: 100, nonempty: true }), { min: 1, max: 200 }),
    artifactIds: array(id, { min: 1, max: 200 }), ttlMs: field("number", { integer: true, min: 1000, max: EXTERNAL_AUTOMATION_LIMITS.maxInputTTL })
  }, required: ["name", "mediaType", "byteLength", "sha256", "stepIds", "artifactIds", "ttlMs"], sideEffecting: true }),
  "execution.input.append": descriptor({ capability: "external-automation", externalAutomation: true, params: { inputRef: id, offset: field("number", { integer: true, min: 0, max: EXTERNAL_AUTOMATION_LIMITS.maxInputBytes }), chunkBase64: field("string", { max: 360000 }) }, required: ["inputRef", "offset", "chunkBase64"], sideEffecting: true }),
  "execution.input.commit": descriptor({ capability: "external-automation", externalAutomation: true, params: { inputRef: id }, required: ["inputRef"], sideEffecting: true }),
  "execution.input.discard": descriptor({ capability: "external-automation", externalAutomation: true, params: { inputRef: id }, required: ["inputRef"], sideEffecting: true }),
  "execution.secret.stage": descriptor({ capability: "external-automation", externalAutomation: true, params: {
    name: field("string", { max: 128, nonempty: true }), value: field("string", { max: EXTERNAL_AUTOMATION_LIMITS.maxSecretBytes }),
    stepIds: array(field("string", { max: 100, nonempty: true }), { min: 1, max: 200 }),
    artifactIds: array(id, { min: 1, max: 200 }), ttlMs: field("number", { integer: true, min: 1000, max: EXTERNAL_AUTOMATION_LIMITS.maxSecretTTL })
  }, required: ["name", "value", "stepIds", "artifactIds", "ttlMs"], sideEffecting: true }),
  "execution.secret.discard": descriptor({ capability: "external-automation", externalAutomation: true, params: { secretRef: id }, required: ["secretRef"], sideEffecting: true }),
  "execution.input.submit": descriptor({ capability: "external-automation", externalAutomation: true, params: { executionId: id, waitId: id, name: field("string", { max: 128, nonempty: true }), value: field("string", { max: EXTERNAL_AUTOMATION_LIMITS.maxSecretBytes }), stepId: field("string", { max: 100, nonempty: true }), taskId: id, artifactId: id, secret: bool }, required: ["executionId", "waitId", "name", "value", "stepId", "taskId", "artifactId"], sideEffecting: true }),
  "execution.start": descriptor({ capability: "external-automation", externalAutomation: true, params: {
    plan: object({ name: field("string", { max: 200, nonempty: true }), steps: array(object({
      id: field("string", { max: 100, nonempty: true }), personaUid: uid,
      urls: array(httpUrl, { min: 1, max: 500 }), artifacts: array(id, { min: 1, max: 200 }),
      concurrency: field("number", { integer: true, min: 1, max: 200 }),
      completion: object(workflowCompletion.shape, { ...workflowCompletion, nullable: true }),
      retries: field("number", { integer: true, min: 0, max: 10 }), retryDelayMs: field("number", { integer: true, min: 0, max: 600000 }),
      closeTabs: bool, stopOnError: bool
    }, { required: ["id", "personaUid", "urls", "artifacts"] }), { min: 1, max: 200 })
  }, { required: ["name", "steps"] }),
  inputRefs: array(id, { max: 16 }), secretRefs: array(id, { max: 16 }), allowDirect: bool
  }, required: ["plan"], sideEffecting: true, directAuthority: true, retry: "bounded-operation-correlation", identifiers: { personaUid: "durable-persona-uid", artifactId: "immutable-artifact-id" } }),
  "execution.list": descriptor({ capability: "external-automation", externalAutomation: true, params: { limit: field("number", { integer: true, min: 1, max: 100 }) } }),
  "execution.get": descriptor({ capability: "external-automation", externalAutomation: true, params: { executionId: id }, required: ["executionId"] }),
  "execution.result.get": descriptor({ capability: "external-automation", externalAutomation: true, params: { executionId: id }, required: ["executionId"] }),
  "execution.result.ack": descriptor({ capability: "external-automation", externalAutomation: true, params: { executionId: id }, required: ["executionId"], sideEffecting: true }),
  "execution.cancel": descriptor({ capability: "external-automation", externalAutomation: true, params: { executionId: id }, required: ["executionId"], sideEffecting: true }),
  "execution.focus": descriptor({ capability: "external-automation", externalAutomation: true, params: { executionId: id, taskId: field("string", { max: 128, nonempty: true }) }, required: ["executionId"], sideEffecting: true }),
  "workflow.list": descriptor({ capability: "workflows", params: listPageParams }),
  "workflow.get": descriptor({ capability: "workflows", params: { workflowId: id }, required: ["workflowId"], identifiers: { workflowId: "workflow-id" } }),
  "workflow.create": descriptor({ capability: "workflows", params: { workflow: workflowDefinition }, required: ["workflow"], mutating: true, identifiers: { personaUid: "durable-persona-uid", scriptId: "userscript-id" } }),
  "workflow.update": descriptor({ capability: "workflows", params: { workflowId: id, workflow: workflowDefinition }, required: ["workflowId", "workflow"], mutating: true, identifiers: { workflowId: "workflow-id", personaUid: "durable-persona-uid", scriptId: "userscript-id" } }),
  "workflow.delete": descriptor({ capability: "workflows", params: { workflowId: id, confirm: bool }, required: ["workflowId", "confirm"], mutating: true, destructive: true, identifiers: { workflowId: "workflow-id" } }),
  "workflow.run": descriptor({ capability: "workflows", params: { workflowId: id, allowDirect: bool }, required: ["workflowId"], sideEffecting: true, directAuthority: true, retry: "bounded-operation-correlation", identifiers: { workflowId: "workflow-id" } }),
  "workflow.jobs.list": descriptor({ capability: "workflow-jobs", params: listPageParams }),
  "workflow.jobs.get": descriptor({ capability: "workflow-jobs", params: { jobId: id }, required: ["jobId"], identifiers: { jobId: "workflow-job-id" } }),
  "workflow.jobs.stop": descriptor({ capability: "workflow-jobs", params: { jobId: id, confirm: bool }, required: ["jobId", "confirm"], sideEffecting: true, destructive: true, identifiers: { jobId: "workflow-job-id" } }),
  "workflow.jobs.clearFinished": descriptor({ capability: "workflow-jobs", params: { confirm: bool }, required: ["confirm"], mutating: true, destructive: true })
});

export function getIntegrationCommandDescriptor(command) {
  return typeof command === "string" && Object.hasOwn(INTEGRATION_COMMAND_DESCRIPTORS, command)
    ? INTEGRATION_COMMAND_DESCRIPTORS[command]
    : undefined;
}

export function listIntegrationCommandDescriptors() {
  return Object.entries(INTEGRATION_COMMAND_DESCRIPTORS).map(([command, meta]) => ({ command, ...meta }));
}

export function normalizeIntegrationPolicy(value) {
  const raw = isPlainObject(value) ? value : {};
  const ids = Array.isArray(raw.trustedExtensionIds) ? raw.trustedExtensionIds : [];
  const trustedExtensionIds = [...new Set(ids
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item && item.length <= MAX_INTEGRATION_ID_LENGTH))]
    .slice(0, MAX_TRUSTED_EXTENSION_IDS);
  return {
    enabled: raw.enabled === true,
    trustedExtensionIds,
    allowDestructive: raw.allowDestructive === true,
    allowDirect: raw.allowDirect === true,
    allowExternalAutomation: raw.allowExternalAutomation === true,
    allowExecutableInstall: raw.allowExecutableInstall === true
  };
}

export function isAuthorizedIntegrationSender(policy, senderId) {
  const normalized = normalizeIntegrationPolicy(policy);
  return normalized.enabled === true
    && typeof senderId === "string"
    && normalized.trustedExtensionIds.includes(senderId);
}

function serializedSize(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return Infinity; }
}

function assertJson(value, state = { nodes: 0, seen: new WeakSet() }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 50_000 || depth > 32) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Request structure is too large");
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Request numbers must be finite");
    return;
  }
  if (typeof value !== "object") throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Request must be JSON-compatible");
  if (state.seen.has(value)) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Request must not be cyclic");
  state.seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, state, depth + 1);
  } else {
    if (!isPlainObject(value)) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Request objects must be plain objects");
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Request contains a prohibited key");
      assertJson(child, state, depth + 1);
    }
  }
  state.seen.delete(value);
}

function validateField(value, spec, path) {
  const fail = () => { throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, `${path} has an invalid value`); };
  if (value === null && spec.nullable) return;
  if (spec.type === "boolean") { if (typeof value !== "boolean") fail(); return; }
  if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail();
    if (spec.integer && !Number.isInteger(value)) fail();
    if (spec.min != null && value < spec.min) fail();
    if (spec.max != null && value > spec.max) fail();
    return;
  }
  if (spec.type === "http-url") {
    if (typeof value !== "string" || value !== value.trim() || !value || value.length > (spec.max || 4096)) fail();
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) fail();
    } catch { fail(); }
    return;
  }
  if (spec.type === "rfc3339") {
    if (typeof value !== "string" || value !== value.trim() || value.length > (spec.max || 64)) fail();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail();
    return;
  }
  if (spec.type === "uuid") {
    // Match the persisted schema-3 Persona identity contract exactly. UUID
    // version/variant nibbles are opaque here; restored/imported valid UIDs
    // must remain addressable by the external Integration API.
    if (typeof value !== "string" || value.trim() !== value || !normalizePersonaUid(value)) fail();
    return;
  }
  if (spec.type === "string") {
    if (typeof value !== "string" || value.length > (spec.max || MAX_INTEGRATION_ID_LENGTH) || (spec.nonempty && !value.trim())) fail();
    if (Array.isArray(spec.values) && !spec.values.includes(value)) fail();
    return;
  }
  if (spec.type === "array") {
    if (!Array.isArray(value)) fail();
    if (spec.min != null && value.length < spec.min) fail();
    if (spec.max != null && value.length > spec.max) fail();
    value.forEach((item, index) => validateField(item, spec.items, path + "[" + index + "]"));
    return;
  }
  if (spec.type === "object") {
    if (!isPlainObject(value)) fail();
    validateObject(value, spec.shape || {}, path);
    for (const key of spec.required || []) if (!Object.hasOwn(value, key)) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, path + "." + key + " is required");
    }
    return;
  }
  fail();
}

function validateObject(value, shape, path) {
  if (!isPlainObject(value)) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, `${path} must be an object`);
  for (const [key, child] of Object.entries(value)) {
    if (!Object.hasOwn(shape, key)) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, `${path}.${key} is not supported`);
    validateField(child, shape[key], `${path}.${key}`);
  }
}

export function validateIntegrationRequest(raw) {
  if (!isPlainObject(raw) || raw.type !== INTEGRATION_REQUEST_TYPE) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Request must use the PersonaMonkey Integration envelope");
  }
  const allowed = new Set(["type", "version", "requestId", "operationId", "command", "precondition", "params"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, `Unknown request field: ${key}`);
  }
  assertJson(raw);
  if (serializedSize(raw) > MAX_INTEGRATION_REQUEST_BYTES) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Request is too large");
  if (raw.version !== INTEGRATION_PROTOCOL_VERSION) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.PROTOCOL_UNSUPPORTED, "Unsupported integration protocol version", { details: { supportedVersion: INTEGRATION_PROTOCOL_VERSION } });
  }
  if (typeof raw.requestId !== "string" || !raw.requestId.trim() || raw.requestId.length > MAX_INTEGRATION_ID_LENGTH) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "requestId is required");
  }
  if (typeof raw.command !== "string" || !raw.command.trim() || raw.command.length > 128) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "command is required");
  }
  const descriptor = getIntegrationCommandDescriptor(raw.command);
  if (!descriptor) throw makeIntegrationError(INTEGRATION_ERROR_CODES.UNKNOWN_COMMAND, "Unknown integration command");
  const params = raw.params ?? {};
  validateObject(params, descriptor.params, "params");
  for (const key of descriptor.required) if (!Object.hasOwn(params, key)) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, `params.${key} is required`);
  }
  const needsOperation = descriptor.mutating || descriptor.sideEffecting;
  if (needsOperation) {
    if (typeof raw.operationId !== "string" || !raw.operationId.trim() || raw.operationId.length > MAX_INTEGRATION_ID_LENGTH) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "operationId is required for side-effecting commands");
    }
    if (!isPlainObject(raw.precondition)) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "precondition is required");
    const keys = Object.keys(raw.precondition);
    if (keys.some((key) => !["bootId", "revision"].includes(key))) throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "precondition contains unknown fields");
    if (typeof raw.precondition.bootId !== "string" || !raw.precondition.bootId.trim() || raw.precondition.bootId.length > MAX_INTEGRATION_ID_LENGTH) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "precondition.bootId is required");
    }
    if (!Number.isInteger(raw.precondition.revision) || raw.precondition.revision < 0) {
      throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "precondition.revision is required");
    }
  } else if (raw.precondition != null) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "Read-only commands do not accept precondition");
  }
  if (raw.operationId != null && (typeof raw.operationId !== "string" || raw.operationId.length > MAX_INTEGRATION_ID_LENGTH)) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "operationId is invalid");
  }
  if (["userscript.artifact.install", "execution.input.begin"].includes(raw.command)
      && !/^[a-f0-9]{64}$/.test(params.sha256 || "")) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.BAD_REQUEST, "SHA-256 must be 64 lowercase hexadecimal characters");
  }
  if ((raw.command === "persona.create" || raw.command === "route.assign") && params.routeId === DIRECT_ROUTE_ID && params.allowDirect !== true) {
    throw makeIntegrationError(INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED, "Direct routing requires request allowDirect intent");
  }
  return { ...raw, params };
}

function normalizedKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function sensitiveKey(key) {
  const k = normalizedKey(key);
  if (!k) return false;
  // Explicit aggregate/browser-identity cookie fields are safe; raw cookie
  // objects/values remain redacted by the generic cookie fragment rule below.
  if (
    k.endsWith("cookiestoreid")
    || [
      "personauid",
      "secretref",
      "secretrefs",
      "cookiecount",
      "cookiebytes",
      "cookiesummary",
      "cookiesremoved"
    ].includes(k)
  ) return false;
  return ["password","passphrase","secret","token","credential","privatekey","authorization","wireguard","cookie","session","code","source"].some((part) => k.includes(part));
}
function sanitizeString(value) {
  let out = String(value).replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      return url.href;
    } catch { return "[url]"; }
  });
  out = out
    .replace(/-----BEGIN[^\n]{0,80}PRIVATE KEY-----[\s\S]*?-----END[^\n]{0,80}PRIVATE KEY-----/gi, "[redacted-private-key]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(password|passphrase|secret|token|credential|authorization|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  return out;
}
export function sanitizeIntegrationValue(value, { maxDepth = 6, maxBytes = MAX_INTEGRATION_RESPONSE_BYTES, redactSensitive = true } = {}) {
  const seen = new WeakSet();
  const visit = (input, depth, key = "") => {
    if (redactSensitive && sensitiveKey(key)) return "[redacted]";
    if (input == null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "string") return sanitizeString(input);
    if (typeof input !== "object") throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);
    if (depth >= maxDepth || seen.has(input)) throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);
    seen.add(input);
    try {
      if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
      const out = {};
      for (const [childKey, child] of Object.entries(input)) out[childKey] = visit(child, depth + 1, childKey);
      return out;
    } finally {
      // Track only the current ancestor path. Repeated/shared objects are
      // valid JSON structure and must not be mistaken for cycles.
      seen.delete(input);
    }
  };
  const result = visit(value, 0);
  if (serializedSize(result) > maxBytes) throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);
  return result;
}

const OWNER_RESULT_MAX_NODES = 10_000;
const OWNER_RESULT_MAX_KEY_LENGTH = 1024;
const OWNER_RESULT_MAX_STRING_LENGTH = 256 * 1024;
const OWNER_RESULT_FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function validateOwnerResultValue(value, {
  maxDepth = 12,
  maxBytes = MAX_INTEGRATION_RESPONSE_BYTES,
  maxNodes = OWNER_RESULT_MAX_NODES
} = {}) {
  const ancestors = new WeakSet();
  let nodes = 0;

  const invalid = (message = "Owner result is not JSON-compatible") =>
    makeIntegrationError(INTEGRATION_ERROR_CODES.VALIDATION_FAILED, message);
  const visit = (input, depth) => {
    nodes += 1;
    if (nodes > maxNodes) throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);
    if (depth > maxDepth) throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw invalid("Owner result contains a non-finite number");
      return input;
    }
    if (typeof input === "string") {
      if (input.length > OWNER_RESULT_MAX_STRING_LENGTH) {
        throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);
      }
      return input;
    }
    if (typeof input !== "object") throw invalid();

    if (ancestors.has(input)) throw invalid("Owner result contains a cycle");
    if (Object.getOwnPropertySymbols(input).length) throw invalid("Owner result contains symbol keys");
    ancestors.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) throw invalid("Owner result contains an exotic array prototype");
        const out = new Array(input.length);
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (key === "length") continue;
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
            throw invalid("Owner result contains a non-data array property");
          }
          if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) {
            throw invalid("Owner result contains a non-JSON array property");
          }
        }
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !Object.hasOwn(descriptor, "value")) {
            throw invalid("Owner result contains a sparse array");
          }
          out[index] = visit(descriptor.value, depth + 1);
        }
        return out;
      }

      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalid("Owner result contains an exotic object prototype");
      }
      const out = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key.length > OWNER_RESULT_MAX_KEY_LENGTH) {
          throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);
        }
        if (OWNER_RESULT_FORBIDDEN_KEYS.has(key)) {
          throw invalid("Owner result contains a prototype-sensitive key");
        }
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw invalid("Owner result contains a non-data object property");
        }
        out[key] = visit(descriptor.value, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(input);
    }
  };

  const result = visit(value, 0);
  if (serializedSize(result) > maxBytes) throw makeIntegrationError(INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);
  return result;
}

function boundedErrorId(value) {
  return typeof value === "string" && value ? value.slice(0, MAX_INTEGRATION_ID_LENGTH) : null;
}

function safeIntegrationErrorDetails(code, error) {
  if (code === INTEGRATION_ERROR_CODES.PROTOCOL_UNSUPPORTED) {
    const supportedVersion = Number(error?.details?.supportedVersion);
    return Number.isInteger(supportedVersion) && supportedVersion >= 0
      ? { supportedVersion }
      : null;
  }
  if (code === INTEGRATION_ERROR_CODES.STATE_CONFLICT) {
    const source = isPlainObject(error?.details) ? error.details : error || {};
    const details = {
      expectedBootId: boundedErrorId(source.expectedBootId),
      actualBootId: boundedErrorId(source.actualBootId),
      expectedRevision: Number.isInteger(source.expectedRevision) && source.expectedRevision >= 0 ? source.expectedRevision : null,
      actualRevision: Number.isInteger(source.actualRevision) && source.actualRevision >= 0 ? source.actualRevision : null
    };
    return Object.values(details).some((value) => value != null) ? details : null;
  }
  if (code === INTEGRATION_ERROR_CODES.VALIDATION_FAILED && Array.isArray(error?.issues)) {
    const issues = error.issues.slice(0, 10).map((issue) => ({
      // This is a controlled validator identifier, not executable/source code.
      // Do not pass the field through the generic secret-key sanitizer, where
      // the literal key name "code" is intentionally redacted.
      code: String(issue?.code || "validation-error")
        .replace(/[^a-z0-9._-]/gi, "-")
        .slice(0, 64) || "validation-error",
      message: sanitizeString(String(issue?.message || "Validation failed")).slice(0, 256),
      stepIndex: Number.isInteger(issue?.stepIndex) ? issue.stepIndex : null
    }));
    const details = { issues };
    if (serializedSize(details) <= MAX_INTEGRATION_ERROR_BYTES) return details;
    return {
      issues: issues.slice(0, 5).map((issue) => ({ ...issue, message: issue.message.slice(0, 128) })),
      truncated: true
    };
  }
  return null;
}

export function structuredIntegrationError(error) {
  const known = error instanceof IntegrationError || Object.values(INTEGRATION_ERROR_CODES).includes(error?.code);
  const code = known ? error.code : (
    Array.isArray(error?.issues) && error.issues.length ? INTEGRATION_ERROR_CODES.VALIDATION_FAILED
      : error?.code === "DIRECT_ROUTE_REQUIRES_OPT_IN" ? INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED
      : error?.code === "SECURITY_AUTHORIZATION_REQUIRED" ? INTEGRATION_ERROR_CODES.VALIDATION_FAILED
      : error?.code === "OPERATION_CONFLICT" ? INTEGRATION_ERROR_CODES.OPERATION_CONFLICT
      : error?.code === "EXECUTION_NOT_TERMINAL" ? INTEGRATION_ERROR_CODES.RESULT_NOT_AVAILABLE
      : /managed persona not found/i.test(String(error?.message || "")) ? INTEGRATION_ERROR_CODES.PERSONA_NOT_FOUND
        : /route.*not found/i.test(String(error?.message || "")) ? INTEGRATION_ERROR_CODES.ROUTE_NOT_FOUND
          : /route.*disabled/i.test(String(error?.message || "")) ? INTEGRATION_ERROR_CODES.ROUTE_DISABLED
            : /execution.*not found/i.test(String(error?.message || "")) ? INTEGRATION_ERROR_CODES.EXECUTION_NOT_FOUND
              : /execution.*no active owned tab/i.test(String(error?.message || "")) ? INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE
                : /\bjob\b.*not found/i.test(String(error?.message || "")) ? INTEGRATION_ERROR_CODES.JOB_NOT_FOUND
                  : /workflow.*not found/i.test(String(error?.message || "")) ? INTEGRATION_ERROR_CODES.WORKFLOW_NOT_FOUND
                    : /personaUid.*already assigned/i.test(String(error?.message || "")) ? INTEGRATION_ERROR_CODES.PERSONA_UID_CONFLICT
                      : INTEGRATION_ERROR_CODES.INTERNAL_ERROR
  );
  return {
    code,
    message: SAFE_MESSAGES[code] || SAFE_MESSAGES[INTEGRATION_ERROR_CODES.INTERNAL_ERROR],
    retryable: error?.retryable === true || code === INTEGRATION_ERROR_CODES.STATE_CONFLICT,
    details: safeIntegrationErrorDetails(code, error)
  };
}
