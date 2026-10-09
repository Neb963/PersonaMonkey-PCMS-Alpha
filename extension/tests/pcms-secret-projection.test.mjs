import assert from "node:assert/strict";
import { createPcmsControlPlane } from "../lib/pcms-control-plane.js";
import { PCMS_PROTOCOL_VERSION, sanitizePcmsValue } from "../lib/pcms-protocol.js";

const secretUrl = "https://example.com/private?token=workflow-secret#fragment";
const userinfoUrl = "https://user:password@example.com/private";
const facade = {
  PersonaManager: {
    list: async () => [{
      id: "p1",
      name: "Persona",
      cookies: { count: 7, bytes: 512 },
      health: { status: "healthy", reason: `Checked ${userinfoUrl}`, internalWire: "do-not-expose" },
      description: `Visit ${userinfoUrl} after setup`,
      arbitraryPluginState: "do-not-expose"
    }],
    get: async () => null,
    create: async () => ({}), open: async () => ({}), updateIdentity: async () => ({}),
    clone: async () => ({}), archive: async () => ({}), destroy: async () => ({})
  },
  StorageManager: {
    inspect: async () => ({}), clearCookies: async () => ({}), clearSiteData: async () => ({}), fullWipe: async () => ({})
  },
  RouteManager: {
    list: async () => [{ id: "r1", name: "Route", username: "route-user", password: "route-secret" }],
    get: async () => null,
    assign: async () => ({}),
    test: async () => ({
      ok: true,
      error: `Request to ${userinfoUrl} failed`,
      url: "https://check.example/?session=route-test-secret",
      authorization: "Bearer route-auth-secret",
      cookies: [{ name: "sid", value: "cookie-secret" }]
    })
  },
  WorkflowRunner: {
    list: async () => [{
      id: "w1",
      name: "Workflow",
      enabled: true,
      steps: [{
        id: "s1",
        profileId: "p1",
        urls: [secretUrl],
        scriptIds: ["script-1"],
        concurrency: 2,
        completion: { mode: "selector", value: "#secret-selector", timeoutMs: 5000 },
        retries: 1,
        retryDelayMs: 100,
        closeTabs: true,
        stopOnError: true
      }]
    }],
    get: async () => ({
      id: "w1",
      name: "Workflow",
      steps: [{ id: "s1", profileId: "p1", urls: [secretUrl], completion: { mode: "signal", value: "signal-secret", timeoutMs: 5000 } }]
    }),
    run: async () => ({ id: "j1", state: "running", tasks: [{ url: secretUrl, result: { token: "job-secret" } }] }),
    listJobs: async () => [{ id: "j1", state: "failed", task: { url: secretUrl, error: "Bearer job-error-secret" } }],
    getJob: async () => ({ id: "j1", state: "failed", task: { url: secretUrl, result: "credential-secret" } }),
    stopJob: async () => ({ id: "j1", state: "stopping", error: "authorization=stop-secret" }),
    clearFinishedJobs: async () => []
  },
  Diagnostics: { getSystemStatus: async () => ({ ready: true, sessionToken: "status-secret" }) }
};

const control = createPcmsControlPlane({
  personaApi: facade,
  getRevision: () => 0,
  bootId: "secret-projection",
  capabilities: ["personas", "persona-storage", "routes", "workflows", "workflow-jobs", "batch", "events", "diagnostics"]
});
const request = (command, params = {}) => control.handleRequest({
  type: "PCMS_REQUEST",
  version: PCMS_PROTOCOL_VERSION,
  requestId: command,
  command,
  params
});

const personas = await request("persona.list");
assert.deepEqual(personas.result[0].cookies, { count: 7, bytes: 512 }, "safe cookie telemetry must remain visible");
assert.equal(personas.result[0].description, "Visit https://example.com/private after setup");
assert.equal(personas.result[0].health.reason, "Checked https://example.com/private");
assert.equal(JSON.stringify(personas).includes("do-not-expose"), false);
assert.equal(sanitizePcmsValue({ message: `Event source ${userinfoUrl}.` }).message, "Event source https://example.com/private.");

const workflows = await request("workflow.list");
assert.equal(workflows.result[0].steps[0].urlCount, 1);
assert.equal("urls" in workflows.result[0].steps[0], false);
assert.deepEqual(workflows.result[0].steps[0].completion, { mode: "selector", timeoutMs: 5000 });
const workflow = await request("workflow.get", { workflowId: "w1" });
assert.equal("urls" in workflow.result.steps[0], false);
assert.equal("value" in workflow.result.steps[0].completion, false);

for (const response of [
  await request("route.list"),
  await request("route.test", { profileId: "p1" }),
  await request("workflow.run", { workflowId: "w1" }),
  await request("workflow.jobs.list"),
  await request("workflow.jobs.get", { jobId: "j1" }),
  await request("workflow.jobs.stop", { jobId: "j1" }),
  await request("system.status")
]) {
  const serialized = JSON.stringify(response);
  for (const secret of [
    "workflow-secret", "fragment", "secret-selector", "signal-secret", "route-user", "route-secret",
    "route-test-secret", "route-auth-secret", "cookie-secret", "job-secret", "job-error-secret",
    "credential-secret", "stop-secret", "status-secret", "user:password@"
  ]) {
    assert.equal(serialized.includes(secret), false, `${response.requestId} leaked ${secret}`);
  }
}

console.log("pcms secret projection tests passed");
