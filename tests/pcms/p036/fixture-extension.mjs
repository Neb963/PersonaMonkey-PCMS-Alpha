// Builds the P036 fixture add-on for the packaged Firefox proof. It is a separate extension
// (never injected into the product XPI): its own manifest and entry page, plus the product
// XPI's `pcms/` and `pcms-modules/` trees copied byte for byte, so the shipped Generators view
// and Deployer modules run in an ordinary extension page realm, exactly as in the product.
// (Marionette page scripts run in a sandbox realm where Firefox forbids typed-array access
// across Xrays, which the shipped hashing and file reading need.)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const P036_FIXTURE_ID = "pcms-p036-fixture@tests";
export const P036_FIXTURE_PAGE = "pcms/app/p036-fixture.html";

const MANIFEST = {
  manifest_version: 3,
  name: "PCMS P036 Generators fixture",
  version: "1.0",
  browser_specific_settings: { gecko: { id: P036_FIXTURE_ID, strict_min_version: "154.0" } }
};
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>P036 fixture</title>'
  + '<script type="module" src="p036-fixture.js"></script></head><body></body></html>\n';
const ENTRY = `import { generatorsViewFlow } from "./p036-flow.js";
const nonce = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
generatorsViewFlow({ base: new URL("../../", location.href).href, documentRef: document, windowRef: window, nonce })
  .then((value) => { document.body.dataset.p036Result = JSON.stringify({ ok: true, value }); })
  .catch((error) => { document.body.dataset.p036Result = JSON.stringify({ ok: false, error: String(error && error.message || error) + " | " + String(error && error.stack || "") }); });
`;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path)); else out.push(path);
  }
  return out;
}

const sha = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

// Returns {xpi, dir, copiedFiles, digest}; `digest` is over the copied product files.
export async function buildP036FixtureExtension({ productXpi, workDir, flowSource }) {
  const unpacked = join(workDir, "product");
  const dir = join(workDir, "fixture");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(unpacked, { recursive: true });
  await mkdir(dir, { recursive: true });
  await run("unzip", ["-q", productXpi, "pcms/*", "pcms-modules/*", "-d", unpacked]);
  const files = (await walk(unpacked)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const rel = relative(unpacked, file).replaceAll("\\", "/");
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await copyFile(file, join(dir, rel));
    hash.update(rel + "\0" + await sha(file) + "\n");
  }
  await writeFile(join(dir, "manifest.json"), JSON.stringify(MANIFEST, null, 2) + "\n");
  await writeFile(join(dir, "pcms/app/p036-fixture.html"), PAGE);
  await writeFile(join(dir, "pcms/app/p036-fixture.js"), ENTRY);
  await writeFile(join(dir, "pcms/app/p036-flow.js"), flowSource);
  const xpi = join(workDir, "p036-fixture.xpi");
  await run("zip", ["-q", "-X", "-r", xpi, "."], { cwd: dir });
  return { xpi, dir, copiedFiles: files.length, digest: hash.digest("hex") };
}

// The A036-03 observations the fixture flow must produce (shared with local rehearsal).
export function assertP036Flow(flow) {
  assert.match(flow.emptyText, /No generators yet/);
  assert.deepEqual(flow.dialogTextInputs, ["address"]);
  assert.equal(flow.previewText, "Target: perchance.org/tavern-names");
  assert.equal(flow.submitEnabled, true);
  assert.deepEqual(flow.waiting, { banner: "WAITING_HUMAN", label: "Waiting for you in Perchance" });
  assert.deepEqual(flow.handoffPanels.map((panel) => panel.label), ["Code panel", "HTML panel"]);
  assert.equal(flow.handoffPanels[0].value, "// tavern-names 1.1.0\ntitle\n  The [adjective] [noun]\n");
  assert.equal(flow.handoffPanels[1].value, "<h1>[title]</h1>\n");
  assert.equal(flow.handoffListing, "Listing: Unlisted");
  assert.equal(flow.thumbnailLink, "thumbnail.jpeg");
  assert.equal(flow.copiedCode, true);
  assert.equal(flow.storedDeployer.includes("adjective"), false, "content never enters the Deployer row");
  assert.match(flow.storedDeployer, /"payloadKind":"v2-release"/);
  assert.equal(flow.afterUnknown, "WAITING_HUMAN");
  assert.equal(flow.dispatchOpens, 1);
  assert.equal(flow.dispatchOpensFinal, 1, "UNCERTAIN is never replayed");
  assert.equal(flow.final.label, "In sync");
  assert.equal(flow.final.handoff, false);
  assert.deepEqual(flow.listRow[0].slice(0, 3), ["tavern-names", "Alice", "In sync · not verified"]);
  assert.equal(flow.listRow[0][5], "Unlisted");
  assert.equal(flow.rowHref, "#/generators/perchance/tavern-names");
}
