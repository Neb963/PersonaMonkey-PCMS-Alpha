import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_WORKFLOW_STEP_TIMEOUT_MS } from "../lib/constants.js";
import { exportWorkflowPackage, importWorkflowPackage, inspectWorkflowPackage, validateWorkflowPackageManifest } from "../lib/workflow-package.js";
import { getIntegrationCommandDescriptor } from "../lib/management-integration-protocol.js";

// Evaluate the keywords used by the published schema from the schema itself.
// This keeps contract checks dependency-free in CI and catches schema drift.
const schema = JSON.parse(readFileSync(new URL("../../docs/reference/personamonkey-workflow-package.schema.json", import.meta.url)));
const optionsUi = readFileSync(new URL("../options/options.js", import.meta.url), "utf8");
const automationsUi = readFileSync(new URL("../options/automations.js", import.meta.url), "utf8");
assert.ok(optionsUi.includes('max="${MAX_WORKFLOW_STEP_TIMEOUT_MS}"'), "workflow editor UI must use the shared timeout maximum");
assert.ok(automationsUi.includes('max="${MAX_WORKFLOW_STEP_TIMEOUT_MS}"'), "automations UI must use the shared timeout maximum");
const packageTimeoutSchema = schema.properties.workflow.properties.steps.items.properties.completion.properties.timeoutMs;
assert.equal(packageTimeoutSchema.maximum, MAX_WORKFLOW_STEP_TIMEOUT_MS, "published package schema must match the shared workflow timeout maximum");
const managementTimeoutSchema = getIntegrationCommandDescriptor("workflow.create").params.workflow.shape.steps.items.shape.completion.shape.timeoutMs;
assert.equal(managementTimeoutSchema.max, MAX_WORKFLOW_STEP_TIMEOUT_MS, "management schema must match the shared workflow timeout maximum");
const example = JSON.parse(readFileSync(new URL("../../examples/workflow-packages/mullvad-signal-check/manifest.json", import.meta.url)));
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/workflow-package-contract.json", import.meta.url)));

function schemaIssues(value, definition, path = "manifest") {
  const issues = [];
  if ("const" in definition && value !== definition.const) issues.push(`${path}: const`);
  if (definition.enum && !definition.enum.includes(value)) issues.push(`${path}: enum`);
  const type = definition.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [...issues, `${path}: object`];
    for (const key of definition.required || []) if (!Object.hasOwn(value, key)) issues.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      const property = definition.properties?.[key];
      if (!property) {
        if (definition.additionalProperties === false) issues.push(`${path}.${key}: additionalProperties`);
      } else issues.push(...schemaIssues(item, property, `${path}.${key}`));
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return [...issues, `${path}: array`];
    if (value.length < (definition.minItems ?? 0) || value.length > (definition.maxItems ?? Infinity)) issues.push(`${path}: item count`);
    if (definition.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) issues.push(`${path}: uniqueItems`);
    value.forEach((item, index) => issues.push(...schemaIssues(item, definition.items, `${path}[${index}]`)));
  } else if (type === "string") {
    if (typeof value !== "string") return [...issues, `${path}: string`];
    if (value.length < (definition.minLength ?? 0) || value.length > (definition.maxLength ?? Infinity)) issues.push(`${path}: length`);
    if (definition.pattern && !new RegExp(definition.pattern).test(value)) issues.push(`${path}: pattern`);
  } else if (type === "integer") {
    if (!Number.isInteger(value) || value < (definition.minimum ?? -Infinity) || value > (definition.maximum ?? Infinity)) issues.push(`${path}: integer range`);
  } else if (type === "boolean" && typeof value !== "boolean") issues.push(`${path}: boolean`);
  return issues;
}

function applyFixture(fixture) {
  const manifest = structuredClone(example);
  if (!fixture.path) return manifest;
  const container = fixture.path.slice(0, -1).reduce((node, key) => node[key], manifest);
  const key = fixture.path.at(-1);
  if (fixture.remove) delete container[key];
  else if (fixture.value === "duplicate:persona") container[key].push({ ...container[key][0], label: "Second persona" });
  else if (fixture.value === "duplicate:script") container[key].push({ ...container[key][0], name: "Second script" });
  else if (fixture.value?.startsWith?.("repeat:")) container[key] = "a".repeat(Number(fixture.value.slice(7)));
  else if (fixture.value?.startsWith?.("urlLength:")) container[key] = "https://example.com/" + "a".repeat(Number(fixture.value.slice(10)) - "https://example.com/".length);
  else if (fixture.value?.startsWith?.("urls:")) container[key] = Array.from({ length: Number(fixture.value.slice(5)) }, (_, index) => `https://example.com/${index}`);
  else if (fixture.value?.startsWith?.("personas:")) container[key] = Array.from({ length: Number(fixture.value.slice(9)) }, (_, index) => ({ key: `persona-${index}`, label: `Persona ${index}` }));
  else if (fixture.value?.startsWith?.("scripts:")) container[key] = Array.from({ length: Number(fixture.value.slice(8)) }, (_, index) => ({ key: `script-${index}`, file: `userscripts/s${index}.user.js`, name: `Script ${index}` }));
  else if (fixture.value?.startsWith?.("steps:")) container[key] = Array.from({ length: Number(fixture.value.slice(6)) }, (_, index) => ({ id: `step-${index}`, personaKey: "protected", urls: ["https://example.com/"] }));
  else if (fixture.value?.startsWith?.("scriptKeys:")) container[key] = Array.from({ length: Number(fixture.value.slice(11)) }, (_, index) => `script-${index}`);
  else container[key] = fixture.value;
  return manifest;
}

for (const fixture of fixtures) {
  const manifest = applyFixture(fixture);
  const schemaErrors = schemaIssues(manifest, schema);
  const runtimeErrors = validateWorkflowPackageManifest(manifest);
  assert.equal(schemaErrors.length === 0, fixture.schemaValid === true, `${fixture.name}: schema ${schemaErrors.join("; ")}`);
  assert.equal(runtimeErrors.length === 0, fixture.runtimeValid === true, `${fixture.name}: importer ${runtimeErrors.join("; ")}`);
  if (fixture.reason) assert.ok(runtimeErrors.some((message) => message.includes(fixture.reason)), `${fixture.name}: expected ${fixture.reason} in ${runtimeErrors.join("; ")}`);
}

const exported = await exportWorkflowPackage({ name: "Export contract", steps: [{ profileId: "p1", urls: ["https://example.com/"] }] }, {
  profiles: { p1: { containerId: "p1", managed: true, name: "Direct", routeId: "__direct__" } },
  routes: {}, scripts: {}, workflows: {}
});
assert.deepEqual(schemaIssues(exported.manifest, schema), [], "exported manifests must validate against the published schema");

for (const timeoutMs of [MAX_WORKFLOW_STEP_TIMEOUT_MS - 1, MAX_WORKFLOW_STEP_TIMEOUT_MS]) {
  const workflow = { name: "Timeout boundary", steps: [{ profileId: "p1", urls: ["https://example.com/"], completion: { mode: "load", timeoutMs } }] };
  const state = { profiles: { p1: { containerId: "p1", managed: true, name: "Direct", routeId: "__direct__" } }, routes: {}, scripts: {}, workflows: {} };
  const packageData = await exportWorkflowPackage(workflow, state);
  assert.equal(packageData.manifest.workflow.steps[0].completion.timeoutMs, timeoutMs, `package export preserves ${timeoutMs}ms`);
  assert.deepEqual(schemaIssues(packageData.manifest, schema), [], `static schema accepts ${timeoutMs}ms`);
  assert.deepEqual(validateWorkflowPackageManifest(packageData.manifest), [], `package validator accepts ${timeoutMs}ms`);
  const preview = await inspectWorkflowPackage(packageData.bytes, state);
  const imported = importWorkflowPackage(preview, state, { "persona-1": "p1" });
  assert.equal(imported.workflow.steps[0].completion.timeoutMs, timeoutMs, `package normalization preserves ${timeoutMs}ms`);
}

const aboveMax = structuredClone(exported.manifest);
aboveMax.workflow.steps[0].completion = { mode: "load", timeoutMs: MAX_WORKFLOW_STEP_TIMEOUT_MS + 1 };
assert.ok(schemaIssues(aboveMax, schema).some((entry) => entry.includes("integer range")), "static schema rejects max+1");
assert.ok(validateWorkflowPackageManifest(aboveMax).some((entry) => entry.includes(`between 1000 and ${MAX_WORKFLOW_STEP_TIMEOUT_MS}`)), "package validator rejects max+1");

console.log(`workflow package schema contract tests passed (${fixtures.length} fixtures)`);
