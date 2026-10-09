import assert from "node:assert/strict";
import { buildDiagnosticsBundle, diagnosticMullvadStatus, diagnosticProfile, diagnosticRoute } from "../lib/diagnostics.js";
import { preserveExternalAutomationJobs } from "../lib/automation-history.js";

const preservedExternalJobs = preserveExternalAutomationJobs({
  ordinary: { id: "ordinary", state: "completed" },
  external: { id: "external", externalOwner: { senderId: "sender-secret" } }
});
assert.deepEqual(Object.keys(preservedExternalJobs), ["external"], "replace imports preserve private execution records only");

const profile = diagnosticProfile({
  containerId: "firefox-container-1",
  name: "Persona 1",
  managed: true,
  routeId: "route-1",
  password: "must-not-leak"
});
assert.equal(profile.containerId, "firefox-container-1");
assert.equal("password" in profile, false);

const route = diagnosticRoute({
  id: "route-1",
  name: "Mullvad CH",
  provider: "mullvad",
  type: "socks",
  host: "10.0.0.1",
  port: 1080,
  username: "secret-user",
  password: "secret-pass",
  privateKey: "secret-key"
});
assert.equal(route.name, "Mullvad CH");
assert.equal(route.host, "10.0.0.1");
assert.equal("username" in route, false);
assert.equal("password" in route, false);
assert.equal("privateKey" in route, false);

const nativeStatus = diagnosticMullvadStatus({
  selected_entry: { name: "entry", password: "selected-entry-secret" },
  interface: "wg-mullvad",
  active_exits: [{
    route_id: "route-1",
    relay_ip: "203.0.113.8",
    relay_port: 443,
    local_host: "127.0.0.1",
    local_port: 1080,
    password: "forwarder-secret",
    forwarder_token: "token-secret",
    credential: "credential-secret"
  }]
});
assert.equal(nativeStatus.selected_entry, null, "native entry metadata must be a scalar string");
assert.deepEqual(nativeStatus.active_exits, [{
  route_id: "route-1",
  relay_ip: "203.0.113.8",
  relay_port: 443,
  local_host: "127.0.0.1",
  local_port: 1080
}], "native exit diagnostics retain only the documented fields");

const bundle = buildDiagnosticsBundle({
  version: "0.5.0",
  generatedAt: "2026-09-14T00:00:00.000Z",
  snapshot: {
    security: {
      ready: true,
      lastProxyError: { at: "2026-09-14T00:00:00Z", message: "Authorization: Bearer proxy-secret" },
      lastBlock: { at: "2026-09-14T00:00:01Z", reason: "blocked", url: "https://example.com/?token=url-secret" }
    },
    mullvadNative: {
      ready: true,
      privateKey: "native-secret",
      error: "private key=native-error-secret",
      active_exits: [{ route_id: "route-1", local_port: 1080, password: "native-exit-secret" }]
    },
    state: {
      profiles: { "firefox-container-1": { ...profile, password: "profile-secret" } },
      routes: { "route-1": { ...route, username: "route-user", password: "route-pass" } },
      workflows: {
        workflow: {
          id: "workflow",
          name: "Sensitive workflow",
          steps: [{
            id: "step-1",
            profileId: "firefox-container-1",
            urls: ["https://example.com/private?session=workflow-url-secret"],
            scriptIds: ["script-1"],
            completion: { mode: "signal", value: "#secret-selector", timeoutMs: 1000 }
          }]
        }
      }
    }
  },
  jobs: [{
    id: "job-1",
    workflowId: "workflow",
    workflowName: "Sensitive workflow",
    state: "failed",
    error: "Authorization token job-error-secret",
    tasks: [{
      id: "1-1",
      stepIndex: 0,
      profileId: "firefox-container-1",
      state: "failed",
      url: "https://example.com/?token=job-url-secret",
      result: { credential: "job-result-secret" },
      error: "cookie=job-task-secret",
      attemptHistory: [{ attempt: 1, state: "failed", error: "attempt-secret" }]
    }]
  }, {
    id: "external-job-secret",
    workflowId: "external-exec",
    state: "completed",
    externalOwner: { senderId: "trusted-sender-secret", executionId: "external-exec-secret" },
    tasks: [{ result: { secret: "external-result-secret" } }]
  }]
});

const text = JSON.stringify(bundle);
for (const secret of [
  "profile-secret", "route-user", "route-pass", "native-secret", "native-error-secret",
  "selected-entry-secret", "forwarder-secret", "token-secret", "credential-secret", "native-exit-secret",
  "proxy-secret", "url-secret", "workflow-url-secret", "secret-selector", "job-error-secret",
  "job-url-secret", "job-result-secret", "job-task-secret", "attempt-secret",
  "external-job-secret", "trusted-sender-secret", "external-exec-secret", "external-result-secret"
]) {
  assert.equal(text.includes(secret), false, `diagnostics bundle leaked ${secret}`);
}
assert.equal(bundle.extensionVersion, "0.5.0");
assert.equal(bundle.jobs[0].id, "job-1");
assert.equal(bundle.jobs.length, 1, "diagnostics excludes external automation executions");
assert.equal(bundle.jobs[0].failed, true);
assert.equal(bundle.jobs[0].tasks[0].hadError, true);
assert.equal(bundle.workflows.workflow.steps[0].urlCount, 1);
assert.equal("urls" in bundle.workflows.workflow.steps[0], false);
assert.equal("result" in bundle.jobs[0].tasks[0], false);

console.log("diagnostics redaction tests passed");
