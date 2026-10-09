import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("A029-01 timer authority remains durable and browser-free; alarms are wake-only",async()=>{
  const timers=await readFile("extension/pcms/services/timers.js","utf8");
  const alarms=await readFile("extension/pcms/background/alarms/coordinator.js","utf8");
  assert.match(timers,/PCMS_TIMERS_ENSURE_CONTRACT\s*=\s*"pcms\.timers\.ensure\/v1"/);
  assert.match(timers,/auditJournal\.transitionAndAppend/);
  assert.doesNotMatch(timers,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)|\bindexedDB\b/i);
  assert.doesNotMatch(timers,/setInterval|setTimeout|createObjectStore|PCMS_DB_VERSION|PCMS_MIGRATIONS/);
  assert.match(alarms,/pcms\.timers\.next/);
  assert.match(alarms,/pcms\.core\.heartbeat/);
  assert.match(alarms,/timers\.recoverInterrupted/);
  assert.match(alarms,/timers\.runDue/);
  assert.doesNotMatch(alarms,/setInterval|setTimeout|visibilitychange|online/);
});

test("A029-02 P029 introduces no domain scheduler and its only declared product job is the Core continuity fixture",async()=>{
  const fixture=await readFile("extension/pcms/background/alarms/continuity-fixture.js","utf8");
  assert.match(fixture,/core\.p029\.continuity/);
  assert.match(fixture,/timers\.ensure/);
  assert.doesNotMatch(fixture,/deployer|refresher|explorer|provisioning|perchance/i);
});

test("A029-03 required CI runs deterministic timer tests and the packaged pinned-FDE continuity proof",async()=>{
  const pkg=JSON.parse(await readFile("package.json","utf8"));
  const workflow=await readFile(".github/workflows/firefox.yml","utf8");
  assert.equal(pkg.scripts["test:p029"],"node --test tests/pcms/p029/*.test.mjs");
  assert.match(pkg.scripts["firefox:packaged:p029"],/tests\/pcms\/p029\/packaged\.mjs/);
  assert.match(workflow,/npm run test:p029/);
  assert.match(workflow,/npm run firefox:packaged:p029/);
});
