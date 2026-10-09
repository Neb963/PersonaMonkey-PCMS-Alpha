import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("A021 boundary: app/search/deep-link code has no privileged authority or dynamic HTML injection",async()=>{
  const paths=[
    "extension/pcms/app/app.js",
    "extension/pcms/app/projections.js",
    "extension/pcms/app/deep-links.js",
    "extension/pcms/app/errors.js"
  ];
  const source=(await Promise.all(paths.map(path=>readFile(path,"utf8")))).join("\n");
  for(const forbidden of [
    /\bbrowser\s*(?:\.|\[)/,
    /\bchrome\s*(?:\.|\[)/,
    /\bindexedDB\b/,
    /sendNativeMessage|nativeMessaging/,
    /\bfetch\s*\(/,
    /\beval\s*\(/,
    /\.innerHTML\b/,
    /resolveForPrivilegedUse|secretValue/i
  ]) assert.doesNotMatch(source,forbidden);
});

test("A021 boundary: projection consumes read-only accepted service methods only",async()=>{
  const source=await readFile("extension/pcms/app/projections.js","utf8");
  assert.match(source,/snapshotMethods\(humanTasks,\["listAttention"\]/);
  assert.match(source,/snapshotMethods\(accounts,\["listAccounts"\]/);
  assert.doesNotMatch(source,/\.open\s*\(|\.resolve\s*\(|\.cancel\s*\(|createAccount\s*\(|rebindPersona\s*\(/);
  assert.doesNotMatch(source,/instructions|credentialRef|cookieStoreId/);
});

test("A021 shell exposes semantic navigation, notifications, search and retains P003 bootstrap boundary",async()=>{
  const html=await readFile("extension/pcms/app/index.html","utf8");
  const app=await readFile("extension/pcms/app/app.js","utf8");
  assert.match(html,/id="primaryNav"/);
  assert.match(html,/id="notificationStatus"[^>]*aria-live="polite"/);
  assert.match(html,/id="searchForm"/);
  assert.match(html,/id="viewAttention"/);
  assert.match(html,/id="viewAccounts"/);
  assert.match(app,/from "\.\.\/core\/bootstrap\.js"/);
  assert.doesNotMatch(html+app,/PCMS_REQUEST|PCMS_EVENTS|pcms-client/);
});
