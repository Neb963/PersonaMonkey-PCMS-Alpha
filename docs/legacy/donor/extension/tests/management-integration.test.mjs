import assert from "node:assert/strict";
import { createPcmsEventHub } from "../lib/pcms-events.js";
import {
  INTEGRATION_ERROR_CODES,
  INTEGRATION_EVENTS_PORT,
  INTEGRATION_PROTOCOL_VERSION,
  INTEGRATION_REQUEST_TYPE,
  EXTERNAL_AUTOMATION_LIMITS,
  normalizeIntegrationPolicy,
  sanitizeIntegrationValue,
  structuredIntegrationError,
  validateOwnerResultValue
} from "../lib/management-integration-protocol.js";
import {
  createIntegrationOperationStore,
  createManagementIntegration
} from "../lib/management-integration.js";

const TRUSTED_ID = "pcms@example.test";
const SECOND_TRUSTED_ID = "pcms-second@example.test";
const SELF_ID = "persona-route-manager@local";
const UID = "70000000-0000-4000-8000-000000000001";
const UID_2 = "70000000-0000-4000-8000-000000000002";
const UID_V7 = "70000000-0000-7000-8000-000000000007";
const OLD_ID = "firefox-container-old";

assert.equal(sanitizeIntegrationValue(Array.from({ length: 150 }, (_, index) => index)).length, 150);
assert.throws(() => sanitizeIntegrationValue({ value: "x".repeat(1024) }, { maxBytes: 100 }),
  (error) => error.code === INTEGRATION_ERROR_CODES.RESPONSE_TOO_LARGE);

const ownerResultFixture = {
  url: "https://provider.example/item?id=123#revision-4",
  source: "token = someProviderField",
  authorizationText: "Bearer this-is-provider-data"
};
assert.deepEqual(validateOwnerResultValue(ownerResultFixture), ownerResultFixture,
  "owner-only result validation must preserve legitimate strings exactly");
assert.throws(
  () => validateOwnerResultValue(JSON.parse('{"__proto__":{"polluted":true}}')),
  (error) => error.code === INTEGRATION_ERROR_CODES.VALIDATION_FAILED,
  "owner-only results must reject prototype-sensitive keys"
);
assert.deepEqual(
  sanitizeIntegrationValue({ secretRef: "secret-opaque-ref", secretValue: "must-not-leak" }),
  { secretRef: "secret-opaque-ref", secretValue: "[redacted]" },
  "opaque secret references must remain usable while secret values stay redacted"
);

for (const [error, expectedCode] of [
  [Object.assign(new Error("Operation ID conflict"), { code: "OPERATION_CONFLICT" }), INTEGRATION_ERROR_CODES.OPERATION_CONFLICT],
  [Object.assign(new Error("Execution is still running"), { code: "EXECUTION_NOT_TERMINAL" }), INTEGRATION_ERROR_CODES.RESULT_NOT_AVAILABLE],
  [new Error("Execution not found"), INTEGRATION_ERROR_CODES.EXECUTION_NOT_FOUND],
  [new Error("Execution has no active owned tab to focus"), INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE]
]) {
  assert.equal(structuredIntegrationError(error).code, expectedCode,
    `external execution service error must map to ${expectedCode}`);
}


const clone = (value) => structuredClone(value);

function makeStorageArea() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: clone(data[key]) }; },
    async set(values) { Object.assign(data, clone(values)); }
  };
}

function makeHarness(policyOverrides = {}, externalRuntime = {
  userScriptsPermission: false,
  userScriptsExecute: false,
  tabOwnership: false
}) {
  let revision = 4;
  const bootId = "boot-integration-test";
  const calls = [];
  const state = {
    schemaVersion: 3,
    global: {
      integration: {
        enabled: true,
        trustedExtensionIds: [TRUSTED_ID],
        allowDestructive: false,
        allowDirect: false,
        ...policyOverrides
      }
    },
    profiles: {
      [OLD_ID]: {
        containerId: OLD_ID,
        personaUid: UID,
        managed: true,
        name: "Existing",
        routeId: "__block__",
        status: "active"
      }
    },
    routes: {
      "route-safe": {
        id: "route-safe",
        name: "Safe",
        provider: "generic",
        type: "socks",
        host: "127.0.0.1",
        port: 1080,
        username: "route-user-secret",
        password: "route-password-secret",
        enabled: true
      }
    },
    scripts: {},
    workflows: {
      flow: {
        id: "flow",
        name: "Flow",
        enabled: true,
        steps: [{
          id: "step-1",
          profileId: OLD_ID,
          urls: ["https://example.test/private?token=workflow-secret"],
          scriptIds: ["private-script-assignment"],
          concurrency: 1,
          completion: { mode: "load", timeoutMs: 5000 },
          retries: 0,
          closeTabs: true,
          stopOnError: true
        }]
      }
    },
    personaRotations: {}
  };

  const personaByContainer = (id) => {
    const profile = state.profiles[id];
    return profile ? {
      id,
      personaUid: profile.personaUid,
      cookieStoreId: id,
      name: profile.name,
      status: profile.status,
      health: { status: "healthy", authorization: "Bearer health-secret" }
    } : null;
  };

  const facade = {
    PersonaManager: {
      async list() {
        return Object.values(state.profiles)
          .filter((profile) => profile.managed && !profile.rotationRole)
          .map((profile) => personaByContainer(profile.containerId));
      },
      async get(id) { return personaByContainer(id); },
      async create(input, options) {
        calls.push(["create", clone(input), clone(options)]);
        const id = `firefox-container-created-${calls.filter((row) => row[0] === "create").length}`;
        state.profiles[id] = {
          containerId: id,
          personaUid: input.profile?.personaUid,
          managed: true,
          name: input.name || "Persona",
          routeId: input.routeId || "__block__",
          status: "active"
        };
        revision += 1;
        return { profile: clone(state.profiles[id]), container: { cookieStoreId: id } };
      },
      async open(id, url, active, options) {
        calls.push(["open", id, url, active, clone(options)]);
        return { id: 900, cookieStoreId: id, url, active };
      },
      async updateIdentity(id, changes) {
        calls.push(["updateIdentity", id, clone(changes)]);
        state.profiles[id].name = changes.name || state.profiles[id].name;
        revision += 1;
        return { profile: clone(state.profiles[id]) };
      },
      async archive(id) {
        state.profiles[id].status = "archived";
        revision += 1;
        return { profile: clone(state.profiles[id]) };
      },
      async destroy(id) {
        calls.push(["destroy", id]);
        delete state.profiles[id];
        revision += 1;
        return true;
      }
    },
    StorageManager: {
      async inspect(id) {
        return {
          cookies: {
            count: 2,
            bytes: 120,
            byDomain: [{ domain: "example.test", count: 2 }],
            raw: [{ name: "sid", value: "cookie-value-secret" }]
          },
          activeTabs: 1,
          inspectedOrigins: ["https://private-origin.example.test/path"],
          note: "opaque-storage-note-secret",
          snapshot: "storage-private-secret"
        };
      },
      async clearCookies(id) {
        calls.push(["clearCookies", id]);
        return { cookies: 2 };
      },
      async clearSiteData(id) {
        calls.push(["clearSiteData", id]);
        return { siteData: true };
      },
      async fullWipe(personaUid, options = {}) {
        calls.push(["fullWipe", personaUid, clone(options)]);
        const source = Object.values(state.profiles).find((profile) => profile.personaUid === personaUid && !profile.rotationRole);
        if (!source) throw new Error("Managed persona not found");
        const oldId = source.containerId;
        const newId = "firefox-container-rotated";
        delete state.profiles[oldId];
        state.profiles[newId] = { ...source, containerId: newId };
        for (const workflow of Object.values(state.workflows)) {
          for (const step of workflow.steps || []) if (step.profileId === oldId) step.profileId = newId;
        }
        revision += 1;
        return {
          personaUid,
          oldCookieStoreId: oldId,
          newCookieStoreId: newId,
          operationId: "rotation-internal",
          correlationOperationId: options.correlationOperationId || null,
          profile: clone(state.profiles[newId])
        };
      }
    },
    RouteManager: {
      async list() { return Object.values(state.routes); },
      async get(routeId) { return state.routes[routeId] || null; },
      async assign(id, routeId, options) {
        calls.push(["assign", id, routeId, clone(options)]);
        state.profiles[id].routeId = routeId;
        revision += 1;
        return { profile: clone(state.profiles[id]), route: clone(state.routes[routeId] || { id: routeId, type: "direct", name: "Direct" }) };
      },
      async test(id) {
        calls.push(["test", id]);
        return {
          ok: true,
          data: {
            ip: "198.51.100.7",
            city: "Amsterdam",
            country: "NL",
            mullvad_exit_ip: true,
            answer: "opaque-route-secret"
          },
          dns: {
            checked: true,
            leaking: false,
            servers: [{ ip: "192.0.2.53", answer: "opaque-dns-secret" }]
          },
          mullvadNative: {
            installed: true,
            ready: true,
            details: "opaque-native-secret"
          },
          payload: { answer: "opaque-route-payload-secret" },
          error: null,
          connectionCheckError: null,
          checkedAt: "2026-09-24T00:00:00.000Z"
        };
      }
    },
    WorkflowRunner: {
      async list() { return Object.values(state.workflows).map(clone); },
      async get(id) { return state.workflows[id] ? clone(state.workflows[id]) : null; },
      async run(id) {
        calls.push(["workflow.run", id]);
        const profileId = Object.values(state.profiles).find((profile) => profile.personaUid === UID)?.containerId;
        return {
          id: "job-1",
          workflowId: id,
          workflowName: "Flow",
          state: "running",
          profileId,
          createdAt: "2026-09-24T00:00:00.000Z",
          currentStep: 0,
          totalSteps: 1,
          error: "opaque-job-secret",
          payload: { answer: "opaque-job-payload-secret" },
          tasks: [{
            id: "task-1",
            stepIndex: 0,
            profileId,
            state: "running",
            url: "https://example.test/private?answer=opaque-job-url-secret",
            result: { answer: "opaque-job-result-secret" },
            error: "opaque-task-secret"
          }]
        };
      },
      async runExternalExecution() { throw new Error("Not used by this harness"); },
      async getExternalExecution() { return null; },
      async getExternalExecutionContext() {
        return { senderId: TRUSTED_ID, executionId: "waiter-test-execution", stepId: "waiter-test-step", taskId: "waiter-test-task", artifactId: "waiter-test-artifact" };
      },
      async listJobs() { return []; },
      async getJob() { return null; },
      async stopJob(id) { calls.push(["workflow.jobs.stop", id]); return { id, state: "stopping" }; },
      async clearFinishedJobs() { return []; }
    },
    Diagnostics: {
      async getSystemStatus() {
        return {
          security: {
            ready: true,
            privacySafe: true,
            networkPredictionSafe: true,
            webRTCSafe: true,
            proxyControl: "controlled_by_this_extension",
            initializedAt: "2026-01-01T00:00:00.000Z",
            snapshot: "diagnostic-secret"
          },
          managedPersonaCount: 1,
          routeHealth: { healthy: 1, blocked: 0, degraded: 0, unknown: 0 },
          runningWorkflowJobCount: 0,
          eventSequence: 3,
          snapshot: "diagnostic-private-secret"
        };
      }
    }
  };

  let mutationTail = Promise.resolve();
  const stateManager = {
    async getState() { return clone(state); },
    getRevision() { return revision; },
    getBootId() { return bootId; },
    async withWorkflowAdmissionLock(operation) {
      const queued = mutationTail.then(operation, operation);
      mutationTail = queued.catch(() => {});
      return queued;
    },
    async mutate(mutator, { expectedBootId, expectedRevision } = {}) {
      const queued = mutationTail.then(async () => {
        if (expectedBootId !== bootId || expectedRevision !== revision) {
          throw Object.assign(new Error("State revision conflict"), { code: INTEGRATION_ERROR_CODES.STATE_CONFLICT });
        }
        const draft = clone(state);
        const result = await mutator(draft);
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, draft);
        revision += 1;
        return { state: clone(state), result: clone(result), revision, bootId };
      });
      mutationTail = queued.catch(() => {});
      return queued;
    }
  };
  const storageArea = makeStorageArea();
  const eventHub = createPcmsEventHub({ bootId, getRevision: () => revision });
  const operationStore = createIntegrationOperationStore(storageArea);
  const integration = createManagementIntegration({
    personaApi: facade,
    stateManager,
    sourceEventHub: eventHub,
    operationStore,
    productVersion: "0.8.0-test",
    selfExtensionId: SELF_ID,
    getExternalRuntimeAvailability: async () => externalRuntime
  });

  const envelope = (command, params = {}, overrides = {}) => {
    const meta = integrationCommandNeedsOperation(command)
      ? {
          operationId: `op-${command}-${Math.random()}`,
          precondition: { bootId, revision }
        }
      : {};
    return {
      type: INTEGRATION_REQUEST_TYPE,
      version: INTEGRATION_PROTOCOL_VERSION,
      requestId: `req-${command}-${Math.random()}`,
      command,
      params,
      ...meta,
      ...overrides
    };
  };

  const request = (command, params = {}, overrides = {}, senderId = TRUSTED_ID) =>
    integration.handleExternalRequest(envelope(command, params, overrides), { id: senderId });

  return {
    bootId,
    calls,
    envelope,
    eventHub,
    facade,
    integration,
    operationStore,
    request,
    setRevision(value) { revision = value; },
    get revision() { return revision; },
    state,
    storageArea,
    stateManager
  };
}

function integrationCommandNeedsOperation(command) {
  return ![
    "system.describe", "system.status", "persona.list", "persona.get",
    "storage.inspect", "route.list", "route.get", "userscript.list", "userscript.get",
    "userscript.artifact.list", "userscript.artifact.get", "workflow.list",
    "workflow.get", "workflow.jobs.list", "workflow.jobs.get", "persona.control.get", "execution.list",
    "execution.get", "execution.result.get"
  ].includes(command);
}

{
  const storageArea = makeStorageArea();
  const store = createIntegrationOperationStore(storageArea);
  await Promise.all([
    store.put("a@example.test", "op-a", { command: "persona.create", fingerprint: "a", state: "pending" }),
    store.put("b@example.test", "op-b", { command: "storage.fullWipe", fingerprint: "b", state: "pending" })
  ]);
  assert.equal((await store.get("a@example.test", "op-a")).command, "persona.create");
  assert.equal((await store.get("b@example.test", "op-b")).command, "storage.fullWipe");
}

{
  const storageArea = makeStorageArea();
  const store = createIntegrationOperationStore(storageArea, { limit: 8 });
  await store.put("pcms@example.test", "pending-a", {
    command: "persona.create", fingerprint: "pending-a", state: "pending"
  });
  for (let index = 0; index < 12; index += 1) {
    await store.put("pcms@example.test", `complete-${index}`, {
      command: "persona.create", fingerprint: `complete-${index}`, state: "complete"
    });
  }
  assert.equal((await store.get("pcms@example.test", "pending-a")).state, "pending", "completed history must not evict unresolved correlation records");

  for (let index = 1; index < 8; index += 1) {
    await store.put("pcms@example.test", `pending-${index}`, {
      command: "storage.fullWipe", fingerprint: `pending-${index}`, state: "pending"
    });
  }
  await assert.rejects(
    store.put("pcms@example.test", "pending-over-capacity", {
      command: "persona.create", fingerprint: "overflow", state: "pending"
    }),
    (error) => error?.code === INTEGRATION_ERROR_CODES.OPERATION_CAPACITY && error?.retryable === true
  );
}

{
  const storageArea = makeStorageArea();
  const store = createIntegrationOperationStore(storageArea, { limit: 32, pendingPerSender: 2 });
  for (const sender of ["a@example.test", "b@example.test"]) {
    await store.put(sender, "pending-1", { command: "persona.create", fingerprint: "1", state: "pending" });
    await store.put(sender, "pending-2", { command: "persona.create", fingerprint: "2", state: "pending" });
  }
  await assert.rejects(
    store.put("a@example.test", "pending-3", { command: "persona.create", fingerprint: "3", state: "pending" }),
    (error) => error?.code === INTEGRATION_ERROR_CODES.OPERATION_CAPACITY && error?.retryable === true,
    "one caller cannot consume another caller's pending-operation allowance"
  );
  assert.equal((await store.get("b@example.test", "pending-2")).state, "pending");
}

{
  // Completed correlation is intentionally bounded. After a completed record
  // is evicted, a caller-supplied UID still makes an old create retry
  // deterministic: it cannot create another logical Persona with that UID.
  const h = makeHarness();
  const first = await h.request("persona.create", {
    personaUid: UID_2,
    name: "Retained by UID"
  }, {
    operationId: "op-create-evicted",
    precondition: { bootId: h.bootId, revision: h.revision }
  });
  assert.equal(first.ok, true);
  const createdCount = h.calls.filter((row) => row[0] === "create").length;

  const boundedStore = createIntegrationOperationStore(h.storageArea, { limit: 8 });
  for (let index = 0; index < 12; index += 1) {
    await boundedStore.put(TRUSTED_ID, `completed-${index}`, {
      command: "persona.create",
      fingerprint: `completed-${index}`,
      state: "complete",
      result: { index }
    });
  }
  assert.equal(await boundedStore.get(TRUSTED_ID, "op-create-evicted"), null, "completed history should be allowed to evict old correlation records");
  const retainedNewest = await boundedStore.get(TRUSTED_ID, "completed-11");
  assert.equal(retainedNewest?.result?.index, 11, "same-millisecond pruning must retain the newest completed correlation record");

  const persistedLedgers = Object.values(h.storageArea.data).filter((value) =>
    value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).some((row) => row && typeof row === "object" && Object.hasOwn(row, "updatedOrder"))
  );
  assert.equal(persistedLedgers.length, 1, "test harness should contain exactly one persisted operation ledger");
  const persistedRows = Object.values(persistedLedgers[0]);
  assert.equal(persistedRows.length, 8, "bounded operation ledger must persist the configured number of newest records");
  assert.ok(persistedRows.every((row) => Number.isSafeInteger(row.updatedOrder) && row.updatedOrder > 0), "operation records must persist a deterministic monotonic order");

  const retried = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: INTEGRATION_PROTOCOL_VERSION,
    requestId: "retry-after-eviction",
    operationId: "op-create-evicted",
    command: "persona.create",
    precondition: { bootId: h.bootId, revision: h.revision },
    params: { personaUid: UID_2, name: "Retained by UID" }
  }, { id: TRUSTED_ID });
  assert.equal(retried.ok, false);
  assert.equal(retried.error.code, INTEGRATION_ERROR_CODES.PERSONA_UID_CONFLICT);
  assert.equal(h.calls.filter((row) => row[0] === "create").length, createdCount, "evicted correlation must not permit duplicate logical UID creation");
}

{
  const normalized = normalizeIntegrationPolicy({
    enabled: true,
    trustedExtensionIds: [
      "  pcms@example.test ",
      "pcms@example.test",
      "",
      "x".repeat(300),
      ...Array.from({ length: 30 }, (_, index) => `trusted-${index}@example.test`)
    ],
    allowDestructive: true,
    allowDirect: true,
    ignored: true
  });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.trustedExtensionIds[0], TRUSTED_ID);
  assert.equal(new Set(normalized.trustedExtensionIds).size, normalized.trustedExtensionIds.length);
  assert.ok(normalized.trustedExtensionIds.length <= 16);
  assert.equal(normalized.allowDestructive, true);
  assert.equal(normalized.allowDirect, true);
  assert.equal("ignored" in normalized, false);
}

{
  const h = makeHarness({ enabled: false });
  const denied = await h.request("system.describe");
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, INTEGRATION_ERROR_CODES.DISABLED);
}

{
  const h = makeHarness();
  const wrong = await h.request("system.describe", {}, {}, "unknown@example.test");
  assert.equal(wrong.error.code, INTEGRATION_ERROR_CODES.UNAUTHORIZED);
  const self = await h.request("system.describe", {}, {}, SELF_ID);
  assert.equal(self.error.code, INTEGRATION_ERROR_CODES.UNAUTHORIZED);
}

{
  const h = makeHarness();
  const badVersion = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: 99,
    requestId: "bad-version",
    command: "system.describe",
    params: {}
  }, { id: TRUSTED_ID });
  assert.equal(badVersion.error.code, INTEGRATION_ERROR_CODES.PROTOCOL_UNSUPPORTED);

  const unknownEnvelopeField = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: 1,
    requestId: "unknown-field",
    command: "system.describe",
    params: {},
    extra: true
  }, { id: TRUSTED_ID });
  assert.equal(unknownEnvelopeField.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST);

  const unknownParam = await h.integration.handleExternalRequest(h.envelope("persona.get", {
    personaUid: UID,
    profileId: OLD_ID
  }), { id: TRUSTED_ID });
  assert.equal(unknownParam.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST);

  const nestedExecutionRefs = await h.integration.handleExternalRequest(h.envelope("execution.start", {
    plan: {
      name: "Nested refs must not be accepted",
      steps: [{
        id: "step-1",
        personaUid: UID,
        urls: ["https://example.test/"],
        artifacts: ["artifact-1"]
      }],
      inputRefs: ["ignored-if-accepted"],
      secretRefs: ["ignored-if-accepted"]
    }
  }), { id: TRUSTED_ID });
  assert.equal(nestedExecutionRefs.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST,
    "execution refs belong only at params.inputRefs/secretRefs; nested refs must not be silently ignored");

  const emptyName = await h.request("persona.create", {
    personaUid: UID_2,
    name: ""
  });
  assert.equal(emptyName.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST);
  assert.equal(h.calls.some((row) => row[0] === "create"), false);

  for (const url of [
    "file:///tmp/private",
    "data:text/html,unsafe",
    "javascript:alert(1)",
    "about:config",
    "moz-extension://other/private.html",
    " https://example.test/"
  ]) {
    const invalidOpen = await h.request("persona.open", { personaUid: UID, url });
    assert.equal(invalidOpen.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST, `unsafe external open URL must be rejected: ${url}`);
  }
  assert.equal(h.calls.some((row) => row[0] === "open"), false);

  for (const createParams of [
    { personaUid: UID_2, name: "Bad expiry", expiresAt: "not-a-date" },
    { personaUid: UID_2, name: "Bad TTL low", temporary: true, ttlHours: 0 },
    { personaUid: UID_2, name: "Bad TTL high", temporary: true, ttlHours: 721 }
  ]) {
    const invalidCreate = await h.request("persona.create", createParams);
    assert.equal(invalidCreate.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST);
  }
  assert.equal(h.calls.some((row) => row[0] === "create"), false);

  const startupFailure = h.integration.failureResponse(
    { requestId: "startup-failure", operationId: "op-startup-failure" },
    new Error("password=initialization-secret")
  );
  assert.equal(startupFailure.ok, false);
  assert.equal(startupFailure.error.code, INTEGRATION_ERROR_CODES.INTERNAL_ERROR);
  assert.equal(JSON.stringify(startupFailure).includes("initialization-secret"), false);
  assert.equal(JSON.stringify(startupFailure).includes("management-integration.test.mjs"), false);

  const unknownCommand = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: 1,
    requestId: "unknown-command",
    command: "SAVE_STATE",
    params: {}
  }, { id: TRUSTED_ID });
  assert.equal(unknownCommand.error.code, INTEGRATION_ERROR_CODES.UNKNOWN_COMMAND);

  for (const type of ["SAVE_STATE", "PERSONA_API", "MULLVAD_STATUS", "PCMS_REQUEST"]) {
    const legacy = await h.integration.handleExternalRequest({ type }, { id: TRUSTED_ID });
    assert.equal(legacy.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST, `${type} must never enter the integration dispatcher`);
  }
}

{
  const h = makeHarness();
  const v7Create = await h.request("persona.create", {
    personaUid: UID_V7,
    name: "Version 7 UID"
  });
  assert.equal(v7Create.ok, true, "external UID validation must match persisted schema-3 UUID semantics");
  assert.equal(v7Create.result.persona.personaUid.toLowerCase(), UID_V7);
}

{
  const h = makeHarness({ allowDestructive: false });
  const denied = await h.request("persona.destroy", { personaUid: UID, confirm: true });
  assert.equal(denied.error.code, INTEGRATION_ERROR_CODES.DESTRUCTIVE_NOT_ALLOWED);
  assert.equal(h.calls.some((row) => row[0] === "destroy"), false);

  h.state.global.integration.allowDestructive = true;
  const missingConfirmation = await h.request("persona.destroy", { personaUid: UID, confirm: false });
  assert.equal(missingConfirmation.error.code, INTEGRATION_ERROR_CODES.DESTRUCTIVE_NOT_ALLOWED);
  assert.equal(h.calls.some((row) => row[0] === "destroy"), false);
}

{
  const h = makeHarness();
  const missingWorkflow = await h.request("workflow.get", { workflowId: "missing" });
  assert.equal(missingWorkflow.error.code, INTEGRATION_ERROR_CODES.WORKFLOW_NOT_FOUND);
  const missingJob = await h.request("workflow.jobs.get", { jobId: "missing" });
  assert.equal(missingJob.error.code, INTEGRATION_ERROR_CODES.JOB_NOT_FOUND);

  h.facade.WorkflowRunner.run = async () => { throw new Error("Workflow not found"); };
  const missingRun = await h.request("workflow.run", { workflowId: "missing" });
  assert.equal(missingRun.error.code, INTEGRATION_ERROR_CODES.WORKFLOW_NOT_FOUND);

  h.facade.RouteManager.assign = async () => {
    const error = new Error("Route is disabled");
    error.code = "ROUTE_DISABLED";
    throw error;
  };
  const disabledRoute = await h.request("route.assign", { personaUid: UID, routeId: "route-safe" });
  assert.equal(disabledRoute.error.code, INTEGRATION_ERROR_CODES.ROUTE_DISABLED);
}

{
  const h = makeHarness({ allowDestructive: true });
  h.facade.WorkflowRunner.stopJob = async () => { throw new Error("Job not found"); };
  const missingStop = await h.request("workflow.jobs.stop", { jobId: "missing", confirm: true });
  assert.equal(missingStop.error.code, INTEGRATION_ERROR_CODES.JOB_NOT_FOUND);
}

{
  const h = makeHarness({ allowDestructive: false });
  const deniedStop = await h.request("workflow.jobs.stop", { jobId: "job-1", confirm: true });
  assert.equal(deniedStop.error.code, INTEGRATION_ERROR_CODES.DESTRUCTIVE_NOT_ALLOWED);
  assert.equal(h.calls.some((row) => row[0] === "workflow.jobs.stop"), false);

  h.state.global.integration.allowDestructive = true;
  const missingStopConfirmation = await h.request("workflow.jobs.stop", { jobId: "job-1", confirm: false });
  assert.equal(missingStopConfirmation.error.code, INTEGRATION_ERROR_CODES.DESTRUCTIVE_NOT_ALLOWED);
  assert.equal(h.calls.some((row) => row[0] === "workflow.jobs.stop"), false);
}

{
  const h = makeHarness({ allowDirect: false });
  const denied = await h.request("route.assign", {
    personaUid: UID,
    routeId: "__direct__",
    allowDirect: true
  });
  assert.equal(denied.error.code, INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED);
  assert.equal(h.calls.some((row) => row[0] === "assign"), false);

  h.state.global.integration.allowDirect = true;
  const noIntent = await h.request("route.assign", {
    personaUid: UID,
    routeId: "__direct__",
    allowDirect: false
  });
  assert.equal(noIntent.error.code, INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED);

  const killSwitch = await h.integration.handleExternalRequest(h.envelope("persona.create", {
    personaUid: UID_2,
    name: "Unsafe",
    killSwitch: false
  }), { id: TRUSTED_ID });
  assert.equal(killSwitch.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST);

  const unmanagedPolicy = await h.integration.handleExternalRequest(h.envelope("route.assign", {
    personaUid: UID,
    routeId: "__block__",
    unmanagedPolicy: "direct"
  }), { id: TRUSTED_ID });
  assert.equal(unmanagedPolicy.error.code, INTEGRATION_ERROR_CODES.BAD_REQUEST);
}

{
  const h = makeHarness({ allowDirect: true });
  const originalGetState = h.stateManager.getState.bind(h.stateManager);
  let reads = 0;
  h.stateManager.getState = async () => {
    const snapshot = await originalGetState();
    reads += 1;
    if (reads === 2) h.state.global.integration.allowDirect = false;
    return snapshot;
  };
  const directCreate = await h.request("persona.create", {
    personaUid: UID_2, name: "Direct race", routeId: "__direct__", allowDirect: true
  });
  assert.equal(directCreate.error.code, INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED,
    "Direct create rechecks durable authority immediately before the Persona side effect");
  assert.equal(h.calls.some((row) => row[0] === "create"), false);
  h.integration.dispose();

  const assign = makeHarness({ allowDirect: true });
  const assignGetState = assign.stateManager.getState.bind(assign.stateManager);
  let assignReads = 0;
  assign.stateManager.getState = async () => {
    const snapshot = await assignGetState();
    assignReads += 1;
    if (assignReads === 2) assign.state.global.integration.allowDirect = false;
    return snapshot;
  };
  const directAssign = await assign.request("route.assign", { personaUid: UID, routeId: "__direct__", allowDirect: true });
  assert.equal(directAssign.error.code, INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED,
    "Direct route assignment also rechecks current local authority at the side-effect boundary");
  assert.equal(assign.calls.some((row) => row[0] === "assign"), false);
  assign.integration.dispose();
}

{
  const h = makeHarness();
  const staleBoot = await h.request("route.assign", {
    personaUid: UID,
    routeId: "route-safe"
  }, {
    operationId: "op-stale-boot",
    precondition: { bootId: "old-boot", revision: h.revision }
  });
  assert.equal(staleBoot.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT);
  assert.equal(h.calls.some((row) => row[0] === "assign"), false);

  const staleRevision = await h.request("route.assign", {
    personaUid: UID,
    routeId: "route-safe"
  }, {
    operationId: "op-stale-revision",
    precondition: { bootId: h.bootId, revision: h.revision + 1 }
  });
  assert.equal(staleRevision.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT);
  assert.deepEqual(staleRevision.error.details, {
    expectedBootId: h.bootId,
    actualBootId: h.bootId,
    expectedRevision: h.revision + 1,
    actualRevision: h.revision
  });
}

{
  const h = makeHarness();
  h.facade.PersonaManager.updateIdentity = async () => {
    const error = new Error("service conflict with private diagnostics");
    error.code = "STATE_CONFLICT";
    error.retryable = true;
    error.details = {
      expectedBootId: h.bootId,
      actualBootId: h.bootId,
      expectedRevision: h.revision,
      actualRevision: h.revision + 1,
      payload: "opaque-error-detail-secret",
      nested: { answer: "opaque-error-nested-secret" }
    };
    throw error;
  };
  const serviceConflict = await h.request("persona.updateIdentity", {
    personaUid: UID,
    changes: { name: "No change" }
  }, {
    operationId: "op-service-conflict-details",
    precondition: { bootId: h.bootId, revision: h.revision }
  });
  assert.equal(serviceConflict.ok, false);
  assert.equal(serviceConflict.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT);
  assert.deepEqual(serviceConflict.error.details, {
    expectedBootId: h.bootId,
    actualBootId: h.bootId,
    expectedRevision: h.revision,
    actualRevision: h.revision + 1
  });
  assert.equal(JSON.stringify(serviceConflict).includes("opaque-error-detail-secret"), false);
  assert.equal(JSON.stringify(serviceConflict).includes("opaque-error-nested-secret"), false);

  const routeError = new Error("Route not found");
  routeError.code = "ROUTE_NOT_FOUND";
  routeError.details = { payload: "opaque-route-error-secret" };
  h.facade.RouteManager.get = async () => { throw routeError; };
  const missingRoute = await h.request("route.get", { routeId: "route-private-error" });
  assert.equal(missingRoute.error.code, INTEGRATION_ERROR_CODES.ROUTE_NOT_FOUND);
  assert.equal(missingRoute.error.details, null, "non-conflict service errors must not forward arbitrary details");
  assert.equal(JSON.stringify(missingRoute).includes("opaque-route-error-secret"), false);
}

{
  const h = makeHarness();
  const first = await h.request("persona.create", {
    personaUid: UID_2,
    name: "Created"
  }, {
    operationId: "op-create-stable",
    precondition: { bootId: h.bootId, revision: h.revision }
  });
  assert.equal(first.ok, true);
  assert.equal(first.result.persona.personaUid, UID_2);
  assert.equal("id" in first.result.persona, false);
  const createCalls = h.calls.filter((row) => row[0] === "create").length;

  const retry = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: 1,
    requestId: "retry-create",
    operationId: "op-create-stable",
    command: "persona.create",
    precondition: { bootId: "stale-after-success", revision: 0 },
    params: { personaUid: UID_2, name: "Created" }
  }, { id: TRUSTED_ID });
  assert.equal(retry.ok, true, "completed correlated create retry must not require the stale original precondition");
  assert.equal(h.calls.filter((row) => row[0] === "create").length, createCalls);

  const direct = makeHarness({ allowDirect: true });
  const directCreated = await direct.request("persona.create", {
    personaUid: UID_2,
    name: "Direct completed retry",
    routeId: "__direct__",
    allowDirect: true
  }, {
    operationId: "op-create-direct-complete",
    precondition: { bootId: direct.bootId, revision: direct.revision }
  });
  assert.equal(directCreated.ok, true);
  const directCreateCalls = direct.calls.filter((row) => row[0] === "create").length;
  direct.state.global.integration.allowDirect = false;
  const directRetry = await direct.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: INTEGRATION_PROTOCOL_VERSION,
    requestId: "retry-direct-after-revocation",
    operationId: "op-create-direct-complete",
    command: "persona.create",
    precondition: { bootId: "stale-after-success", revision: 0 },
    params: {
      personaUid: UID_2,
      name: "Direct completed retry",
      routeId: "__direct__",
      allowDirect: true
    }
  }, { id: TRUSTED_ID });
  assert.equal(directRetry.ok, true, "completed create correlation lookup should survive later Direct-authority revocation");
  assert.equal(direct.calls.filter((row) => row[0] === "create").length, directCreateCalls);

  const intentBound = makeHarness({ allowDirect: true });
  const intentCreate = await intentBound.request("persona.create", {
    personaUid: UID_2, name: "Intent fingerprint", routeId: "route-safe", allowDirect: true
  }, {
    operationId: "op-create-intent-fingerprint",
    precondition: { bootId: intentBound.bootId, revision: intentBound.revision }
  });
  assert.equal(intentCreate.ok, true);
  const changedIntentRetry = await intentBound.integration.handleExternalRequest({
    ...intentBound.envelope("persona.create", {
      personaUid: UID_2, name: "Intent fingerprint", routeId: "route-safe", allowDirect: false
    }),
    requestId: "intent-fingerprint-retry",
    operationId: "op-create-intent-fingerprint",
    precondition: { bootId: intentBound.bootId, revision: intentBound.revision }
  }, { id: TRUSTED_ID });
  assert.equal(changedIntentRetry.error.code, INTEGRATION_ERROR_CODES.OPERATION_CONFLICT,
    "Direct intent remains part of the correlated fingerprint when a safe route is selected");
  intentBound.integration.dispose();

  const duplicateUid = await h.request("persona.create", {
    personaUid: UID_2,
    name: "Different logical create"
  }, {
    operationId: "op-create-different",
    precondition: { bootId: h.bootId, revision: h.revision }
  });
  assert.equal(duplicateUid.error.code, INTEGRATION_ERROR_CODES.PERSONA_UID_CONFLICT);
  assert.equal(h.calls.filter((row) => row[0] === "create").length, createCalls);

  const operationConflict = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: 1,
    requestId: "reuse-op-different-payload",
    operationId: "op-create-stable",
    command: "persona.create",
    precondition: { bootId: h.bootId, revision: h.revision },
    params: { personaUid: UID_2, name: "Changed name" }
  }, { id: TRUSTED_ID });
  assert.equal(operationConflict.error.code, INTEGRATION_ERROR_CODES.OPERATION_CONFLICT);
}

{
  // Pending correlation keeps logical operation identity separate from the
  // boot-scoped concurrency guard. A retry may refresh the precondition while
  // preserving operationId, command, and params.
  const h = makeHarness();
  const originalCreate = h.facade.PersonaManager.create;
  h.facade.PersonaManager.create = async () => { throw new Error("transient create failure"); };
  const params = { personaUid: UID_2, name: "Resume pending create" };

  const first = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: INTEGRATION_PROTOCOL_VERSION,
    requestId: "pending-create-first",
    operationId: "op-create-refresh-precondition",
    command: "persona.create",
    precondition: { bootId: h.bootId, revision: h.revision },
    params
  }, { id: TRUSTED_ID });
  assert.equal(first.ok, false);
  assert.equal(first.error.code, INTEGRATION_ERROR_CODES.INTERNAL_ERROR);

  h.setRevision(h.revision + 1);
  const refreshedRevision = h.revision;
  h.facade.PersonaManager.create = originalCreate;
  const retry = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: INTEGRATION_PROTOCOL_VERSION,
    requestId: "pending-create-retry",
    operationId: "op-create-refresh-precondition",
    command: "persona.create",
    precondition: { bootId: h.bootId, revision: refreshedRevision },
    params
  }, { id: TRUSTED_ID });
  assert.equal(retry.ok, true);
  assert.equal(retry.result.persona.personaUid, UID_2);
  assert.equal(h.calls.filter((row) => row[0] === "create").length, 1, "pending retry must perform exactly one successful create");
  const createCall = h.calls.find((row) => row[0] === "create");
  assert.equal(createCall?.[2]?.expectedRevision, refreshedRevision, "pending retry must forward the refreshed revision");
  assert.equal(createCall?.[2]?.expectedBootId, h.bootId, "pending retry must forward the current boot ID");
}

{
  const h = makeHarness();
  let firstEntered;
  let releaseFirst;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const hold = new Promise((resolve) => { releaseFirst = resolve; });
  const originalCreate = h.facade.PersonaManager.create;
  h.facade.PersonaManager.create = async (...args) => {
    firstEntered();
    await hold;
    return originalCreate(...args);
  };
  const raw = {
    type: INTEGRATION_REQUEST_TYPE,
    version: 1,
    operationId: "op-concurrent",
    command: "persona.create",
    precondition: { bootId: h.bootId, revision: h.revision },
    params: { personaUid: UID_2, name: "Concurrent" }
  };
  const a = h.integration.handleExternalRequest({ ...raw, requestId: "concurrent-a" }, { id: TRUSTED_ID });
  await entered;
  const b = h.integration.handleExternalRequest({ ...raw, requestId: "concurrent-b" }, { id: TRUSTED_ID });
  releaseFirst();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(h.calls.filter((row) => row[0] === "create").length, 1, "correlated concurrent retries must create once");
}

{
  const h = makeHarness({ allowDestructive: true });
  const beforeRevision = h.revision;
  const externalOperationId = `external-op-${"x".repeat(244)}`;
  assert.equal(externalOperationId.length, 256);
  const first = await h.request("storage.fullWipe", {
    personaUid: UID,
    confirm: true
  }, {
    operationId: externalOperationId,
    precondition: { bootId: h.bootId, revision: beforeRevision }
  });
  assert.equal(first.ok, true);
  assert.equal(first.result.personaUid, UID);
  assert.equal(first.result.oldCookieStoreId, OLD_ID);
  assert.equal(first.result.newCookieStoreId, "firefox-container-rotated");
  assert.equal(first.result.operationId, externalOperationId);
  assert.equal(first.result.rotationOperationId, "rotation-internal");
  const wipeInvocation = h.calls.find((row) => row[0] === "fullWipe");
  assert.equal(wipeInvocation[2].correlationOperationId, externalOperationId, "full external operationId must be passed into the rotation journal");

  const requery = await h.request("persona.get", { personaUid: UID });
  assert.equal(requery.ok, true);
  assert.equal(requery.result.personaUid, UID);
  assert.equal(requery.result.cookieStoreId, "firefox-container-rotated");
  assert.equal("id" in requery.result, false);

  const wipeCalls = h.calls.filter((row) => row[0] === "fullWipe").length;
  const retry = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: 1,
    requestId: "wipe-retry",
    operationId: externalOperationId,
    command: "storage.fullWipe",
    precondition: { bootId: "stale-boot", revision: 0 },
    params: { personaUid: UID, confirm: true }
  }, { id: TRUSTED_ID });
  assert.equal(retry.ok, true);
  assert.equal(h.calls.filter((row) => row[0] === "fullWipe").length, wipeCalls, "completed wipe retry must not rotate twice");

  h.state.global.integration.allowDestructive = false;
  const retryAfterRevocation = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: INTEGRATION_PROTOCOL_VERSION,
    requestId: "wipe-retry-after-revocation",
    operationId: externalOperationId,
    command: "storage.fullWipe",
    precondition: { bootId: "stale-after-success", revision: 0 },
    params: { personaUid: UID, confirm: true }
  }, { id: TRUSTED_ID });
  assert.equal(retryAfterRevocation.ok, true, "completed wipe correlation lookup should survive later destructive-authority revocation");
  assert.equal(h.calls.filter((row) => row[0] === "fullWipe").length, wipeCalls, "revoked completed retry must not rotate twice");
}

{
  const h = makeHarness({ allowDestructive: false });
  const store = createIntegrationOperationStore(h.storageArea);
  await store.put(TRUSTED_ID, "op-wipe-pending-revoked", {
    command: "storage.fullWipe",
    fingerprint: JSON.stringify({
      command: "storage.fullWipe",
      params: { confirm: true, personaUid: UID }
    }),
    state: "pending",
    personaUid: UID,
    sourceCookieStoreId: OLD_ID
  });
  const deniedPending = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: INTEGRATION_PROTOCOL_VERSION,
    requestId: "wipe-pending-revoked",
    operationId: "op-wipe-pending-revoked",
    command: "storage.fullWipe",
    precondition: { bootId: h.bootId, revision: h.revision },
    params: { personaUid: UID, confirm: true }
  }, { id: TRUSTED_ID });
  assert.equal(deniedPending.ok, false);
  assert.equal(deniedPending.error.code, INTEGRATION_ERROR_CODES.DESTRUCTIVE_NOT_ALLOWED);
  assert.equal(h.calls.some((row) => row[0] === "fullWipe"), false, "pending wipe must not resume after destructive authority is revoked");
}

{
  const h = makeHarness({ allowDestructive: true });
  const operationStore = createIntegrationOperationStore(h.storageArea);
  await operationStore.put(TRUSTED_ID, "op-wipe-ambiguous", {
    command: "storage.fullWipe",
    fingerprint: JSON.stringify({
      command: "storage.fullWipe",
      params: { confirm: true, personaUid: UID }
    }),
    state: "pending",
    personaUid: UID,
    sourceCookieStoreId: OLD_ID
  });
  const source = h.state.profiles[OLD_ID];
  delete h.state.profiles[OLD_ID];
  h.state.profiles["firefox-container-after-lost-response"] = {
    ...source,
    containerId: "firefox-container-after-lost-response"
  };
  const recovered = await h.integration.handleExternalRequest({
    type: INTEGRATION_REQUEST_TYPE,
    version: 1,
    requestId: "wipe-ambiguous-retry",
    operationId: "op-wipe-ambiguous",
    command: "storage.fullWipe",
    precondition: { bootId: "stale-original-boot", revision: 0 },
    params: { personaUid: UID, confirm: true }
  }, { id: TRUSTED_ID });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.result.recovered, true);
  assert.equal(recovered.result.oldCookieStoreId, OLD_ID);
  assert.equal(recovered.result.newCookieStoreId, "firefox-container-after-lost-response");
  assert.equal(h.calls.some((row) => row[0] === "fullWipe"), false);
}

{
  const h = makeHarness();
  const describe = await h.request("system.describe");
  assert.equal(describe.ok, true);
  assert.equal(describe.result.integrationProtocolVersion, 1);
  assert.equal(describe.result.managementProtocolVersion, 1);
  assert.equal(describe.result.stateSchemaVersion, 3);
  assert.equal(describe.result.authority.allowDirect, false);
  assert.equal(describe.result.authority.allowDestructive, false);
  assert.equal(describe.result.externalAutomation.enabled, false);
  assert.equal(describe.result.externalAutomation.executionAvailable, false);
  const createMeta = describe.result.commands.find((entry) => entry.command === "persona.create");
  const wipeMeta = describe.result.commands.find((entry) => entry.command === "storage.fullWipe");
  const runMeta = describe.result.commands.find((entry) => entry.command === "workflow.run");
  const executionStartMeta = describe.result.commands.find((entry) => entry.command === "execution.start");
  const stopMeta = describe.result.commands.find((entry) => entry.command === "workflow.jobs.stop");
  assert.equal(createMeta.batchable, false);
  assert.equal(createMeta.retry, "bounded-operation-correlation");
  assert.equal(wipeMeta, undefined, "locally unauthorized destructive commands must not be advertised");
  assert.equal(stopMeta, undefined, "locally unauthorized destructive commands must not be advertised");
  assert.equal("exactlyOnce" in createMeta, false, "discovery must not overclaim distributed exactly-once semantics");
  assert.equal(describe.result.commands.every((entry) => typeof entry.batchable === "boolean"), true);
  assert.equal(runMeta.retry, "bounded-operation-correlation");
  assert.equal(executionStartMeta.available, false, "execution.start requires Firefox runtime readiness as well as a service method");
  assert.equal(executionStartMeta.authorized, false, "missing Firefox runtime must not be reported as currently authorized to execute");
  assert.equal(createMeta.identifiers.personaUid, "durable-persona-uid");

  h.state.global.integration.allowDestructive = true;
  const destructiveDescribe = await h.request("system.describe");
  const authorizedWipe = destructiveDescribe.result.commands.find((entry) => entry.command === "storage.fullWipe");
  const authorizedStop = destructiveDescribe.result.commands.find((entry) => entry.command === "workflow.jobs.stop");
  assert.equal(authorizedWipe.retry, "bounded-operation-correlation");
  assert.equal(authorizedStop.destructive, true);
  assert.equal(authorizedStop.params.confirm.type, "boolean");

  h.facade.PersonaManager.list = async () => [{
    id: OLD_ID,
    containerId: OLD_ID,
    personaUid: UID,
    name: "Work",
    managed: true,
    health: {
      status: "error",
      reason: "opaque-health-diagnostic-secret",
      routeId: "route-safe",
      routeName: "Safe route",
      protected: true,
      proxy: false,
      dns: false
    }
  }];
  const listed = await h.request("persona.list");
  assert.equal(listed.result[0].personaUid, UID);
  assert.equal(listed.result[0].cookieStoreId, OLD_ID);
  assert.equal("id" in listed.result[0], false);
  assert.equal(listed.result[0].health.reason, "Route verification failed");
  assert.equal(JSON.stringify(listed).includes("opaque-health-diagnostic-secret"), false);

  const got = await h.request("persona.get", { personaUid: UID });
  assert.equal(got.result.cookieStoreId, OLD_ID);

  const opened = await h.request("persona.open", {
    personaUid: UID,
    url: "https://example.test/",
    active: false
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.result.personaUid, UID);
  assert.equal(opened.result.cookieStoreId, OLD_ID);
  const openCall = h.calls.find((row) => row[0] === "open");
  assert.equal(openCall[4].expectedBootId, h.bootId);
  assert.equal(openCall[4].expectedRevision, h.revision);

  const assigned = await h.request("route.assign", {
    personaUid: UID,
    routeId: "route-safe"
  });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.result.persona.personaUid, UID);
  assert.equal(assigned.result.persona.cookieStoreId, OLD_ID);
  assert.equal(h.calls.at(-1)[0], "assign");
  assert.equal(h.calls.at(-1)[1], OLD_ID);
  assert.equal(h.calls.at(-1)[2], "route-safe");

  const tested = await h.request("route.test", { personaUid: UID });
  assert.equal(tested.ok, true);
  assert.deepEqual(tested.result.exit, {
    ip: "198.51.100.7",
    city: "Amsterdam",
    country: "NL",
    mullvadExit: true
  });
  assert.deepEqual(tested.result.dns, { checked: true, leaking: false, serverCount: 1 });
  assert.deepEqual(tested.result.native, { installed: true, ready: true });
  for (const secret of [
    "opaque-route-secret",
    "opaque-dns-secret",
    "opaque-native-secret",
    "opaque-route-payload-secret"
  ]) assert.equal(JSON.stringify(tested).includes(secret), false, `route.test leaked ${secret}`);

  const workflow = await h.request("workflow.get", { workflowId: "flow" });
  assert.equal(workflow.ok, true);
  assert.equal(workflow.result.steps[0].personaUid, UID);
  assert.equal(workflow.result.steps[0].cookieStoreId, OLD_ID);
  assert.equal("profileId" in workflow.result.steps[0], false);
  assert.deepEqual(workflow.result.steps[0].urls, ["https://example.test/private"], "Stage 5 workflow URLs may be projected but credentials/query/hash data must be stripped");
  assert.deepEqual(workflow.result.steps[0].scriptIds, ["private-script-assignment"], "Stage 5 may expose installed userscript IDs needed for workflow lifecycle management");
  assert.equal(JSON.stringify(workflow).includes("workflow-secret"), false);

  const run = await h.request("workflow.run", { workflowId: "flow" });
  assert.equal(run.ok, true);
  assert.equal(run.result.personaUid, UID);
  assert.equal(run.result.cookieStoreId, OLD_ID);
  assert.equal(run.result.error, "Workflow failed");
  assert.equal(run.result.tasks[0].error, "Task failed");
  assert.equal(run.result.tasks[0].personaUid, UID);
  assert.equal(run.result.tasks[0].cookieStoreId, OLD_ID);
  assert.equal("url" in run.result.tasks[0], false);
  assert.equal("result" in run.result.tasks[0], false);
  for (const secret of [
    "opaque-job-secret",
    "opaque-job-payload-secret",
    "opaque-job-url-secret",
    "opaque-job-result-secret",
    "opaque-task-secret"
  ]) assert.equal(JSON.stringify(run).includes(secret), false, `workflow job projection leaked ${secret}`);

  const routes = await h.request("route.list");
  assert.equal(routes.ok, true);
  assert.equal(JSON.stringify(routes).includes("route-user-secret"), false);
  assert.equal(JSON.stringify(routes).includes("route-password-secret"), false);

  const storage = await h.request("storage.inspect", { personaUid: UID });
  assert.equal(storage.ok, true);
  assert.deepEqual(storage.result.cookieSummary, {
    count: 2,
    bytes: 120,
    domainCount: 1
  });
  assert.equal(storage.result.inspectedOriginCount, 1);
  assert.equal("inspectedOrigins" in storage.result, false);
  assert.equal("note" in storage.result, false);
  assert.equal(JSON.stringify(storage).includes("example.test"), false, "external storage summary must not expose cookie domains or inspected origins");
  assert.equal(JSON.stringify(storage).includes("cookie-value-secret"), false);
  assert.equal(JSON.stringify(storage).includes("opaque-storage-note-secret"), false);
  assert.equal(JSON.stringify(storage).includes("storage-private-secret"), false);

  const status = await h.request("system.status");
  assert.equal(status.ok, true);
  assert.equal(status.result.security.ready, true);
  assert.equal(status.result.managedPersonaCount, 1);
  assert.equal(JSON.stringify(status).includes("diagnostic-secret"), false);
  assert.equal(JSON.stringify(status).includes("diagnostic-private-secret"), false);

  h.facade.RouteManager.test = async () => ({
    ok: true,
    data: {
      ip: "198.51.100.9",
      city: "x".repeat(10_000),
      country: "Example",
      mullvad_exit_ip: false
    },
    payload: Array.from({ length: 100 }, () =>
      Array.from({ length: 100 }, (_, index) => `opaque-${index}-012345678901234567890123456789`))
  });
  const oversizedRouteTest = await h.request("route.test", { personaUid: UID });
  assert.equal(oversizedRouteTest.ok, true);
  assert.equal(oversizedRouteTest.result.exit.city.length, 128, "route-test public strings must be bounded before response serialization");
  assert.equal(JSON.stringify(oversizedRouteTest).includes("opaque-99"), false, "unknown oversized route-test payloads must be omitted");
}

{
  const ready = { userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true };
  for (const missing of ["userScriptsPermission", "userScriptsExecute", "tabOwnership"]) {
    const h = makeHarness({ allowExternalAutomation: true }, { ...ready, [missing]: false });
    const describe = await h.request("system.describe");
    const start = describe.result.commands.find((entry) => entry.command === "execution.start");
    assert.equal(describe.result.authority.allowExternalAutomation, true, `${missing}: enabled local authority should remain visible`);
    assert.equal(describe.result.externalAutomation.enabled, true, `${missing}: authority and readiness are distinct fields`);
    assert.equal(describe.result.externalAutomation.runtime[missing], false, `${missing}: runtime deficiency should be discoverable`);
    assert.equal(describe.result.externalAutomation.executionAvailable, false, `${missing}: execution must be unavailable`);
    assert.equal(start.available, false, `${missing}: execution.start must not be advertised as available`);
    assert.equal(start.authorized, false, `${missing}: execution.start must not be advertised as authorized`);
    h.integration.dispose();
  }

  const apiMissing = makeHarness({ allowExternalAutomation: true }, ready);
  apiMissing.facade.WorkflowRunner.runExternalExecution = undefined;
  const apiDescribe = await apiMissing.request("system.describe");
  assert.equal(apiDescribe.result.externalAutomation.executionAvailable, false, "missing runner method blocks readiness");
  assert.equal(apiDescribe.result.commands.some((entry) => entry.command === "execution.start"), false, "unimplemented command must not be advertised");
  apiMissing.integration.dispose();

  const available = makeHarness({ allowExternalAutomation: true }, ready);
  const availableDescribe = await available.request("system.describe");
  const availableStart = availableDescribe.result.commands.find((entry) => entry.command === "execution.start");
  assert.equal(availableDescribe.result.externalAutomation.executionAvailable, true);
  assert.equal(availableStart.available, true);
  assert.equal(availableStart.authorized, true);
  available.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  const describe = await h.request("system.describe");
  const limits = describe.result.externalAutomation.limits;
  for (const key of ["maxPendingSecrets", "maxSecretBytes", "maxSecretBytesPerSender", "maxContinuationInputBytes"]) {
    assert.equal(limits[key], EXTERNAL_AUTOMATION_LIMITS[key], `${key} must be discoverable to integration clients`);
  }

  const stagedRefs = [];
  for (let index = 0; index < EXTERNAL_AUTOMATION_LIMITS.maxSecretBytesPerSender / EXTERNAL_AUTOMATION_LIMITS.maxSecretBytes; index += 1) {
    const staged = await h.request("execution.secret.stage", {
      name: `secret-${index}`,
      value: "s".repeat(EXTERNAL_AUTOMATION_LIMITS.maxSecretBytes),
      stepIds: ["step-1"],
      artifactIds: ["artifact-1"],
      ttlMs: 60000
    });
    assert.equal(staged.ok, true, JSON.stringify(staged.error));
    assert.match(staged.result.secretRef, /^secret-[0-9a-f-]+$/i,
      "secret staging must return the usable owner-scoped opaque reference");
    stagedRefs.push(staged.result.secretRef);
  }
  const senderOverflow = await h.request("execution.secret.stage", {
    name: "secret-overflow",
    value: "x",
    stepIds: ["step-1"],
    artifactIds: ["artifact-1"],
    ttlMs: 60000
  });
  assert.equal(senderOverflow.error.code, INTEGRATION_ERROR_CODES.INPUT_CAPACITY,
    "the advertised per-sender staged-secret byte ceiling must be enforced");

  const longSecretContinuation = await h.request("execution.input.submit", {
    executionId: "missing-execution",
    waitId: "missing-wait",
    stepId: "step-1",
    taskId: "task-1",
    artifactId: "artifact-1",
    name: "verification-code",
    value: "v".repeat(9000),
    secret: true
  });
  assert.equal(longSecretContinuation.error.code, INTEGRATION_ERROR_CODES.INPUT_REQUEST_NOT_ACTIVE,
    "secret continuation values above the old 8192-character schema ceiling must reach waiter validation");

  for (const secretRef of stagedRefs) {
    const discarded = await h.request("execution.secret.discard", { secretRef });
    assert.equal(discarded.ok, true);
  }
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  h.facade.WorkflowRunner.getExternalExecution = async (_senderId, executionId) => ({
    executionId, state: "running", stepProgress: [{ index: 0, state: "running" }], tasks: []
  });
  const describe = await h.request("system.describe");
  assert.equal(describe.result.externalAutomation.limits.maxInputWaiters, EXTERNAL_AUTOMATION_LIMITS.maxInputWaiters,
    "waiter capacity must be discoverable to integration clients");
  const waiters = [];
  for (let index = 0; index < EXTERNAL_AUTOMATION_LIMITS.maxInputWaiters; index += 1) {
    const pending = h.integration.handleUserscriptInput({
      tabId: 1, scriptId: "script", action: "wait", args: { name: `input-${index}`, timeoutMs: 60000 }
    });
    waiters.push(pending.then((value) => ({ value }), (error) => ({ error })));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    h.integration.handleUserscriptInput({ tabId: 1, scriptId: "script", action: "wait", args: { name: "overflow", timeoutMs: 60000 } }),
    (error) => error.code === INTEGRATION_ERROR_CODES.INPUT_CAPACITY
  );

  const pendingWait = async (name) => {
    const status = await h.request("execution.get", { executionId: "waiter-test-execution" });
    assert.equal(status.ok, true, JSON.stringify(status));
    return status.result.waitingForInput.find((wait) => wait.name === name);
  };
  const submit = async (name) => {
    const wait = await pendingWait(name);
    return h.request("execution.input.submit", {
      executionId: "waiter-test-execution", waitId: wait.waitId, stepId: wait.stepId,
      taskId: wait.taskId, artifactId: wait.artifactId, name, value: `value-${name}`
    });
  };
  const first = await submit("input-0");
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(await waiters[0], { value: "value-input-0" });

  const reused = h.integration.handleUserscriptInput({
    tabId: 1, scriptId: "script", action: "wait", args: { name: "input-0", timeoutMs: 60000 }
  }).then((value) => ({ value }), (error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await submit("input-0");
  assert.equal(second.ok, true, "submitting a waiter must remove its key so it can be requested again");
  assert.deepEqual(await reused, { value: "value-input-0" });

  h.integration.dispose();
  const disposed = await Promise.all(waiters.slice(1));
  assert.ok(disposed.every((result) => result.error?.code === INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE),
    "dispose must reject and remove all outstanding waiters");
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  h.facade.WorkflowRunner.getExternalExecution = async (_senderId, executionId) => ({
    executionId, state: "running", stepProgress: [{ index: 0, state: "running" }], tasks: []
  });
  const expired = h.integration.handleUserscriptInput({
    tabId: 1, scriptId: "script", action: "wait", args: { name: "expires", timeoutMs: 1000 }
  }).then((value) => ({ value }), (error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const expiredResult = await expired;
  assert.equal(expiredResult.error?.code, INTEGRATION_ERROR_CODES.INPUT_EXPIRED, "expired waiters must reject and release their key");
  const afterExpiry = h.integration.handleUserscriptInput({
    tabId: 1, scriptId: "script", action: "wait", args: { name: "expires", timeoutMs: 60000 }
  }).then((value) => ({ value }), (error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = await h.request("execution.get", { executionId: "waiter-test-execution" });
  const wait = status.result.waitingForInput.find((item) => item.name === "expires");
  const submitted = await h.request("execution.input.submit", {
    executionId: "waiter-test-execution", waitId: wait.waitId, stepId: "waiter-test-step", taskId: wait.taskId,
    artifactId: "waiter-test-artifact", name: "expires", value: "renewed"
  });
  assert.equal(submitted.ok, true, "an expired waiter's key must be reusable");
  assert.deepEqual(await afterExpiry, { value: "renewed" });
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  let acknowledged = false;
  const runnerJob = {
    executionId: "status-shaped-execution", state: "completed", createdAt: "2026-09-27T00:00:00.000Z",
    startedAt: "2026-09-27T00:00:01.000Z", finishedAt: "2026-09-27T00:00:02.000Z",
    stepProgress: [{
      stepId: "step-public-4", index: 4, profileId: OLD_ID, state: "completed",
      completed: 1, failed: 0, stopped: 0, retrying: 0, active: 0, total: 1,
      startedAt: "2026-09-27T00:00:01.000Z", finishedAt: "2026-09-27T00:00:02.000Z"
    }],
    tasks: [{
      id: "task-shaped-1", stepIndex: 4, profileId: OLD_ID, state: "completed", attempts: 2,
      startedAt: "2026-09-27T00:00:01.100Z", finishedAt: "2026-09-27T00:00:01.900Z"
    }],
    ...(acknowledged ? { acknowledged: true } : {})
  };
  h.facade.WorkflowRunner.getExternalExecution = async (senderId, executionId) => {
    assert.equal(senderId, TRUSTED_ID, "execution status lookups stay owner-scoped");
    return { ...runnerJob, executionId, ...(acknowledged ? { acknowledged: true } : {}) };
  };
  h.facade.WorkflowRunner.listExternalExecutions = async (senderId) => {
    assert.equal(senderId, TRUSTED_ID, "execution lists stay owner-scoped");
    return [{ ...runnerJob, ...(acknowledged ? { acknowledged: true } : {}) }];
  };
  h.facade.WorkflowRunner.getExternalExecutionResult = async (senderId) => {
    assert.equal(senderId, TRUSTED_ID);
    return {
      executionId: "status-shaped-execution",
      provider: {
        url: "https://provider.example/item?id=123#revision-4",
        source: "token = someProviderField",
        authorizationText: "Bearer this-is-provider-data"
      },
      tasks: [{ taskId: "task-shaped-1", failure: { code: "USER_SCRIPT_ERROR", message: "safe" } }]
    };
  };
  h.facade.WorkflowRunner.acknowledgeExternalExecution = async (senderId) => {
    assert.equal(senderId, TRUSTED_ID);
    acknowledged = true;
    return { ...runnerJob, acknowledged: true };
  };
  const status = await h.request("execution.get", { executionId: "status-shaped-execution" });
  assert.equal(status.ok, true, JSON.stringify(status.error));
  assert.equal(status.result.progress[0].index, 4);
  assert.equal(status.result.progress[0].stepId, "step-public-4");
  assert.equal(status.result.progress[0].tasks[0].taskId, "task-shaped-1");
  assert.equal(status.result.progress[0].personaUid, UID);
  assert.equal(status.result.progress[0].failed, 0);
  assert.equal(status.result.progress[0].active, 0);
  assert.equal(status.result.progress[0].tasks[0].personaUid, UID);
  assert.equal(status.result.progress[0].tasks[0].attempts, 2);
  assert.equal(status.result.progress[0].tasks[0].failed, false);
  assert.equal(status.result.progress[0].tasks[0].startedAt, "2026-09-27T00:00:01.100Z");
  assert.equal(status.result.resultAvailable, true);
  const listed = await h.request("execution.list");
  assert.equal(listed.ok, true);
  assert.equal(listed.result[0].progress[0].index, 4);
  const result = await h.request("execution.result.get", { executionId: "status-shaped-execution" });
  assert.equal(result.ok, true);
  assert.equal(result.result.tasks[0].failure.code, "USER_SCRIPT_ERROR", "structured result codes survive the owner-only result projection");
  assert.equal(result.result.provider.url, "https://provider.example/item?id=123#revision-4",
    "owner-only result URLs must retain query and fragment");
  assert.equal(result.result.provider.source, "token = someProviderField",
    "owner-only result strings must not be token-redacted");
  assert.equal(result.result.provider.authorizationText, "Bearer this-is-provider-data",
    "owner-only result strings must not be bearer-redacted");
  const ack = await h.request("execution.result.ack", { executionId: "status-shaped-execution" });
  assert.equal(ack.ok, true);
  assert.equal(ack.result.acknowledged, true);
  assert.equal(ack.result.resultAvailable, false, "externalJobView's acknowledged:true field closes result availability");
  h.integration.dispose();
}

{
  const ready = { userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true };
  const h = makeHarness({ allowDirect: true, allowExternalAutomation: true }, ready);
  h.state.profiles[OLD_ID].routeId = "__direct__";

  for (const [command, params] of [
    ["persona.open", { personaUid: UID, url: "https://example.test/" }],
    ["route.test", { personaUid: UID }],
    ["workflow.run", { workflowId: "flow" }]
  ]) {
    const denied = await h.request(command, params);
    assert.equal(denied.ok, false, `${command} must require explicit Direct intent for an already-Direct Persona`);
    assert.equal(denied.error.code, INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED);
    const allowed = await h.request(command, { ...params, allowDirect: true });
    assert.equal(allowed.ok, true, `${command} should proceed when request intent and local Direct authority are both present`);
  }

  const duplicate = await h.request("execution.start", {
    plan: {
      name: "Duplicate steps",
      steps: [
        { id: "same-step", personaUid: UID, urls: ["https://example.test/a"], artifacts: ["artifact-a"] },
        { id: "same-step", personaUid: UID, urls: ["https://example.test/b"], artifacts: ["artifact-a"] }
      ]
    },
    allowDirect: true
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, INTEGRATION_ERROR_CODES.VALIDATION_FAILED,
    "duplicate external step IDs must be rejected before input/artifact scoping");

  h.state.global.integration.allowDirect = false;
  const startDenied = await h.request("execution.start", {
    plan: {
      name: "Direct start denied",
      steps: [{ id: "step-direct", personaUid: UID, urls: ["https://example.test/"], artifacts: ["artifact-a"] }]
    },
    allowDirect: true
  });
  assert.equal(startDenied.ok, false);
  assert.equal(startDenied.error.code, INTEGRATION_ERROR_CODES.DIRECT_NOT_ALLOWED,
    "execution.start must require durable local Direct authority as well as caller intent");
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  h.facade.WorkflowRunner.getExternalExecutionContext = async (_tabId, _scriptId) => ({
    senderId: TRUSTED_ID, executionId: "cancel-wait-execution", stepId: "step-cancel", taskId: "task-cancel", artifactId: "artifact-cancel"
  });
  h.facade.WorkflowRunner.stopExternalExecution = async (senderId, executionId) => {
    assert.equal(senderId, TRUSTED_ID);
    return { executionId, state: "stopping", stepProgress: [], tasks: [] };
  };
  const waiting = h.integration.handleUserscriptInput({
    tabId: 7, scriptId: "artifact-cancel", action: "wait", args: { name: "approval", timeoutMs: 60000 }
  }).then((value) => ({ value }), (error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cancelled = await h.request("execution.cancel", { executionId: "cancel-wait-execution" });
  assert.equal(cancelled.ok, true);
  assert.equal((await waiting).error.code, INTEGRATION_ERROR_CODES.EXECUTION_NOT_ACTIVE,
    "cancelling an execution promptly rejects its task's active human-input wait");
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  h.facade.WorkflowRunner.getExternalExecution = async (_senderId, executionId) => ({
    executionId, state: "running", stepProgress: [{ index: 0, state: "running" }], tasks: []
  });
  h.facade.WorkflowRunner.getExternalExecutionContext = async (_tabId, scriptId) => ({
    senderId: TRUSTED_ID,
    executionId: "same-step-execution",
    stepId: "same-step",
    taskId: _tabId === 1 ? "task-a" : "task-b",
    artifactId: scriptId
  });
  let firstSettled = false;
  const first = h.integration.handleUserscriptInput({
    tabId: 1, scriptId: "artifact-a", action: "wait", args: { name: "approval", timeoutMs: 60000 }
  }).then((value) => { firstSettled = true; return value; });
  const second = h.integration.handleUserscriptInput({
    tabId: 2, scriptId: "artifact-b", action: "wait", args: { name: "approval", timeoutMs: 60000 }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const status = await h.request("execution.get", { executionId: "same-step-execution" });
  const waitA = status.result.waitingForInput.find((wait) => wait.artifactId === "artifact-a");
  const waitB = status.result.waitingForInput.find((wait) => wait.artifactId === "artifact-b");
  assert.notEqual(waitA.waitId, waitB.waitId, "same-name waits must have unique wait identifiers");
  const wrongTask = await h.request("execution.input.submit", {
    executionId: "same-step-execution", waitId: waitB.waitId, stepId: "same-step", taskId: "task-a",
    artifactId: "artifact-b", name: "approval", value: "approved"
  });
  assert.equal(wrongTask.error.code, INTEGRATION_ERROR_CODES.INPUT_REQUEST_NOT_ACTIVE,
    "a waitId cannot be replayed into a parallel task");
  const submittedB = await h.request("execution.input.submit", {
    executionId: "same-step-execution", waitId: waitB.waitId, stepId: "same-step", taskId: "task-b",
    artifactId: "artifact-b", name: "approval", value: "approved-b"
  });
  assert.equal(submittedB.ok, true);
  assert.equal(await second, "approved-b");
  assert.equal(firstSettled, false, "a same-name wait from another artifact must not receive the response");
  const submittedA = await h.request("execution.input.submit", {
    executionId: "same-step-execution", waitId: waitA.waitId, stepId: "same-step", taskId: "task-a",
    artifactId: "artifact-a", name: "approval", value: "approved-a"
  });
  assert.equal(submittedA.ok, true);
  assert.equal(await first, "approved-a");
  h.integration.dispose();
}

{
  const h = makeHarness({
    allowExternalAutomation: true,
    trustedExtensionIds: [TRUSTED_ID, SECOND_TRUSTED_ID]
  });
  const lease = await h.request("persona.control.acquire", {
    personaUid: UID, purpose: "cross-integration visibility", ttlMs: 60000
  });
  assert.equal(lease.ok, true, JSON.stringify(lease.error));

  const foreign = await h.request("persona.control.get", { personaUid: UID }, {}, SECOND_TRUSTED_ID);
  assert.equal(foreign.ok, true, JSON.stringify(foreign.error));
  assert.equal(foreign.result.controlled, true);
  assert.equal(foreign.result.owner, "another-integration");
  assert.equal(foreign.result.personaUid, UID);
  assert.equal(foreign.result.acquiredAt, lease.result.acquiredAt);
  assert.equal(foreign.result.expiresAt, lease.result.expiresAt);
  assert.equal(Object.hasOwn(foreign.result, "leaseId"), false,
    "a foreign caller must not learn another integration's lease ID");
  assert.equal(Object.hasOwn(foreign.result, "purpose"), false,
    "a foreign caller must not learn another integration's lease purpose");

  const own = await h.request("persona.control.get", { personaUid: UID });
  assert.equal(own.ok, true, JSON.stringify(own.error));
  assert.equal(own.result.owner, "self");
  assert.equal(own.result.leaseId, lease.result.leaseId);
  assert.equal(own.result.purpose, "cross-integration visibility");
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  const lease = await h.request("persona.control.acquire", {
    personaUid: UID, purpose: "local override test", ttlMs: 60000
  });
  assert.equal(lease.ok, true);
  assert.equal(lease.result.leaseId != null, true);
  await assert.rejects(h.integration.runLocalWorkflow("flow"),
    (error) => error.code === INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY,
    "local workflow dispatch must require an explicit control override");
  await assert.rejects(h.integration.runLocalWorkflow("flow", true),
    (error) => error.code === INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY,
    "the legacy boolean must not authorize an unbound control override");
  const staleConfirmation = {
    expectedPersonaUids: [UID], leases: [], takeControl: false
  };
  await assert.rejects(h.integration.runLocalWorkflow("flow", staleConfirmation),
    (error) => error.code === INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST,
    "a lease acquired after a no-lease confirmation must block the run");
  const staleLeaseConfirmation = {
    expectedPersonaUids: [UID],
    leases: [{ personaUid: UID, leaseId: lease.result.leaseId }],
    takeControl: true
  };
  const released = await h.request("persona.control.release", { leaseId: lease.result.leaseId });
  assert.equal(released.ok, true, JSON.stringify(released.error));
  const reacquired = await h.request("persona.control.acquire", {
    personaUid: UID, purpose: "replacement lease", ttlMs: 60000
  });
  assert.equal(reacquired.ok, true);
  assert.notEqual(reacquired.result.leaseId, lease.result.leaseId);
  await assert.rejects(h.integration.runLocalWorkflow("flow", staleLeaseConfirmation),
    (error) => error.code === INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST,
    "release-and-reacquire after confirmation must not transfer the override to a new lease");
  assert.equal((await h.integration.listControlLeases())[0].leaseId, reacquired.result.leaseId,
    "a stale confirmation cannot stop the replacement lease");
  const confirmedLease = {
    expectedPersonaUids: [UID],
    leases: [{ personaUid: UID, leaseId: reacquired.result.leaseId }],
    takeControl: true
  };
  const localJob = await h.integration.runLocalWorkflow("flow", confirmedLease);
  assert.equal(localJob.id, "job-1");
  assert.deepEqual(await h.integration.listControlLeases(), [], "explicit local workflow override releases active control");

  let observedLimit;
  h.facade.WorkflowRunner.listJobs = async (limit) => {
    observedLimit = limit;
    return [{ id: "older-job", state: "running", profileId: OLD_ID }];
  };
  const reacquire = await h.request("persona.control.acquire", {
    personaUid: UID, purpose: "active job guard", ttlMs: 60000
  });
  assert.equal(observedLimit, 200, "lease checks request a broad ordinary job window using the numeric list API");
  assert.equal(reacquire.error.code, INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY);
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  const lease = await h.request("persona.control.acquire", {
    personaUid: UID, purpose: "settings override binding", ttlMs: 60000
  });
  assert.equal(lease.ok, true);
  const released = await h.request("persona.control.release", { leaseId: lease.result.leaseId });
  assert.equal(released.ok, true);
  const replacement = await h.request("persona.control.acquire", {
    personaUid: UID, purpose: "replacement after settings refresh", ttlMs: 60000
  });
  assert.equal(replacement.ok, true);
  assert.notEqual(replacement.result.leaseId, lease.result.leaseId);

  await assert.rejects(h.integration.overrideControlLocally(UID, lease.result.leaseId),
    (error) => error.code === INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST,
    "a stale settings action cannot override a replacement lease");
  assert.equal((await h.integration.listControlLeases())[0].leaseId, replacement.result.leaseId,
    "the replacement lease remains active after a stale override action");
  await assert.rejects(h.integration.overrideControlLocally(UID),
    (error) => error.code === INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_INVALID,
    "settings override requires the exact displayed lease ID");
  const overridden = await h.integration.overrideControlLocally(UID, replacement.result.leaseId);
  assert.equal(overridden.overridden, true);
  assert.deepEqual(await h.integration.listControlLeases(), []);
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let clock = realNow();
  const timers = [];
  Date.now = () => clock;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = { callback: () => callback(...args), delay, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
  try {
    const acquired = await h.request("persona.control.acquire", {
      personaUid: UID, purpose: "expiry validation race", ttlMs: 10000
    });
    assert.equal(acquired.ok, true);
    const scheduled = timers.filter((timer) => !timer.cleared);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 10000,
      "lease cleanup is scheduled for the nearest lease expiry instead of the 30-second maintenance sweep");

    let releaseValidation;
    let validationStarted;
    const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
    const validationEntered = new Promise((resolve) => { validationStarted = resolve; });
    const getState = h.stateManager.getState.bind(h.stateManager);
    let getStateCalls = 0;
    h.stateManager.getState = async () => {
      getStateCalls += 1;
      if (getStateCalls === 3) {
        validationStarted();
        await validationGate;
      }
      return getState();
    };
    const renewal = h.request("persona.control.renew", { leaseId: acquired.result.leaseId, ttlMs: 60000 });
    await validationEntered;
    clock += 10001;
    const expiryCallback = timers.filter((timer) => !timer.cleared).at(-1)?.callback;
    assert.equal(typeof expiryCallback, "function");
    expiryCallback();
    releaseValidation();
    const expiredRenewal = await renewal;
    assert.equal(expiredRenewal.ok, false);
    assert.equal(expiredRenewal.error.code, INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST,
      "a lease that expires during awaited Persona/state/route validation cannot be renewed or used");
    assert.deepEqual(await h.integration.listControlLeases(), [], "an expired lease is reaped immediately after validation returns");
  } finally {
    h.integration.dispose();
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

{
  const h = makeHarness({ allowExternalAutomation: true, allowExecutableInstall: true }, {
    userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true
  });
  h.facade.WorkflowRunner.listExternalExecutions = async () => [];
  h.facade.WorkflowRunner.runExternalExecution = async (_workflow, owner) => ({
    executionId: owner.executionId, operationId: owner.operationId, state: "queued", stepProgress: [], tasks: []
  });
  h.facade.UserscriptManager = {
    async list() { return Object.values(h.state.scripts).map(clone); },
    async assign(scriptId, profileId) {
      h.state.scripts[scriptId].profileIds = [...new Set([...(h.state.scripts[scriptId].profileIds || []), profileId])];
      return clone(h.state.scripts[scriptId]);
    }
  };
  const source = "// ==UserScript==\n// @name Ref rollback\n// @match https://example.test/*\n// @grant none\n// ==/UserScript==\n";
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const installed = await h.request("userscript.artifact.install", {
    artifactId: "ref-rollback-artifact", source, sha256: hash,
    provenance: { packageId: "test", packageVersion: "1.0.0", component: "ref-rollback" }
  });
  assert.equal(installed.ok, true, JSON.stringify(installed.error));
  const assigned = await h.request("userscript.artifact.assign", { artifactId: "ref-rollback-artifact", personaUid: UID });
  assert.equal(assigned.ok, true, JSON.stringify(assigned.error));
  const lease = await h.request("persona.control.acquire", { personaUid: UID, purpose: "input binding", ttlMs: 60000 });
  assert.equal(lease.ok, true);
  const emptyHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array()))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const goodRef = await h.request("execution.input.begin", {
    name: "good", mediaType: "application/octet-stream", byteLength: 0, sha256: emptyHash,
    stepIds: ["step-1"], artifactIds: ["ref-rollback-artifact"], ttlMs: 60000
  });
  const badRef = await h.request("execution.input.begin", {
    name: "wrong-scope", mediaType: "application/octet-stream", byteLength: 0, sha256: emptyHash,
    stepIds: ["other-step"], artifactIds: ["ref-rollback-artifact"], ttlMs: 60000
  });
  assert.equal(goodRef.ok, true); assert.equal(badRef.ok, true);
  assert.equal((await h.request("execution.input.commit", { inputRef: goodRef.result.inputRef })).ok, true);
  assert.equal((await h.request("execution.input.commit", { inputRef: badRef.result.inputRef })).ok, true);
  const plan = { name: "staged ref rollback", steps: [{
    id: "step-1", personaUid: UID, urls: ["https://example.test/"], artifacts: ["ref-rollback-artifact"],
    concurrency: 1, completion: { mode: "load", value: "", timeoutMs: 10000 }, retries: 0,
    retryDelayMs: 0, closeTabs: true, stopOnError: true
  }] };
  const invalidBind = await h.request("execution.start", { plan, inputRefs: [goodRef.result.inputRef, badRef.result.inputRef] });
  assert.equal(invalidBind.error.code, INTEGRATION_ERROR_CODES.INPUT_SCOPE_DENIED);
  const retryWithValidRef = await h.request("execution.start", { plan, inputRefs: [goodRef.result.inputRef] });
  assert.equal(retryWithValidRef.ok, true, JSON.stringify(retryWithValidRef.error));

  const directIntentOperation = "op-execution-direct-intent";
  const directIntentStart = await h.request("execution.start", { plan, allowDirect: true }, {
    operationId: directIntentOperation,
    precondition: { bootId: h.bootId, revision: h.revision }
  });
  assert.equal(directIntentStart.ok, true, JSON.stringify(directIntentStart.error));
  const changedDirectIntent = await h.request("execution.start", { plan, allowDirect: false }, {
    operationId: directIntentOperation,
    precondition: { bootId: h.bootId, revision: h.revision }
  });
  assert.equal(changedDirectIntent.error.code, INTEGRATION_ERROR_CODES.OPERATION_CONFLICT,
    "external execution correlation must bind security-relevant Direct intent");
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true, allowExecutableInstall: true }, {
    userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true
  });
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  let runnerCalls = 0;
  h.facade.WorkflowRunner.runExternalExecution = async () => {
    runnerCalls += 1;
    return { id: "external-job", state: "queued" };
  };
  h.facade.WorkflowRunner.listExternalExecutions = async () => [];
  h.facade.UserscriptManager = {
    async list() { return Object.values(h.state.scripts).map(clone); },
    async assign(scriptId, profileId) {
      const script = h.state.scripts[scriptId];
      script.profileIds = [...new Set([...(script.profileIds || []), profileId])];
      return clone(script);
    }
  };
  try {
    const source = "// ==UserScript==\n// @name Lease expiry\n// @match https://example.test/*\n// @grant none\n// ==/UserScript==\n";
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const installed = await h.request("userscript.artifact.install", {
      artifactId: "lease-expiry-artifact", source, sha256,
      provenance: { packageId: "test", packageVersion: "1.0.0", component: "lease-expiry" }
    });
    assert.equal(installed.ok, true, JSON.stringify(installed.error));
    const assigned = await h.request("userscript.artifact.assign", {
      artifactId: "lease-expiry-artifact", personaUid: UID
    });
    assert.equal(assigned.ok, true, JSON.stringify(assigned.error));
    const lease = await h.request("persona.control.acquire", {
      personaUid: UID, purpose: "external start expiry race", ttlMs: 10000
    });
    assert.equal(lease.ok, true);

    let releaseValidation;
    let validationStarted;
    const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
    const validationEntered = new Promise((resolve) => { validationStarted = resolve; });
    const getState = h.stateManager.getState.bind(h.stateManager);
    let getStateCalls = 0;
    h.stateManager.getState = async () => {
      getStateCalls += 1;
      if (getStateCalls === 9) {
        validationStarted();
        await validationGate;
      }
      return getState();
    };
    const start = h.request("execution.start", {
      plan: { name: "expiry race", steps: [{
        id: "step-1", personaUid: UID, urls: ["https://example.test/"], artifacts: ["lease-expiry-artifact"],
        concurrency: 1, completion: { mode: "load", value: "", timeoutMs: 10000 },
        retries: 0, retryDelayMs: 0, closeTabs: true, stopOnError: true
      }] }
    });
    await validationEntered;
    clock += 10001;
    releaseValidation();
    const expiredStart = await start;
    assert.equal(expiredStart.ok, false, JSON.stringify(expiredStart));
    assert.equal(expiredStart.error.code, INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST,
      "external execution admission rechecks exact lease identity and expiry after all awaited validation");
    assert.equal(runnerCalls, 0, "an execution whose lease expires during final validation never starts");
  } finally {
    h.integration.dispose();
    Date.now = realNow;
  }
}

{
  const h = makeHarness({ allowExternalAutomation: true, allowExecutableInstall: true }, {
    userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true
  });
  h.facade.WorkflowRunner.listExternalExecutions = async () => [];
  h.facade.WorkflowRunner.getExternalExecution = async () => null;
  h.facade.UserscriptManager = {
    async list() { return Object.values(h.state.scripts).map(clone); },
    async assign(scriptId, profileId) {
      const script = h.state.scripts[scriptId];
      script.profileIds = [...new Set([...(script.profileIds || []), profileId])];
      return clone(script);
    }
  };
  const source = "// ==UserScript==\n// @name Restart recovery\n// @match https://example.test/*\n// @grant none\n// ==/UserScript==\n";
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const installed = await h.request("userscript.artifact.install", {
    artifactId: "restart-recovery-artifact", source, sha256,
    provenance: { packageId: "test", packageVersion: "1.0.0", component: "restart-recovery" }
  });
  assert.equal(installed.ok, true, JSON.stringify(installed.error));
  const assigned = await h.request("userscript.artifact.assign", { artifactId: "restart-recovery-artifact", personaUid: UID });
  assert.equal(assigned.ok, true, JSON.stringify(assigned.error));
  const firstLease = await h.request("persona.control.acquire", { personaUid: UID, purpose: "before restart", ttlMs: 60000 });
  assert.equal(firstLease.ok, true, JSON.stringify(firstLease.error));
  h.facade.WorkflowRunner.runExternalExecution = async () => { throw new Error("simulated loss after journal write"); };
  const params = { plan: { name: "restart recovery", steps: [{
    id: "step-1", personaUid: UID, urls: ["https://example.test/"], artifacts: ["restart-recovery-artifact"],
    concurrency: 1, completion: { mode: "load", value: "", timeoutMs: 10000 },
    retries: 0, retryDelayMs: 0, closeTabs: true, stopOnError: true
  }] } };
  const envelope = h.envelope("execution.start", params, {
    operationId: "op-restart-recovery",
    precondition: { bootId: h.bootId, revision: h.revision }
  });
  const ambiguous = await h.integration.handleExternalRequest(envelope, { id: TRUSTED_ID });
  assert.equal(ambiguous.ok, false);
  assert.equal((await h.operationStore.get(TRUSTED_ID, "op-restart-recovery")).state, "pending");
  h.integration.dispose();

  const restarted = createManagementIntegration({
    personaApi: h.facade,
    stateManager: h.stateManager,
    sourceEventHub: h.eventHub,
    operationStore: createIntegrationOperationStore(h.storageArea),
    selfExtensionId: SELF_ID,
    getExternalRuntimeAvailability: async () => ({ userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true })
  });
  const replacementLease = await restarted.handleExternalRequest(h.envelope("persona.control.acquire", {
    personaUid: UID, purpose: "after restart", ttlMs: 60000
  }), { id: TRUSTED_ID });
  assert.equal(replacementLease.ok, true, JSON.stringify(replacementLease.error));
  assert.notEqual(replacementLease.result.leaseId, firstLease.result.leaseId);
  const recovered = await restarted.handleExternalRequest(envelope, { id: TRUSTED_ID });
  assert.equal(recovered.ok, false);
  assert.equal(recovered.error.code, INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST,
    "a no-job pending admission with a pre-restart lease is terminalized after conservative recovery checks");
  const terminal = await createIntegrationOperationStore(h.storageArea).get(TRUSTED_ID, "op-restart-recovery");
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.failureCode, INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
  for (let index = 0; index < 15; index += 1) {
    await createIntegrationOperationStore(h.storageArea).put(TRUSTED_ID, `pending-fill-${index}`, { state: "pending", command: "test" });
  }
  await createIntegrationOperationStore(h.storageArea).put(TRUSTED_ID, "pending-slot-released", { state: "pending", command: "test" });
  restarted.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true, allowExecutableInstall: true }, {
    userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true
  });
  h.facade.WorkflowRunner.runExternalExecution = async () => ({ id: "ordered-external-job", state: "queued" });
  h.facade.WorkflowRunner.listExternalExecutions = async () => [];
  h.facade.UserscriptManager = {
    async list() { return Object.values(h.state.scripts).map(clone); },
    async assign(scriptId, profileId) {
      const script = h.state.scripts[scriptId];
      script.profileIds = [...new Set([...(script.profileIds || []), profileId])];
      return clone(script);
    }
  };
  try {
    const source = "// ==UserScript==\n// @name Lock order\n// @match https://example.test/*\n// @grant none\n// ==/UserScript==\n";
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const installed = await h.request("userscript.artifact.install", {
      artifactId: "lock-order-artifact", source, sha256,
      provenance: { packageId: "test", packageVersion: "1.0.0", component: "lock-order" }
    });
    assert.equal(installed.ok, true, JSON.stringify(installed.error));
    const assigned = await h.request("userscript.artifact.assign", {
      artifactId: "lock-order-artifact", personaUid: UID
    });
    assert.equal(assigned.ok, true, JSON.stringify(assigned.error));
    const lease = await h.request("persona.control.acquire", {
      personaUid: UID, purpose: "concurrent lock-order test", ttlMs: 60000
    });
    assert.equal(lease.ok, true, JSON.stringify(lease.error));

    let releaseExternal;
    let externalEnteredResolve;
    const externalGate = new Promise((resolve) => { releaseExternal = resolve; });
    const externalEntered = new Promise((resolve) => { externalEnteredResolve = resolve; });
    h.facade.WorkflowRunner.listExternalExecutions = async () => {
      externalEnteredResolve();
      await externalGate;
      return [];
    };
    const externalRun = h.request("execution.start", {
      plan: { name: "concurrent lock-order test", steps: [{
        id: "step-1", personaUid: UID, urls: ["https://example.test/"], artifacts: ["lock-order-artifact"],
        concurrency: 1, completion: { mode: "load", value: "", timeoutMs: 10000 },
        retries: 0, retryDelayMs: 0, closeTabs: true, stopOnError: true
      }] }
    });
    await externalEntered;
    const localRun = h.integration.runLocalWorkflow("flow");
    releaseExternal();

    let timeoutId;
    const settled = await Promise.race([
      Promise.allSettled([localRun, externalRun]),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Concurrent starts deadlocked on workflow/Persona locks")), 2000);
      })
    ]).finally(() => clearTimeout(timeoutId));
    assert.equal(settled[0].status, "rejected");
    assert.equal(settled[0].reason.code, INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY,
      "local start settles after the external admission releases the shared locks");
    assert.equal(settled[1].status, "fulfilled");
    assert.equal(settled[1].value.ok, true, JSON.stringify(settled[1].value.error));
  } finally {
    h.integration.dispose();
  }
}

{
  const h = makeHarness({ allowExternalAutomation: true, allowExecutableInstall: true }, {
    userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true
  });
  h.facade.WorkflowRunner.listExternalExecutions = async () => [];
  h.facade.WorkflowRunner.getExternalExecution = async () => null;
  h.facade.UserscriptManager = {
    async list() { return Object.values(h.state.scripts).map(clone); },
    async assign(scriptId, profileId) {
      h.state.scripts[scriptId].profileIds = [...new Set([...(h.state.scripts[scriptId].profileIds || []), profileId])];
      return clone(h.state.scripts[scriptId]);
    }
  };
  const source = "// ==UserScript==\n// @name Restart journal\n// @match https://example.test/*\n// @grant none\n// ==/UserScript==\n";
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const installed = await h.request("userscript.artifact.install", {
    artifactId: "restart-journal-artifact", source, sha256: hash,
    provenance: { packageId: "test", packageVersion: "1.0.0", component: "restart-journal" }
  });
  assert.equal(installed.ok, true, JSON.stringify(installed.error));
  const assigned = await h.request("userscript.artifact.assign", { artifactId: "restart-journal-artifact", personaUid: UID });
  assert.equal(assigned.ok, true, JSON.stringify(assigned.error));
  const oldLease = await h.request("persona.control.acquire", { personaUid: UID, purpose: "old session", ttlMs: 60000 });
  assert.equal(oldLease.ok, true, JSON.stringify(oldLease.error));
  h.facade.WorkflowRunner.runExternalExecution = async () => {
    assert.equal((await h.operationStore.get(TRUSTED_ID, "op-no-ref-restart"))?.state, "pending",
      "the admission journal is durable before the runner can create browser side effects");
    throw new Error("runner admission interruption");
  };
  const startParams = { plan: { name: "pending without staged input", steps: [{
    id: "step-1", personaUid: UID, urls: ["https://example.test/"], artifacts: ["restart-journal-artifact"],
    concurrency: 1, completion: { mode: "load", value: "", timeoutMs: 10000 }, retries: 0,
    retryDelayMs: 0, closeTabs: true, stopOnError: true
  }] } };
  const startEnvelope = h.envelope("execution.start", startParams, {
    operationId: "op-no-ref-restart", precondition: { bootId: h.bootId, revision: h.revision }
  });
  const lostReply = await h.integration.handleExternalRequest(startEnvelope, { id: TRUSTED_ID });
  assert.equal(lostReply.ok, false);
  assert.equal((await h.operationStore.get(TRUSTED_ID, "op-no-ref-restart")).state, "pending");
  h.integration.dispose();

  const restarted = createManagementIntegration({
    personaApi: h.facade, stateManager: h.stateManager, sourceEventHub: h.eventHub,
    operationStore: createIntegrationOperationStore(h.storageArea), selfExtensionId: SELF_ID,
    getExternalRuntimeAvailability: async () => ({ userScriptsPermission: true, userScriptsExecute: true, tabOwnership: true })
  });
  const newLease = await restarted.handleExternalRequest(h.envelope("persona.control.acquire", {
    personaUid: UID, purpose: "new session", ttlMs: 60000
  }), { id: TRUSTED_ID });
  assert.equal(newLease.ok, true, JSON.stringify(newLease.error));
  assert.notEqual(newLease.result.leaseId, oldLease.result.leaseId);
  const retry = await restarted.handleExternalRequest(startEnvelope, { id: TRUSTED_ID });
  assert.equal(retry.error.code, INTEGRATION_ERROR_CODES.PERSONA_CONTROL_LEASE_LOST);
  const terminal = await createIntegrationOperationStore(h.storageArea).get(TRUSTED_ID, "op-no-ref-restart");
  assert.equal(terminal.state, "failed", "a no-ref pending operation is terminalized when its persisted lease cannot survive restart");
  for (let index = 0; index < 15; index += 1) {
    await createIntegrationOperationStore(h.storageArea).put(TRUSTED_ID, `pending-restart-fill-${index}`, { command: "execution.start", state: "pending" });
  }
  await createIntegrationOperationStore(h.storageArea).put(TRUSTED_ID, "pending-restart-slot-free", { command: "execution.start", state: "pending" });
  restarted.dispose();
}

{
  const h = makeHarness();
  const confirmation = { expectedPersonaUids: [UID], leases: [], takeControl: false };
  await assert.rejects(h.integration.runLocalWorkflow("flow", {
    ...confirmation, expectedPersonaUids: [UID_2]
  }), (error) => error.code === INTEGRATION_ERROR_CODES.STATE_CONFLICT,
  "a workflow target change after local confirmation must reject the run");

  h.state.profiles["firefox-container-next"] = {
    containerId: "firefox-container-next", personaUid: UID_2, managed: true, name: "Next", routeId: "route-safe"
  };
    const originalGetState = h.stateManager.getState.bind(h.stateManager);
    let reads = 0;
    h.stateManager.getState = async () => {
      const snapshot = await originalGetState();
      reads += 1;
      if (reads === 1) h.state.workflows.flow.steps[0].profileId = "firefox-container-next";
      return snapshot;
    };
  const runCallsBeforeRetarget = h.calls.filter((row) => row[0] === "workflow.run").length;
  await assert.rejects(h.integration.runLocalWorkflow("flow", confirmation),
    (error) => error.code === INTEGRATION_ERROR_CODES.STATE_CONFLICT,
    "the target set must be reread after Persona locks are acquired");
  assert.equal(h.calls.filter((row) => row[0] === "workflow.run").length, runCallsBeforeRetarget,
    "a retargeted workflow cannot run while only its original Persona was locked");
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  const lease = await h.request("persona.control.acquire", {
    personaUid: UID, purpose: "correlated workflow run guard", ttlMs: 60000
  });
  assert.equal(lease.ok, true);
  const before = h.calls.filter((row) => row[0] === "workflow.run").length;
  const blocked = await h.request("workflow.run", { workflowId: "flow" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY,
    "the external API correlated workflow.run path must respect an active control lease");
  assert.equal(h.calls.filter((row) => row[0] === "workflow.run").length, before,
    "a blocked correlated run must not invoke WorkflowRunner.run");
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  h.state.profiles["firefox-container-next"] = {
    containerId: "firefox-container-next", personaUid: UID_2, managed: true, name: "Next", routeId: "route-safe"
  };
  const originalGetState = h.stateManager.getState.bind(h.stateManager);
  let reads = 0;
  h.stateManager.getState = async () => {
    const snapshot = await originalGetState();
    reads += 1;
    if (reads === 2) h.state.workflows.flow.steps[0].profileId = "firefox-container-next";
    return snapshot;
  };
  const before = h.calls.filter((row) => row[0] === "workflow.run").length;
  const retargeted = await h.request("workflow.run", { workflowId: "flow" });
  assert.equal(retargeted.ok, false);
  assert.equal(retargeted.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT,
    "a correlated run must reject when its saved workflow targets change after lock selection");
  assert.equal(h.calls.filter((row) => row[0] === "workflow.run").length, before,
    "the correlated runner must never start with locks for stale targets");
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExecutableInstall: true });
  h.facade.UserscriptManager = { async list() { return []; }, async assign() {} };
  for (let index = 0; index < EXTERNAL_AUTOMATION_LIMITS.maxExternalArtifacts; index += 1) {
    h.state.scripts[`external-${index}`] = {
      id: `external-${index}`, code: "x", externalArtifact: { artifactId: `seed-${index}`, ownerKey: "a".repeat(64) }
    };
  }
  const source = "// ==UserScript==\n// @name Capacity\n// @match https://example.test/*\n// ==/UserScript==\n";
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const capped = await h.request("userscript.artifact.install", {
    artifactId: "capacity-check", source, sha256: digest,
    provenance: { packageId: "test", packageVersion: "1.0.0", component: "capacity" }
  });
  assert.equal(capped.error.code, INTEGRATION_ERROR_CODES.OPERATION_CAPACITY,
    "the external artifact registry must have a discoverable finite capacity");
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true });
  const senderLimit = EXTERNAL_AUTOMATION_LIMITS.maxControlLeasesPerSender;
  for (let index = 1; index < senderLimit + 1; index += 1) {
    const uid = `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const containerId = `firefox-container-lease-cap-${index}`;
    h.state.profiles[containerId] = {
      containerId, personaUid: uid, managed: true, name: `Lease ${index}`, routeId: "__block__", status: "active"
    };
  }
  const acquired = [];
  for (let index = 0; index < senderLimit; index += 1) {
    const uid = index === 0 ? UID : `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const result = await h.request("persona.control.acquire", {
      personaUid: uid, purpose: "bounded registry test", ttlMs: 60000
    }, { operationId: `lease-cap-${index}` });
    assert.equal(result.ok, true, `lease ${index} should fit within the advertised per-sender cap`);
    acquired.push(result.result.leaseId);
  }
  const overflowUid = `70000000-0000-4000-8000-${String(senderLimit + 1).padStart(12, "0")}`;
  const overflow = await h.request("persona.control.acquire", {
    personaUid: overflowUid, purpose: "bounded registry test", ttlMs: 60000
  }, { operationId: "lease-cap-overflow" });
  assert.equal(overflow.error.code, INTEGRATION_ERROR_CODES.OPERATION_CAPACITY,
    "the in-memory lease registry must enforce its advertised finite capacity");
  h.integration.dispose();
}

{
  const h = makeHarness();
  const before = h.revision;
  const committed = await h.integration.withLocalMutationFence({ targetPersonaUids: [UID], mode: "block" }, () =>
    h.stateManager.mutate((draft) => {
      draft.profiles[OLD_ID].name = "Fenced mutation completed";
      return draft.profiles[OLD_ID].name;
    }, { expectedBootId: h.bootId, expectedRevision: before }));
  assert.equal(committed.result, "Fenced mutation completed",
    "a fenced state mutation completes through the ordinary state transaction queue");
  assert.equal(h.state.profiles[OLD_ID].name, "Fenced mutation completed");
  assert.equal(h.revision, before + 1);
  h.integration.dispose();
}

{
  const retainedSender = "retained-control@example.test";
  const h = makeHarness({ allowExternalAutomation: true, trustedExtensionIds: [TRUSTED_ID, retainedSender] });
  const nextId = "firefox-container-fence-blocked";
  h.state.profiles[nextId] = { containerId: nextId, personaUid: UID_2, managed: true, name: "Blocked Persona", routeId: "route-safe" };
  const revokedLease = await h.request("persona.control.acquire", { personaUid: UID, purpose: "to revoke", ttlMs: 60000 });
  const retainedLease = await h.request("persona.control.acquire", {
    personaUid: UID_2, purpose: "must remain", ttlMs: 60000
  }, {}, retainedSender);
  assert.equal(revokedLease.ok, true);
  assert.equal(retainedLease.ok, true);
  let operationCalls = 0;
  await assert.rejects(h.integration.withLocalMutationFence({
    targetPersonaUids: [UID, UID_2], blockPersonaUids: [UID_2],
    mode: "system-revoke", revokeSenderIds: [TRUSTED_ID]
  }, async () => { operationCalls += 1; }),
  (error) => error.code === INTEGRATION_ERROR_CODES.PERSONA_CONTROL_BUSY,
  "a retained owner lease overlapping the block set prevents the state edit");
  assert.equal(operationCalls, 0);
  assert.deepEqual(new Set((await h.integration.listControlLeases()).map((lease) => lease.leaseId)),
    new Set([revokedLease.result.leaseId, retainedLease.result.leaseId]),
    "preflight checks every blocking lease before revoking any owner");

  await h.integration.withLocalMutationFence({
    targetPersonaUids: [UID, UID_2], blockPersonaUids: [],
    mode: "system-revoke", revokeSenderIds: [TRUSTED_ID]
  }, async () => { operationCalls += 1; });
  assert.equal(operationCalls, 1);
  assert.deepEqual((await h.integration.listControlLeases()).map((lease) => lease.leaseId), [retainedLease.result.leaseId],
    "system revoke cancels only selected senders when no retained lease blocks the change");
  h.integration.dispose();
}

{
  const h = makeHarness({ allowExternalAutomation: true, allowDirect: true });
  const protectedId = "firefox-container-direct-revoke-protected";
  h.state.profiles[OLD_ID].routeId = "__direct__";
  h.state.profiles[protectedId] = {
    containerId: protectedId, personaUid: UID_2, managed: true,
    name: "Protected survivor", routeId: "route-safe", status: "active"
  };
  const directLease = await h.request("persona.control.acquire", {
    personaUid: UID, purpose: "direct authority revocation", ttlMs: 60000
  });
  const protectedLease = await h.request("persona.control.acquire", {
    personaUid: UID_2, purpose: "protected route survives", ttlMs: 60000
  });
  assert.equal(directLease.ok, true);
  assert.equal(protectedLease.ok, true);

  let commits = 0;
  await h.integration.withLocalMutationFence({
    targetPersonaUids: [UID, UID_2], mode: "system-revoke",
    revokeDirectSenderIds: [TRUSTED_ID]
  }, async () => { commits += 1; });
  assert.equal(commits, 1);
  const surviving = await h.integration.listControlLeases();
  assert.deepEqual(surviving.map((lease) => lease.leaseId), [protectedLease.result.leaseId],
    "revoking Direct authority terminates only Direct-controlled Personas and preserves protected-route control");
  h.integration.dispose();
}

{
  const h = makeHarness();
  let releaseRun;
  let runEnteredResolve;
  let updateCalled = false;
  const runEntered = new Promise((resolve) => { runEnteredResolve = resolve; });
  const runGate = new Promise((resolve) => { releaseRun = resolve; });
  h.facade.WorkflowRunner.run = async (workflowId) => {
    runEnteredResolve();
    await runGate;
    return { id: "fenced-local-job", workflowId, state: "running" };
  };
  h.facade.WorkflowRunner.update = async (workflowId, workflow) => {
    updateCalled = true;
    return { ...workflow, id: workflowId };
  };
  const existing = await h.request("workflow.get", { workflowId: "flow" });
  assert.equal(existing.ok, true);
  const localRun = h.integration.runLocalWorkflow("flow");
  await runEntered;
  const update = h.request("workflow.update", { workflowId: "flow", workflow: existing.result });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(updateCalled, false, "workflow target mutations queue behind the shared run-admission gate");
  releaseRun();
  assert.equal((await localRun).id, "fenced-local-job");
  const updated = await update;
  assert.equal(updated.ok, true, JSON.stringify(updated.error));
  assert.equal(updateCalled, true);
  h.integration.dispose();
}

{
  const h = makeHarness();
  function port(senderId) {
    const disconnectListeners = [];
    const messages = [];
    return {
      name: INTEGRATION_EVENTS_PORT,
      sender: { id: senderId },
      messages,
      disconnected: false,
      postMessage(value) { messages.push(clone(value)); },
      disconnect() { this.disconnected = true; for (const listener of disconnectListeners) listener(); },
      onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } }
    };
  }

  const bad = port("not-trusted@example.test");
  assert.equal(await h.integration.attachExternalPort(bad), false);
  assert.equal(bad.disconnected, true);

  const self = port(SELF_ID);
  assert.equal(await h.integration.attachExternalPort(self), false);
  assert.equal(self.disconnected, true);

  const good = port(TRUSTED_ID);
  assert.equal(await h.integration.attachExternalPort(good), true);
  const externalOperationId = `external-op-${"x".repeat(244)}`;
  assert.equal(externalOperationId.length, 256);
  h.eventHub.emit({
    type: "persona.container.rotated",
    entity: "persona",
    entityId: UID,
    data: {
      personaUid: UID,
      oldCookieStoreId: OLD_ID,
      newCookieStoreId: "firefox-container-new",
      operationId: "rotation-1",
      correlationOperationId: externalOperationId,
      password: "must-not-leak"
    },
    revision: h.revision
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const event = good.messages.find((row) => row.type === "persona.container.rotated");
  assert.ok(event);
  assert.equal(typeof event.time, "string");
  assert.equal("at" in event, false);
  assert.equal(event.entityId, UID);
  assert.equal(event.data.personaUid, UID);
  assert.equal(event.data.oldCookieStoreId, OLD_ID);
  assert.equal(event.data.newCookieStoreId, "firefox-container-new");
  assert.equal(event.data.operationId, externalOperationId, "external event must expose the exact 256-character initiating Integration API operationId");
  assert.equal(event.data.rotationOperationId, "rotation-1", "internal rotation journal ID must remain distinct");
  assert.equal(JSON.stringify(event).includes("must-not-leak"), false);

  h.eventHub.emit({
    type: "route.test.completed",
    entity: "persona",
    entityId: OLD_ID,
    data: {
      ok: true,
      data: {
        ip: "198.51.100.77",
        city: "Rotterdam",
        country: "NL",
        mullvad_exit_ip: true,
        answer: "opaque-internal-route-secret"
      },
      dns: {
        checked: true,
        leaking: false,
        servers: [{ ip: "192.0.2.88", answer: "opaque-internal-dns-secret" }]
      },
      mullvadNative: {
        installed: true,
        ready: true,
        details: "opaque-internal-native-secret"
      },
      payload: { answer: "opaque-internal-payload-secret" },
      checkedAt: "2026-09-24T00:00:00.000Z"
    },
    revision: h.revision
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const projectedRouteEvent = good.messages.find((row) =>
    row.type === "route.test.completed" && row.data?.result?.exit?.ip === "198.51.100.77");
  assert.ok(projectedRouteEvent, "internal route-test event must reach the external stream through the explicit projection");
  assert.deepEqual(projectedRouteEvent.data.result.dns, { checked: true, leaking: false, serverCount: 1 });
  for (const secret of [
    "opaque-internal-route-secret",
    "opaque-internal-dns-secret",
    "opaque-internal-native-secret",
    "opaque-internal-payload-secret"
  ]) assert.equal(JSON.stringify(projectedRouteEvent).includes(secret), false, `external route-test event leaked ${secret}`);

  h.integration.emit({
    type: "state.changed",
    entity: "state",
    data: {
      payload: Array.from({ length: 100 }, () =>
        Array.from({ length: 100 }, (_, index) => `event-${index}-012345678901234567890123456789`))
    },
    revision: h.revision
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    good.messages.at(-1).data,
    { requery: true },
    "oversized advisory event payloads must request an authoritative requery"
  );

  // A Persona added through the bundled management surface is indexed by the
  // state-change projection so a later removal can still be emitted by UID
  // after the profile itself no longer exists.
  h.state.profiles["firefox-container-internal"] = {
    containerId: "firefox-container-internal",
    personaUid: UID_2,
    managed: true,
    name: "Internal"
  };
  h.eventHub.emit({ type: "state.changed", entity: "state", revision: h.revision, data: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  delete h.state.profiles["firefox-container-internal"];
  h.eventHub.emit({
    type: "persona.removed",
    entity: "persona",
    entityId: "firefox-container-internal",
    data: { id: "firefox-container-internal" },
    revision: h.revision
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const internalRemoval = good.messages.find((row) =>
    row.type === "persona.removed" && row.entityId === UID_2);
  assert.ok(internalRemoval, "internally removed Personas must remain UID-correlatable");

  const beforeRevocation = good.messages.length;
  h.state.global.integration.enabled = false;
  h.eventHub.emit({
    type: "state.changed",
    entity: "state",
    data: { source: "policy-change" },
    revision: h.revision
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(good.messages.length, beforeRevocation, "revoked ports must not receive later events");
  assert.equal(good.disconnected, true, "policy revocation disconnects an existing external port");

  const wrongName = port(TRUSTED_ID);
  wrongName.name = "PCMS_EVENTS";
  assert.equal(await h.integration.attachExternalPort(wrongName), false);
  assert.equal(wrongName.disconnected, true, "legacy/internal port names are not accepted externally");
}

{
  const trustedSenders = Array.from({ length: 8 }, (_, index) => `event-caller-${index}@example.test`);
  const h = makeHarness({ trustedExtensionIds: trustedSenders });
  const originalGetState = h.stateManager.getState;
  let stateReads = 0;
  let refreshStarted;
  const refreshEntered = new Promise((resolve) => { refreshStarted = resolve; });
  let releaseRefresh;
  const refreshRelease = new Promise((resolve) => { releaseRefresh = resolve; });
  h.stateManager.getState = async () => {
    stateReads += 1;
    if (stateReads > trustedSenders.length) {
      refreshStarted();
      await refreshRelease;
    }
    return originalGetState();
  };

  function eventPort(senderId) {
    const disconnectListeners = [];
    return {
      name: INTEGRATION_EVENTS_PORT,
      sender: { id: senderId },
      disconnected: false,
      postMessage() {},
      disconnect() { this.disconnected = true; for (const listener of disconnectListeners) listener(); },
      onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } }
    };
  }

  const firstSender = trustedSenders[0];
  const burst = Array.from({ length: 5 }, () => eventPort(firstSender));
  const burstResults = Promise.all(burst.map((port) => h.integration.attachExternalPort(port)));
  await refreshEntered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(burst.filter((port) => port.disconnected).length, 1, "port reservations are counted before the asynchronous persona-index refresh");
  releaseRefresh();
  assert.deepEqual(await burstResults, [true, true, true, true, false], "each trusted sender is limited to four live event ports");

  const remaining = [];
  for (const senderId of trustedSenders.slice(1)) {
    for (let index = 0; index < 4; index += 1) remaining.push(eventPort(senderId));
  }
  assert.deepEqual(await Promise.all(remaining.map((port) => h.integration.attachExternalPort(port))), Array(28).fill(true));
  const overTotal = eventPort(firstSender);
  assert.equal(await h.integration.attachExternalPort(overTotal), false, "event subscribers are capped globally");
  assert.equal(overTotal.disconnected, true);
  burst[0].disconnect();
  const replacement = eventPort(firstSender);
  assert.equal(await h.integration.attachExternalPort(replacement), true, "disconnect releases the sender and global reservation");
  h.integration.dispose();
  assert.equal(replacement.disconnected, true, "dispose disconnects retained external ports");
}

{
  // Source-event projection must preserve source order even when the first
  // projection blocks on a state read. Otherwise a later route/persona event
  // can receive an earlier external sequence number.
  const h = makeHarness();
  const projected = {
    name: INTEGRATION_EVENTS_PORT,
    sender: { id: TRUSTED_ID },
    messages: [],
    disconnected: false,
    postMessage(value) { this.messages.push(clone(value)); },
    disconnect() { this.disconnected = true; },
    onDisconnect: { addListener() {} }
  };
  assert.equal(await h.integration.attachExternalPort(projected), true);

  const originalGetState = h.stateManager.getState;
  let releaseFirstProjection;
  let firstProjectionRead = true;
  h.stateManager.getState = async () => {
    if (firstProjectionRead) {
      firstProjectionRead = false;
      await new Promise((resolve) => { releaseFirstProjection = resolve; });
    }
    return clone(h.state);
  };

  try {
    h.eventHub.emit({
      type: "state.changed",
      entity: "state",
      data: { source: "ordered-first" },
      revision: h.revision
    });
    h.eventHub.emit({
      type: "route.assignment.changed",
      entity: "persona",
      entityId: OLD_ID,
      data: { routeId: "route-safe" },
      revision: h.revision
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(projected.messages.length, 0, "later source event must not overtake a blocked earlier projection");

    releaseFirstProjection();
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      projected.messages.slice(-2).map((row) => row.type),
      ["state.changed", "route.assignment.changed"],
      "external projection must preserve source event order"
    );
    assert.ok(
      projected.messages.at(-2).sequence < projected.messages.at(-1).sequence,
      "external sequence must follow serialized source projection order"
    );
  } finally {
    h.stateManager.getState = originalGetState;
  }
}

{
  // A rejected source projection must become a generic recovery signal rather
  // than an unhandled promise rejection or silent event loss.
  const h = makeHarness();
  const projected = {
    name: INTEGRATION_EVENTS_PORT,
    sender: { id: TRUSTED_ID },
    messages: [],
    disconnected: false,
    postMessage(value) { this.messages.push(clone(value)); },
    disconnect() { this.disconnected = true; },
    onDisconnect: { addListener() {} }
  };
  assert.equal(await h.integration.attachExternalPort(projected), true);
  const originalGetState = h.stateManager.getState;
  let failed = false;
  h.stateManager.getState = async () => {
    if (!failed) {
      failed = true;
      throw new Error("opaque-projection-failure-secret");
    }
    return clone(h.state);
  };
  try {
    h.eventHub.emit({ type: "state.changed", entity: "state", revision: h.revision, data: {} });
    for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const recovery = projected.messages.find((row) => row.type === "state.changed" && row.data?.requery === true);
    assert.ok(recovery, "projection failure must emit a generic authoritative-requery signal");
    assert.equal(JSON.stringify(recovery).includes("opaque-projection-failure-secret"), false);
  } finally {
    h.stateManager.getState = originalGetState;
  }
}

{
  // Per-port delivery must preserve sequence even when the first
  // authorization read is artificially delayed and a later event is ready.
  // Use an isolated harness so no other subscribed port can consume policy
  // reads and make the ordering assertion nondeterministic.
  const h = makeHarness();
  const ordered = {
    name: INTEGRATION_EVENTS_PORT,
    sender: { id: TRUSTED_ID },
    messages: [],
    disconnected: false,
    postMessage(value) { this.messages.push(clone(value)); },
    disconnect() { this.disconnected = true; },
    onDisconnect: { addListener() {} }
  };
  assert.equal(await h.integration.attachExternalPort(ordered), true);

  const originalGetState = h.stateManager.getState;
  let releaseFirstPolicyRead;
  let policyReads = 0;
  h.stateManager.getState = async () => {
    policyReads += 1;
    if (policyReads === 1) {
      await new Promise((resolve) => { releaseFirstPolicyRead = resolve; });
    }
    return clone(h.state);
  };

  try {
    const first = h.integration.emit({
      type: "state.changed",
      entity: "state",
      data: { order: 1 },
      revision: h.revision
    });
    const second = h.integration.emit({
      type: "state.changed",
      entity: "state",
      data: { order: 2 },
      revision: h.revision
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ordered.messages.length, 0, "later event must not overtake delayed authorization for an earlier sequence");
    assert.equal(policyReads, 1, "second authorization must wait for the first event delivery");

    releaseFirstPolicyRead();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      ordered.messages.map((row) => row.sequence),
      [first.sequence, second.sequence],
      "external event delivery must preserve sequence order per port"
    );
    assert.equal(policyReads, 2, "each delivered event must be re-authorized exactly once");
  } finally {
    h.stateManager.getState = originalGetState;
  }
}

{
  const h = makeHarness();
  const ids = Array.from({ length: 150 }, (_, index) => String(index).padStart(4, "0"));
  for (const id of ids.toReversed()) {
    const containerId = `container-${id}`;
    h.state.profiles[containerId] = {
      containerId,
      personaUid: `70000000-0000-4000-8000-${id.padStart(12, "0")}`,
      managed: true, name: id
    };
  }
  const listCases = [
    ["persona.list", () => h.state.profiles && Object.values(h.state.profiles)
      .filter((entry) => entry.containerId !== OLD_ID).map((entry) => ({ ...entry, cookieStoreId: entry.containerId }))],
    ["route.list", () => ids.toReversed().map((id) => ({ id, name: id, password: "hidden-route-password" }))],
    ["userscript.list", () => ids.toReversed().map((id) => ({ id, name: id, source: "hidden-script-source" }))],
    ["workflow.list", () => ids.toReversed().map((id) => ({ id, name: id, enabled: true, steps: [] }))],
    ["workflow.jobs.list", () => ids.toReversed().map((id) => ({ id, workflowId: id, tasks: [] }))]
  ];
  h.facade.PersonaManager.list = listCases[0][1];
  h.facade.RouteManager.list = listCases[1][1];
  h.facade.UserscriptManager = { list: listCases[2][1] };
  h.facade.WorkflowRunner.list = listCases[3][1];
  h.facade.WorkflowRunner.listJobs = listCases[4][1];
  for (const [command] of listCases) {
    const values = [];
    let cursor;
    do {
      const result = await h.request(command, { page: { size: 47, ...(cursor ? { cursor } : {}) } });
      assert.equal(result.ok, true, `${command} (${cursor?.length || 0}): ${JSON.stringify(result.error)}`);
      assert.equal(Array.isArray(result.result.items), true);
      values.push(...result.result.items);
      cursor = result.result.nextCursor;
      assert.equal(Boolean(cursor), result.result.hasMore);
    } while (cursor);
    assert.equal(values.length, 150, `${command} must expose every entry`);
    assert.deepEqual(values.map((item) => command === "persona.list" ? item.name : item.id), ids);
    assert.equal(JSON.stringify(values).includes("hidden-"), false);
  }
  const automatic = await h.request("persona.list");
  assert.equal(automatic.ok, true);
  assert.equal(automatic.result.items.length, 100);
  assert.equal(automatic.result.hasMore, true);
  const invalid = await h.request("persona.list", { page: { cursor: "broken" } });
  assert.equal(invalid.error.code, INTEGRATION_ERROR_CODES.PAGE_INVALID);
  const first = await h.request("persona.list", { page: { size: 47 } });
  const forgedToken = JSON.parse(decodeURIComponent(first.result.nextCursor));
  forgedToken.offset += 1;
  const forged = await h.request("persona.list", { page: { size: 47, cursor: encodeURIComponent(JSON.stringify(forgedToken)) } });
  assert.equal(forged.error.code, INTEGRATION_ERROR_CODES.PAGE_INVALID);
  h.state.profiles["container-0001"].name = "Updated without a revision bump";
  const changedProjection = await h.request("persona.list", { page: { size: 47, cursor: first.result.nextCursor } });
  assert.equal(changedProjection.error.code, INTEGRATION_ERROR_CODES.PAGE_STALE);
  delete h.state.profiles["container-0000"];
  const changedCollection = await h.request("persona.list", { page: { size: 47, cursor: first.result.nextCursor } });
  assert.equal(changedCollection.error.code, INTEGRATION_ERROR_CODES.PAGE_STALE);
  h.setRevision(h.revision + 1);
  const stale = await h.request("persona.list", { page: { size: 47, cursor: first.result.nextCursor } });
  assert.equal(stale.error.code, INTEGRATION_ERROR_CODES.PAGE_STALE);
  const small = await h.request("route.list", { page: { size: 100 } });
  assert.equal(small.ok, true);
}

{
  const h = makeHarness({ allowDestructive: true });
  h.state.personaRotations["rotation-original"] = {
    personaUid: UID, sourceCookieStoreId: OLD_ID,
    correlationOperationId: "original-external-operation"
  };
  const conflicted = await h.request("storage.fullWipe", { personaUid: UID, confirm: true }, {
    operationId: "different-external-operation",
    precondition: { bootId: h.bootId, revision: h.revision }
  });
  assert.equal(conflicted.error.code, INTEGRATION_ERROR_CODES.OPERATION_CONFLICT);
  assert.equal(h.calls.some((row) => row[0] === "fullWipe"), false);
}

{
  const h = makeHarness({ allowDestructive: true });
  h.state.personaRotations["rotation-recover"] = {
    operationId: "rotation-recover", personaUid: UID, sourceCookieStoreId: OLD_ID,
    correlationOperationId: "matching-external-id"
  };
  h.state.profiles[OLD_ID].rotationRole = "source";
  h.facade.StorageManager.fullWipe = async (personaUid, options) => {
    h.calls.push(["fullWipe", personaUid, clone(options)]);
    return { personaUid, oldCookieStoreId: OLD_ID, newCookieStoreId: "rotated-container", operationId: "rotation-recover" };
  };
  const recovered = await h.request("storage.fullWipe", { personaUid: UID, confirm: true }, {
    operationId: "matching-external-id", precondition: { bootId: h.bootId, revision: 0 }
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.error));
  assert.equal(recovered.result.operationId, "matching-external-id");
  assert.equal(recovered.result.rotationOperationId, "rotation-recover");
  assert.equal(h.calls.filter((row) => row[0] === "fullWipe").length, 1);
}

{
  const h = makeHarness({ allowDestructive: true });
  const originalWipe = h.facade.StorageManager.fullWipe;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let starts = 0;
  h.facade.StorageManager.fullWipe = async (...args) => {
    starts += 1;
    enteredResolve();
    await held;
    return originalWipe(...args);
  };
  const precondition = { bootId: h.bootId, revision: h.revision };
  const first = h.request("storage.fullWipe", { personaUid: UID, confirm: true },
    { operationId: "external-first", precondition });
  await entered;
  const second = h.request("storage.fullWipe", { personaUid: UID, confirm: true },
    { operationId: "external-second", precondition });
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.result.operationId, "external-first");
  assert.equal(secondResult.error.code, INTEGRATION_ERROR_CODES.STATE_CONFLICT);
  assert.equal(starts, 1, "another external operation must not enter the first rotation");
}

{
  const h = makeHarness();
  const secretUrl = "https://name:password@example.test/private?token=secret-value#private";
  const steps = Array.from({ length: 200 }, (_, index) => ({
    id: `step-${index}`, profileId: OLD_ID,
    urls: [index === 0 ? secretUrl : `https://example.test/step/${index}`],
    scriptIds: [], concurrency: 1,
    completion: { mode: "load", value: "", timeoutMs: 5000 },
    retries: 0, retryDelayMs: 0, closeTabs: true, stopOnError: true
  }));
  h.state.workflows.flow.steps = steps;
  let updated;
  h.facade.WorkflowRunner.update = async (_id, definition) => {
    updated = clone(definition);
    h.state.workflows.flow = { ...h.state.workflows.flow, ...definition };
    return clone(h.state.workflows.flow);
  };
  const read = await h.request("workflow.get", { workflowId: "flow" });
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.equal(read.result.steps.length, 200);
  assert.equal(JSON.stringify(read).includes("secret-value"), false);
  const input = clone(read.result);
  const result = await h.request("workflow.update", { workflowId: "flow", workflow: input });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(updated.steps.length, 200);
  assert.equal(updated.steps[0].urls[0], secretUrl, "unchanged secret-safe URL must retain hidden components");
  assert.equal(updated.steps[199].urls[0], steps[199].urls[0]);

  const urls = Array.from({ length: 500 }, (_, index) =>
    `https://example.test/${index}/${"x".repeat(3800)}`);
  h.state.workflows.flow.steps = [{ ...steps[0], urls }];
  const large = await h.request("workflow.get", { workflowId: "flow" });
  assert.equal(large.ok, true, JSON.stringify(large.error));
  assert.equal(large.result.steps[0].urls.length, 500);
  const saved = await h.request("workflow.update", { workflowId: "flow", workflow: large.result });
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  assert.deepEqual(updated.steps[0].urls, urls);
}

{
  for (const resource of ["https://cdn.example.test/helper.js", "//cdn.example.test/helper.js", "../helper.js"]) {
    const source = `// ==UserScript==\n// @name Unsafe artifact resource\n// @match https://example.test/*\n// @resource helper ${resource}\n// ==/UserScript==\n`;
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const harness = makeHarness({ allowExecutableInstall: true });
    harness.facade.UserscriptManager = { async list() { return []; }, async assign() {} };
    const result = await harness.request("userscript.artifact.install", {
      artifactId: `unsafe-resource-${resource.length}`,
      source,
      sha256,
      provenance: { packageId: "test", packageVersion: "1.0.0", component: "resource" }
    });
    assert.equal(result.error.code, INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH,
      `artifact install rejects non-self-contained resource ${resource}`);
    assert.equal(Object.values(harness.state.scripts).some((script) => script.externalArtifact), false,
      "an unsafe source failure must happen before the state mutation commits");
    harness.integration.dispose();
  }
}

{
  const source = "// ==UserScript==\n// @name Authority split\n// @match https://example.test/*\n// ==/UserScript==\n";
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const installOnly = makeHarness({ allowExecutableInstall: true, allowExternalAutomation: false });
  installOnly.facade.UserscriptManager = { async list() { return []; }, async assign() {} };
  const installed = await installOnly.request("userscript.artifact.install", {
    artifactId: "install-only-artifact", source, sha256,
    provenance: { packageId: "test", packageVersion: "1.0.0", component: "authority" }
  });
  assert.equal(installed.ok, true, `executable-install authority does not depend on external automation: ${JSON.stringify(installed)}`);
  const installedList = await installOnly.request("userscript.artifact.list");
  assert.equal(installedList.ok, true,
    `reconciliation list access belongs to executable-install authority: ${JSON.stringify(installedList)}`);
  assert.equal((await installOnly.request("userscript.artifact.get", { artifactId: "install-only-artifact" })).ok, true);
  const conflictingProvenance = await installOnly.request("userscript.artifact.install", {
    artifactId: "install-only-artifact", source, sha256,
    provenance: { packageId: "different-package", packageVersion: "1.0.0", component: "authority" }
  });
  assert.equal(conflictingProvenance.error.code, INTEGRATION_ERROR_CODES.ARTIFACT_CONFLICT,
    "idempotent source bytes cannot silently accept conflicting provenance claims");
  const installedArtifact = Object.values(installOnly.state.scripts).find((script) =>
    script.externalArtifact?.artifactId === "install-only-artifact");
  assert.equal(installedArtifact.externalArtifact.ownershipVerified, true,
    "fresh authenticated installs are immediately verified");
  installedArtifact.externalArtifact.ownershipVerified = false;
  const hiddenClaim = await installOnly.request("userscript.artifact.get", { artifactId: "install-only-artifact" });
  assert.equal(hiddenClaim.error.code, INTEGRATION_ERROR_CODES.ARTIFACT_NOT_FOUND,
    "an imported/unverified owner claim is unusable before authenticated reclaim");
  const reclaimed = await installOnly.request("userscript.artifact.install", {
    artifactId: "install-only-artifact", source, sha256,
    provenance: { packageId: "test", packageVersion: "1.0.0", component: "authority" }
  });
  assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed.error));
  const reclaimedStoredArtifact = Object.values(installOnly.state.scripts).find((script) =>
    script.externalArtifact?.artifactId === "install-only-artifact");
  assert.equal(reclaimedStoredArtifact.externalArtifact.ownershipVerified, true,
    "an authenticated exact reinstall reclaims the portable owner claim");
  reclaimedStoredArtifact.grants = ["none", "GM_xmlhttpRequest"];
  const tamperedArtifactGet = await installOnly.request("userscript.artifact.get", { artifactId: "install-only-artifact" });
  assert.equal(tamperedArtifactGet.error.code, INTEGRATION_ERROR_CODES.ARTIFACT_MISMATCH,
    "management artifact reads reject source-metadata divergence");
  const leaseDenied = await installOnly.request("persona.control.acquire", {
    personaUid: UID, purpose: "independent authority test", ttlMs: 60000
  });
  assert.equal(leaseDenied.error.code, INTEGRATION_ERROR_CODES.AUTOMATION_NOT_ALLOWED);
  installOnly.integration.dispose();

  const automationOnly = makeHarness({ allowExternalAutomation: true, allowExecutableInstall: false });
  automationOnly.facade.UserscriptManager = { async list() { return []; }, async assign() {} };
  const installDenied = await automationOnly.request("userscript.artifact.install", {
    artifactId: "automation-only-artifact", source, sha256,
    provenance: { packageId: "test", packageVersion: "1.0.0", component: "authority" }
  });
  assert.equal(installDenied.error.code, INTEGRATION_ERROR_CODES.EXECUTABLE_INSTALL_NOT_ALLOWED);
  const allowedLease = await automationOnly.request("persona.control.acquire", {
    personaUid: UID, purpose: "independent authority test", ttlMs: 60000
  });
  assert.equal(allowedLease.ok, true, "external automation authority does not imply executable installation");
  automationOnly.integration.dispose();
}

console.log("PersonaMonkey Integration API tests passed");
