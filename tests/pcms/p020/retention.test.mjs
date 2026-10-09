import test from "node:test";
import assert from "node:assert/strict";

import { planBackupRetention } from "../../../extension/pcms/recovery/retention.js";

test("A020-01 retention keeps newest backups deterministically",()=>{
  const result=planBackupRetention([
    {backupId:"b1",createdAt:"2026-10-01T00:00:00Z"},
    {backupId:"b3",createdAt:"2026-10-03T00:00:00Z"},
    {backupId:"b2",createdAt:"2026-10-02T00:00:00Z"},
    {backupId:"b4",createdAt:"2026-10-03T00:00:00Z"}
  ],{keepLatest:2});
  assert.deepEqual(result.retain,["b4","b3"]);
  assert.deepEqual(result.delete,["b2","b1"]);
});

test("retention rejects duplicate identities and invalid bounds",()=>{
  assert.throws(()=>planBackupRetention([{backupId:"b",createdAt:"2026-10-01T00:00:00Z"},{backupId:"b",createdAt:"2026-10-02T00:00:00Z"}]));
  assert.throws(()=>planBackupRetention([],{keepLatest:0}));
});
