import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FILES = [
  "pcms-modules/p018/errors.js",
  "pcms-modules/p018/schema.js",
  "pcms-modules/p018/projection.js",
  "pcms-modules/p018/view.js",
  "pcms-modules/p018/statistics.js"
];

test("A018-01/A018-02/A018-03 Statistics remains a read-only projection behind bounded PCMS capabilities", async () => {
  const source = (await Promise.all(FILES.map((path) => readFile(path, "utf8")))).join("\n");
  assert.doesNotMatch(source, /\bbrowser\s*(?:\.|\[)|\bchrome\s*(?:\.|\[)/);
  assert.doesNotMatch(source, /sendNativeMessage|connectNative|nativeMessaging|\bindexedDB\b/i);
  assert.doesNotMatch(source, /personamonkey.*(?:service|state)|management-api|mullvad-native/i);
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b/);
  assert.doesNotMatch(source, /document\.|querySelector|MutationObserver|fetch\s*\(/);
  assert.doesNotMatch(source, /password|credential|secretRef|accessToken|refreshToken/i);
});

test("A018-01/A018-02 Statistics consumes Audit Journal reads only and never appends or mutates operational state", async () => {
  const source = await readFile("pcms-modules/p018/statistics.js", "utf8");
  assert.match(source, /audit\.read\(/);
  assert.doesNotMatch(source, /\.append\s*\(|transitionAndAppend|compareAndSwap|gate\.mutate|remoteOperation/i);
});

test("A018-03 export code cannot expose arbitrary raw event or subject fields", async () => {
  const source = await readFile("pcms-modules/p018/view.js", "utf8");
  assert.doesNotMatch(source, /subject|event\.data|rawEvent|payload/i);
  assert.match(source, /metric_id,label,aggregation,day,value,matched_events,late_matched_events/);
});
