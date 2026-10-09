/**
 * PCMS Persona Broker contract v1.
 *
 * Transport-neutral snapshot of PersonaMonkey Integration API v1 semantics.
 * P009 supplies the implementation adapter. Keep this module free of
 * PersonaMonkey service objects, browser APIs, storage, routing, and native RPC.
 */
export const PERSONA_BROKER_CONTRACT_VERSION = 1;
export const PERSONA_BROKER_IDENTITY_FIELD = "personaUid";
export const PERSONA_BROKER_REQUEST_ID_MAX_LENGTH = 256;

/**
 * @typedef {object} PersonaBroker
 * @property {(request: object) => Promise<object>} request
 * @property {(listener: (event: object) => void) => {disconnect: () => void}} subscribe
 */

const SNAPSHOT = {
  "system.describe": {
    "capability": "system",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "system.status": {
    "capability": "diagnostics",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "persona.list": {
    "capability": "personas",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "persona.get": {
    "capability": "personas",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "persona.create": {
    "capability": "personas",
    "mutating": true,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": true,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "bounded-operation-correlation"
  },
  "persona.open": {
    "capability": "personas",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": true,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "persona.updateIdentity": {
    "capability": "personas",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "persona.archive": {
    "capability": "personas",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "persona.destroy": {
    "capability": "personas",
    "mutating": true,
    "sideEffecting": false,
    "destructive": true,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "storage.inspect": {
    "capability": "persona-storage",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "storage.clearCookies": {
    "capability": "persona-storage",
    "mutating": true,
    "sideEffecting": false,
    "destructive": true,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "storage.clearSiteData": {
    "capability": "persona-storage",
    "mutating": true,
    "sideEffecting": false,
    "destructive": true,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "storage.fullWipe": {
    "capability": "persona-storage",
    "mutating": true,
    "sideEffecting": false,
    "destructive": true,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "bounded-operation-correlation"
  },
  "route.list": {
    "capability": "routes",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "route.get": {
    "capability": "routes",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "route.assign": {
    "capability": "routes",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": true,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "route.test": {
    "capability": "routes",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": true,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "userscript.list": {
    "capability": "userscripts",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "userscript.get": {
    "capability": "userscripts",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "userscript.assign": {
    "capability": "userscripts",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "userscript.unassign": {
    "capability": "userscripts",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "userscript.artifact.install": {
    "capability": "external-executable-install",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": true,
    "retry": "idempotent-by-artifact-identity"
  },
  "userscript.artifact.list": {
    "capability": "external-executable-install",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": true,
    "retry": "safe-to-retry"
  },
  "userscript.artifact.get": {
    "capability": "external-executable-install",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": true,
    "retry": "safe-to-retry"
  },
  "userscript.artifact.assign": {
    "capability": "external-executable-install",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": true,
    "retry": "requery-after-ambiguous-failure"
  },
  "userscript.artifact.unassign": {
    "capability": "external-executable-install",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": true,
    "retry": "requery-after-ambiguous-failure"
  },
  "userscript.artifact.release": {
    "capability": "external-executable-install",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": true,
    "retry": "requery-after-ambiguous-failure"
  },
  "persona.control.acquire": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "persona.control.renew": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "persona.control.release": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "persona.control.get": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "execution.input.begin": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "execution.input.append": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "execution.input.commit": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "execution.input.discard": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "execution.secret.stage": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "execution.secret.discard": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "execution.input.submit": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "execution.start": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": true,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "bounded-operation-correlation"
  },
  "execution.list": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "execution.get": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "execution.result.get": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "execution.result.ack": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "execution.cancel": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "execution.focus": {
    "capability": "external-automation",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": true,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "workflow.list": {
    "capability": "workflows",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "workflow.get": {
    "capability": "workflows",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "workflow.create": {
    "capability": "workflows",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "workflow.update": {
    "capability": "workflows",
    "mutating": true,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "workflow.delete": {
    "capability": "workflows",
    "mutating": true,
    "sideEffecting": false,
    "destructive": true,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "workflow.run": {
    "capability": "workflows",
    "mutating": false,
    "sideEffecting": true,
    "destructive": false,
    "directAuthority": true,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "bounded-operation-correlation"
  },
  "workflow.jobs.list": {
    "capability": "workflow-jobs",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "workflow.jobs.get": {
    "capability": "workflow-jobs",
    "mutating": false,
    "sideEffecting": false,
    "destructive": false,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "safe-to-retry"
  },
  "workflow.jobs.stop": {
    "capability": "workflow-jobs",
    "mutating": false,
    "sideEffecting": true,
    "destructive": true,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  },
  "workflow.jobs.clearFinished": {
    "capability": "workflow-jobs",
    "mutating": true,
    "sideEffecting": false,
    "destructive": true,
    "directAuthority": false,
    "externalAutomation": false,
    "executableInstall": false,
    "retry": "requery-after-ambiguous-failure"
  }
};

export const PERSONA_BROKER_COMMANDS = Object.freeze(Object.fromEntries(
  Object.entries(SNAPSHOT).map(([command, spec]) => [
    command,
    Object.freeze({
      ...spec,
      requiresOperation: spec.mutating === true || spec.sideEffecting === true
    })
  ])
));

export const PERSONA_BROKER_COMMAND_NAMES = Object.freeze(Object.keys(PERSONA_BROKER_COMMANDS));

export const PERSONA_BROKER_ERROR_CODES = Object.freeze([
  "INTEGRATION_DISABLED",
  "INTEGRATION_UNAUTHORIZED",
  "INTEGRATION_PROTOCOL_UNSUPPORTED",
  "INTEGRATION_BAD_REQUEST",
  "INTEGRATION_VALIDATION_FAILED",
  "INTEGRATION_UNKNOWN_COMMAND",
  "INTEGRATION_CAPABILITY_UNAVAILABLE",
  "STATE_CONFLICT",
  "PERSONA_NOT_FOUND",
  "PERSONA_UID_CONFLICT",
  "ROUTE_NOT_FOUND",
  "ROUTE_DISABLED",
  "USERSCRIPT_NOT_FOUND",
  "USERSCRIPT_DISABLED",
  "USERSCRIPT_INCOMPATIBLE",
  "USERSCRIPT_ARTIFACT_NOT_FOUND",
  "USERSCRIPT_ARTIFACT_CONFLICT",
  "USERSCRIPT_ARTIFACT_MISMATCH",
  "INTEGRATION_AUTOMATION_NOT_ALLOWED",
  "INTEGRATION_EXECUTABLE_INSTALL_NOT_ALLOWED",
  "PERSONA_CONTROL_BUSY",
  "PERSONA_CONTROL_LEASE_INVALID",
  "PERSONA_CONTROL_LEASE_LOST",
  "EXECUTION_NOT_FOUND",
  "EXECUTION_NOT_OWNED",
  "EXECUTION_NOT_ACTIVE",
  "INPUT_NOT_FOUND",
  "INPUT_EXPIRED",
  "INPUT_CAPACITY",
  "INPUT_SCOPE_DENIED",
  "INPUT_REQUEST_NOT_ACTIVE",
  "RESULT_NOT_AVAILABLE",
  "RESULT_ALREADY_ACKNOWLEDGED",
  "WORKFLOW_NOT_FOUND",
  "JOB_NOT_FOUND",
  "INTEGRATION_DIRECT_NOT_ALLOWED",
  "INTEGRATION_DESTRUCTIVE_NOT_ALLOWED",
  "INTEGRATION_OPERATION_CONFLICT",
  "INTEGRATION_OPERATION_CAPACITY",
  "INTEGRATION_PAGE_INVALID",
  "INTEGRATION_PAGE_STALE",
  "INTEGRATION_RESPONSE_TOO_LARGE",
  "INTEGRATION_INTERNAL_ERROR"
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function assertBoundedId(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > PERSONA_BROKER_REQUEST_ID_MAX_LENGTH) {
    throw new TypeError(`${name} must be a non-empty string of at most ${PERSONA_BROKER_REQUEST_ID_MAX_LENGTH} characters`);
  }
}

function assertPlainParams(params) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError("params must be a plain object");
  }
  const prototype = Object.getPrototypeOf(params);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("params must be a plain object");
  }
}

function normalizePrecondition(precondition) {
  if (precondition === null || typeof precondition !== "object" || Array.isArray(precondition)) {
    throw new TypeError("precondition must be an object");
  }
  const keys=Object.keys(precondition);
  if (keys.length !== 2 || !keys.includes("bootId") || !keys.includes("revision")) {
    throw new TypeError("precondition must contain exactly bootId and revision");
  }
  assertBoundedId(precondition.bootId, "precondition.bootId");
  if (!Number.isInteger(precondition.revision) || precondition.revision < 0) {
    throw new TypeError("precondition.revision must be a non-negative integer");
  }
  return Object.freeze({ bootId: precondition.bootId, revision: precondition.revision });
}

export function getPersonaBrokerCommand(command) {
  return typeof command === "string" && hasOwn(PERSONA_BROKER_COMMANDS, command)
    ? PERSONA_BROKER_COMMANDS[command]
    : undefined;
}

export function createPersonaBrokerRequest({
  command,
  params = {},
  requestId,
  operationId,
  precondition
} = {}) {
  const descriptor=getPersonaBrokerCommand(command);
  if (!descriptor) throw new TypeError("Unknown Persona Broker command");
  assertBoundedId(requestId, "requestId");
  assertPlainParams(params);

  if (operationId !== undefined && operationId !== null) assertBoundedId(operationId, "operationId");

  let normalizedPrecondition;
  if (descriptor.requiresOperation) {
    assertBoundedId(operationId, "operationId");
    normalizedPrecondition=normalizePrecondition(precondition);
  } else if (precondition !== undefined && precondition !== null) {
    throw new TypeError("Read-only Persona Broker commands do not accept precondition");
  }

  const request={
    version:PERSONA_BROKER_CONTRACT_VERSION,
    command,
    params:Object.freeze({ ...params }),
    requestId
  };
  if (operationId !== undefined && operationId !== null) request.operationId=operationId;
  if (normalizedPrecondition) request.precondition=normalizedPrecondition;
  return Object.freeze(request);
}

export function validatePersonaBrokerResponse(response, request) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError("Persona Broker response must be an object");
  }
  if (!request || response.version !== PERSONA_BROKER_CONTRACT_VERSION || response.requestId !== request.requestId) {
    throw new TypeError("Persona Broker response correlation is invalid");
  }
  const expectedOperationId=request.operationId ?? null;
  if ((response.operationId ?? null) !== expectedOperationId) {
    throw new TypeError("Persona Broker operation correlation is invalid");
  }
  assertBoundedId(response.bootId, "response.bootId");
  if (!Number.isInteger(response.revision) || response.revision < 0 || typeof response.ok !== "boolean") {
    throw new TypeError("Persona Broker response state metadata is invalid");
  }
  if (response.ok) {
    if (!hasOwn(response, "result")) throw new TypeError("Successful Persona Broker response must contain result");
    return response;
  }
  const error=response.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)
      || !isPersonaBrokerErrorCode(error.code) || typeof error.message !== "string"
      || typeof error.retryable !== "boolean") {
    throw new TypeError("Persona Broker error response is invalid");
  }
  return response;
}

export function validatePersonaBrokerEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)
      || event.version !== PERSONA_BROKER_CONTRACT_VERSION) {
    throw new TypeError("Persona Broker event must be a version-1 object");
  }
  assertBoundedId(event.bootId, "event.bootId");
  if (!Number.isInteger(event.sequence) || event.sequence < 1
      || !Number.isInteger(event.revision) || event.revision < 0
      || typeof event.type !== "string" || event.type.length < 1) {
    throw new TypeError("Persona Broker event metadata is invalid");
  }
  return event;
}

export function assertPersonaBroker(broker) {
  if (broker === null || typeof broker !== "object" || Array.isArray(broker)
      || typeof broker.request !== "function" || typeof broker.subscribe !== "function") {
    throw new TypeError("Persona Broker must expose request() and subscribe()");
  }
  return broker;
}

export function isPersonaBrokerErrorCode(code) {
  return typeof code === "string" && PERSONA_BROKER_ERROR_CODES.includes(code);
}
