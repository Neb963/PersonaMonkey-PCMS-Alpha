import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { createStoredZip, readZip, decodeZipText, crc32 } from "../lib/zip.js";
import { WORKFLOW_PACKAGE_LIMITS } from "../lib/package-limits.js";
import { inspectWorkflowPackage } from "../lib/workflow-package.js";

function buildZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const method = entry.method === 8 ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const expectedCrc = entry.expectedCrc ?? crc32(data);
    const declaredSize = entry.declaredSize ?? data.byteLength;
    const flags = entry.flags ?? 0x0800;
    const hasDataDescriptor = Boolean(flags & 0x0008);

    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.localCrc ?? (hasDataDescriptor ? 0 : expectedCrc), 14);
    local.writeUInt32LE(entry.localCompressedSize ?? (hasDataDescriptor ? 0 : compressed.length), 18);
    local.writeUInt32LE(entry.localDeclaredSize ?? (hasDataDescriptor ? 0 : declaredSize), 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    const descriptor = hasDataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (hasDataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(expectedCrc, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(declaredSize, 12);
    }
    localRecords.push(Buffer.concat([local, descriptor]));

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(expectedCrc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    localOffset += local.length + descriptor.length;
  }

  const centralOffset = localOffset;
  const centralSize = centralRecords.reduce((size, record) => size + record.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return {
    bytes: Buffer.concat([...localRecords, ...centralRecords, end]),
    centralOffset
  };
}

const zip = createStoredZip([
  { name: "manifest.json", data: JSON.stringify({ ok: true }) },
  { name: "userscripts/example.user.js", data: "// ==UserScript==\n// @name Example\n// ==/UserScript==\n" }
]);

assert.ok(zip instanceof Uint8Array);
assert.ok(zip.byteLength > 100);
const entries = await readZip(zip);
assert.equal(entries.size, 2);
assert.deepEqual(JSON.parse(decodeZipText(entries.get("manifest.json"))), { ok: true });
assert.match(decodeZipText(entries.get("userscripts/example.user.js")), /@name Example/);
assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);

const withDirectory = Uint8Array.from(Buffer.from("UEsDBBQAAAAAALouNV0AAAAAAAAAAAAAAAAMAAAAdXNlcnNjcmlwdHMvUEsDBBQAAAAAALouNV38r5lqBwAAAAcAAAAVAAAAdXNlcnNjcmlwdHMvYS51c2VyLmpzLy8gdGVzdFBLAQIUAxQAAAAAALouNV0AAAAAAAAAAAAAAAAMAAAAAAAAAAAAEAD9QQAAAAB1c2Vyc2NyaXB0cy9QSwECFAMUAAAAAAC6LjVd/K+ZagcAAAAHAAAAFQAAAAAAAAAAAAAAgAEqAAAAdXNlcnNjcmlwdHMvYS51c2VyLmpzUEsFBgAAAAACAAIAfQAAAGQAAAAAAA==","base64"));
const directoryDecoded = await readZip(withDirectory);
assert.equal(directoryDecoded.has("userscripts/"), false, "directory entries are structural and must not be exposed as files");
assert.equal(decodeZipText(directoryDecoded.get("userscripts/a.user.js")), "// test");

const mismatched = zip.slice();
mismatched[30] = "x".charCodeAt(0);
await assert.rejects(readZip(mismatched), /local\/central header mismatch/);

const deflated = buildZip([{ name: "compressed.txt", data: "a normal DEFLATE entry", method: 8 }]);
const deflatedEntries = await readZip(deflated.bytes);
assert.equal(decodeZipText(deflatedEntries.get("compressed.txt")), "a normal DEFLATE entry");

const withDataDescriptor = buildZip([{
  name: "descriptor.txt",
  data: "descriptor metadata is deferred",
  method: 8,
  flags: 0x0808
}]);
assert.equal(decodeZipText((await readZip(withDataDescriptor.bytes)).get("descriptor.txt")), "descriptor metadata is deferred");

const boundedBomb = buildZip([{
  name: "understated.txt",
  data: Buffer.alloc(5 * 1024 * 1024, 0x41),
  method: 8,
  declaredSize: 1024
}]);
assert.ok(boundedBomb.bytes.byteLength < 64 * 1024, "the adversarial fixture must remain small on disk");
assert.equal(boundedBomb.bytes.readUInt32LE(boundedBomb.centralOffset + 24), 1024);
await assert.rejects(readZip(boundedBomb.bytes), /runtime size/);

const aggregateOverflow = buildZip([
  { name: "first.txt", data: Buffer.alloc(7, 0x41), method: 8 },
  { name: "second.txt", data: Buffer.alloc(7, 0x42), method: 8 }
]);
await assert.rejects(readZip(aggregateOverflow.bytes, {
  maxCompressedBytes: 1024,
  maxEntries: 8,
  maxEntryBytes: 8,
  maxUncompressedBytes: 10,
  maxPathBytes: 2048
}), /runtime size/);

const twoEntries = createStoredZip([
  { name: "one.txt", data: "1" },
  { name: "two.txt", data: "2" }
]);
await assert.rejects(readZip(twoEntries, { maxEntries: 1 }), /entry count/);

const crcMismatch = buildZip([{ name: "crc.txt", data: "crc-check" }]);
const incorrectCrc = (crc32(Buffer.from("crc-check")) ^ 1) >>> 0;
crcMismatch.bytes.writeUInt32LE(incorrectCrc, 14);
crcMismatch.bytes.writeUInt32LE(incorrectCrc, crcMismatch.centralOffset + 16);
await assert.rejects(readZip(crcMismatch.bytes), /CRC mismatch/);

const sizeMismatch = buildZip([{ name: "size.txt", data: "size-check" }]);
const incorrectSize = Buffer.byteLength("size-check") - 1;
sizeMismatch.bytes.writeUInt32LE(incorrectSize, 22);
sizeMismatch.bytes.writeUInt32LE(incorrectSize, sizeMismatch.centralOffset + 24);
await assert.rejects(readZip(sizeMismatch.bytes), /size mismatch/);

const inconsistentLocalSize = buildZip([{ name: "local-size.txt", data: "local-size", localDeclaredSize: 0 }]);
await assert.rejects(readZip(inconsistentLocalSize.bytes), /local\/central size or checksum mismatch/);
const inconsistentLocalCrc = buildZip([{ name: "local-crc.txt", data: "local-crc", localCrc: 0 }]);
await assert.rejects(readZip(inconsistentLocalCrc.bytes), /local\/central size or checksum mismatch/);

await assert.rejects(
  inspectWorkflowPackage(new Uint8Array(WORKFLOW_PACKAGE_LIMITS.maxCompressedBytes + 1), { profiles: {}, routes: {}, scripts: {} }),
  /allowed compressed size/
);

assert.throws(() => createStoredZip([{ name: "../evil", data: "x" }]), /Unsafe ZIP path/);
assert.throws(() => createStoredZip([{ name: "a", data: "1" }, { name: "a", data: "2" }]), /Duplicate ZIP path/);
assert.throws(() => createStoredZip([]), /at least one entry/);

console.log("zip package tests passed");
