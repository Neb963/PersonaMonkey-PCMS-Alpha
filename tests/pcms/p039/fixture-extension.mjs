// Builds the P039 fixture add-on for the A039-03 packaged proof. It is a separate MV3 extension
// with a non-persistent event page, never injected into the product XPI: its own manifest, the
// fixture background (fixture-background.js), and the product XPI's `pcms/` and `pcms-modules/`
// trees copied byte for byte, so the shipped observation, scheduler, timers and alarm coordinator
// run in a real Firefox event page over a real IndexedDB.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const P039_FIXTURE_ID = "pcms-p039-fixture@tests";
export const P039_FIXTURE_PAGE = "pcms/p039/probe.html";
// Exercise delayed event delivery: a nominal timer deadline cannot prove that
// both reads and the durable challenge transition have already completed.
export const P039_ALARM_DELIVERY_DELAY_MS = 3000;

const MANIFEST = {
  manifest_version:3,
  name:"PCMS P039 observation background fixture",
  version:"1.0",
  permissions:["storage", "alarms"],
  background:{ scripts:["pcms/p039/background-entry.js"], type:"module" },
  browser_specific_settings:{ gecko:{ id:P039_FIXTURE_ID, strict_min_version:"154.0" } }
};
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>P039 probe</title></head><body>P039 probe</body></html>\n';
const entry = (origin,personaUid) => `import { createP039Background, P039_FIXTURE_PROBE } from "./fixture-background.js";
// Listeners are registered synchronously so an alarm that woke this event page is delivered.
const ready = (async () => {
  const background = await createP039Background({
    pcmsBase: new URL("../", import.meta.url).href,
    modulesBase: new URL("../../pcms-modules/", import.meta.url).href,
    browserRef: browser, origin: ${JSON.stringify(origin)}, personaUid: ${JSON.stringify(personaUid)}
  });
  const marker = await browser.storage.session.get("p039.started");
  const wake = marker["p039.started"] ? "WARM" : "COLD";
  await browser.storage.session.set({ "p039.started": true });
  await background.start(wake);
  return background;
})();
ready.catch(() => {});
browser.alarms.onAlarm.addListener((alarm) => { void ready.then(async (background) => {
  await new Promise(resolve => setTimeout(resolve, ${P039_ALARM_DELIVERY_DELAY_MS}));
  await background.handleAlarm(alarm.name);
  const status = await background.status();
  if (status.attention.some(task => task.taskKind === "provider.observation-challenge")) {
    // Fixture-only completion receipt, emitted after the timer and challenge
    // writes settle. This does not send provider content or wake the event page.
    const response = await fetch(${JSON.stringify(origin + "/__p039_sweep_complete")}, { method:"POST" });
    if (!response.ok) throw new Error("Fixture completion receipt failed");
  }
}).catch(() => {}); });
browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== P039_FIXTURE_PROBE) return undefined;
  return ready.then((background) => background.status(), (error) => ({ error: String(error)+" | "+String(error && error.stack || "") }));
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
export async function buildP039FixtureExtension({ productXpi, workDir, backgroundSource, origin, personaUid }) {
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
  await mkdir(join(dir, "pcms/p039"), { recursive:true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...MANIFEST, host_permissions:[origin + "/*"] }, null, 2) + "\n");
  await writeFile(join(dir, P039_FIXTURE_PAGE), PAGE);
  await writeFile(join(dir, "pcms/p039/background-entry.js"), entry(origin,personaUid));
  await writeFile(join(dir, "pcms/p039/fixture-background.js"), backgroundSource);
  const xpi = join(workDir, "p039-fixture.xpi");
  await run("zip", ["-q", "-X", "-r", xpi, "."], { cwd:dir });
  return { xpi, dir, copiedFiles:files.length, digest:hash.digest("hex") };
}
