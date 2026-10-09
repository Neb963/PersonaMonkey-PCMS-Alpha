import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertFileSha256,
  createIsolatedProfile,
  sha256File,
} from "../../tools/firefox/lib.mjs";

test("checksum verification fails closed", async () => {
  const path = join(tmpdir(), `pcms-checksum-${process.pid}-${Date.now()}.txt`);
  const contents = "persona-monkey-pcms\n";
  await writeFile(path, contents, "utf8");
  const expected = createHash("sha256").update(contents).digest("hex");
  assert.equal(await sha256File(path), expected);
  await assertFileSha256(path, expected);
  await assert.rejects(() => assertFileSha256(path, "0".repeat(64)), /SHA-256 mismatch/);
});

test("isolated profiles are unique and hardened for CI startup", async () => {
  const parent = join(tmpdir(), `pcms-profile-test-${process.pid}-${Date.now()}`);
  const first = await createIsolatedProfile(parent);
  const second = await createIsolatedProfile(parent);
  assert.notEqual(first, second);
  const prefs = await readFile(join(first, "user.js"), "utf8");
  assert.match(prefs, /app\.update\.auto/);
  assert.match(prefs, /toolkit\.telemetry\.enabled/);
});
