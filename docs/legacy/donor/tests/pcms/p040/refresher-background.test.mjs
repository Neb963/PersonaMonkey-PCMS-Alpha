import test from "node:test";
import assert from "node:assert/strict";
import { REFRESHER_ERROR_CODES } from "../../../pcms-modules/p017/errors.js";
import { REFRESHER_SOURCE_KIND } from "../../../pcms-modules/p017/schema.js";
import { generatorPayloadHash } from "../../../extension/pcms/providers/perchance/contract.js";
import { AUTO_POLICY, SHA1, SHA2, commit, createP040Fixture, release } from "./harness.mjs";

async function cohort(fx, { generators, policy = AUTO_POLICY, accountId = "acct-1", cohortId = "daily" } = {}) {
  const listed = await fx.refresher.listCohorts();
  return fx.refresher.createCohort({ cohortId, name:"Daily", accountId, enabled:true, policy,
    members:generators.map((generatorId) => ({ generatorId })) }, { expectedRevision:listed.revision });
}

test("A040-02 background pass refreshes from the Deployer-confirmed release without pasted source", async () => {
  const fx = createP040Fixture();
  await fx.connect();
  await fx.deploy("alpha");
  const confirmed = (await fx.ctx.deployer.listDeployments()).deployments[0].confirmed;
  assert.equal(confirmed.payloadHash, await generatorPayloadHash("code of alpha", "<main>alpha</main>"));
  const created = await cohort(fx, { generators:["alpha"] });
  assert.equal(created.cohort.members[0].sourceKind, REFRESHER_SOURCE_KIND.DEPLOYER_CONFIRMED);
  assert.equal(created.cohort.members[0].sourceHash, null);

  const before = fx.ctx.emulator.dispatched().length;
  const pass = await fx.refresher.runBackgroundPass();
  assert.deepEqual(pass.dispatched.map((item) => [item.generatorId, item.status]), [["alpha", "APPLIED"]]);
  const dispatched = fx.ctx.emulator.dispatched().slice(before);
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].operationId, /^refresh:daily:1:1$/);
  // The refreshed content is the confirmed release, byte for byte.
  const onPerchance = fx.ctx.emulator.getGenerator("alpha");
  assert.equal(onPerchance.code, "code of alpha");
  assert.equal(onPerchance.html, "<main>alpha</main>");
  const member = (await fx.refresher.getCohort("daily")).members[0];
  assert.equal(member.operation.status, "SUCCEEDED");
  assert.equal(member.confirmedCount, 1);
  assert.deepEqual(member.operation.release, { payloadKind:"v2-release", payloadHash:confirmed.payloadHash, thumbnailHash:null, listing:"UNLISTED" });
  // Content is read only at dispatch; the Refresher stores hashes, never content.
  const stored = await fx.storedRefresherJson();
  assert.equal(stored.includes("code of alpha"), false);
  assert.equal(stored.includes("<main>alpha</main>"), false);
  // The refresh RemoteOperation carries the v2 release fingerprint of the confirmed release.
  const op = await fx.ctx.remoteOps.get("refresh:daily:1:1");
  assert.match(op.value.intentFingerprint, /^perchance:generator-release:v2:[a-f0-9]{64}$/);
  assert.equal(op.value.state, "SUCCEEDED");
});

test("A040-02 passes stay within the daily budget and the next wake is the next budget day", async () => {
  const fx = createP040Fixture({ commits:{ [SHA1]:commit(release({ slug:"alpha" }), release({ slug:"beta" }), release({ slug:"gamma" })) } });
  await fx.connect();
  for (const slug of ["alpha", "beta", "gamma"]) await fx.deploy(slug);
  await cohort(fx, { generators:["alpha", "beta", "gamma"] });
  assert.equal(await fx.refresher.nextWakeAt(), new Date(Date.parse(fx.now) + 60000).toISOString());
  const first = await fx.refresher.runBackgroundPass();
  assert.equal(first.dispatched.length, 2);
  const second = await fx.refresher.runBackgroundPass();
  assert.equal(second.dispatched.length, 0, "budget 2 per day is never exceeded");
  const views = await fx.refresher.listCohortViews();
  assert.deepEqual(views.cohorts[0].budget, { limit:2, used:2, remaining:0 });
  // Next budget day, capped by the 6 h re-evaluation horizon.
  assert.equal(await fx.refresher.nextWakeAt(), "2026-10-08T18:00:00.000Z");
  fx.setNow("2026-10-08T23:30:00.000Z");
  assert.equal(await fx.refresher.nextWakeAt(), "2026-10-09T00:00:00.000Z");
  fx.setNow("2026-10-09T00:00:01.000Z");
  const nextDay = await fx.refresher.runBackgroundPass();
  assert.deepEqual(nextDay.dispatched.map((item) => item.generatorId), ["gamma", "alpha"], "never-refreshed first, then least recently refreshed");
});

test("A040-02 a pass dispatches at most its bound even when budget allows more", async () => {
  const slugs = ["a1", "a2", "a3", "a4", "a5", "a6"];
  const fx = createP040Fixture({ commits:{ [SHA1]:commit(...slugs.map((slug) => release({ slug }))) } });
  await fx.connect();
  for (const slug of slugs) await fx.deploy(slug);
  await cohort(fx, { generators:slugs, policy:{ ...AUTO_POLICY, dailyBudget:50 } });
  const pass = await fx.refresher.runBackgroundPass({ maxDispatches:4 });
  assert.equal(pass.dispatched.length, 4);
});

test("A040-02 a refresh never rolls Perchance back: a moved release cancels the pinned refresh", async () => {
  const fx = createP040Fixture({ commits:{ [SHA1]:commit(release({ slug:"alpha" })), [SHA2]:commit(release({ slug:"alpha", version:"2.0.0", code:"new code" })) } });
  await fx.connect();
  await fx.deploy("alpha");
  await cohort(fx, { generators:["alpha"] });
  const listed = await fx.refresher.listCohorts();
  const prepared = await fx.refresher.prepareRefresh("daily", "alpha", { expectedRevision:listed.revision });
  // The repository moves on: Deployer now wants 2.0.0 that is not confirmed yet.
  fx.provider.setRef("main", SHA2);
  await fx.scan();
  await assert.rejects(fx.refresher.dispatchRefresh("daily", "alpha", { expectedRevision:prepared.revision }),
    (error) => error?.code === REFRESHER_ERROR_CODES.RELEASE_UNAVAILABLE);
  const pass = await fx.refresher.runBackgroundPass();
  assert.deepEqual(pass.cancelled, ["alpha"]);
  assert.equal((await fx.refresher.getCohort("daily")).members[0].operation.status, "CANCELLED");
  assert.equal(fx.ctx.emulator.getGenerator("alpha").code, "code of alpha", "no refresh dispatched the old release over a pending update");
  assert.equal((await fx.refresher.runBackgroundPass()).dispatched.length, 0);
  assert.equal(await fx.refresher.nextWakeAt(), "2026-10-08T18:00:00.000Z", "nothing refreshable: re-evaluate at the horizon");
});

test("A040-02 an uncertain refresh is never retried by the background; reconcile settles it", async () => {
  const fx = createP040Fixture();
  await fx.connect();
  await fx.deploy("alpha");
  await cohort(fx, { generators:["alpha"] });
  fx.ctx.emulator.failNext("after-apply");
  const pass = await fx.refresher.runBackgroundPass();
  assert.equal(pass.dispatched.length, 0);
  assert.equal(pass.errors.length, 1);
  let member = (await fx.refresher.getCohort("daily")).members[0];
  assert.equal(member.operation.status, "RECONCILE");
  const dispatchedBefore = fx.ctx.emulator.dispatched().length;
  await fx.refresher.runBackgroundPass();
  assert.equal(fx.ctx.emulator.dispatched().length, dispatchedBefore, "UNCERTAIN is never replayed");
  const listed = await fx.refresher.listCohorts();
  const settled = await fx.refresher.reconcileRefresh("daily", "alpha", { expectedRevision:listed.revision });
  assert.equal(settled.member.operation.status, "SUCCEEDED");
  assert.equal(settled.member.confirmedCount, 1);
});

test("A040-02 manual cohorts are never refreshed in the background; Refresh now uses the confirmed release", async () => {
  const fx = createP040Fixture();
  await fx.connect();
  await fx.deploy("alpha");
  await cohort(fx, { generators:["alpha"], policy:{ ...AUTO_POLICY, mode:"MANUAL" } });
  assert.equal((await fx.refresher.runBackgroundPass()).dispatched.length, 0);
  assert.equal(await fx.refresher.nextWakeAt(), null);
  const result = await fx.refresher.refreshNow("daily", "alpha");
  assert.equal(result.status, "APPLIED");
  await assert.rejects(fx.refresher.refreshNow("daily", "alpha"), (error) => error?.code === REFRESHER_ERROR_CODES.INVALID_TRANSITION,
    "a generator is refreshed at most once per budget day");
});

test("A040-01 cohort membership is explicit and fenced by account and target ownership", async () => {
  const fx = createP040Fixture({ commits:{ [SHA1]:commit(release({ slug:"alpha" }), release({ slug:"beta" })) } });
  await fx.connect();
  await fx.deploy("alpha");
  await assert.rejects(cohort(fx, { generators:["alpha"], accountId:"acct-2" }),
    (error) => error?.code === REFRESHER_ERROR_CODES.ACCOUNT_UNAVAILABLE, "a generator joins only its own account's cohort");
  assert.equal((await fx.refresher.listCohorts()).cohorts.length, 0, "a failed creation leaves no cohort behind");
  await cohort(fx, { generators:["alpha"] });
  let listed = await fx.refresher.listCohorts();
  await assert.rejects(fx.refresher.addMember("daily", { expectedRevision:listed.revision, generatorId:"alpha" }),
    (error) => error?.code === REFRESHER_ERROR_CODES.TARGET_CONFLICT);
  const added = await fx.refresher.addMember("daily", { expectedRevision:listed.revision, generatorId:"beta" });
  assert.deepEqual(added.cohort.members.map((m) => [m.generatorId, m.ordinal]), [["alpha", 1], ["beta", 2]]);
  const removed = await fx.refresher.removeMember("daily", "alpha", { expectedRevision:added.revision });
  listed = await fx.refresher.listCohorts();
  const readded = await fx.refresher.addMember("daily", { expectedRevision:listed.revision, generatorId:"alpha" });
  assert.equal(removed.cohort.members.length, 1);
  assert.equal(readded.cohort.members.find((m) => m.generatorId === "alpha").ordinal, 3, "ordinals are never reused");
  // beta is linked but not deployed: membership is allowed, refreshing is not.
  const pass = await fx.refresher.runBackgroundPass();
  assert.deepEqual(pass.dispatched.map((item) => item.generatorId), ["alpha"]);
  assert.deepEqual(pass.skipped.map((item) => [item.generatorId, item.reason]), [["beta", "NOT_DEPLOYED"]]);
});

test("A040-02 no release source fails closed and dispatch never accepts caller content", async () => {
  const fx = createP040Fixture();
  await fx.connect();
  await fx.deploy("alpha");
  await cohort(fx, { generators:["alpha"] });
  const listed = await fx.refresher.listCohorts();
  const prepared = await fx.refresher.prepareRefresh("daily", "alpha", { expectedRevision:listed.revision });
  await assert.rejects(fx.refresher.dispatchRefresh("daily", "alpha", { expectedRevision:prepared.revision, source:"pasted" }),
    (error) => error?.code === REFRESHER_ERROR_CODES.INVALID_ARGUMENT);
  assert.equal(fx.ctx.emulator.getGenerator("alpha").code, "code of alpha");
});
