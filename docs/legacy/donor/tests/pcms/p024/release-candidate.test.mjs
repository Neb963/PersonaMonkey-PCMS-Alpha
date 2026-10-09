import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");

function run(command,args) {
  const result=spawnSync(command,args,{cwd:root,encoding:"utf8"});
  if(result.error) throw result.error;
  assert.equal(result.status,0,[
    command+" "+args.join(" ")+" failed",
    result.stdout||"",
    result.stderr||""
  ].join("\n"));
  return result;
}

test("A024-02 current extension XPI is byte-reproducible, checksummed, and contains the PCMS surface", async () => {
  const reproducibility=run(process.execPath,[resolve(root,"scripts/test-build-reproducibility.mjs")]);
  assert.match(reproducibility.stdout,/XPI reproducibility test passed across UTC and Europe\/Warsaw/);

  const manifest=JSON.parse(await readFile(resolve(root,"extension/manifest.json"),"utf8"));
  const xpi=resolve(root,"dist",`persona-route-manager-v${manifest.version}.xpi`);
  const bytes=await readFile(xpi);
  const digest=createHash("sha256").update(bytes).digest("hex");
  const sidecar=(await readFile(xpi+".sha256","utf8")).trim();
  assert.equal(sidecar,`${digest}  persona-route-manager-v${manifest.version}.xpi`);

  const inspect=run("python3",[
    "-c",
    "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps(sorted(z.namelist())))",
    xpi
  ]);
  const entries=JSON.parse(inspect.stdout);
  for(const required of [
    "manifest.json",
    "pcms/index.html",
    "pcms/pcms.js",
    "pcms/integration/composition.js",
    "pcms/modules/lifecycle.js",
    "pcms/remoteops/provider-gate.js",
    "pcms/recovery/backup-restore.js"
  ]) assert.equal(entries.includes(required),true,`missing release member: ${required}`);

  assert.equal(entries.some((entry)=>entry.startsWith("tests/")||entry.includes("/tests/")),false);
  assert.ok(bytes.byteLength>0);
});
