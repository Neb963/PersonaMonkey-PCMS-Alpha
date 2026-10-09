// A036-01: Deployer v1 records migrate losslessly and existing RemoteOperations remain linked.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPLOYER_MIGRATION_ID,
  migrateDeployerStateV1,
  migrateDeploymentRecordV1,
  projectDeploymentV1,
  readDeployerState
} from "../../../pcms-modules/p015/migration.js";
import { DEPLOYER_SCHEMA_VERSION, DEPLOYER_STATE_CONTRACT, normalizeDeployerState } from "../../../pcms-modules/p015/schema.js";
import { DEPLOYER_ERROR_CODES } from "../../../pcms-modules/p015/errors.js";
import { generatorSourceFingerprint, sha256Hex } from "../../../extension/pcms/providers/perchance/contract.js";
import { setup } from "./harness.mjs";

const HASH_A = "eb326958738d171e78bdff8117386308557c0f4d19783441bca3dea03314d2bc"; // sha256("new source")
const HASH_B = "470f5e33c65605ccb235dfaab0f3bc914bb2c23ea7a408bf3ad81218feae39a2"; // sha256("old source")
const STATUSES = ["PENDING", "ACTIVE", "RECONCILE", "RETRYABLE", "FAILED", "CANCELLED", "SUCCEEDED"];

function v1Record({ id = "dep-1", generatorId = "gen-1", revision = 1, sequence = 1, status = "PENDING", desired = HASH_A, observed = null }) {
  return {
    schemaVersion:1, kind:"deployment", deploymentId:id, providerId:"perchance", accountId:"acct-1",
    targetRef:{ kind:"generator", id:generatorId },
    desired:{ revision, sourceHash:desired },
    observed:observed === null ? { sourceHash:null, confirmedAt:null } : { sourceHash:observed, confirmedAt:"2026-10-05T05:00:01.000Z" },
    operation:{ sequence, operationId:"deploy:" + id + ":" + revision + ":" + sequence, status },
    createdAt:"2026-10-05T05:00:00.000Z", updatedAt:"2026-10-05T05:00:02.000Z"
  };
}

// Every valid v1 record shape: each operation status, with and without a confirmation, for
// the current desired revision and for an older confirmed one.
function v1Variants() {
  const out = [];
  let n = 0;
  for (const status of STATUSES) {
    for (const observed of [null, HASH_A, HASH_B]) {
      if (status === "SUCCEEDED" && observed !== HASH_A) continue;
      for (const [revision, sequence] of [[1, 1], [3, 2]]) {
        n += 1;
        out.push(v1Record({ id:"dep-" + n, generatorId:"gen-" + n, revision, sequence, status, observed }));
      }
    }
  }
  return out;
}

test("A036-01 the migration id and v2 contract are the allocated ones", () => {
  assert.equal(DEPLOYER_MIGRATION_ID, "MIG-P036-deployer-state-v2");
  assert.equal(DEPLOYER_STATE_CONTRACT, "pcms.deployer.state/v2");
  assert.equal(DEPLOYER_SCHEMA_VERSION, 2);
});

test("A036-01 every v1 record shape migrates to v2 and projects back to the identical v1 record", () => {
  const variants = v1Variants();
  assert.ok(variants.length >= 30);
  for (const v1 of variants) {
    const v2 = migrateDeploymentRecordV1(v1);
    assert.equal(v2.schemaVersion, 2);
    assert.equal(v2.desired.payloadKind, "v1-source");
    assert.equal(v2.desired.payloadHash, v1.desired.sourceHash);
    assert.deepEqual(v2.desired.origin, { kind:"MANUAL" });
    assert.equal(v2.desired.listing, null);
    assert.equal(v2.confirmed.payloadHash, v1.observed.sourceHash);
    assert.equal(v2.confirmed.confirmedAt, v1.observed.confirmedAt);
    assert.equal(v2.confirmed.baselineHash, null);
    assert.deepEqual(v2.policy, { paused:false, pauseReason:null });
    // RemoteOperation identity is unchanged.
    assert.equal(v2.operation.operationId, v1.operation.operationId);
    assert.equal(v2.desired.revision, v1.desired.revision);
    assert.equal(v2.operation.sequence, v1.operation.sequence);
    assert.equal(v2.confirmed.operationId, v1.operation.status === "SUCCEEDED" ? v1.operation.operationId : null);
    assert.deepEqual(JSON.parse(JSON.stringify(projectDeploymentV1(v2))), v1, "lossless for " + v1.deploymentId);
  }
});

test("A036-01 whole v1 state migrates (sorted, deduplicated, bounded) and v2 is never re-migrated", () => {
  const variants = v1Variants();
  const v1State = { schemaVersion:1, kind:"deployer-state", deployments:[...variants].sort((a, b) => a.deploymentId.localeCompare(b.deploymentId)) };
  const read = readDeployerState(v1State);
  assert.equal(read.migrated, true);
  assert.equal(read.value.deployments.length, variants.length);
  const again = readDeployerState(JSON.parse(JSON.stringify(read.value)));
  assert.equal(again.migrated, false);
  assert.deepEqual(JSON.parse(JSON.stringify(again.value)), JSON.parse(JSON.stringify(read.value)));
  assert.deepEqual(normalizeDeployerState(JSON.parse(JSON.stringify(read.value))).deployments.map((d) => d.deploymentId),
    v1State.deployments.map((d) => d.deploymentId).sort((a, b) => a.localeCompare(b)));
});

test("A036-01 corrupt or ambiguous v1 records fail closed instead of being guessed", () => {
  const bad = [
    { ...v1Record({}), observed:{ sourceHash:HASH_A, confirmedAt:null } },
    { ...v1Record({}), operation:{ sequence:1, operationId:"deploy:other:1:1", status:"PENDING" } },
    v1Record({ status:"SUCCEEDED", observed:HASH_B }),
    { ...v1Record({}), extra:true }
  ];
  for (const record of bad) assert.throws(() => migrateDeploymentRecordV1(record), (error) => error?.code === DEPLOYER_ERROR_CODES.CORRUPT_STATE);
  const duplicate = { schemaVersion:1, kind:"deployer-state", deployments:[v1Record({}), v1Record({ id:"dep-2" })] };
  assert.throws(() => migrateDeployerStateV1(duplicate), (error) => error?.code === DEPLOYER_ERROR_CODES.CORRUPT_STATE);
});

// Integration: a real v1 row in PCMS storage, with a v1 RemoteOperation left UNCERTAIN by an
// ambiguous dispatch, is read by the v2 Deployer; reconciliation finds the same operation.
test("A036-01 stored v1 state with an UNCERTAIN v1 RemoteOperation stays linked through migration", async () => {
  const h = setup();
  h.emulator.seedGenerator({ generatorId:"gen-legacy", sourceHash:HASH_B, source:"old source" });
  const created = await h.deployer.createDeployment({ deploymentId:"dep-legacy", accountId:"acct-1", generatorId:"gen-legacy", sourceHash:HASH_A }, { expectedRevision:0 });
  h.emulator.failNext("after-apply");
  await assert.rejects(h.deployer.deploy("dep-legacy", { expectedRevision:created.revision, source:"new source" }));
  const operationId = "deploy:dep-legacy:1:1";
  const remote = await h.remoteOps.get(operationId);
  assert.equal(remote.value.state, "UNCERTAIN");
  assert.equal(remote.value.intentFingerprint, generatorSourceFingerprint(HASH_A));

  // Rewrite the stored row in the accepted v1 shape, exactly as a P015 build left it.
  const row = await h.stateStore.read();
  const v1Value = { schemaVersion:1, kind:"deployer-state", deployments:row.value.deployments.map((d) => JSON.parse(JSON.stringify(projectDeploymentV1(d)))) };
  const written = await h.stateStore.compareAndSwap({ expectedRevision:row.revision, value:v1Value });
  assert.equal(written.ok, true);
  assert.equal((await h.stateStore.read()).value.schemaVersion, 1);

  const migratedView = await h.deployer.getDeployment("dep-legacy");
  assert.equal(migratedView.schemaVersion, 2);
  assert.equal(migratedView.operation.operationId, operationId);
  assert.equal(migratedView.operation.status, "RECONCILE");

  const listed = await h.deployer.listDeployments();
  const reconciled = await h.deployer.reconcileDeployment("dep-legacy", { expectedRevision:listed.revision });
  assert.equal(reconciled.deployment.operation.status, "SUCCEEDED");
  assert.equal(reconciled.deployment.confirmed.payloadHash, HASH_A);
  assert.equal(reconciled.deployment.confirmed.operationId, operationId);
  assert.equal((await h.stateStore.read()).value.schemaVersion, 2, "the next write persisted v2");
  assert.equal((await h.remoteOps.get(operationId)).value.state, "SUCCEEDED");
  assert.equal(await sha256Hex("new source"), HASH_A);
});

test("A036-01 migrateState persists v2 once and is idempotent; legacy v1 inputs keep working", async () => {
  const h = setup();
  const v1Value = { schemaVersion:1, kind:"deployer-state", deployments:[v1Record({ id:"dep-a", generatorId:"gen-a" })] };
  await h.stateStore.compareAndSwap({ expectedRevision:0, value:v1Value });
  const first = await h.deployer.migrateState();
  assert.deepEqual({ ...first }, { revision:2, migrated:true });
  const second = await h.deployer.migrateState();
  assert.deepEqual({ ...second }, { revision:2, migrated:false });
  const views = await h.deployer.listDeploymentViews();
  // The v1 projection fields used by legacy forms and capability set v1 keep their meaning.
  assert.equal(views.deployments[0].desiredSourceHash, HASH_A);
  assert.equal(views.deployments[0].observedSourceHash, null);
  assert.equal(views.deployments[0].syncState, "PENDING");
  const changed = await h.deployer.setDesired("dep-a", { expectedRevision:2, expectedDesiredRevision:1, sourceHash:HASH_B });
  assert.equal(changed.deployment.desired.payloadKind, "v1-source");
  assert.equal(changed.deployment.operation.operationId, "deploy:dep-a:2:1");
});
