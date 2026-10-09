// A036-03 FDE proof in the exact pinned Developer Edition with the packaged product XPI.
//
// Part A drives the real dashboard against the real background Core: the Generators route and
// the #/generators/perchance/<slug> deep link render from the Core generator index through the
// UI client, and the Deploy-from-file dialog asks for no typed IDs. Nothing is deployed against
// real Perchance (provider-live work belongs to P043/P044).
//
// Part B runs the shipped Generators view and the shipped Deployer, RemoteOps, ProviderGate,
// HumanTask, Audit Journal, provider handoff and assisted driver modules, copied byte for
// byte from the product XPI into a separate fixture add-on page, over its own IndexedDB: real File inputs, TextDecoder, crypto.subtle and
// Blob URLs; a durable assisted handoff; an "I'm not sure" answer that is never replayed; and
// an Applied answer that settles to "In sync". Product Core and PersonaMonkey are untouched.
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { execFileText, loadBrowserPin, sha256File, writeJson } from "../../../tools/firefox/lib.mjs";
import { PackagedFirefox, waitFor } from "../../../tools/firefox/packaged-harness.mjs";
import { P036_FIXTURE_ID, P036_FIXTURE_PAGE, assertP036Flow, buildP036FixtureExtension } from "./fixture-extension.mjs";

const PRODUCT = "persona-route-manager@local";
const root = resolve(process.env.FIREFOX_PACKAGED_DIR || join(tmpdir(), "pcms-firefox-p036"));
const reportPath = resolve(process.env.FIREFOX_P036_REPORT || join(root, "p036-report.json"));
const pin = await loadBrowserPin();
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const xpi = resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report = {
  schemaVersion: 1,
  phase: "P036",
  commitSha: process.env.GITHUB_SHA || (await execFileText("git", ["rev-parse", "HEAD"])).stdout.trim(),
  workflowRun: process.env.GITHUB_RUN_ID || null,
  version: pin.version,
  artifactSha256: pin.archive.sha256,
  productXpiSha256: await sha256File(xpi),
  checks: {},
  facts: {}
};

let h;
let sequence = 0;

async function page(code, args = []) {
  const result = await h.pageScript(`const done = arguments[arguments.length - 1];
    (async () => { const api = window.wrappedJSObject.browser; ${code} })()
      .then(value => done({ ok: true, value: JSON.parse(JSON.stringify(value ?? null)) }),
        error => done({ ok: false, error: String(error && error.message || error) + " | " + String(error && error.stack || "") }));`, args, { async: true });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function ui(name, args = [], kind = "query") {
  const id = "p036-" + (++sequence) + "-" + Date.now();
  const response = await page(`
    const [name, args, kind, id] = [arguments[0], arguments[1], arguments[2], arguments[3]];
    const message = { type: "PCMS_UI_REQUEST", version: 1, requestId: id, kind, name, params: { args } };
    if (kind === "command") message.idempotencyKey = id;
    return api.runtime.sendMessage(message);`, [name, args, kind, id]);
  if (!response?.ok) throw Object.assign(new Error((response?.error?.code || "PCMS_UI_FAILED") + ": " + (response?.error?.message || name)), { code: response?.error?.code });
  return response.result;
}

async function dom() {
  return h.pageScript(`
    const host = document.getElementById("generatorsV2");
    const modal = host?.querySelector(".generators-modal") ?? null;
    return {
      hash: location.hash,
      placeholderVisible: document.getElementById("viewPlaceholder")?.hidden === false,
      hostVisible: host ? host.hidden === false : null,
      heading: document.getElementById("placeholderHeading")?.textContent ?? null,
      text: host?.textContent?.slice(0, 600) ?? null,
      empty: host?.querySelector(".empty-state")?.textContent ?? null,
      deployButton: Boolean(host?.querySelector("[data-generators-action=deploy-new]")),
      modal: modal ? {
        textInputs: [...modal.querySelectorAll("input")].filter((i) => !["file","radio","search"].includes(i.type)).map((i) => i.name),
        fileInputs: [...modal.querySelectorAll("input[type=file]")].map((i) => i.name),
        listing: [...modal.querySelectorAll("input[name=listing]")].map((i) => i.value + ":" + i.checked),
        picker: Boolean(modal.querySelector('.entity-picker [role="listbox"]')),
        submitDisabled: modal.querySelector("button[type=submit]")?.disabled ?? null
      } : null
    };`);
}

async function until(predicate, label, timeout = 30000) {
  let last = null;
  try {
    return await waitFor(async () => { last = await dom(); return predicate(last) ? last : null; }, label, timeout);
  } catch (error) {
    error.message += " · last DOM " + JSON.stringify(last);
    throw error;
  }
}

try {
  await mkdir(root, { recursive: true });
  h = await PackagedFirefox.create({ root: join(root, "profiles-p036") });
  await h.start();
  assert.equal(await h.install(xpi), PRODUCT);
  const handle = await h.openPage(PRODUCT, "pcms/app/index.html#/generators");
  await waitFor(() => h.pageScript('return document.getElementById("brokerLiveStatus")?.dataset.state==="connected";'),
    "packaged P036 dashboard connects", 30000);

  // Part A — real background Core through the UI client.
  const index = await ui("generators.list", [{}]);
  assert.equal(index.contract, "pcms.generator-index/v1");
  assert.equal(index.total, 0);
  assert.equal(await ui("generators.get", ["perchance:tavern-names"]), null);
  const views = await ui("deployer.listDeploymentViews");
  assert.deepEqual(views.deployments, []);
  let state = await until((d) => d.placeholderVisible && d.hostVisible && d.empty, "Generators list renders from the Core index");
  assert.equal(state.heading, "Generators");
  assert.match(state.empty, /No generators yet/);
  assert.equal(state.deployButton, true);
  report.checks.generatorsRouteRendersCoreIndex = true;

  await h.pageScript(`document.querySelector("#generatorsV2 [data-generators-action=deploy-new]").click(); return true;`);
  state = await until((d) => d.modal, "Deploy from file dialog opens");
  assert.deepEqual(state.modal.textInputs, ["address"], "only the Perchance address is typed; IDs are generated");
  assert.deepEqual(state.modal.fileInputs, ["code", "html", "thumbnail"]);
  assert.deepEqual(state.modal.listing, ["PUBLICLY_LISTED:true", "UNLISTED:false"]);
  assert.equal(state.modal.picker, true);
  assert.equal(state.modal.submitDisabled, true);
  await h.pageScript(`[...document.querySelectorAll("#generatorsV2 .generators-dialog-actions button")].find((b) => b.type === "button").click(); return true;`);
  await until((d) => !d.modal, "dialog cancels without any command");
  report.checks.deployDialogNeedsNoTypedIds = true;

  await h.pageScript("location.hash = arguments[0]; return true;", ["#/generators/perchance/tavern-names"]);
  state = await until((d) => d.hash === "#/generators/perchance/tavern-names" && /does not manage this generator yet/.test(d.text || ""), "generator detail deep link");
  report.checks.generatorDetailDeepLink = true;
  assert.equal((await ui("generators.list", [{}])).total, 0, "Part A deployed nothing");

  // Part B — shipped modules and view in a separate fixture add-on page (own IndexedDB).
  const fixture = await buildP036FixtureExtension({
    productXpi: xpi,
    workDir: join(root, "fixture-p036"),
    flowSource: await readFile("tests/pcms/p036/view-flow.mjs", "utf8")
  });
  report.facts.fixture = { copiedProductFiles: fixture.copiedFiles, copiedProductDigest: fixture.digest };
  assert.equal(await h.install(fixture.xpi), P036_FIXTURE_ID);
  const fixtureTab = await h.openPage(P036_FIXTURE_ID, P036_FIXTURE_PAGE);
  const outcome = await waitFor(async () => {
    const text = await h.pageScript("return document.body?.dataset.p036Result ?? null;");
    return text ? JSON.parse(text) : null;
  }, "P036 fixture flow completes", 90000);
  if (!outcome.ok) throw new Error("P036 fixture flow failed: " + outcome.error);
  const flow = outcome.value;
  await h.closePage(fixtureTab);
  report.facts.flow = { ...flow, storedDeployer: undefined, handoffPanels: flow.handoffPanels?.map((panel) => ({ label: panel.label, chars: panel.value.length })) };
  assertP036Flow(flow);
  report.checks.manualDeployDurableHandoffInFirefox = true;
  report.checks.unknownAnswerNeverReplayed = true;
  report.checks.appliedAnswerSettlesInSync = true;
  await h.closePage(handle);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await h?.stop();
  await writeJson(reportPath, report);
  if (h) await rm(h.profilePath, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
