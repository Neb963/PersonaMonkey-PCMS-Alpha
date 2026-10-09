// P031 boundaries (AGENTS §6, ADR-003 §4): the background module supervisor and capability
// set v1 never hand a module raw browser.*, IndexedDB, PersonaMonkey service objects or a
// second userScripts authority; only the host binding touches the background document.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createBackgroundModuleRuntimeOptions } from "../../../extension/pcms/background/modules/host.js";
import { MODULE_SCHEDULE_NAMESPACE, moduleSchedulerServiceName, moduleTimerId, parseModuleTimerId } from "../../../extension/pcms/background/modules/schedules.js";
import { createModuleSupervisor } from "../../../extension/pcms/background/modules/supervisor.js";

const DIR = "extension/pcms/background/modules";

test("A031-02 supervisor, schedules and capabilities use no raw browser, IndexedDB or PersonaMonkey objects", async () => {
  const files = (await readdir(DIR)).filter((name) => name.endsWith(".js"));
  assert.deepEqual(files.sort(), ["capabilities.js", "host.js", "schedules.js", "supervisor.js"]);
  for (const name of files) {
    const source = await readFile(join(DIR, name), "utf8");
    assert.doesNotMatch(source, /\bindexedDB\b|\bIDB[A-Z]/, name);
    assert.doesNotMatch(source, /\buserScripts\b|\bchrome\./, name);
    assert.doesNotMatch(source, /personamonkey|native(Host|Messaging)|runtime\.connectNative/i, name);
    if (name === "host.js") continue;
    assert.doesNotMatch(source, /\bbrowser\b\s*[.?[]|globalThis\.browser|globalThis\.document/, name);
  }
  const host = await readFile(join(DIR, "host.js"), "utf8");
  const browserUses = [...host.matchAll(/browserRef\.runtime\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(browserUses)].sort(), ["getBrowserInfo", "getManifest", "getURL"]);
});

test("A031-01 without a background document the module runtime reports UNAVAILABLE and nothing is framed", async () => {
  const options = createBackgroundModuleRuntimeOptions({ documentRef: null, browserRef: null });
  assert.equal(options.frameFactory, null);
  const status = await options.support.getStatus();
  assert.equal(status.state, "UNAVAILABLE");
  assert.match(status.message, /Firefox 154\+/);
});

test("A031-02 module schedule names map one-to-one onto module-scoped Core timers", () => {
  assert.equal(MODULE_SCHEDULE_NAMESPACE, "core.module-schedules");
  assert.equal(moduleSchedulerServiceName("fixture.counter"), "module.fixture.counter.scheduler");
  const timerId = moduleTimerId("fixture.counter", "tick");
  assert.equal(timerId, "module.fixture.counter/tick");
  assert.deepEqual({ ...parseModuleTimerId(timerId) }, { moduleId: "fixture.counter", name: "tick" });
  assert.equal(parseModuleTimerId("pcms.continuity/tick"), null);
  assert.throws(() => moduleTimerId("fixture.counter", "../escape"));
});

test("A031-01 the supervisor refuses incomplete wiring", () => {
  assert.throws(() => createModuleSupervisor({}), TypeError);
});
