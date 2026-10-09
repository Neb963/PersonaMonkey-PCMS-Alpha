// A036-02 (C, SEC): Perchance driver v2 contract, canonical payload identity and the listing
// mapping. isPrivate appears only inside the Perchance adapter, with an UNKNOWN fallback.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  encodeGeneratorPayload,
  generatorPayloadHash,
  generatorReleaseFingerprint,
  normalizePerchanceCompatibility,
  thumbnailHash
} from "../../../extension/pcms/providers/perchance/contract.js";
import { parseGeneratorListing, serializeGeneratorListing } from "../../../extension/pcms/providers/perchance/listing.js";
import { createPerchanceProviderAdapter } from "../../../extension/pcms/providers/perchance/adapter.js";
import { createPerchanceEmulator } from "../../../extension/pcms/providers/perchance/emulator.js";
import { jpegBase64 } from "./harness.mjs";

test("A036-02 canonical payload encoding is byte-exact and length-prefixed (04 §E.4.1)", async () => {
  const bytes = encodeGeneratorPayload("ab", "é");
  assert.equal(new TextDecoder().decode(bytes), "pcms.perchance.generator-payload/v1\ncode 2\nab\nhtml 2\né\n");
  // Fixed vectors: identity never changes silently.
  assert.equal(await generatorPayloadHash("a", "b"), "4b7ad442acba6c0384e14194eda3e7ff87f0d9f57b2538767cc6fb4c86e1a179");
  // No concatenation collision between the two panels; no whitespace normalisation.
  assert.notEqual(await generatorPayloadHash("ab", ""), await generatorPayloadHash("a", "b"));
  assert.notEqual(await generatorPayloadHash("x\r\n", ""), await generatorPayloadHash("x\n", ""));
  assert.throws(() => encodeGeneratorPayload("a\u0000", ""));
  assert.throws(() => encodeGeneratorPayload("\ud800", ""));
  assert.throws(() => encodeGeneratorPayload("x".repeat(4 * 1024 * 1024), "y"));
});

test("A036-02 release fingerprint covers payload, thumbnail and listing", async () => {
  const payloadHash = "a".repeat(64);
  const pub = await generatorReleaseFingerprint({ payloadHash, thumbnailHash:null, listing:"PUBLICLY_LISTED" });
  const unl = await generatorReleaseFingerprint({ payloadHash, thumbnailHash:null, listing:"UNLISTED" });
  const thumb = await generatorReleaseFingerprint({ payloadHash, thumbnailHash:"b".repeat(64), listing:"PUBLICLY_LISTED" });
  assert.match(pub, /^perchance:generator-release:v2:[a-f0-9]{64}$/);
  assert.equal(new Set([pub, unl, thumb]).size, 3);
  await assert.rejects(generatorReleaseFingerprint({ payloadHash, thumbnailHash:null, listing:"PRIVATE" }));
  assert.match(await thumbnailHash(jpegBase64()), /^[a-f0-9]{64}$/);
  await assert.rejects(thumbnailHash(Buffer.from("GIF89a....").toString("base64")));
});

test("A036-02 the listing mapping lives in the adapter and falls back to UNKNOWN", () => {
  assert.deepEqual({ ...serializeGeneratorListing("PUBLICLY_LISTED") }, { isPrivate:false });
  assert.deepEqual({ ...serializeGeneratorListing("UNLISTED") }, { isPrivate:true });
  assert.throws(() => serializeGeneratorListing("UNKNOWN"));
  assert.equal(parseGeneratorListing({ isPrivate:false }), "PUBLICLY_LISTED");
  assert.equal(parseGeneratorListing({ isPrivate:true }), "UNLISTED");
  for (const raw of [undefined, null, {}, { isPrivate:"true" }, { isPrivate:1 }, { isPrivate:null }, { visibility:"unlisted" }, [true], "private"]) {
    assert.equal(parseGeneratorListing(raw), "UNKNOWN", JSON.stringify(raw));
  }
  const getter = {}; Object.defineProperty(getter, "isPrivate", { get() { return true; }, enumerable:true });
  assert.equal(parseGeneratorListing(getter), "UNKNOWN");
});

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes:true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(path));
    else if (/\.(?:m?js|html|css|json)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("A036-02 SEC: isPrivate never appears outside the Perchance adapter; 'private' never in Deployer domain or UI", async () => {
  const files = [...await sourceFiles("extension"), ...await sourceFiles("pcms-modules")];
  const allowed = new Set(["extension/pcms/providers/perchance/listing.js", "extension/pcms/providers/perchance/emulator.js"]);
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (/isPrivate/.test(text) && !allowed.has(file.replaceAll("\\", "/"))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
  const domain = [
    ...await sourceFiles("pcms-modules/p015"),
    ...await sourceFiles("extension/pcms/app/views/generators"),
    "extension/pcms/integration/generator-index.js",
    "extension/pcms/providers/perchance/assisted-driver.js"
  ];
  for (const file of domain) assert.doesNotMatch(await readFile(file, "utf8"), /private/i, file);
});

test("A036-02 v1 probes stay exact; v2 capabilities are fail-closed per capability", async () => {
  const v1 = createPerchanceProviderAdapter({ driver:createPerchanceEmulator().driver });
  assert.deepEqual(JSON.parse(JSON.stringify(await v1.probeCompatibility())),
    { contractId:"pcms.perchance.driver", contractVersion:1, providerId:"perchance", operations:["generator.update"] });
  const base = { contractId:"pcms.perchance.driver", contractVersion:2, providerId:"perchance", operations:["generator.update", "generator.teleport"] };
  const normalized = normalizePerchanceCompatibility({ ...base, capabilities:{ unattended:"yes", observe:true, listing:true, thumbnail:1, future:true } });
  assert.deepEqual([...normalized.operations], ["generator.update"]);
  // observe is false without the generator.observe operation; unknown/non-true values are false.
  assert.deepEqual({ ...normalized.capabilities }, { unattended:false, observe:false, listing:true, thumbnail:false, create:false });
  assert.throws(() => normalizePerchanceCompatibility({ ...base, operations:["generator.observe"], capabilities:{} }), (e) => e.code === "PCMS_PERCHANCE_INCOMPATIBLE");
  assert.throws(() => normalizePerchanceCompatibility({ ...base, contractVersion:3, capabilities:{} }));
  assert.throws(() => normalizePerchanceCompatibility({ ...base, capabilities:{}, extra:true }));
});

test("A036-02 observe maps provider settings and turns listing capability off after an unknown shape", async () => {
  const emulator = createPerchanceEmulator({ contractVersion:2 });
  const adapter = createPerchanceProviderAdapter({ driver:emulator.driver });
  emulator.seedGenerator({ generatorId:"cat-facts", code:"c", html:"h", settings:{ isPrivate:true } });
  const seen = await adapter.observe("cat-facts");
  assert.deepEqual({ ...seen }, { exists:true, payloadHash:await generatorPayloadHash("c", "h"), thumbnailHash:null, listing:"UNLISTED", challenge:false });
  assert.equal((await adapter.probeCompatibility()).capabilities.listing, true);
  emulator.setSettingsShape({ visibility:"hidden" });
  assert.equal((await adapter.observe("cat-facts")).listing, "UNKNOWN");
  assert.equal((await adapter.probeCompatibility()).capabilities.listing, false);
  assert.deepEqual({ ...await adapter.observe("missing-gen") }, { exists:false, payloadHash:null, thumbnailHash:null, listing:"UNKNOWN", challenge:false });
  emulator.setCapabilities({ observe:false });
  await assert.rejects(adapter.observe("cat-facts"), (e) => e.code === "PCMS_PERCHANCE_INCOMPATIBLE");
  // A v1 driver has no v2 reads at all.
  const v1 = createPerchanceProviderAdapter({ driver:createPerchanceEmulator().driver });
  await assert.rejects(v1.observe("cat-facts"), (e) => e.code === "PCMS_PERCHANCE_INCOMPATIBLE");
});
