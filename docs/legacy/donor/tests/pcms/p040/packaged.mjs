// A040-02 PKG proof in the exact pinned Firefox Developer Edition.
//
// The fixture add-on (fixture-extension.mjs) runs the shipped Refresher, Deployer, repository
// service, timer service, Refresher scheduler and P029 alarm coordinator, copied byte for byte
// from the product XPI, in a real non-persistent event page over a real IndexedDB. The proof:
// seed three Deployer-confirmed releases and one automatic cohort (budget 2/day), close every
// extension tab, force the event page to unload, and let only the durable timer's alarm wake it.
// With zero tabs open, the pass must refresh exactly two generators from their confirmed
// releases (never pasted source), store no content, and re-declare its next pass.
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { execFileText, loadBrowserPin, sha256File, writeJson } from "../../../tools/firefox/lib.mjs";
import { PackagedFirefox, waitFor } from "../../../tools/firefox/packaged-harness.mjs";
import { P040_FIXTURE_ID, P040_FIXTURE_PAGE, buildP040FixtureExtension } from "./fixture-extension.mjs";

const root = resolve(process.env.FIREFOX_PACKAGED_DIR || join(tmpdir(), "pcms-firefox-p040"));
const reportPath = resolve(process.env.FIREFOX_P040_REPORT || join(root, "p040-report.json"));
const pin = await loadBrowserPin();
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const xpi = resolve(`dist/persona-route-manager-v${manifest.version}.xpi`);
const report = {
  schemaVersion:1,
  phase:"P040",
  commitSha:process.env.GITHUB_SHA || (await execFileText("git", ["rev-parse", "HEAD"])).stdout.trim(),
  workflowRun:process.env.GITHUB_RUN_ID || null,
  version:pin.version,
  artifactSha256:pin.archive.sha256,
  productXpiSha256:await sha256File(xpi),
  checks:{},
  facts:{}
};

let h;
let probe = null;
async function status() {
  const result = await h.pageScript(`const done = arguments[arguments.length - 1];
    window.wrappedJSObject.browser.runtime.sendMessage({ type: "p040-status" })
      .then(value => done({ ok: true, value: JSON.parse(JSON.stringify(value ?? null)) }),
        error => done({ ok: false, error: String(error && error.message || error) }));`, [], { async:true });
  if (!result.ok) throw new Error(result.error);
  if (result.value?.error) throw new Error(result.value.error);
  return result.value;
}

try {
  await mkdir(root, { recursive:true });
  const fixture = await buildP040FixtureExtension({ productXpi:xpi, workDir:join(root, "fixture-build"),
    backgroundSource:await readFile("tests/pcms/p040/fixture-background.js", "utf8") });
  report.facts.fixture = { copiedProductFiles:fixture.copiedFiles, productTreeDigest:fixture.digest, fixtureXpiSha256:await sha256File(fixture.xpi) };
  h = await PackagedFirefox.create({ root:join(root, "profiles") });
  await h.start();
  assert.equal(await h.install(fixture.xpi), P040_FIXTURE_ID);
  const extension = await h.extension(P040_FIXTURE_ID);
  assert.equal(extension.manifestVersion, 3);
  assert.equal(extension.persistent, false);

  probe = await h.openPage(P040_FIXTURE_ID, P040_FIXTURE_PAGE);
  const seeded = await waitFor(async () => {
    const value = await status();
    return value.seededAt && value.timer?.state === "SCHEDULED" ? value : null;
  }, "fixture seeds confirmed releases and declares the Refresher pass", 30000);
  assert.deepEqual(seeded.confirmed.map((c) => c.confirmed), [true, true, true]);
  assert.deepEqual(seeded.cohort.budget, { limit:2, used:0, remaining:2 });
  assert.equal(seeded.refreshOperations.length, 0);
  const dueAt = Date.parse(seeded.timer.dueAt);
  assert.ok(seeded.alarms.some((alarm) => alarm.name === "pcms.timers.next" && alarm.scheduledTime === dueAt), "the durable timer armed browser.alarms");
  assert.ok(dueAt - Date.now() > 15000, "enough time remains to unload before the pass is due");
  report.facts.seeded = { seededAt:seeded.seededAt, dueAt:seeded.timer.dueAt, alarms:seeded.alarms };

  await h.closePage(probe);
  probe = null;
  const unloadedAt = Date.now();
  report.facts.unload = await h.forceIdleUnload(P040_FIXTURE_ID);
  assert.equal(report.facts.unload.state, "stopped", "Firefox test hook must confirm suspension");
  report.checks.zeroTabsAndEventPageStopped = true;

  // No extension page is open from here until the pass has been observed to complete.
  await waitFor(async () => Date.now() >= dueAt + 1000 && (await h.extension(P040_FIXTURE_ID)).state === "running",
    "the Refresher alarm wakes the unloaded event page with zero tabs", Math.max(30000, dueAt - Date.now() + 30000));
  await new Promise((done) => setTimeout(done, 5000));
  const probeOpenedAt = Date.now();
  probe = await h.openPage(P040_FIXTURE_ID, P040_FIXTURE_PAGE);
  const after = await waitFor(async () => {
    const value = await status();
    return value.passes.length > 0 ? value : null;
  }, "the background pass is recorded", 15000);
  const wakeStart = after.starts.find((start) => Date.parse(start.at) > unloadedAt);
  assert.ok(wakeStart, "the event page started again after the unload");
  assert.ok(Date.parse(wakeStart.at) < probeOpenedAt, "it started before any extension tab was opened");
  const pass = after.passes[0];
  assert.ok(Date.parse(pass.at) > unloadedAt && Date.parse(pass.at) < probeOpenedAt, "the pass ran with zero extension tabs");
  assert.equal(pass.lastPass.dispatched, 2);
  assert.deepEqual(after.cohort.budget, { limit:2, used:2, remaining:0 });
  assert.deepEqual(after.cohort.members.map((m) => [m.generatorId, m.operationStatus]),
    [["alpha", "SUCCEEDED"], ["beta", "SUCCEEDED"], ["gamma", "IDLE"]]);
  for (const member of after.cohort.members.slice(0, 2)) {
    assert.ok(Date.parse(member.lastConfirmedAt) > unloadedAt && Date.parse(member.lastConfirmedAt) < probeOpenedAt);
  }
  assert.equal(after.refreshOperations.length, 2);
  assert.ok(after.refreshOperations.every((op) => op.state === "SUCCEEDED" && op.intentFingerprint.startsWith("perchance:generator-release:v2:")));
  assert.equal(after.refresherStoresContent, false);
  assert.equal(after.timer.state, "SCHEDULED", "the next pass is re-declared");
  assert.ok(Date.parse(after.timer.dueAt) > Date.now());
  report.facts.afterWake = { wakeStart, pass, budget:after.cohort.budget, members:after.cohort.members.map((m) => ({ generatorId:m.generatorId,
    status:m.operationStatus, lastConfirmedAt:m.lastConfirmedAt })), refreshOperations:after.refreshOperations, nextDueAt:after.timer.dueAt };
  report.checks.alarmWokeZeroTabEventPage = true;
  report.checks.refreshedWithinBudgetFromConfirmedReleases = true;
  report.checks.noContentStored = true;
  report.checks.nextPassRedeclared = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error.stack || error);
  throw error;
} finally {
  try { if (probe) await h.closePage(probe); } catch {}
  await h?.stop();
  await writeJson(reportPath, report);
  if (h) await rm(h.profilePath, { recursive:true, force:true });
}
console.log(JSON.stringify(report));
