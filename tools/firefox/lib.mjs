import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const DEFAULT_PIN_PATH = fileURLToPath(
  new URL("../../docs/implementation/v1/browser-pin.json", import.meta.url),
);

export async function loadBrowserPin(path = DEFAULT_PIN_PATH) {
  const pin = JSON.parse(await readFile(path, "utf8"));
  return validateBrowserPin(pin);
}

export function validateBrowserPin(pin) {
  if (pin?.schemaVersion !== 1) throw new Error("browser pin schemaVersion must be 1");
  if (pin.product !== "firefox-developer-edition") throw new Error("browser pin product must be Firefox Developer Edition");
  if (pin.channel !== "developer") throw new Error("browser pin channel must be developer");
  if (!/^\d+\.0b\d+$/.test(pin.version ?? "")) throw new Error("browser pin version must be an exact beta build");
  if (Number(pin.version.split(".")[0]) < 154) throw new Error("P027 browser pin must support Firefox sandbox pages (154+)");
  if (pin.platform !== "linux-x86_64") throw new Error("P001 CI pin must target linux-x86_64");
  if (pin.locale !== "en-US") throw new Error("P001 CI pin must target en-US");
  if (!/^[0-9a-f]{64}$/.test(pin.archive?.sha256 ?? "")) throw new Error("browser pin requires an exact SHA-256");
  if (pin.archive?.fileName !== `firefox-${pin.version}.tar.xz`) throw new Error("archive filename does not match version");

  const expectedEntry = `${pin.platform}/${pin.locale}/${pin.archive.fileName}`;
  if (pin.checksumManifest?.entry !== expectedEntry) throw new Error("checksum manifest entry does not match artifact coordinates");

  const archiveUrl = new URL(pin.archive.url);
  if (archiveUrl.protocol !== "https:" || archiveUrl.hostname !== "archive.mozilla.org") {
    throw new Error("browser artifact must come from Mozilla archive over HTTPS");
  }
  const expectedPath = `/pub/devedition/releases/${pin.version}/${expectedEntry}`;
  if (archiveUrl.pathname !== expectedPath) throw new Error("browser artifact URL is not the exact Developer Edition archive path");

  const manifestUrl = new URL(pin.checksumManifest.url);
  if (
    manifestUrl.protocol !== "https:" ||
    manifestUrl.hostname !== "archive.mozilla.org" ||
    manifestUrl.pathname !== `/pub/devedition/releases/${pin.version}/SHA256SUMS`
  ) {
    throw new Error("checksum manifest URL is not the matching Mozilla release manifest");
  }
  return pin;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertFileSha256(path, expected) {
  const actual = await sha256File(path);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

export async function execFileText(file, args, options = {}) {
  const result = await execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function createIsolatedProfile(parent = join(tmpdir(), "pcms-firefox-profiles")) {
  await mkdir(parent, { recursive: true });
  const profilePath = await mkdtemp(join(parent, "profile-"));
  const prefs = [
    'user_pref("app.update.auto", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.healthreport.uploadEnabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
  ].join("\n") + "\n";
  await writeFile(join(profilePath, "user.js"), prefs, "utf8");
  return profilePath;
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}
