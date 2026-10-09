import test from "node:test";
import assert from "node:assert/strict";
import { REFRESHER_MIGRATION_ID, migrateRefresherStateV1, projectRefresherStateV1, readRefresherState } from "../../../pcms-modules/p017/migration.js";
import { normalizeRefresherStateV1 } from "../../../pcms-modules/p017/schema.js";
import { createRefresherService } from "../../../pcms-modules/p017/refresher.js";
import { generatorSourceFingerprint } from "../../../extension/pcms/providers/perchance/contract.js";
import { account, makeAccounts, makeProvider, makeStateStore } from "../p017/harness.mjs";

const HASH_A = "eb326958738d171e78bdff8117386308557c0f4d19783441bca3dea03314d2bc"; // sha256("new source")
const HASH_B = "470f5e33c65605ccb235dfaab0f3bc914bb2c23ea7a408bf3ad81218feae39a2";
const T = "2026-10-05T06:00:00.000Z";

function v1Member(generatorId, sourceHash, ordinal, operation, extra = {}) {
  return { schemaVersion:1, kind:"refresher-member", generatorId, sourceHash, ordinal, lastConfirmedAt:null, confirmedCount:0,
    operation, createdAt:T, updatedAt:T, ...extra };
}
export function v1State() {
  return {
    schemaVersion:1, kind:"refresher-state",
    cohorts:[{
      schemaVersion:1, kind:"refresher-cohort", cohortId:"p026-live", providerId:"perchance", accountId:"acct-1", enabled:true,
      policy:{ mode:"MANUAL", dailyBudget:1, dayOffsetMinutes:0, activeHours:24, sleepDays:0, anchorAt:T },
      members:[
        v1Member("gen-1", HASH_A, 1, { sequence:1, operationId:"refresh:p026-live:1:1", status:"PENDING", budgetDayStart:"2026-10-05T00:00:00.000Z" }),
        v1Member("gen-2", HASH_B, 2, { sequence:2, operationId:"refresh:p026-live:2:2", status:"SUCCEEDED", budgetDayStart:"2026-10-04T00:00:00.000Z" },
          { lastConfirmedAt:"2026-10-04T08:00:00.000Z", confirmedCount:2 }),
        v1Member("gen-3", HASH_A, 3, { sequence:0, operationId:null, status:"IDLE", budgetDayStart:null })
      ],
      createdAt:T, updatedAt:T
    }]
  };
}

test("MIG-P040-refresher-state-v2 is mechanical and lossless for accepted v1 state", () => {
  assert.equal(REFRESHER_MIGRATION_ID, "MIG-P040-refresher-state-v2");
  const v2 = migrateRefresherStateV1(v1State());
  assert.equal(v2.schemaVersion, 2);
  const cohort = v2.cohorts[0];
  assert.equal(cohort.name, "p026-live");
  assert.equal(cohort.nextOrdinal, 4);
  assert.deepEqual(cohort.members.map((m) => [m.generatorId, m.sourceKind, m.sourceHash, m.ordinal]),
    [["gen-1", "LEGACY_SOURCE", HASH_A, 1], ["gen-2", "LEGACY_SOURCE", HASH_B, 2], ["gen-3", "LEGACY_SOURCE", HASH_A, 3]]);
  // The unresolved operation pins its v1 intent; operation identities are unchanged.
  assert.deepEqual(cohort.members[0].operation, { sequence:1, operationId:"refresh:p026-live:1:1", status:"PENDING",
    budgetDayStart:"2026-10-05T00:00:00.000Z", release:{ payloadKind:"v1-source", payloadHash:HASH_A, thumbnailHash:null, listing:null } });
  assert.equal(cohort.members[1].operation.release, null);
  assert.doesNotThrow(() => normalizeRefresherStateV1(projectRefresherStateV1(v2)));
  assert.deepEqual(JSON.parse(JSON.stringify(projectRefresherStateV1(v2))), v1State());
  assert.equal(readRefresherState(v1State()).migrated, true);
  assert.equal(readRefresherState(JSON.parse(JSON.stringify(v2))).migrated, false);
});

test("MIG-P040-refresher-state-v2 keeps an unresolved legacy refresh linked to its RemoteOperation intent", async () => {
  const state = makeStateStore({ row:{ revision:7, value:v1State() } });
  const provider = makeProvider();
  const service = createRefresherService({ stateStore:state.store, accountsService:makeAccounts({ "acct-1":account("acct-1") }).service,
    providerGateResolver:provider.resolver, remoteOperationReader:provider.remoteReader, clock:() => "2026-10-05T06:30:00.000Z" });
  const cohort = await service.getCohort("p026-live");
  assert.equal(cohort.members[0].operation.status, "PENDING");
  // Dispatching the migrated legacy intent reproduces the accepted v1 fingerprint exactly.
  const result = await service.dispatchRefresh("p026-live", "gen-1", { expectedRevision:7, source:"new source" });
  assert.equal(result.status, "APPLIED");
  assert.equal(provider.mutations[0].operation.operationId, "refresh:p026-live:1:1");
  assert.equal(provider.mutations[0].operation.intentFingerprint, generatorSourceFingerprint(HASH_A));
  // The first write persisted v2.
  assert.equal(state.shared.row.value.schemaVersion, 2);
  assert.equal(JSON.stringify(state.shared.row.value).includes("new source"), false);
});

test("MIG-P040-refresher-state-v2 lets the operator discard a legacy refresh that never reached Perchance", async () => {
  const state = makeStateStore({ row:{ revision:7, value:v1State() } });
  const provider = makeProvider();
  const service = createRefresherService({ stateStore:state.store, accountsService:makeAccounts({ "acct-1":account("acct-1") }).service,
    providerGateResolver:provider.resolver, remoteOperationReader:provider.remoteReader, clock:() => "2026-10-05T06:30:00.000Z" });
  const discarded = await service.cancelRefresh("p026-live", "gen-1", { expectedRevision:7 });
  assert.equal(discarded.member.operation.status, "CANCELLED");
  assert.equal(provider.mutations.length, 0);
  // A possibly dispatched refresh can never be discarded; it must be reconciled.
  provider.setRemote("refresh:p026-live:1:1", "UNCERTAIN");
  const listed = await service.listCohorts();
  await assert.rejects(service.cancelRefresh("p026-live", "gen-1", { expectedRevision:listed.revision }), (error) => error?.code === "PCMS_REFRESHER_INVALID_TRANSITION");
});

test("MIG-P040-refresher-state-v2 rejects corrupt v2 records instead of guessing", () => {
  const v2 = JSON.parse(JSON.stringify(migrateRefresherStateV1(v1State())));
  const reused = structuredClone(v2);
  reused.cohorts[0].members[2].ordinal = 2;
  assert.throws(() => readRefresherState(reused), (error) => error?.code === "PCMS_REFRESHER_CORRUPT_STATE");
  const mixed = structuredClone(v2);
  mixed.cohorts[0].members[0].sourceKind = "DEPLOYER_CONFIRMED";
  assert.throws(() => readRefresherState(mixed), (error) => error?.code === "PCMS_REFRESHER_CORRUPT_STATE");
  const unpinned = structuredClone(v2);
  unpinned.cohorts[0].members[0].operation.release = null;
  assert.throws(() => readRefresherState(unpinned), (error) => error?.code === "PCMS_REFRESHER_CORRUPT_STATE");
});
