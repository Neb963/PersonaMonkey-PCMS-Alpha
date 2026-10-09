import assert from "node:assert/strict";
import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID } from "../lib/constants.js";
import { collectWorkflowValidationIssues } from "../lib/workflow-model.js";

function workflow(profileId) {
  return {
    enabled: true,
    steps: [{
      profileId,
      urls: ["https://example.com/"],
      concurrency: 1,
      scriptIds: [],
      completion: { mode: "load", value: "", timeoutMs: 60000 },
      retries: 0,
      retryDelayMs: 1000
    }]
  };
}

const state = {
  profiles: {
    blocked: { containerId: "blocked", managed: true, routeId: BLOCK_ROUTE_ID },
    direct: { containerId: "direct", managed: true, routeId: DIRECT_ROUTE_ID },
    missingRoute: { containerId: "missingRoute", managed: true, routeId: "route-missing" },
    disabledRoute: { containerId: "disabledRoute", managed: true, routeId: "route-disabled" },
    protected: { containerId: "protected", managed: true, routeId: "route-ok" }
  },
  routes: {
    "route-disabled": { id: "route-disabled", enabled: false },
    "route-ok": { id: "route-ok", enabled: true }
  },
  scripts: {}
};

assert.ok(collectWorkflowValidationIssues(workflow("blocked"), state).some((item) => item.code === "route-blocked"));
assert.ok(collectWorkflowValidationIssues(workflow("missingRoute"), state).some((item) => item.code === "route-unavailable"));
assert.ok(collectWorkflowValidationIssues(workflow("disabledRoute"), state).some((item) => item.code === "route-unavailable"));
assert.equal(collectWorkflowValidationIssues(workflow("direct"), state).length, 0);
assert.equal(collectWorkflowValidationIssues(workflow("protected"), state).length, 0);

console.log("workflow route validation tests passed");
