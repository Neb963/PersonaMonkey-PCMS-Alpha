// A036-02: the generator status derivation table passes exhaustively (04 §E.11).
import assert from "node:assert/strict";
import test from "node:test";

import { deriveGeneratorStatus } from "../../../pcms-modules/p015/status.js";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const OPS = ["PENDING", "ACTIVE", "RECONCILE", "RETRYABLE", "FAILED", "CANCELLED", "SUCCEEDED"];
const CONFIRMED = ["none", "match", "payload", "listing"];
const OBSERVATIONS = ["none", "same", "content", "listing", "missing", "old", "operator", "unknownListing"];
const REPOSITORY = [null, "PRESENT", "BLOCKED", "ABSENT"];
const TOKENS = new Set(["OK","INFO","ACTIVE","WAITING_HUMAN","WARNING","ERROR","UNCERTAIN","HELD","UNAVAILABLE"]);
const CONFIRMED_AT = "2026-10-08T10:00:00.000Z";
const NOW = "2026-10-08T13:00:00.000Z";

function record({ op, confirmed, baseline, paused, origin }) {
  const operationId = "deploy:gen:x:2:1";
  const desired = { revision:2, payloadKind:"v2-release", payloadHash:A, thumbnailHash:null, listing:"PUBLICLY_LISTED",
    origin:origin === "REPOSITORY" ? { kind:"REPOSITORY", commitId:"9".repeat(40), path:"alice/x", version:"1.4.0" } : { kind:"MANUAL" } };
  const confirmedValue = confirmed === "none"
    ? { payloadHash:null, thumbnailHash:null, listing:null, confirmedAt:null, operationId:null, baselineHash:null }
    : { payloadHash:confirmed === "payload" ? B : A, thumbnailHash:null, listing:confirmed === "listing" ? "UNLISTED" : "PUBLICLY_LISTED",
      confirmedAt:CONFIRMED_AT, operationId:confirmed === "match" ? operationId : "deploy:gen:x:1:1", baselineHash:baseline ? A : null };
  return {
    schemaVersion:2, kind:"deployment", deploymentId:"gen:x", providerId:"perchance", accountId:"alice",
    targetRef:{ kind:"generator", id:"x" }, desired, confirmed:confirmedValue,
    operation:{ sequence:1, operationId, status:op },
    policy:paused ? { paused:true, pauseReason:"OPERATOR" } : { paused:false, pauseReason:null },
    createdAt:"2026-10-01T00:00:00.000Z", updatedAt:CONFIRMED_AT
  };
}

function observation(kind, confirmedListing) {
  const later = "2026-10-08T12:00:00.000Z";
  if (kind === "none") return null;
  if (kind === "old") return { method:"PROVIDER_READ", observedAt:"2026-10-08T09:00:00.000Z", exists:true, payloadHash:C, listing:"UNLISTED" };
  if (kind === "operator") return { method:"OPERATOR_CONFIRMED", observedAt:later, exists:true, payloadHash:null, listing:"UNKNOWN" };
  if (kind === "missing") return { method:"PROVIDER_READ", observedAt:later, exists:false, payloadHash:null, listing:"UNKNOWN" };
  if (kind === "content") return { method:"PROVIDER_READ", observedAt:later, exists:true, payloadHash:C, listing:confirmedListing ?? "PUBLICLY_LISTED" };
  if (kind === "listing") return { method:"PROVIDER_READ", observedAt:later, exists:true, payloadHash:A,
    listing:confirmedListing === "UNLISTED" ? "PUBLICLY_LISTED" : "UNLISTED" };
  if (kind === "unknownListing") return { method:"PROVIDER_READ", observedAt:later, exists:true, payloadHash:A, listing:"UNKNOWN" };
  return { method:"PROVIDER_READ", observedAt:later, exists:true, payloadHash:A, listing:confirmedListing ?? "PUBLICLY_LISTED" };
}

// The 04 §E.11 table restated as ordered predicates over the scenario (the oracle).
function expectedRule(s) {
  const confirmedSet = s.confirmed !== "none";
  const awaiting = s.awaiting && (s.op === "ACTIVE" || s.op === "RECONCILE");
  const obs = s.observationValue;
  const drift = confirmedSet && obs?.method === "PROVIDER_READ" && obs.observedAt > CONFIRMED_AT && (
    obs.exists === false
    || (s.baseline && obs.payloadHash !== null && obs.payloadHash !== A)
    || (obs.listing !== "UNKNOWN" && obs.listing !== s.recordValue.confirmed.listing));
  if ((s.op === "RECONCILE" || (s.op === "ACTIVE" && !s.liveDispatch)) && !awaiting) return 1;
  if (awaiting) return 2;
  if (s.op === "ACTIVE") return 3;
  if (confirmedSet && s.observeAvailable && !s.baseline && s.op === "SUCCEEDED") return 4;
  if (drift) return 5;
  if (s.repository === "BLOCKED") return 6;
  if (!s.accountHealthy) return 7;
  if (s.op === "FAILED") return 8;
  if (s.origin === "REPOSITORY" && s.repository === "ABSENT") return 9;
  if (s.hold || s.paused) return 10;
  if (!confirmedSet) return 11;
  if (s.confirmed !== "match") return 12;
  return 13;
}

const TOKEN_BY_RULE = { 1:"UNCERTAIN", 2:"WAITING_HUMAN", 3:"ACTIVE", 4:"ACTIVE", 5:"WARNING", 6:"ERROR", 7:"UNAVAILABLE",
  8:"ERROR", 9:"INFO", 10:"INFO", 11:"WARNING", 12:"WARNING", 13:"OK" };

function* scenarios() {
  for (const op of OPS) for (const confirmed of CONFIRMED) for (const baseline of [false, true]) {
    if (confirmed === "none" && baseline) continue;
    if (op === "SUCCEEDED" && confirmed !== "match") continue; // not a valid durable record
    for (const awaiting of [false, true]) for (const liveDispatch of [false, true])
    for (const observeAvailable of [false, true]) for (const obsKind of OBSERVATIONS)
    for (const repository of REPOSITORY) for (const hold of [false, true]) for (const accountHealthy of [false, true])
    for (const paused of [false, true]) for (const origin of ["MANUAL", "REPOSITORY"]) {
      const recordValue = record({ op, confirmed, baseline, paused, origin });
      const observationValue = observation(obsKind, recordValue.confirmed.listing);
      yield { op, confirmed, baseline, awaiting, liveDispatch, observeAvailable, obsKind, repository, hold, accountHealthy, paused, origin, recordValue, observationValue };
    }
  }
}

test("A036-02 every reachable input combination matches the ordered rule table", () => {
  let count = 0;
  const seenRules = new Set();
  for (const s of scenarios()) {
    const result = deriveGeneratorStatus({
      deployment:s.recordValue, awaitingOperator:s.awaiting, liveDispatch:s.liveDispatch, observeAvailable:s.observeAvailable,
      observation:s.observationValue, repository:s.repository ? { state:s.repository, problem:s.repository === "BLOCKED" ? "page.html missing" : null, hold:s.hold } : (s.hold ? { state:"PRESENT", hold:true } : null),
      accountHealthy:s.accountHealthy, mode:"ASSISTED", now:NOW
    });
    const scenario = s.repository === null && s.hold ? { ...s, repository:"PRESENT" } : s;
    const rule = expectedRule(scenario);
    count += 1;
    if (result.rule !== rule) assert.fail("rule " + result.rule + " != " + rule + " for " + JSON.stringify({ ...s, recordValue:undefined, observationValue:undefined }));
    assert.equal(result.status.token, TOKEN_BY_RULE[rule]);
    assert.ok(TOKENS.has(result.status.token));
    assert.ok(typeof result.status.label === "string" && result.status.label.length > 0 && result.status.label.length <= 80);
    seenRules.add(rule);
  }
  assert.ok(count > 100000, "exhaustive: " + count);
  assert.deepEqual([...seenRules].sort((a, b) => a - b), [1,2,3,4,5,6,7,8,9,10,11,12,13]);
});

const base = (overrides = {}) => ({ deployment:record({ op:"SUCCEEDED", confirmed:"match", baseline:false, paused:false, origin:"REPOSITORY" }), now:NOW, ...overrides });

test("A036-02 table wording per rule", () => {
  const rows = [
    [{ deployment:record({ op:"RECONCILE", confirmed:"none", origin:"MANUAL" }) }, "UNCERTAIN", "Outcome unknown — check needed", "Check Perchance. Nothing is retried until you answer."],
    [{ deployment:record({ op:"RECONCILE", confirmed:"none", origin:"MANUAL" }), awaitingOperator:true }, "WAITING_HUMAN", "Waiting for you in Perchance", "Finish the save in the Perchance tab, then confirm."],
    [{ deployment:record({ op:"ACTIVE", confirmed:"none", origin:"REPOSITORY" }), liveDispatch:true }, "ACTIVE", "Deploying 1.4.0", ""],
    [{ observeAvailable:true }, "ACTIVE", "Verifying", ""],
    [{ deployment:record({ op:"SUCCEEDED", confirmed:"match", baseline:true, origin:"REPOSITORY" }), observation:observation("content", "PUBLICLY_LISTED") }, "WARNING", "Changed on Perchance", "Nothing happens automatically. Compare and choose."],
    [{ observation:observation("listing", "PUBLICLY_LISTED") }, "WARNING", "Listing differs", "Nothing happens automatically. Compare and choose."],
    [{ observation:observation("missing") }, "WARNING", "Missing on Perchance", "Nothing happens automatically. Compare and choose."],
    [{ repository:{ state:"BLOCKED", problem:"page.html missing" } }, "ERROR", "Repository problem — page.html missing", "Fix the repository, then check again."],
    [{ accountHealthy:false }, "UNAVAILABLE", "Account unavailable", "Fix the account's Persona binding."],
    [{ deployment:record({ op:"FAILED", confirmed:"none", origin:"MANUAL" }) }, "ERROR", "Deployment failed — not applied", "Deploy again"],
    [{ repository:{ state:"ABSENT" } }, "INFO", "No longer in repository", "Nothing changes on Perchance."],
    [{ deployment:record({ op:"PENDING", confirmed:"payload", paused:true, origin:"MANUAL" }) }, "INFO", "Paused", "Resume to deploy updates."],
    [{ deployment:record({ op:"PENDING", confirmed:"none", origin:"MANUAL" }) }, "WARNING", "Not yet deployed", "Ready — deploy when you choose"],
    [{ deployment:record({ op:"PENDING", confirmed:"none", origin:"MANUAL" }), observation:observation("missing") }, "WARNING", "Not yet deployed · needs creation", "Ready — deploy when you choose"],
    [{ deployment:record({ op:"PENDING", confirmed:"payload", origin:"MANUAL" }) }, "WARNING", "Update ready", "Ready — deploy when you choose"],
    [{ deployment:record({ op:"PENDING", confirmed:"listing", origin:"MANUAL" }) }, "WARNING", "Listing change ready", "Ready — deploy when you choose"],
    [{}, "OK", "In sync", "Nothing to do."]
  ];
  for (const [overrides, token, label, next] of rows) {
    const result = deriveGeneratorStatus(base(overrides));
    assert.equal(result.status.token, token, label);
    assert.equal(result.status.label, label);
    assert.equal(result.next.text, next, label);
  }
});

test("A036-02 freshness notes, mode wording and global overlays", () => {
  assert.deepEqual([...deriveGeneratorStatus(base()).notes], ["not verified"]);
  const verified = deriveGeneratorStatus(base({ deployment:record({ op:"SUCCEEDED", confirmed:"match", baseline:true, origin:"MANUAL" }), observation:observation("same", "PUBLICLY_LISTED") }));
  assert.equal(verified.status.label, "In sync");
  assert.deepEqual([...verified.notes], ["verified 1 h ago"]);
  // An UNKNOWN observed listing is never a mismatch (04 §F.3).
  assert.equal(deriveGeneratorStatus(base({ deployment:record({ op:"SUCCEEDED", confirmed:"match", baseline:true, origin:"MANUAL" }), observation:observation("unknownListing") })).rule, 13);
  const pending = { deployment:record({ op:"PENDING", confirmed:"payload", origin:"MANUAL" }) };
  assert.equal(deriveGeneratorStatus(base({ ...pending, mode:"AUTOMATIC", nextCheckAt:"2026-10-08T12:34:00.000Z" })).next.text, "Deploys automatically at the next check (≈12:34)");
  assert.equal(deriveGeneratorStatus(base({ ...pending, mode:"PAUSED" })).next.text, "Automatic checks paused");
  assert.equal(deriveGeneratorStatus(base({ ...pending, recovery:"RECOVERY_HOLD" })).next.text, "On hold until recovery checks finish");
  assert.equal(deriveGeneratorStatus(base({ ...pending, providerAvailable:false })).next.text, "Waiting for Perchance");
  // Overlays never rewrite a non-mutating next step.
  assert.equal(deriveGeneratorStatus(base({ deployment:record({ op:"RECONCILE", confirmed:"none", origin:"MANUAL" }), recovery:"RECOVERY_HOLD" })).next.kind, "reconcile");
});

test("A036-02 invalid input fails closed", () => {
  assert.throws(() => deriveGeneratorStatus({ deployment:{}, now:NOW }));
  assert.throws(() => deriveGeneratorStatus(base({ mode:"SOMETIMES" })));
  assert.throws(() => deriveGeneratorStatus(base({ observation:{ method:"GUESS", observedAt:NOW, exists:true, listing:"UNKNOWN" } })));
  assert.throws(() => deriveGeneratorStatus(base({ now:"yesterday" })));
});
