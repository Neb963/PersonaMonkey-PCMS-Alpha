import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("P026 Firefox ESR popup uses a stable intrinsic body width", async () => {
  const css=await readFile("extension/popup/popup.css","utf8");
  assert.match(css,/body\s*\{[^}]*\bwidth:370px;/s);
  assert.match(css,/body\s*\{[^}]*\bmin-width:300px;/s);
  assert.doesNotMatch(css,/body\s*\{[^}]*\bwidth:min\(/s);
  assert.doesNotMatch(css,/body\s*\{[^}]*\b(?:width|min-width|max-width):[^;}]*100vw/s);
});
