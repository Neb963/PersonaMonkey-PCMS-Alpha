// pcms.generator-index/v1 union rules and P036 boundaries (A036-02 SEC, A036-03 U).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mergeGeneratorListings, parseGeneratorIndexFilter } from "../../../extension/pcms/integration/generator-index.js";

test("A036-03 index unions listings by ref and never picks an account winner", () => {
  const rows = mergeGeneratorListings([
    { moduleId:"deployer", items:[
      { ref:"perchance:a", accountId:"alice", filter:"sync", status:{ token:"OK", label:"In sync" }, next:{ kind:"none", text:"" }, notes:[], columns:{ repo:"1.0.0" }, deploymentId:"gen:a" },
      { ref:"perchance:b", accountId:"alice", filter:"update", status:{ token:"WARNING", label:"Update ready" }, next:{ kind:"deploy", text:"" }, notes:[], columns:{}, deploymentId:"gen:b" }
    ] },
    { moduleId:"refresher", items:[
      { ref:"perchance:a", accountId:"alice", title:"A gen", columns:{ cohort:"Daily A" } },
      { ref:"perchance:b", accountId:"bob", columns:{} },
      { ref:"perchance:c", accountId:"carol", columns:{} },
      { ref:"not-a-ref", accountId:"x", columns:{} }
    ] }
  ]);
  assert.deepEqual(rows.map((row) => row.ref), ["perchance:a", "perchance:b", "perchance:c"]);
  assert.equal(rows[0].title, "A gen");
  assert.deepEqual({ ...rows[0].columns }, { repo:"1.0.0", cohort:"Daily A" });
  assert.equal(rows[1].status.label, "Account mismatch");
  assert.equal(rows[1].accountId, null);
  assert.deepEqual([...rows[1].accountIds], ["alice", "bob"]);
  assert.equal(rows[2].status.label, "Not managed by Deployer");
});

test("A036-03 index filter grammar is closed and matches router-v2", () => {
  assert.deepEqual({ ...parseGeneratorIndexFilter("status:update,account:alice") }, { status:"update", account:"alice" });
  for (const bad of ["status:", "colour:red", "status:update,status:new", "status:unknown-status"]) assert.throws(() => parseGeneratorIndexFilter(bad));
});

test("P036 boundaries: no raw browser, storage, network or eval in the Deployer, provider or index", async () => {
  const files = [
    "pcms-modules/p015/schema.js", "pcms-modules/p015/migration.js", "pcms-modules/p015/status.js",
    "pcms-modules/p015/listing.js", "pcms-modules/p015/deployer.js",
    "extension/pcms/providers/perchance/contract.js", "extension/pcms/providers/perchance/adapter.js",
    "extension/pcms/providers/perchance/listing.js", "extension/pcms/providers/perchance/assisted-driver.js",
    "extension/pcms/integration/generator-index.js",
    "extension/pcms/app/views/generators/model.js", "extension/pcms/app/views/generators/generators-view.js"
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/, file);
    assert.doesNotMatch(source, /sendNativeMessage|connectNative|\bindexedDB\b|localStorage|sessionStorage/, file);
    assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b|innerHTML|insertAdjacentHTML|document\.write/, file);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/, file);
    assert.doesNotMatch(source, /userScripts/, file);
  }
  // The Deployer stays on the accepted generator.update action through ProviderGate only.
  const deployer = await readFile("pcms-modules/p015/deployer.js", "utf8");
  assert.match(deployer, /gate\.mutate/);
  assert.doesNotMatch(deployer, /updateGeneratorRelease\s*\(|updateGenerator\s*\(|generator\.create/);
  // The Core index never imports module code; it receives the Deployer listing as a service call.
  assert.doesNotMatch(await readFile("extension/pcms/integration/generator-index.js", "utf8"), /pcms-modules/);
});
