import assert from "node:assert/strict";
import {
  addWorkflowStep,
  chooseStarterProfileId,
  collectWorkflowValidationIssues,
  createStarterWorkflow,
  createWorkflowStep,
  duplicateWorkflow,
  moveWorkflowStep,
  removeWorkflowStep,
  MAX_WORKFLOW_TASKS,
  validateWorkflowForRun
} from "../lib/workflow-model.js";
import { MAX_WORKFLOW_STEP_TIMEOUT_MS } from "../lib/constants.js";
import { normalizeWorkflow } from "../lib/storage.js";

const profiles = {
  blocked: { containerId: "blocked", managed: true, routeId: "__block__" },
  direct: { containerId: "direct", managed: true, routeId: "__direct__" },
  protected: { containerId: "protected", managed: true, routeId: "mullvad-1" },
  unmanaged: { containerId: "unmanaged", managed: false, routeId: "mullvad-2" }
};

assert.equal(chooseStarterProfileId(profiles), "protected", "starter should prefer a protected routed persona");
assert.equal(chooseStarterProfileId({ blocked: profiles.blocked, direct: profiles.direct }), "direct");
assert.equal(chooseStarterProfileId({ blocked: profiles.blocked }), "blocked");
assert.equal(chooseStarterProfileId({}), "");

const starter = createStarterWorkflow(profiles);
assert.equal(starter.id, "workflow-starter-smoke");
assert.equal(starter.name, "Smoke test — example.com");
assert.equal(starter.steps.length, 1);
assert.equal(starter.steps[0].profileId, "protected");
assert.deepEqual(starter.steps[0].urls, ["https://example.com/"]);
assert.equal(starter.steps[0].concurrency, 1);
assert.equal(starter.steps[0].completion.mode, "load");
assert.equal(starter.steps[0].completion.timeoutMs, 30000);
assert.equal(starter.steps[0].retryDelayMs, 1000);
assert.equal(starter.steps[0].closeTabs, true);
assert.equal(starter.steps[0].stopOnError, true);
assert.equal(createStarterWorkflow({}), null);

const first = createWorkflowStep({ profileId: "protected" });
const workflow = {
  id: "workflow-test",
  name: "Test",
  enabled: true,
  steps: [first]
};
const withSecond = addWorkflowStep(workflow, "direct");
assert.equal(withSecond.steps.length, 2);
assert.equal(withSecond.steps[0].profileId, "protected");
assert.equal(withSecond.steps[1].profileId, "direct");
assert.notEqual(withSecond.steps[0].id, withSecond.steps[1].id, "added steps need unique ids");
assert.equal(workflow.steps.length, 1, "model helpers must not mutate the caller's workflow object");

const duplicateStepWorkflow = {
  enabled: true,
  steps: [
    { id: "duplicate-step", profileId: "protected", urls: ["https://example.com/a"] },
    { id: "duplicate-step", profileId: "protected", urls: ["https://example.com/b"] }
  ]
};
const duplicateStepIssue = collectWorkflowValidationIssues(duplicateStepWorkflow, { profiles })
  .find((entry) => entry.code === "step-id-duplicate");
assert.ok(duplicateStepIssue, "saved workflows must reject duplicate semantic step IDs");
assert.throws(() => validateWorkflowForRun(duplicateStepWorkflow, { profiles }), /step id .* must be unique/i);

const moved = moveWorkflowStep(withSecond, 1, -1);
assert.equal(moved.steps[0].profileId, "direct");
assert.equal(moved.steps[1].profileId, "protected");

const removed = removeWorkflowStep(withSecond, 0);
assert.equal(removed.steps.length, 1);
assert.equal(removed.steps[0].profileId, "direct");
assert.equal(removeWorkflowStep(removed, 0).steps.length, 1, "the editor must keep at least one step");

const duplicated = duplicateWorkflow(withSecond, { id: "workflow-copy" });
assert.equal(duplicated.id, "workflow-copy");
assert.equal(duplicated.name, "Test copy");
assert.equal(duplicated.steps.length, 2);
assert.notEqual(duplicated.steps[0].id, withSecond.steps[0].id);
assert.notEqual(duplicated.steps[1].id, withSecond.steps[1].id);

assert.doesNotThrow(() => validateWorkflowForRun({ enabled: true, steps: [{ profileId: "protected", urls: ["https://example.com/"], concurrency: 1, retries: 0, retryDelayMs: 1000, completion: { mode: "delay", value: "5000", timeoutMs: 60000 } }] }));
assert.doesNotThrow(() => validateWorkflowForRun({ enabled: true, steps: [{ profileId: "protected", urls: ["https://example.com/"], concurrency: 1, retries: 0, retryDelayMs: 1000, completion: { mode: "delay", value: "", timeoutMs: 60000 } }] }));
assert.throws(
  () => validateWorkflowForRun({ enabled: true, steps: [{ profileId: "protected", urls: ["https://example.com/"], concurrency: 1, retries: 0, retryDelayMs: 1000, completion: { mode: "delay", value: "-5000", timeoutMs: 60000 } }] }),
  /delay must be between 0 and 600000 ms/
);
assert.throws(
  () => validateWorkflowForRun({ enabled: true, steps: [{ profileId: "protected", urls: ["https://example.com/"], concurrency: 1, retries: 0, retryDelayMs: 1000, scriptIds: [], completion: { mode: "signal", timeoutMs: 60000 } }] }),
  /Persona\.complete\(\) signal requires at least one selected userscript/
);
const validSignalState = { profiles, routes: { "mullvad-1": { enabled: true } }, scripts: { "signal-script": { name: "Signal", enabled: true, grants: ["Persona.signal"], profileIds: ["protected"] } } };
const validSignalWorkflow = { enabled: true, steps: [{ profileId: "protected", urls: ["https://example.com/"], concurrency: 1, retries: 0, retryDelayMs: 1000, scriptIds: ["signal-script"], completion: { mode: "signal", timeoutMs: 60000 } }] };
assert.doesNotThrow(() => validateWorkflowForRun(validSignalWorkflow, validSignalState));

for (const timeoutMs of [31 * 60_000, MAX_WORKFLOW_STEP_TIMEOUT_MS - 1, MAX_WORKFLOW_STEP_TIMEOUT_MS]) {
  assert.doesNotThrow(() => validateWorkflowForRun({ steps: [{ profileId: "direct", urls: ["https://example.com/"], completion: { mode: "load", timeoutMs } }] }), `validator accepts ${timeoutMs}ms`);
  assert.equal(normalizeWorkflow({ steps: [{ completion: { timeoutMs } }] }, "timeout-test").steps[0].completion.timeoutMs, timeoutMs, `storage preserves ${timeoutMs}ms`);
}
assert.throws(
  () => validateWorkflowForRun({ steps: [{ profileId: "direct", urls: ["https://example.com/"], completion: { mode: "load", timeoutMs: MAX_WORKFLOW_STEP_TIMEOUT_MS + 1 } }] }),
  /timeout must be between 1000 and 3600000 ms/
);
assert.equal(normalizeWorkflow({ steps: [{ completion: { timeoutMs: MAX_WORKFLOW_STEP_TIMEOUT_MS + 1 } }] }, "timeout-test").steps[0].completion.timeoutMs, MAX_WORKFLOW_STEP_TIMEOUT_MS, "normalization caps values above the shared maximum");

const signalStep = { profileId: "protected", urls: ["https://example.com/"], scriptIds: ["signal-script"], completion: { mode: "signal" } };
const missingSignalGrant = collectWorkflowValidationIssues({ steps: [signalStep] }, {
  ...validSignalState,
  scripts: { "signal-script": { ...validSignalState.scripts["signal-script"], grants: ["GM_info"] } }
}).find((entry) => entry.code === "signal-grant-required");
assert.match(missingSignalGrant.message, /@grant Persona\.signal/);
const mainWorldState = { ...validSignalState, scripts: { "signal-script": { ...validSignalState.scripts["signal-script"], name: "Page signal", injectInto: "page" } } };
const mainWorldIssue = collectWorkflowValidationIssues({ steps: [signalStep] }, mainWorldState).find((entry) => entry.code === "signal-main-world");
assert.match(mainWorldIssue.message, /@inject-into content/);
assert.doesNotThrow(() => validateWorkflowForRun({ steps: [signalStep] }, {
  ...mainWorldState, scripts: { "signal-script": { ...mainWorldState.scripts["signal-script"], injectInto: "content" } }
}));

const urls = Array.from({ length: MAX_WORKFLOW_TASKS }, (_, index) => `https://example.com/${index}`);
assert.doesNotThrow(() => validateWorkflowForRun({ steps: [{ profileId: "direct", urls }] }));
const tooLarge = { steps: [{ profileId: "direct", urls: [...urls, "https://example.com/overflow"] }] };
assert.equal(collectWorkflowValidationIssues(tooLarge).find((entry) => entry.code === "workflow-task-limit").stepIndex, null);
assert.throws(() => validateWorkflowForRun(tooLarge), /maximum is 500/);
assert.doesNotThrow(() => validateWorkflowForRun({ steps: [{ profileId: "direct", urls: [...urls, urls[0]] }] }), "repeated URL within a step creates no new task");
assert.throws(() => validateWorkflowForRun({ steps: [{ profileId: "direct", urls }, { profileId: "direct", urls: [urls[0]] }] }), /maximum is 500/, "the same URL in another step is another task");

const state = {
  profiles,
  scripts: {
    "signal-script": { id: "signal-script", name: "Signal", enabled: true, profileIds: ["protected"] }
  }
};
const issues = collectWorkflowValidationIssues({
  enabled: true,
  steps: [{ profileId: "protected", urls: ["ftp://bad.example/"], concurrency: 0, scriptIds: ["missing"], completion: { mode: "selector", value: "", timeoutMs: 500 }, retries: 11, retryDelayMs: 700000 }]
}, state);
assert.ok(issues.length >= 6, "validation should report all actionable problems instead of only the first");
assert.ok(issues.some((entry) => entry.code === "url-invalid"));
assert.ok(issues.some((entry) => entry.code === "script-missing"));
assert.ok(issues.some((entry) => entry.code === "selector-required"));
assert.ok(issues.some((entry) => entry.code === "retry-delay-invalid"));

console.log("workflow model tests passed");
