import http from "node:http";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  createIsolatedProfile,
  execFileText,
  loadBrowserPin,
  writeJson,
} from "./lib.mjs";

const firefoxBin = process.env.FIREFOX_BIN;
if (!firefoxBin) throw new Error("FIREFOX_BIN is required");

const pin = await loadBrowserPin();
const smokeRoot = resolve(process.env.FIREFOX_SMOKE_DIR || join(tmpdir(), "pcms-firefox-smoke"));
await mkdir(smokeRoot, { recursive: true });
const profilePath = await createIsolatedProfile(join(smokeRoot, "profiles"));
const screenshotPath = join(smokeRoot, "smoke.png");

const server = http.createServer((request, response) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end("<!doctype html><meta charset=utf-8><title>PCMS Firefox CI</title><main id=ready>pinned-fde-ok</main>");
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind local smoke server");
const url = `http://127.0.0.1:${address.port}/`;

let result;
try {
  result = await execFileText(
    firefoxBin,
    [
      "--headless",
      "--no-remote",
      "--profile",
      profilePath,
      "--screenshot",
      screenshotPath,
      url,
    ],
    {
      env: {
        ...process.env,
        MOZ_HEADLESS: "1",
        HOME: profilePath,
        XDG_CACHE_HOME: join(profilePath, ".cache"),
        XDG_CONFIG_HOME: join(profilePath, ".config"),
      },
      timeout: 90_000,
    },
  );
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

const screenshot = await stat(screenshotPath);
if (screenshot.size < 1000) {
  throw new Error(`Firefox smoke screenshot is unexpectedly small: ${screenshot.size} bytes`);
}

const version = await execFileText(firefoxBin, ["--version"], {
  env: { ...process.env, MOZ_HEADLESS: "1" },
  timeout: 30_000,
});
const versionOutput = (version.stdout + version.stderr).trim();
if (!versionOutput.includes(pin.version)) {
  throw new Error(`Smoke used wrong Firefox build: ${versionOutput}`);
}

const report = {
  schemaVersion: 1,
  passed: true,
  product: pin.product,
  version: pin.version,
  artifactSha256: pin.archive.sha256,
  profileIsolation: "explicit-disposable-profile",
  profileDirectoryName: basename(profilePath),
  screenshotBytes: screenshot.size,
  versionOutput,
  firefoxStdout: result.stdout.trim(),
  firefoxStderr: result.stderr.trim(),
};
const reportPath = resolve(process.env.FIREFOX_SMOKE_REPORT || join(smokeRoot, "report.json"));
await writeJson(reportPath, report);

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "## Pinned Firefox Developer Edition smoke",
      "",
      `- Version: \`${pin.version}\``,
      `- Artifact SHA-256: \`${pin.archive.sha256}\``,
      "- Profile: explicit disposable profile",
      `- Screenshot bytes: ${screenshot.size}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

console.log(JSON.stringify(report));
