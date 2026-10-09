import assert from "node:assert/strict";
import {
  INTEGRATION_COMMAND_DESCRIPTORS,
  INTEGRATION_ERROR_CODES,
  INTEGRATION_PROTOCOL_VERSION,
  INTEGRATION_REQUEST_TYPE,
  getIntegrationCommandDescriptor,
  IntegrationError,
  structuredIntegrationError,
  validateIntegrationRequest
} from "../lib/management-integration-protocol.js";
import { createManagementIntegration } from "../lib/management-integration.js";
import { MAX_WORKFLOW_STEP_TIMEOUT_MS } from "../lib/constants.js";

const UID = "11111111-1111-4111-8111-111111111111";
const TRUSTED = "pcms-parity@example.test";
const BOOT = "boot-parity";

function sample(spec) {
  switch (spec.type) {
    case "boolean": return true;
    case "number": return spec.min ?? 1;
    case "uuid": return UID;
    case "http-url": return "https://example.com/";
    case "rfc3339": return "2026-09-24T12:00:00Z";
    case "string": return Array.isArray(spec.values) ? spec.values[0] : spec.max === 64 ? "a".repeat(64) : "sample";
    case "array": return Array.from({ length: Math.max(0, spec.min || 0) }, () => sample(spec.items));
    case "object": {
      const value = {};
      for (const key of spec.required || []) value[key] = sample(spec.shape[key]);
      return value;
    }
    default: throw new Error("Unsupported descriptor field type: " + spec.type);
  }
}

function validEnvelope(command, descriptor) {
  const params = {};
  for (const key of descriptor.required || []) params[key] = sample(descriptor.params[key]);
  const envelope = {
    type: INTEGRATION_REQUEST_TYPE,
    version: INTEGRATION_PROTOCOL_VERSION,
    requestId: "req-" + command,
    command,
    params
  };
  if (descriptor.mutating || descriptor.sideEffecting) {
    envelope.operationId = "op-" + command;
    envelope.precondition = { bootId: BOOT, revision: 0 };
  }
  return envelope;
}

const descriptorNames = Object.keys(INTEGRATION_COMMAND_DESCRIPTORS).sort();

for (const inheritedName of ["constructor", "toString", "__proto__", "hasOwnProperty", "isPrototypeOf"]) {
  assert.equal(getIntegrationCommandDescriptor(inheritedName), undefined, `${inheritedName} must not resolve through Object.prototype`);
  assert.throws(
    () => validateIntegrationRequest({
      type: INTEGRATION_REQUEST_TYPE,
      version: INTEGRATION_PROTOCOL_VERSION,
      requestId: "prototype-command",
      command: inheritedName,
      params: {}
    }),
    (error) => error?.code === INTEGRATION_ERROR_CODES.UNKNOWN_COMMAND,
    `${inheritedName} must return the stable unknown-command error`
  );
}

for (const [command, descriptor] of Object.entries(INTEGRATION_COMMAND_DESCRIPTORS)) {
  const request = validEnvelope(command, descriptor);
  assert.doesNotThrow(() => validateIntegrationRequest(request), command + " descriptor sample must validate");
  for (const required of descriptor.required || []) {
    const invalid = structuredClone(request);
    delete invalid.params[required];
    assert.throws(
      () => validateIntegrationRequest(invalid),
      (error) => error?.code === INTEGRATION_ERROR_CODES.BAD_REQUEST,
      command + " must reject missing " + required
    );
  }
  const extra = structuredClone(request);
  extra.params.__unsupported = true;
  assert.throws(
    () => validateIntegrationRequest(extra),
    (error) => error?.code === INTEGRATION_ERROR_CODES.BAD_REQUEST,
    command + " must reject unknown parameters"
  );
}

const workflowTimeoutDescriptor = getIntegrationCommandDescriptor("workflow.create");
for (const timeoutMs of [MAX_WORKFLOW_STEP_TIMEOUT_MS - 1, MAX_WORKFLOW_STEP_TIMEOUT_MS]) {
  const request = validEnvelope("workflow.create", workflowTimeoutDescriptor);
  request.params.workflow.steps[0].completion = { mode: "load", timeoutMs };
  assert.doesNotThrow(() => validateIntegrationRequest(request), `Integration API accepts ${timeoutMs}ms step timeout`);
}
const overLimitWorkflow = validEnvelope("workflow.create", workflowTimeoutDescriptor);
overLimitWorkflow.params.workflow.steps[0].completion = { mode: "load", timeoutMs: MAX_WORKFLOW_STEP_TIMEOUT_MS + 1 };
assert.throws(
  () => validateIntegrationRequest(overLimitWorkflow),
  (error) => error?.code === INTEGRATION_ERROR_CODES.BAD_REQUEST,
  "Integration API rejects max+1 step timeout"
);

const stableCodes = Object.values(INTEGRATION_ERROR_CODES);
assert.equal(new Set(stableCodes).size, stableCodes.length, "integration error names must be unique");
for (const code of stableCodes) {
  assert.equal(structuredIntegrationError(new IntegrationError(code, "private detail")).code, code, code + " must remain stable through public error projection");
}

let policy = {
  enabled: true,
  trustedExtensionIds: [TRUSTED],
  allowDestructive: true,
  allowDirect: false
};
const stateManager = {
  getBootId: () => BOOT,
  getRevision: () => 0,
  getState: async () => ({ global: { integration: policy }, profiles: {}, routes: {}, scripts: {}, workflows: {}, personaRotations: {} })
};
const fn = async () => ({});
const list = async () => [];
const fullFacade = {
  PersonaManager: { list, get: fn, create: fn, open: fn, updateIdentity: fn, archive: fn, destroy: fn },
  StorageManager: { inspect: fn, clearCookies: fn, clearSiteData: fn, fullWipe: fn },
  RouteManager: { list, get: fn, assign: fn, test: fn },
  UserscriptManager: { list, get: fn, assign: fn, unassign: fn },
  WorkflowRunner: {
    list, get: fn, create: fn, update: fn, delete: fn, run: fn, listJobs: list, getJob: fn,
    stopJob: fn, clearFinishedJobs: fn, runExternalExecution: fn, listExternalExecutions: list,
    getExternalExecution: fn, findExternalExecutionByOperation: fn, getExternalExecutionResult: fn,
    stopExternalExecution: fn, acknowledgeExternalExecution: fn, focusExternalExecution: fn,
    getExternalExecutionContext: fn
  },
  Diagnostics: { getSystemStatus: fn }
};
const operationStore = { get: async () => null, put: async (_sender, _operation, record) => record };
const integration = createManagementIntegration({ personaApi: fullFacade, stateManager, operationStore, selfExtensionId: "self@example.test" });
const requestDescribe = () => integration.handleExternalRequest({
  type: INTEGRATION_REQUEST_TYPE,
  version: INTEGRATION_PROTOCOL_VERSION,
  requestId: "describe",
  command: "system.describe",
  params: {}
}, { id: TRUSTED });

let described = await requestDescribe();
assert.equal(described.ok, true);
assert.deepEqual(integration.listCommands().sort(), descriptorNames);
assert.deepEqual(
  described.result.commands.map((entry) => entry.command).sort(),
  descriptorNames,
  "full facade discovery must advertise every usable descriptor command"
);
for (const entry of described.result.commands) {
  const source = INTEGRATION_COMMAND_DESCRIPTORS[entry.command];
  assert.equal(entry.capability, source.capability);
  assert.equal(entry.mutating, source.mutating);
  assert.equal(entry.destructive, source.destructive);
  assert.equal(entry.batchable, source.batchable);
  assert.deepEqual(entry.required, source.required);
  assert.deepEqual(entry.params, source.params);
}

for (const [command, descriptor] of Object.entries(INTEGRATION_COMMAND_DESCRIPTORS)) {
  const response = await integration.handleExternalRequest(validEnvelope(command, descriptor), { id: TRUSTED });
  assert.notEqual(response.error?.code, INTEGRATION_ERROR_CODES.UNKNOWN_COMMAND, command + " must reach an executable dispatcher branch");
  assert.notEqual(response.error?.code, INTEGRATION_ERROR_CODES.CAPABILITY_UNAVAILABLE, command + " must be usable when its facade method is present");
}

policy = { ...policy, allowDestructive: false };
described = await requestDescribe();
assert.equal(described.result.commands.some((entry) => entry.destructive), false, "destructive commands must not be advertised without local authority");
policy = { ...policy, allowDestructive: true };

const partialFacade = {
  ...fullFacade,
  WorkflowRunner: { ...fullFacade.WorkflowRunner, create: undefined },
  UserscriptManager: undefined
};
const partial = createManagementIntegration({ personaApi: partialFacade, stateManager, operationStore, selfExtensionId: "self@example.test" });
const partialDescribe = await partial.handleExternalRequest({
  type: INTEGRATION_REQUEST_TYPE,
  version: INTEGRATION_PROTOCOL_VERSION,
  requestId: "partial-describe",
  command: "system.describe",
  params: {}
}, { id: TRUSTED });
assert.equal(partialDescribe.result.commands.some((entry) => entry.command === "workflow.create"), false);
assert.equal(partialDescribe.result.commands.some((entry) => entry.command.startsWith("userscript.")), false);

console.log("Integration command/catalog parity tests passed");
