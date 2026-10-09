import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// P035 is included in the existing independent CI verification entrypoint.
import "../pcms/p035/popup.test.mjs";

const manifest = JSON.parse(await readFile("docs/upstream/import-manifest.json", "utf8"));

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

test("frozen PersonaMonkey provenance coordinates are immutable", () => {
  assert.equal(manifest.upstream.repository, "Neb963/persona-router");
  assert.equal(manifest.upstream.commitSha, "9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf");
  assert.equal(manifest.upstream.treeSha, "9d59d800c3a687b2e7360c64d9dd859d701d6ba5");
  assert.equal(manifest.upstream.version, "1.2.0");
  assert.equal(manifest.upstream.frozenCiRunId, 36412342425);
  assert.equal(manifest.upstream.frozenCiConclusion, "success");
  assert.equal(manifest.upstream.expectedXpiSha256, "928b94a871d70455e42c2a8269a7adec27c59b3c5937e7618f80da218fb126e1");
});

test("all 223 frozen upstream blobs remain exact and derivative overlays are explicit", async () => {
  assert.equal(manifest.entries.length, 223);
  const expectedOverrides = new Set([
    "extension/background.js",
    "extension/lib/management-integration.js",
    "extension/lib/recovery-bootstrap.js",
    "extension/tests/background-routing-init.test.mjs",
    "extension/manifest.json",
    "extension/popup/popup.html",
    "extension/popup/popup.css",
    "extension/popup/popup.js",
    "scripts/build-extension.mjs"
  ]);
  assert.equal(Array.isArray(manifest.derivativeOverrides), true);
  assert.deepEqual(new Set(manifest.derivativeOverrides.map((item) => item.destinationPath)), expectedOverrides);

  const seen = new Set();
  for (const entry of manifest.entries) {
    assert.equal(seen.has(entry.sourcePath), false, `duplicate source path: ${entry.sourcePath}`);
    seen.add(entry.sourcePath);
    const bytes = await readFile(entry.destinationPath);
    assert.equal(bytes.length, entry.size, `size drift: ${entry.sourcePath}`);
    assert.equal(gitBlobSha(bytes), entry.sourceBlobSha, `blob drift: ${entry.sourcePath}`);
  }

  for (const override of manifest.derivativeOverrides) {
    assert.equal(typeof override.reason, "string");
    assert.equal(override.reason.length > 20, true);
    const frozen = manifest.entries.find((entry) => entry.sourcePath === override.destinationPath);
    assert.ok(frozen, `override target lacks frozen source identity: ${override.destinationPath}`);
    assert.equal(frozen.sourceBlobSha, override.upstreamBlobSha, `override upstream identity drift: ${override.destinationPath}`);
    assert.equal(frozen.destinationPath, `docs/upstream/source/${frozen.sourcePath}`);
    const bytes = await readFile(override.destinationPath);
    assert.equal(bytes.length, override.derivativeSize, `derivative size drift: ${override.destinationPath}`);
    assert.equal(gitBlobSha(bytes), override.derivativeBlobSha, `derivative blob drift: ${override.destinationPath}`);
  }
});

test("root package composes PCMS verification without mutating upstream package bytes", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  const upstream = JSON.parse(await readFile("docs/upstream/source/package.json", "utf8"));
  assert.equal(root.name, "persona-monkey-pcms");
  assert.equal(root.version, upstream.version);
  assert.equal(root.version, "1.2.0");
  assert.equal(root.engines.node, upstream.engines.node);
  assert.equal(typeof root.scripts["verify:repo"], "string");
  assert.equal(typeof root.scripts["test:firefox"], "string");
  assert.equal(typeof root.scripts["verify:upstream"], "string");
});


const execFile=promisify(execFileCallback);
// P035 owns this acceptance hook; parallel phases own package.json and .github
// workflow files. Execute pinned FDE under the independent verify CI runner,
// without altering shared CI resource ownership or relying on Firefox DevTools.
test("A035-01/A035-03 — packaged Firefox popup layout and account deep link",{
  skip:process.env.GITHUB_ACTIONS!=="true",
  timeout:360_000
},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"pcms-p035-ci-"));
  const env={...process.env,FIREFOX_INSTALL_ROOT:join(dir,"fde"),FIREFOX_P035_ROOT:join(dir,"packaged")};
  async function run(script,timeout){
    const result=await execFile(process.execPath,[script],{env,timeout,maxBuffer:8*1024*1024});
    return result.stdout.trim();
  }
  try{
    const install=JSON.parse((await run("tools/firefox/install-pinned.mjs",150_000)).split("\n").at(-1));
    assert.equal(install.installed,true);
    env.FIREFOX_BIN=install.firefoxBin;
    await run("scripts/build-extension.mjs",90_000);
    const output=await run("tests/pcms/p035/packaged.mjs",180_000);
    const report=JSON.parse(output.split("\n").at(-1));
    assert.equal(report.passed,true);
    assert.equal(report.checks.managedPersonaContext,true);
    assert.equal(report.checks.coreAccountStatusProjection,true);
    assert.equal(report.checks.pinnedFirefoxIntrinsicPopupSizing,true);
    assert.equal(report.checks.pinnedFirefoxStatusAndAccountLink,true);
    assert.equal(report.checks.pinnedFirefoxAccountDeepLinkReusesTab,true);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
