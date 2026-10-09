// Builds the P040 fixture add-on for the A040-02 packaged proof. It is a separate MV3 extension
// with a non-persistent event page, never injected into the product XPI: its own manifest, the
// fixture background (fixture-background.js), and the product XPI's `pcms/` and `pcms-modules/`
// trees copied byte for byte, so the shipped Refresher, scheduler, timers and alarm coordinator
// run in a real Firefox event page over a real IndexedDB.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const P040_FIXTURE_ID = "pcms-p040-fixture@tests";
export const P040_FIXTURE_PAGE = "pcms/p040/probe.html";

const MANIFEST = {
  manifest_version:3,
  name:"PCMS P040 Refresher background fixture",
  version:"1.0",
  permissions:["storage", "alarms"],
  background:{ scripts:["pcms/p040/background-entry.js"], type:"module" },
  browser_specific_settings:{ gecko:{ id:P040_FIXTURE_ID, strict_min_version:"154.0" } }
};
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>P040 probe</title></head><body>P040 probe</body></html>\n';
const ENTRY = `import { createP040Background, P040_FIXTURE_PROBE } from "./fixture-background.js";
// Listeners are registered synchronously so an alarm that woke this event page is delivered.
const ready = (async () => {
  const background = await createP040Background({
    pcmsBase: new URL("../", import.meta.url).href,
    modulesBase: new URL("../../pcms-modules/", import.meta.url).href,
    browserRef: browser
  });
  const marker = await browser.storage.session.get("p040.started");
  const wake = marker["p040.started"] ? "WARM" : "COLD";
  await browser.storage.session.set({ "p040.started": true });
  await background.start(wake);
  return background;
})();
ready.catch(() => {});
browser.alarms.onAlarm.addListener((alarm) => { void ready.then((background) => background.handleAlarm(alarm.name)).catch(() => {}); });
browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== P040_FIXTURE_PROBE) return undefined;
  return ready.then((background) => background.status(), (error) => ({ error: String(error && error.stack || error) }));
});
`;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes:true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path)); else out.push(path);
  }
  return out;
}
const sha = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

// Returns {xpi, dir, copiedFiles, digest}; `digest` is over the copied product files.
export async function buildP040FixtureExtension({ productXpi, workDir, backgroundSource }) {
  const unpacked = join(workDir, "product");
  const dir = join(workDir, "fixture");
  await rm(workDir, { recursive:true, force:true });
  await mkdir(unpacked, { recursive:true });
  await mkdir(dir, { recursive:true });
  await run("unzip", ["-q", productXpi, "pcms/*", "pcms-modules/*", "-d", unpacked]);
  const files = (await walk(unpacked)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const rel = relative(unpacked, file).replaceAll("\\", "/");
    await mkdir(join(dir, rel, ".."), { recursive:true });
    await copyFile(file, join(dir, rel));
    hash.update(rel + "\0" + await sha(file) + "\n");
  }
  await mkdir(join(dir, "pcms/p040"), { recursive:true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(MANIFEST, null, 2) + "\n");
  await writeFile(join(dir, P040_FIXTURE_PAGE), PAGE);
  await writeFile(join(dir, "pcms/p040/background-entry.js"), ENTRY);
  await writeFile(join(dir, "pcms/p040/fixture-background.js"), backgroundSource);
  const xpi = join(workDir, "p040-fixture.xpi");
  await run("zip", ["-q", "-X", "-r", xpi, "."], { cwd:dir });
  return { xpi, dir, copiedFiles:files.length, digest:hash.digest("hex") };
}
