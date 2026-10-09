import { mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export async function captureBrowserScreenshot({
  command,
  url,
  width,
  height,
  name,
  virtualTimeBudget = 12000,
  timeoutMs = 45000
}) {
  const requestedDir = String(process.env.UI_SCREENSHOT_DIR || "").trim();
  if (!requestedDir) return null;

  const outputDir = resolve(requestedDir);
  mkdirSync(outputDir, { recursive:true });
  const outputPath = resolve(outputDir, `${name}.png`);
  const child = spawn(command, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${virtualTimeBudget}`,
    `--screenshot=${outputPath}`,
    url
  ], { stdio:["ignore","ignore","pipe"] });

  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const result = await new Promise((resolveChild) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveChild({ code:124 });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveChild({ code:null, error });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveChild({ code });
    });
  });

  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(`Screenshot capture failed for ${name} using ${command}: exit ${result.code}\n${Buffer.concat(errors).toString("utf8").slice(-3000)}`);
  }
  let size;
  try {
    size = statSync(outputPath).size;
  } catch (error) {
    throw new Error(`Screenshot capture produced no file for ${name}: ${error.message}`);
  }
  if (size === 0) throw new Error(`Screenshot capture produced an empty file for ${name}`);
  return outputPath;
}
