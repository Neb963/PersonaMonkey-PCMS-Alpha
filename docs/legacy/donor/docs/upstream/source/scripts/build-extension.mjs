import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "extension");
const dist = resolve(root, "dist");
const validate = spawnSync(process.execPath, [resolve(root, "scripts/validate-extension.mjs")], { cwd: root, stdio: "inherit" });
if (validate.status !== 0) process.exit(validate.status || 1);

const manifest = JSON.parse(readFileSync(resolve(source, "manifest.json"), "utf8"));
const zipTool = spawnSync("zip", ["-v"], { stdio: "ignore" });
if (zipTool.error?.code === "ENOENT") throw new Error("Building the extension requires the zip command; install zip and retry");
if (zipTool.error || zipTool.status !== 0) throw new Error("The zip command is unavailable or failed its prerequisite check");
mkdirSync(dist, { recursive: true });
const out = resolve(dist, `persona-route-manager-v${manifest.version}.xpi`);
const checksum = `${out}.sha256`;
const stage = mkdtempSync(resolve(tmpdir(), "persona-extension-"));
const epoch = new Date("2000-01-01T00:00:00Z");
const zipEnv = { ...process.env, TZ: "UTC", LC_ALL: "C" };

function archivePath(file) {
  return relative(stage, file).replaceAll("\\", "/");
}

function compareArchivePaths(left, right) {
  const a = archivePath(left);
  const b = archivePath(right);
  const foldedA = a.toLowerCase();
  const foldedB = b.toLowerCase();
  if (foldedA < foldedB) return -1;
  if (foldedA > foldedB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "tests") continue;
    const from = resolve(src, entry.name);
    const to = resolve(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else cpSync(from, to);
  }
}
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

try {
  copyTree(source, stage);
  const files = walk(stage).sort(compareArchivePaths);
  for (const file of files) utimesSync(file, epoch, epoch);
  for (const dir of [...new Set(files.map((file) => dirname(file)))].sort((a, b) => b.length - a.length)) {
    if (existsSync(dir) && statSync(dir).isDirectory()) utimesSync(dir, epoch, epoch);
  }
  rmSync(out, { force: true });
  const rel = files.map(archivePath);
  // Info-ZIP stores DOS timestamps as local wall-clock values. Force UTC so
  // the normalized source mtimes produce identical archive headers on CI and
  // developer machines in other time zones. LC_ALL also keeps subprocess
  // behavior independent of the caller's locale.
  const zipped = spawnSync("zip", ["-X", "-q", out, ...rel], {
    cwd: stage,
    stdio: "inherit",
    env: zipEnv
  });
  if (zipped.status !== 0) throw new Error("zip command failed");
  const digest = createHash("sha256").update(readFileSync(out)).digest("hex");
  writeFileSync(checksum, `${digest}  ${out.split("/").at(-1)}\n`);
  console.log(`Built ${relative(root, out)}`);
  console.log(`SHA256 ${digest}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
