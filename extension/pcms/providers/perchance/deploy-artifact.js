// Reviewed, immutable PersonaMonkey execution artifact for the deterministic fixture editor
// (P042). It is deliberately not a guessed Perchance editor selector contract: real Perchance
// unattended deployment stays disabled until the final live phase confirms it (P044).
//
// The release travels as a transient PersonaMonkey execution input ("release"), never in the
// artifact source, so one reviewed artifact identity serves every deployment of an origin.
import { DEPLOY_FIXTURE_LISTING_SOURCE } from "./listing.js";

export const PERCHANCE_DEPLOY_FIXTURE_FORMAT = "pcms.perchance.deploy-fixture/v1";
export const PERCHANCE_RELEASE_INPUT_FORMAT = "pcms.perchance.release-input/v1";
export const PERCHANCE_RELEASE_INPUT_NAME = "release";

export function createDeployFixtureArtifact(origin) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new TypeError("Deployment fixture requires an exact loopback HTTP origin");
  }
  return `// ==UserScript==
// @name PCMS Perchance fixture deployment
// @match ${url.protocol}//${url.hostname}/*
// @grant Persona.signal
// @grant Persona.input
// @run-at document-idle
// ==/UserScript==
(async () => {
  const fail = () => { throw new Error("Deployment fixture contract unavailable"); };
  if (location.origin !== ${JSON.stringify(origin)}) fail();
  const page = document.querySelector('[data-pcms-editor="v1"]');
  if (!page || page.dataset.generator !== location.pathname.slice(1)) fail();
  const input = await Persona.input.json(${JSON.stringify(PERCHANCE_RELEASE_INPUT_NAME)});
  if (!input || input.format !== ${JSON.stringify(PERCHANCE_RELEASE_INPUT_FORMAT)} || input.generatorId !== page.dataset.generator
      || typeof input.operationId !== "string" || !["deploy", "verify"].includes(input.mode)) fail();
  const report = (status, challenge = false) => Persona.complete({ operationId:input.operationId, generatorId:input.generatorId, status, challenge });
  // A challenge never proves anything and is never solved by PCMS.
  if (page.dataset.challenge === "true") { report("NOT_APPLIED", true); return; }
  const receipts = (page.dataset.receipts || "").split(" ").filter(Boolean);
  // Fixture reconciliation: the editor's save-receipt ledger is the provider's answer.
  if (input.mode === "verify") { report(receipts.includes(input.operationId) ? "APPLIED" : "NOT_APPLIED"); return; }
  if (receipts.includes(input.operationId)) { report("APPLIED"); return; }
  // generator.create is not supported: a missing generator is never created implicitly.
  if (page.dataset.exists === "false") { report("NOT_APPLIED"); return; }
  if (typeof input.code !== "string" || typeof input.html !== "string" || (input.thumbnail !== null && typeof input.thumbnail !== "string")) fail();
  const field = name => { const node = page.querySelector('[data-panel="' + name + '"]'); if (!node) fail(); return node; };
  const set = (node, value) => { node.value = value; node.dispatchEvent(new Event("input", { bubbles:true })); };
  set(field("code"), input.code);
  set(field("html"), input.html);
  set(field("thumbnail"), input.thumbnail ?? "");
  ${DEPLOY_FIXTURE_LISTING_SOURCE}
  const operation = page.querySelector('[data-field="operation"]');
  const save = page.querySelector('[data-action="save"]');
  if (!operation || !save) fail();
  operation.value = input.operationId;
  save.click();
  for (let i = 0; i < 200; i++) {
    if (page.dataset.saveState === "saved:" + input.operationId) { report("APPLIED"); return; }
    if (page.dataset.saveState === "rejected:" + input.operationId) { report("NOT_APPLIED"); return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // No confirmation: the outcome is unknown and PCMS reconciles before any retry.
  fail();
})().catch(() => Persona.fail("Deployment fixture contract unavailable"));
`;
}
