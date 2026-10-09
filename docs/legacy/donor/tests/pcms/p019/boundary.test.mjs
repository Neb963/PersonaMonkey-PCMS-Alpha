import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files=["errors.js","schema.js","provisioning.js","provider.js"];
async function source(){ return (await Promise.all(files.map((name)=>readFile(new URL(`../../../pcms-modules/p019/${name}`,import.meta.url),"utf8")))).join("\n"); }

test("A019 boundary: module has no raw browser/native/storage/network authority or credential resolution",async()=>{
  const text=await source();
  for(const forbidden of [/\bbrowser\s*\./,/\bchrome\s*\./,/\bindexedDB\b/,/sendNativeMessage/,/\bnativeMessaging\b/,/\bfetch\s*\(/,/\bdocument\s*\./,/\beval\s*\(/,/resolveForPrivilegedUse/,/\bpassword\b/i,/\bpassphrase\b/i,/secretValue/i]) {
    assert.equal(forbidden.test(text),false,`forbidden authority or secret token: ${forbidden}`);
  }
});

test("A019 boundary: CAPTCHA is an operator gate, never a solver/bypass path",async()=>{
  const text=await source();
  assert.match(text,/operator\.captcha/);
  assert.equal(/captcha.{0,40}\b(solve|bypass)\b|\b(solve|bypass)\b.{0,40}captcha/i.test(text),false);
});

test("A019 boundary: external mutation surface is RemoteControl mutate/reconcile/get only",async()=>{
  const text=await readFile(new URL("../../../pcms-modules/p019/provisioning.js",import.meta.url),"utf8");
  assert.match(text,/snapshotMethods\(remoteControl,\["mutate","reconcile","get"\]/);
  assert.equal(/remote\.(dispatch|send|request|execute)\s*\(/.test(text),false);
});
