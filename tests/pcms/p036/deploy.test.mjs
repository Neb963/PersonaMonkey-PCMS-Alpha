// A036-03 (U, I, E): manual deployment needs no typed IDs, runs as a background command with
// a durable assisted handoff, and never replays UNCERTAIN.
import assert from "node:assert/strict";
import test from "node:test";

import { generatorPayloadHash, generatorReleaseFingerprint, thumbnailHash } from "../../../extension/pcms/providers/perchance/contract.js";
import { DEPLOYER_ERROR_CODES } from "../../../pcms-modules/p015/errors.js";
import { runInNewContext } from "node:vm";
import { decodeUtf8Exact, deploymentIdForSlug, isJpeg, manualDeployPlan, parsePerchanceAddress } from "../../../extension/pcms/app/views/generators/model.js";
import { jpegBase64, setup } from "./harness.mjs";

const CODE = "// tavern-names 1.1.0\ntitle = Tavern Names\n";
const HTML = "<h1>[title]</h1>\n";

async function intent({ code = CODE, html = HTML, thumbnail = null, listing = "PUBLICLY_LISTED" } = {}) {
  return { payloadHash:await generatorPayloadHash(code, html), thumbnailHash:thumbnail ? await thumbnailHash(thumbnail) : null, listing };
}

async function createManual(h, slug, wanted, accountId = "acct-1") {
  const listed = await h.deployer.listDeployments();
  return h.deployer.createDeployment({ deploymentId:deploymentIdForSlug(slug), accountId, generatorId:slug, ...wanted, origin:{ kind:"MANUAL" } },
    { expectedRevision:listed.revision });
}

test("A036-03 the operator names generators by Perchance address; deployment IDs are generated", () => {
  for (const raw of ["tavern-names", " perchance.org/tavern-names ", "https://perchance.org/tavern-names", "https://www.perchance.org/tavern-names/?x=1"]) {
    assert.equal(parsePerchanceAddress(raw), "tavern-names");
  }
  for (const raw of ["", "Tavern Names", "https://example.com/../x", "perchance.org/a/b", "-bad"]) assert.equal(parsePerchanceAddress(raw), null);
  assert.equal(deploymentIdForSlug("tavern-names"), "gen:tavern-names");
});

// Regression from the pinned-Firefox run: file bytes may come from another JS realm.
test("A036-03 uploaded file bytes are accepted from another realm, byte-exactly", () => {
  const foreign = runInNewContext("new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a])");
  assert.equal(foreign instanceof Uint8Array, false);
  assert.equal(decodeUtf8Exact(foreign, "Code"), "\ufeffa\r\n");
  assert.equal(isJpeg(runInNewContext("new Uint8Array([0xff, 0xd8, 0xff, 0xe0])")), true);
  assert.throws(() => decodeUtf8Exact(runInNewContext("[0x61]"), "Code"), /could not be read/);
  assert.throws(() => decodeUtf8Exact(new Uint8Array([0xc3]), "Code"), /not valid UTF-8/);
  assert.throws(() => decodeUtf8Exact(new Uint8Array([0x61, 0x00]), "Code"), /NUL/);
});

test("A036-03 emulator: v2 release deploys code, HTML, thumbnail and listing through ProviderGate", async () => {
  const h = setup();
  const thumbnail = jpegBase64();
  const wanted = await intent({ thumbnail, listing:"UNLISTED" });
  const created = await createManual(h, "tavern-names", wanted);
  assert.equal(created.deployment.desired.payloadKind, "v2-release");
  const result = await h.deployer.deploy("gen:tavern-names", { expectedRevision:created.revision, payload:{ code:CODE, html:HTML, thumbnail } });
  assert.equal(result.status, "APPLIED");
  assert.equal(result.deployment.operation.status, "SUCCEEDED");
  assert.deepEqual({ ...result.deployment.confirmed, confirmedAt:null }, { payloadHash:wanted.payloadHash, thumbnailHash:wanted.thumbnailHash,
    listing:"UNLISTED", confirmedAt:null, operationId:"deploy:gen:tavern-names:1:1", baselineHash:null });
  const stored = h.emulator.getGenerator("tavern-names");
  assert.equal(stored.code, CODE); assert.equal(stored.html, HTML); assert.equal(stored.thumbnail, thumbnail);
  // The provider wire shape is produced only by the adapter.
  assert.deepEqual(stored.settings, { isPrivate:true });
  const remote = await h.remoteOps.get("deploy:gen:tavern-names:1:1");
  assert.equal(remote.value.intentFingerprint, await generatorReleaseFingerprint(wanted));
  // Content bytes never enter the Deployer row.
  assert.equal(JSON.stringify((await h.stateStore.read()).value).includes("Tavern Names"), false);
  const listed = await h.generators.list();
  assert.equal(listed.rows[0].status.label, "In sync");
  assert.equal(listed.rows[0].columns.listing, "Unlisted");
  assert.equal(listed.rows[0].accountLabel, "Alice");
});

test("A036-03 content that differs from the desired release fails before any RemoteOperation", async () => {
  const h = setup();
  const created = await createManual(h, "tavern-names", await intent());
  await assert.rejects(h.deployer.deploy("gen:tavern-names", { expectedRevision:created.revision, payload:{ code:CODE + " ", html:HTML, thumbnail:null } }),
    (e) => e?.code === DEPLOYER_ERROR_CODES.CONTENT_MISMATCH);
  await assert.rejects(h.deployer.deploy("gen:tavern-names", { expectedRevision:created.revision, source:CODE }),
    (e) => e?.code === DEPLOYER_ERROR_CODES.INVALID_ARGUMENT);
  assert.equal(await h.remoteOps.get("deploy:gen:tavern-names:1:1"), null);
  assert.equal(h.emulator.getGenerator("tavern-names"), null);
});

test("A036-03 emulator: an ambiguous dispatch is never replayed; it reconciles first", async () => {
  const h = setup();
  const created = await createManual(h, "tavern-names", await intent());
  h.emulator.failNext("after-apply");
  await assert.rejects(h.deployer.deploy("gen:tavern-names", { expectedRevision:created.revision, payload:{ code:CODE, html:HTML, thumbnail:null } }));
  let listed = await h.deployer.listDeployments();
  assert.equal(listed.deployments[0].operation.status, "RECONCILE");
  assert.equal((await h.generators.list()).rows[0].status.token, "UNCERTAIN");
  const dispatches = h.emulator.dispatched().length;
  // The Deployer refuses a second dispatch, and so does ProviderGate for the same operation.
  await assert.rejects(h.deployer.deploy("gen:tavern-names", { expectedRevision:listed.revision, payload:{ code:CODE, html:HTML, thumbnail:null } }),
    (e) => e?.code === DEPLOYER_ERROR_CODES.INVALID_TRANSITION);
  assert.equal(manualDeployPlan(listed.deployments[0], { ...await intent(), payloadKind:"v2-release" }).step, "blocked");
  assert.equal(h.emulator.dispatched().length, dispatches);
  const reconciled = await h.deployer.reconcileDeployment("gen:tavern-names", { expectedRevision:listed.revision });
  assert.equal(reconciled.deployment.operation.status, "SUCCEEDED");
  assert.equal(h.emulator.dispatched().length, dispatches, "reconciliation reads the receipt; it does not re-dispatch");
});

test("A036-03 assisted: deploy is a durable handoff with separate code/HTML; the answer settles without replay", async () => {
  const h = setup({ mode:"assisted" });
  const thumbnail = jpegBase64(32);
  const created = await createManual(h, "tavern-names", await intent({ thumbnail, listing:"UNLISTED" }));
  // The background command returns once the handoff is recorded; the outcome is unknown.
  await assert.rejects(h.deployer.deploy("gen:tavern-names", { expectedRevision:created.revision, payload:{ code:CODE, html:HTML, thumbnail } }));
  assert.deepEqual(h.opened, [{ operationId:"deploy:gen:tavern-names:1:1", generatorId:"tavern-names", phase:"open" }]);
  const operationId = "deploy:gen:tavern-names:1:1";
  assert.equal((await h.remoteOps.get(operationId)).value.state, "UNCERTAIN");
  const detail = await h.generators.get("perchance:tavern-names");
  assert.equal(detail.row.status.token, "WAITING_HUMAN");
  assert.equal(detail.row.status.label, "Waiting for you in Perchance");
  assert.ok(detail.handoffTaskId);
  const described = await h.handoff.describe(detail.handoffTaskId);
  assert.equal(described.state, "OPEN");
  assert.equal(described.payload.code, CODE);
  assert.equal(described.payload.html, HTML);
  assert.equal(described.payload.thumbnail, thumbnail);
  assert.equal(described.payload.listing, "Unlisted");
  assert.match(described.instructions, /set the generator to Unlisted/);
  assert.doesNotMatch(JSON.stringify(described), /isPrivate/);

  // A second tab (fresh services over the same storage) sees the same durable task.
  const other = setup({ mode:"assisted", storage:h.storage });
  assert.equal((await other.generators.get("perchance:tavern-names")).handoffTaskId, detail.handoffTaskId);

  // "I'm not sure" keeps it UNCERTAIN and opens a fresh task; nothing is dispatched again.
  const unknown = await other.answer(detail.handoffTaskId, "UNKNOWN");
  assert.equal(unknown.operationState, "UNCERTAIN");
  const again = await other.generators.get("perchance:tavern-names");
  assert.notEqual(again.handoffTaskId, detail.handoffTaskId);
  assert.equal(again.row.status.token, "WAITING_HUMAN");
  assert.equal(h.opened.filter((item) => item.phase === "open").length, 1, "never re-opened for dispatch");

  const applied = await other.answer(again.handoffTaskId, "APPLIED");
  assert.equal(applied.operationState, "SUCCEEDED");
  const listed = await other.deployer.listDeployments();
  const settled = await other.deployer.reconcileDeployment("gen:tavern-names", { expectedRevision:listed.revision });
  assert.equal(settled.deployment.operation.status, "SUCCEEDED");
  assert.equal(settled.deployment.confirmed.listing, "UNLISTED");
  const final = await other.generators.get("perchance:tavern-names");
  assert.equal(final.row.status.label, "In sync");
  assert.equal(final.handoffTaskId, null);
  assert.equal(h.opened.filter((item) => item.phase === "open").length, 1);
});

test("A036-03 assisted NOT_APPLIED needs a new operation identity; the next deploy is a new handoff", async () => {
  const h = setup({ mode:"assisted" });
  const created = await createManual(h, "tavern-names", await intent());
  await assert.rejects(h.deployer.deploy("gen:tavern-names", { expectedRevision:created.revision, payload:{ code:CODE, html:HTML, thumbnail:null } }));
  const task = (await h.generators.get("perchance:tavern-names")).handoffTaskId;
  await h.answer(task, "NOT_APPLIED");
  let listed = await h.deployer.listDeployments();
  const settled = await h.deployer.reconcileDeployment("gen:tavern-names", { expectedRevision:listed.revision });
  assert.equal(settled.deployment.operation.status, "RETRYABLE");
  assert.equal(manualDeployPlan(settled.deployment, { ...await intent(), payloadKind:"v2-release" }).step, "deploy");
  listed = await h.deployer.listDeployments();
  await assert.rejects(h.deployer.deploy("gen:tavern-names", { expectedRevision:listed.revision, payload:{ code:CODE, html:HTML, thumbnail:null } }));
  assert.equal(h.opened.filter((item) => item.phase === "open").length, 2);
  assert.equal((await h.generators.get("perchance:tavern-names")).row.status.token, "WAITING_HUMAN");
});

test("A036-03 a listing-only change is a new deployment with the same content", async () => {
  const h = setup();
  const first = await createManual(h, "cat-facts", await intent());
  const applied = await h.deployer.deploy("gen:cat-facts", { expectedRevision:first.revision, payload:{ code:CODE, html:HTML, thumbnail:null } });
  const changed = await h.deployer.setDesired("gen:cat-facts", { expectedRevision:applied.revision, expectedDesiredRevision:1,
    ...await intent({ listing:"UNLISTED" }), origin:{ kind:"MANUAL" } });
  assert.equal(changed.changed, true);
  assert.equal((await h.generators.list()).rows[0].status.label, "Listing change ready");
  const redeployed = await h.deployer.deploy("gen:cat-facts", { expectedRevision:changed.revision, payload:{ code:CODE, html:HTML, thumbnail:null } });
  assert.equal(redeployed.deployment.confirmed.listing, "UNLISTED");
  assert.deepEqual(h.emulator.getGenerator("cat-facts").settings, { isPrivate:true });
});

test("A036-03 recovery hold blocks dispatch before any provider call", async () => {
  const h = setup();
  const created = await createManual(h, "tavern-names", await intent());
  await h.recoveryHold.enterRecoveryHold({ reason:"restore" });
  await assert.rejects(h.deployer.deploy("gen:tavern-names", { expectedRevision:created.revision, payload:{ code:CODE, html:HTML, thumbnail:null } }));
  assert.equal(h.emulator.dispatched().length, 0);
  const row = (await h.generators.list()).rows[0];
  assert.equal(row.next.text, "On hold until recovery checks finish");
});

test("A036-03 generator index: filters, chips, paging and search", async () => {
  const h = setup();
  for (let index = 0; index < 55; index += 1) {
    const slug = "gen-" + String(index).padStart(2, "0");
    const created = await createManual(h, slug, await intent({ code:CODE + index }), index % 2 ? "acct-2" : "acct-1");
    if (index < 3) await h.deployer.deploy(created.deployment.deploymentId, { expectedRevision:created.revision, payload:{ code:CODE + index, html:HTML, thumbnail:null } });
  }
  const page1 = await h.generators.list();
  assert.equal(page1.total, 55); assert.equal(page1.rows.length, 50); assert.equal(page1.pages, 2);
  assert.deepEqual(page1.chips.map((chip) => [chip.key, chip.count]), [["new", 52], ["sync", 3]]);
  const page2 = await h.generators.list({ page:2 });
  assert.equal(page2.rows.length, 5);
  const bob = await h.generators.list({ filter:"status:new,account:acct-2" });
  assert.equal(bob.matching, 26);
  assert.ok(bob.rows.every((row) => row.accountId === "acct-2"));
  await assert.rejects(h.generators.list({ filter:"status:private" }));
  const hits = await h.generators.search("gen-0", 5);
  assert.equal(hits.length, 5);
  assert.equal(hits[0].ref, "perchance:gen-00");
});
