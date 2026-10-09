import test from "node:test";
import assert from "node:assert/strict";

import { MODULE_ERROR_CODES } from "../../../extension/pcms/modules/errors.js";
import { createModulePackageRegistry } from "../../../extension/pcms/modules/registry.js";
import { archive, makeStorage } from "./harness.mjs";

test("A022-03 registry refuses deletion of active/last-known-good package references",async()=>{
  const storage=makeStorage();
  const registry=createModulePackageRegistry({storageBroker:storage,clock:()=>"2026-10-05T12:00:00.000Z"});
  let row=await registry.stageCandidate(archive("1.0.0",{capabilities:[]}),{expectedModuleRevision:0});
  row=await registry.admitCandidate("demo.module",row.value.candidate.packageHash,{expectedModuleRevision:row.revision});
  await assert.rejects(
    ()=>registry.deletePackage(row.value.activePackageHash),
    e=>e?.code===MODULE_ERROR_CODES.PACKAGE_REFERENCED
  );
});

test("A022-03 preserved admission keeps prior known-good until explicit success mark",async()=>{
  const storage=makeStorage();
  const registry=createModulePackageRegistry({storageBroker:storage,clock:()=>"2026-10-05T12:00:00.000Z"});
  let first=await registry.stageCandidate(archive("1.0.0",{capabilities:[]}),{expectedModuleRevision:0});
  first=await registry.admitCandidate("demo.module",first.value.candidate.packageHash,{expectedModuleRevision:first.revision});
  const firstHash=first.value.activePackageHash;

  let next=await registry.stageCandidate(archive("2.0.0",{capabilities:[]}),{expectedModuleRevision:first.revision});
  next=await registry.admitCandidate("demo.module",next.value.candidate.packageHash,{
    expectedModuleRevision:next.revision,
    preserveLastKnownGood:true
  });
  assert.notEqual(next.value.activePackageHash,firstHash);
  assert.equal(next.value.lastKnownGoodPackageHash,firstHash);

  const rolled=await registry.rollbackAdmission("demo.module",next.value.activePackageHash,{expectedModuleRevision:next.revision});
  assert.equal(rolled.value.activePackageHash,firstHash);
  assert.equal(rolled.value.lastKnownGoodPackageHash,firstHash);
});
