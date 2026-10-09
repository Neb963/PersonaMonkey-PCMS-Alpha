import { createWriteStream } from "node:fs";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertFileSha256,
  execFileText,
  loadBrowserPin,
  writeJson,
} from "./lib.mjs";

const pin = await loadBrowserPin();
const root = resolve(process.env.FIREFOX_INSTALL_ROOT || join(tmpdir(), "pcms-pinned-firefox"));
const downloads = join(root, "downloads");
const versionRoot = join(root, "versions", pin.version);
const archivePath = join(downloads, pin.archive.fileName);
const firefoxBin = join(versionRoot, "firefox", "firefox");

await mkdir(downloads, { recursive: true });

let useExisting = false;
try {
  await stat(archivePath);
  await assertFileSha256(archivePath, pin.archive.sha256);
  useExisting = true;
} catch {
  await rm(archivePath, { force: true });
}

if (!useExisting) {
  const partial = archivePath + ".partial";
  await rm(partial, { force: true });
  const response = await fetch(pin.archive.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Mozilla download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
  await assertFileSha256(partial, pin.archive.sha256);
  await rename(partial, archivePath);
}

await assertFileSha256(archivePath, pin.archive.sha256);
await rm(versionRoot, { recursive: true, force: true });
await mkdir(versionRoot, { recursive: true });
await execFileText("tar", ["-xJf", archivePath, "-C", versionRoot]);

const versionResult = await execFileText(firefoxBin, ["--version"], {
  env: { ...process.env, MOZ_HEADLESS: "1" },
  timeout: 30_000,
});
const versionOutput = (versionResult.stdout + versionResult.stderr).trim();
if (!versionOutput.includes(pin.version)) {
  throw new Error(`Pinned Firefox version mismatch: expected ${pin.version}, got ${versionOutput}`);
}

const manifestPath = join(root, "install-manifest.json");
await writeJson(manifestPath, {
  schemaVersion: 1,
  product: pin.product,
  channel: pin.channel,
  version: pin.version,
  artifactSha256: pin.archive.sha256,
  firefoxBin,
  versionOutput,
});

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `firefox_bin=${firefoxBin}\nfirefox_version=${pin.version}\ninstall_manifest=${manifestPath}\n`,
    "utf8",
  );
}

console.log(JSON.stringify({
  installed: true,
  version: pin.version,
  sha256: pin.archive.sha256,
  firefoxBin,
  versionOutput,
}));
