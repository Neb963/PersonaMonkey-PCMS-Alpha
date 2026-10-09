import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = resolve(root, "extension/tests");
const tests = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

if (!tests.length) {
  console.error("No extension tests found");
  process.exit(1);
}

let failed = 0;
for (const test of tests) {
  console.log(`\n==> ${test}`);
  const result = spawnSync(process.execPath, [resolve(testsDir, test)], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status !== 0) failed += 1;
}

if (failed) {
  console.error(`\n${failed} extension test file(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} extension test files passed`);
