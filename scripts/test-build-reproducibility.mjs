import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "extension/manifest.json"), "utf8"));
const out = resolve(root, "dist", `persona-route-manager-v${manifest.version}.xpi`);
const checksum = `${out}.sha256`;
const builder = resolve(root, "scripts/build-extension.mjs");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildInTimezone(timeZone) {
  const run = spawnSync(process.execPath, [builder], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone }
  });
  if (run.status !== 0) {
    process.stderr.write(run.stdout || "");
    process.stderr.write(run.stderr || "");
    throw new Error(`XPI build failed under TZ=${timeZone}`);
  }
  const bytes = readFileSync(out);
  const actual = digest(bytes);
  const listed = readFileSync(checksum, "utf8").trim().split(/\s+/)[0];
  if (listed !== actual) throw new Error(`checksum mismatch under TZ=${timeZone}`);
  return { bytes, actual };
}

const utc = buildInTimezone("UTC");
const warsaw = buildInTimezone("Europe/Warsaw");

if (!utc.bytes.equals(warsaw.bytes)) {
  throw new Error(`XPI build is timezone-dependent: UTC=${utc.actual}, Europe/Warsaw=${warsaw.actual}`);
}

console.log(`XPI reproducibility test passed across UTC and Europe/Warsaw: ${utc.actual}`);
