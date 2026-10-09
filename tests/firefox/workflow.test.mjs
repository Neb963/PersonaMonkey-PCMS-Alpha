import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("hosted CI installs and smokes the repository-pinned Developer Edition", async () => {
  const workflow = await readFile(".github/workflows/firefox.yml", "utf8");
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /npm run firefox:install/);
  assert.match(workflow, /npm run firefox:smoke/);
  assert.match(workflow, /steps\.install\.outputs\.firefox_bin/);
  assert.doesNotMatch(workflow, /firefox.*latest/i);
});
