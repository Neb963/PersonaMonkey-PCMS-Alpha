import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createUiContribution as refresherUi } from "../../../pcms-modules/p017/ui.js";
import { createUiContribution as explorerUi } from "../../../pcms-modules/p016/ui.js";
import { createUiContribution as provisioningUi } from "../../../pcms-modules/p019/ui.js";
import { createExplorerService } from "../../../pcms-modules/p016/explorer.js";
import { createExplorerDeployerBridge } from "../../../extension/pcms/integration/explorer-deployer.js";
import { createSingletonStateStore } from "../../../extension/pcms/integration/adapters.js";
import { normalizeBuiltinContribution } from "../../../extension/pcms/integration/ui-contributions.js";
import {
  normalizePcmsUiConditions, normalizePcmsUiDetail, normalizePcmsUiFacet, normalizePcmsUiInput, normalizePcmsUiListPage,
  normalizePcmsUiReceipt, normalizePcmsUiSummary, wrapPcmsUiSecret
} from "../../../extension/pcms/integration/ui-contribution-contract.js";
import { sha256Hex } from "../../../extension/pcms/providers/perchance/contract.js";
import { isSecretRef } from "../../../extension/pcms/secrets/secret-ref.js";
import { AUTO_POLICY, SHA1, commit, createP040Fixture, release } from "./harness.mjs";

const TYPED_ID = /\b(?:id|ids|key|hash|sha|sha-256|uid|secretref|reference)\b/i;

function accountsWithList(ctx) {
  return Object.freeze({
    getAccount:ctx.accounts.service.getAccount,
    async listAccounts() {
      const rows = [];
      for (const id of ["acct-1", "acct-2"]) { const row = await ctx.accounts.service.getAccount(id); if (row) rows.push({ ...row, displayName:id === "acct-1" ? "Alice" : "Bob" }); }
      return { revision:1, accounts:rows };
    }
  });
}
// Core's side of an invocation: the declared input spec validates exactly what the dashboard sent.
async function invoke(contribution, actionId, target, raw, { mode = "execute" } = {}) {
  const { descriptor, functions } = normalizeBuiltinContribution(contribution, contribution.moduleId);
  const action = descriptor.actions.find((item) => item.id === actionId);
  const input = normalizePcmsUiInput(action.input, raw);
  const receipt = await functions.invoke({ asOf:"2026-10-08T12:00:00.000Z", recovery:"NORMAL", generation:null, locale:"en-US" }, actionId, target, input, { mode, idempotencyKey:null });
  return normalizePcmsUiReceipt(receipt, { mode, risk:action.risk });
}
function refresherBundle(fx, wakes) {
  return { refresher:fx.refresher, accounts:accountsWithList(fx.ctx), deployer:fx.ctx.deployer, async wake() { wakes.push(fx.now); return null; } };
}

test("A040-01 Refresher, Explorer and Provisioning inputs are pickers, files and secrets, never typed IDs, hashes or SecretRefs", () => {
  const fake = { refresher:{ listCohortViews() {} }, accounts:{ listAccounts() {} }, deployer:{ listDeployments() {} }, wake() {},
    explorer:{ listCandidates() {} }, explorerDeployer:{ createDeploymentFromClaim() {} },
    provisioning:{ listAttempts() {} }, secrets:{ create() {}, delete() {} } };
  for (const [moduleId, factory] of [["refresher", refresherUi], ["explorer", explorerUi], ["provisioning", provisioningUi]]) {
    const { descriptor } = normalizeBuiltinContribution(factory({ moduleId, service:fake }), moduleId);
    assert.ok(descriptor.nav, moduleId + " contributes a page");
    for (const action of descriptor.actions) {
      for (const field of action.input || []) {
        if (field.kind === "text") assert.doesNotMatch(field.label + " " + field.key, TYPED_ID, moduleId + "." + action.id + "." + field.key);
        if (/account|persona|generator/i.test(field.key) && field.kind !== "text") assert.equal(field.kind, "entity", moduleId + "." + field.key);
      }
    }
  }
  const provisioning = normalizeBuiltinContribution(provisioningUi({ service:fake }), "provisioning").descriptor;
  const start = provisioning.actions.find((action) => action.id === "start");
  assert.deepEqual(start.input.map((field) => [field.key, field.kind]), [["name", "text"], ["persona", "entity"], ["credential", "secret"]]);
  const refresher = normalizeBuiltinContribution(refresherUi({ service:fake }), "refresher").descriptor;
  assert.equal(refresher.actions.find((action) => action.id === "new-cohort").input.find((f) => f.key === "account").entityKind, "account");
  assert.equal(refresher.actions.find((action) => action.id === "add-generator").input[0].entityKind, "generator");
});

test("A040-01 a cohort exists only through New cohort…, with a generated key, explicit generator and human schedule", async () => {
  const fx = createP040Fixture({ commits:{ [SHA1]:commit(release({ slug:"alpha" }), release({ slug:"beta" })) } });
  await fx.connect();
  await fx.deploy("alpha");
  await fx.deploy("beta");
  const wakes = [];
  const ui = refresherUi({ service:refresherBundle(fx, wakes) });
  const created = await invoke(ui, "new-cohort", null, { name:"Daily refresh", account:"acct-1", generator:"alpha",
    mode:"automatic", dailyBudget:3, startHour:6, activeHours:24, restDays:0, enabled:true });
  assert.equal(created.status.token, "OK");
  assert.equal(created.followUp.href, "#/m/refresher/cohort/daily-refresh");
  const cohort = await fx.refresher.getCohort("daily-refresh");
  assert.equal(cohort.name, "Daily refresh");
  assert.deepEqual(cohort.policy, { mode:"AUTO_RECENT", dailyBudget:3, dayOffsetMinutes:360, activeHours:24, sleepDays:0, anchorAt:"2026-10-08T06:00:00.000Z" });
  assert.equal(wakes.length, 1, "the background schedule is re-declared after the change");
  const again = await invoke(ui, "new-cohort", null, { name:"Daily refresh", account:"acct-1", generator:"beta",
    mode:"manual", dailyBudget:1, startHour:0, activeHours:24, restDays:0 });
  assert.equal(again.followUp.href, "#/m/refresher/cohort/daily-refresh-2");
  // Nothing else creates a cohort: refreshing or adding to a missing cohort never creates one.
  const missing = await invoke(ui, "add-generator", { kind:"module-object", moduleId:"refresher", view:"cohort", id:"nope" }, { generator:"beta" }).catch((error) => error);
  assert.ok(missing instanceof Error);
  await assert.rejects(fx.refresher.refreshNow("nope", "alpha"));
  assert.equal((await fx.refresher.listCohorts()).cohorts.length, 2);
  const source = await readFile("pcms-modules/p017/ui.js", "utf8");
  assert.equal(source.match(/refresher\.createCohort\(/g).length, 1);
  // Pages, rows, details, conditions and facets all pass Core validation.
  const { descriptor, functions } = normalizeBuiltinContribution(ui, "refresher");
  const ctx = { asOf:fx.now, recovery:"NORMAL" };
  normalizePcmsUiSummary(await functions.summary(ctx));
  // Assisted-only provider (no `unattended` capability): due refreshes surface in Attention.
  const conditions = normalizePcmsUiConditions(await functions.conditions(ctx), "refresher");
  assert.ok(conditions.some((c) => c.key === "refresher:due:daily-refresh@alpha" && c.actionId === "refresh-now"));
  assert.equal((await functions.summary(ctx)).facts.at(-1).value, "Assisted: use Refresh now");
  const cohorts = normalizePcmsUiListPage(await functions.listRows(ctx, "cohorts", null), descriptor.page.views[0]);
  assert.deepEqual(cohorts.rows.map((row) => row.cells.name), ["Daily refresh", "Daily refresh"]);
  const members = normalizePcmsUiListPage(await functions.listRows(ctx, "members", null), descriptor.page.views[2]);
  assert.deepEqual(members.rows.map((row) => row.id), ["daily-refresh@alpha", "daily-refresh-2@beta"]);
  assert.equal(members.rows[0].cells.ready, "Ready");
  const detail = normalizePcmsUiDetail(await functions.getDetail(ctx, "member", "daily-refresh@alpha"));
  assert.equal(detail.sections[0].facts.find((fact) => fact.label === "Content").value, "Ready");
  normalizePcmsUiFacet(await functions.facets.generator(ctx, { kind:"generator", id:"alpha" }), { actionIds:descriptor.actions.map((a) => a.id) });
  // Refresh now is previewed with the consequences and dispatches the confirmed release.
  const target = { kind:"module-object", moduleId:"refresher", view:"member", id:"daily-refresh-2@beta" };
  const preview = await invoke(ui, "refresh-now", target, null, { mode:"preview" });
  assert.match(preview.impact.consequences[0], /Deployer-confirmed release of beta/);
  const refreshed = await invoke(ui, "refresh-now", target, null);
  assert.equal(refreshed.status.token, "OK");
  const budget = await invoke(ui, "refresh-now", target, null);
  assert.equal(budget.status.token, "WARNING");
  assert.match(budget.message, /not possible|budget/);
});

test("A040-01 Explorer records from a picked account and an uploaded file, and generates every ID", async () => {
  const fx = createP040Fixture();
  const explorerStore = createSingletonStateStore({ storageBroker:fx.ctx.storage, namespace:"module.explorer" });
  const explorer = createExplorerService({ stateStore:explorerStore, accountsService:fx.ctx.accounts.service, clock:() => fx.now });
  const explorerDeployer = createExplorerDeployerBridge({ explorer, deployer:fx.ctx.deployer });
  const ui = explorerUi({ service:{ explorer, explorerDeployer, deployer:fx.ctx.deployer, accounts:accountsWithList(fx.ctx) } });
  const source = "observed generator source";
  const recorded = await invoke(ui, "record", null, { account:"acct-1", generator:"found-one", source });
  assert.equal(recorded.status.token, "OK");
  await invoke(ui, "record", null, { account:"acct-1", generator:"found-two" });
  const candidates = await explorer.listCandidates();
  assert.deepEqual(candidates.candidates.map((c) => [c.generatorId, c.freshness]), [["found-one", "CURRENT"], ["found-two", "CURRENT"]],
    "a new observation adds to, never drops, earlier ones");
  assert.equal(candidates.candidates[0].observedSourceHash, await sha256Hex(source));
  assert.equal(JSON.stringify((await explorerStore.read()).value).includes(source), false, "only the fingerprint is kept");
  const reserved = await invoke(ui, "reserve", { kind:"module-object", moduleId:"explorer", view:"candidate", id:candidates.candidates[0].candidateId }, null);
  const claimId = decodeURIComponent(reserved.followUp.href.split("/").pop());
  assert.equal(claimId, "reserve:found-one:1");
  const prepared = await invoke(ui, "prepare", { kind:"module-object", moduleId:"explorer", view:"reservation", id:claimId }, null);
  assert.equal(prepared.status.token, "OK");
  const deployment = (await fx.ctx.deployer.listDeployments()).deployments.find((d) => d.targetRef.id === "found-one");
  assert.equal(deployment.deploymentId, "explore:found-one:1");
  assert.equal(deployment.desired.payloadHash, await sha256Hex(source));
  // A reservation without uploaded source cannot become a deployment (it has no fingerprint).
  const two = (await explorer.listCandidates()).candidates[1];
  const reservedTwo = await invoke(ui, "reserve", { kind:"module-object", moduleId:"explorer", view:"candidate", id:two.candidateId }, null);
  const notReady = await invoke(ui, "prepare", { kind:"module-object", moduleId:"explorer", view:"reservation", id:decodeURIComponent(reservedTwo.followUp.href.split("/").pop()) }, null);
  assert.equal(notReady.status.token, "WARNING");
});

function provisioningFake({ failCreate = false } = {}) {
  const attempts = [];
  const secrets = { created:[], deleted:[] };
  return {
    attempts, secrets,
    service:{
      provisioning:{
        async listAttempts() { return attempts.map((value) => ({ revision:1, value })); },
        async createAttempt(input) {
          if (failCreate) throw Object.assign(new Error("conflict"), { code:"PCMS_PROVISIONING_PERSONA_CONFLICT" });
          attempts.push({ ...input, state:"SESSION_REQUIRED", updatedAt:"2026-10-08T12:00:00.000Z" });
          return { revision:1, value:attempts.at(-1) };
        },
        async getAttempt(id) { const value = attempts.find((a) => a.attemptId === id); return value ? { revision:1, value } : null; },
        async acquireSession(id) { const value = attempts.find((a) => a.attemptId === id); value.state = "SESSION_ACTIVE"; return { revision:2, value }; },
        async advance(id) { const value = attempts.find((a) => a.attemptId === id); value.state = "WAITING_HUMAN"; return { revision:3, value }; },
        async reconcileAttempt() { throw new Error("unexpected"); },
        async cancelAttempt() { throw new Error("unexpected"); }
      },
      accounts:{ async listAccounts() { return { revision:1, accounts:[{ accountId:"carol", displayName:"Carol" }] }; } },
      secrets:{
        async create(value) { secrets.created.push(value); return "pcms-secret:v1:0f8fad5b-d9cb-469f-a165-70867728950e"; },
        async delete(ref) { secrets.deleted.push(ref); return { deleted:true }; }
      }
    }
  };
}

test("A040-01 Provisioning stores the credential through the secret host and keeps only a SecretRef", async () => {
  const fake = provisioningFake();
  const ui = provisioningUi({ service:fake.service });
  const password = "correct horse battery staple";
  const started = await invoke(ui, "start", null, { name:"Carol", persona:"11111111-1111-4111-8111-111111111111", credential:wrapPcmsUiSecret(password) });
  assert.equal(started.status.token, "OK");
  assert.deepEqual(fake.secrets.created, [password]);
  const attempt = fake.attempts[0];
  assert.equal(attempt.accountId, "carol-2", "the account key is generated and never collides");
  assert.equal(attempt.attemptId, "attempt:carol-2:1");
  assert.ok(isSecretRef(attempt.credentialRef));
  assert.equal(JSON.stringify(started).includes(password), false);
  assert.equal(JSON.stringify(started).includes(attempt.credentialRef), false, "the operator never sees the SecretRef");
  const target = { kind:"module-object", moduleId:"provisioning", view:"attempt", id:attempt.attemptId };
  assert.match((await invoke(ui, "continue", target, null)).message, /Session open/);
  assert.match((await invoke(ui, "continue", target, null)).message, /Waiting for you/);
  // A secret never arrives as a plain string, and an empty secret is refused.
  assert.throws(() => normalizePcmsUiInput(normalizeBuiltinContribution(ui, "provisioning").descriptor.actions[0].input,
    { name:"Dan", persona:"11111111-1111-4111-8111-111111111111", credential:password }));
  // A failed attempt creation deletes the secret it just stored.
  const failing = provisioningFake({ failCreate:true });
  const refused = await invoke(provisioningUi({ service:failing.service }), "start", null,
    { name:"Dan", persona:"11111111-1111-4111-8111-111111111111", credential:wrapPcmsUiSecret("x") });
  assert.equal(refused.status.token, "WARNING");
  assert.deepEqual(failing.secrets.deleted, ["pcms-secret:v1:0f8fad5b-d9cb-469f-a165-70867728950e"]);
});

test("A040-01 the dashboard collects inputs with pickers, file reads and password boxes, never free-text IDs", async () => {
  const [input, app, view, html] = await Promise.all([
    readFile("extension/pcms/app/action-input.js", "utf8"),
    readFile("extension/pcms/app/app.js", "utf8"),
    readFile("extension/pcms/app/module-view.js", "utf8"),
    readFile("extension/pcms/app/index.html", "utf8")
  ]);
  assert.match(input, /createEntityPicker/);
  assert.match(input, /runtime\.accounts\.listAccounts\(\)/);
  assert.match(input, /runtime\.personaDirectory\.list\(\)/);
  assert.match(input, /runtime\.generators\.list\(\{page\}\)/);
  assert.match(input, /input\.type="password"/);
  assert.match(input, /wrapPcmsUiSecret\(input\.value\)/);
  assert.match(input, /clear:\(\)=>\{input\.value="";\}/);
  assert.match(input, /file\.text\(\)/);
  assert.doesNotMatch(input, /innerHTML|localStorage|sessionStorage|console\./);
  assert.match(app, /createPcmsActionInputDialog/);
  assert.match(view, /module-object-actions/);
  assert.match(view, /module-view-tabs/);
  assert.match(html, /id="moduleInputDialog"/);
});
