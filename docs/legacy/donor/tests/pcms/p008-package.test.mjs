import assert from "node:assert/strict";
import test from "node:test";

import { diffModuleAuthority, normalizeModuleAuthority } from "../../extension/pcms/modules/authority.js";
import { MODULE_ERROR_CODES } from "../../extension/pcms/modules/errors.js";
import {
  MODULE_MAX_ARCHIVE_BYTES,
  PCMS_MODULE_ARCHIVE_FORMAT,
  encodeModuleArchive,
  hashModuleArchiveBytes,
  parseModuleArchive
} from "../../extension/pcms/modules/package.js";

function definition(capabilities=["storage.read"]) {
  return {
    format: PCMS_MODULE_ARCHIVE_FORMAT,
    manifest: {
      schemaVersion:1,
      moduleId:"demo.module",
      version:"1.2.3",
      controller:"controller.js",
      authority:{capabilities}
    },
    files:{"notes.txt":"ok","controller.js":"() => ({ ping(){ return 'pong'; } })"}
  };
}

test("A008-01 archive encoding is canonical, bounded, and hash-identified", async () => {
  const bytes=encodeModuleArchive(definition(["zeta.read","alpha.write"]));
  const text=new TextDecoder().decode(bytes);
  assert.equal(text, '{"format":"pcms.module.archive/v1","manifest":{"schemaVersion":1,"moduleId":"demo.module","version":"1.2.3","controller":"controller.js","authority":{"capabilities":["alpha.write","zeta.read"]}},"files":{"controller.js":"() => ({ ping(){ return \'pong\'; } })","notes.txt":"ok"}}');

  const parsed=await parseModuleArchive(bytes);
  assert.equal(parsed.packageHash,"sha256:0ea853e536852d5e4693e3e5b45b694d10a9de3b18890745a68feee058069eae");
  assert.equal(parsed.packageHash,await hashModuleArchiveBytes(bytes));
  assert.equal(parsed.manifest.moduleId,"demo.module");
  assert.deepEqual(parsed.manifest.authority.capabilities,["alpha.write","zeta.read"]);
  assert.equal(parsed.files["controller.js"],"() => ({ ping(){ return 'pong'; } })");
});

test("A008-01 parser rejects non-canonical, unsafe, oversized, and raw-authority archives", async () => {
  const canonical=encodeModuleArchive(definition());
  const pretty=new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(canonical)),null,2));
  await assert.rejects(() => parseModuleArchive(pretty),(e)=>e?.code===MODULE_ERROR_CODES.INVALID_ARCHIVE);

  assert.throws(
    ()=>encodeModuleArchive({...definition(),manifest:{...definition().manifest,controller:"../escape.js"}}),
    (e)=>e?.code===MODULE_ERROR_CODES.INVALID_PATH
  );
  for (const capability of ["browser.tabs","provider.*","provider.execute","indexeddb.raw"]) {
    if (capability === "provider.execute") continue;
    assert.throws(
      ()=>encodeModuleArchive(definition([capability])),
      (e)=>e?.code===MODULE_ERROR_CODES.INVALID_AUTHORITY
    );
  }
  assert.doesNotThrow(()=>encodeModuleArchive(definition(["provider.execute"])));
  await assert.rejects(
    ()=>parseModuleArchive(new Uint8Array(MODULE_MAX_ARCHIVE_BYTES+1)),
    (e)=>e?.code===MODULE_ERROR_CODES.ARCHIVE_TOO_LARGE
  );
});

test("A008-02 authority delta is deterministic and expansion-only approval is explicit", () => {
  const previous=normalizeModuleAuthority({capabilities:["storage.read","provider.observe"]});
  const next=normalizeModuleAuthority({capabilities:["provider.execute","storage.read"]});
  assert.deepEqual(diffModuleAuthority(previous,next),{
    added:["provider.execute"],
    removed:["provider.observe"],
    unchanged:["storage.read"],
    requiresApproval:true
  });
  assert.equal(diffModuleAuthority(next,{capabilities:["storage.read"]}).requiresApproval,false);
});
