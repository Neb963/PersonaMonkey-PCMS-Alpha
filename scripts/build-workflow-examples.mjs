import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStoredZip } from "../extension/lib/zip.js";
import { inspectWorkflowPackage } from "../extension/lib/workflow-package.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "examples/workflow-packages/mullvad-signal-check");
const dist = resolve(root, "dist");
const manifestText = readFileSync(resolve(source, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestText);
const entries = [{ name: "manifest.json", data: manifestText }];
for (const script of manifest.scripts || []) {
  entries.push({ name: script.file, data: readFileSync(resolve(source, script.file)) });
}

const zip = createStoredZip(entries);
await inspectWorkflowPackage(zip, { profiles: {}, routes: {}, scripts: {}, workflows: {} });
mkdirSync(dist, { recursive: true });
const out = resolve(dist, "mullvad-signal-check.personamonkey.zip");
writeFileSync(out, zip);
const digest = createHash("sha256").update(zip).digest("hex");
writeFileSync(`${out}.sha256`, `${digest}  mullvad-signal-check.personamonkey.zip\n`);
console.log(`Built ${out}`);
console.log(`SHA256 ${digest}`);
