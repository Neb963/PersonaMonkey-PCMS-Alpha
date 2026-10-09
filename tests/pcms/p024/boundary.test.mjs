import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("A024 security boundary: release hardening preserves deterministic build controls", async () => {
  const build=await readFile("scripts/build-extension.mjs","utf8");
  const repro=await readFile("scripts/test-build-reproducibility.mjs","utf8");

  assert.match(build,/2000-01-01T00:00:00Z/);
  assert.match(build,/TZ:\s*"UTC"/);
  assert.match(build,/LC_ALL:\s*"C"/);
  assert.match(build,/\["-X",\s*"-q"/);
  assert.match(build,/\.sort\(compareArchivePaths\)/);
  assert.match(build,/createHash\("sha256"\)/);

  assert.match(repro,/buildInTimezone\("UTC"\)/);
  assert.match(repro,/buildInTimezone\("Europe\/Warsaw"\)/);
  assert.match(repro,/utc\.bytes\.equals\(warsaw\.bytes\)/);
});

test("A024 security boundary: focused hardening suite contains no live-provider or Firefox DevTools dependency", async () => {
  const source=(await Promise.all([
    "tests/pcms/p024/fault-security.test.mjs",
    "tests/pcms/p024/release-candidate.test.mjs",
    "tests/pcms/p024/restart.test.mjs"
  ].map((path)=>readFile(path,"utf8")))).join("\n");

  assert.doesNotMatch(source,/firefox-devtools|firefox-dev-mcp|marionette/i);
  assert.doesNotMatch(source,/perchance\.org|mullvad\.net|api\.mullvad/i);
  assert.doesNotMatch(source,/\bfetch\s*\(/);
});

test("A024 security boundary: release suite uses accepted PCMS authority surfaces rather than raw browser authority", async () => {
  const source=(await Promise.all([
    "tests/pcms/p024/fault-security.test.mjs",
    "tests/pcms/p024/restart.test.mjs"
  ].map((path)=>readFile(path,"utf8")))).join("\n");

  assert.doesNotMatch(source,/\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source,/management-integration|persona-api|mullvad-native|cookieStoreId|userScripts/i);
});
